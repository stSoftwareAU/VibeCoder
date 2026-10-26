/**
 * The baseline gate of a resumed run measures the default branch, not the
 * resumed branch (Issue #4412).
 *
 * A resumed issue branch already carries the commits of an earlier attempt.
 * The baseline gate used to run on that checkout, so a check those commits
 * broke was recorded as "red on the untouched tree"; the post-change gate
 * then reproduced it and the run filed a "quality gate red on the default
 * branch" tracker against a default branch that was green. The baseline now
 * runs on the commit the branch forked from, and the branch is checked out
 * again afterwards.
 *
 * The red check that exposed it, `semgrep`, was a second fault: the egress
 * proxy refused semgrep.dev, and `--quiet` hid the error that would have
 * made the stage a loud SKIPPED rather than a FAILED.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { workOnIssueBaselineQuality } from "../lib/phases/baseline_quality_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { CheckResult } from "../lib/quality_helpers.ts";
import { resolveEgressAllowlist } from "../lib/egress_allowlist.ts";
import { runPreSetupCommand } from "../lib/repo_config.ts";
import {
  isRegistryUnavailable,
  semgrepScanArgs,
} from "../lib/semgrep_check.ts";

const BRANCH = "issue-7-resumed";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const run = await runGitCommand(args, { cwd });
  if (!run.ok) throw run.error;
  if (run.value.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${run.value.stderr}`);
  }
  return run.value.stdout.trim();
}

/**
 * A clone whose `origin/main` is clean and whose resumed issue branch has one
 * earlier-attempt commit that breaks the gate.
 */
async function resumedCheckout(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "baseline-fork-point-4412-" });
  await git(dir, "init", "-q", "-b", "main");
  // CI runners have no global git identity.
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@example.com");
  await Deno.writeTextFile(`${dir}/state.txt`, "clean\n");
  await Deno.writeTextFile(`${dir}/setup.txt`, "original\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "base");
  await git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  await git(dir, "checkout", "-q", "-b", BRANCH);
  await Deno.writeTextFile(
    `${dir}/state.txt`,
    "broken by an earlier attempt\n",
  );
  await git(dir, "commit", "-q", "-am", "earlier attempt");
  return dir;
}

function context(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 7,
    issueTitle: "t",
    issueBody: "b",
    issueLabels: [],
    issueComments: "",
    githubUser: "bot",
    config: { ...buildDefaultWorkerConfig(), baselineAwareQualityGate: false },
  };
}

function state(repoPath: string, resumed: boolean): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    resumedFromCheckpoint: resumed,
  };
}

/** Deps whose gate fails `spawn timeout` when the checkout holds the break. */
function deps(warnings: string[] = [], onGate?: () => void) {
  const base = createMockDeps({
    git: { runGitCommand },
    quality: {
      runQualityGate: async ({ scriptDir }) => {
        onGate?.();
        const broken = (await Deno.readTextFile(`${scriptDir}/state.txt`))
          .startsWith("broken");
        const checks: CheckResult[] = broken
          ? [{ name: "spawn timeout", status: "FAILED", output: "offence" }]
          : [];
        return {
          ok: true as const,
          value: {
            checks,
            summary: { text: "", passed: !broken },
            passed: !broken,
            output: broken ? "spawn timeout: FAILED" : "",
          },
        };
      },
      readBaselineQualityCache: () => Promise.resolve(null),
      writeBaselineQualityCache: () => Promise.resolve(),
    },
  });
  const logger = base.logger;
  base.logger = {
    ...logger,
    warn: (msg: string, fields?: Record<string, unknown>) => {
      warnings.push(fields?.error ? `${msg}: ${fields.error}` : msg);
      logger.warn(msg, fields);
    },
  };
  return base;
}

Deno.test("a resumed run's baseline gates the fork point, not the branch's own commits (Issue #4412)", async () => {
  const dir = await resumedCheckout();
  try {
    const phaseState = state(dir, true);
    const result = await workOnIssueBaselineQuality(
      context(),
      phaseState,
      deps(),
    );

    assertEquals(result.status, "continue");
    assertEquals(phaseState.baselineQualityPassed, true);
    assertEquals(phaseState.baselineFailedChecks, []);
    // The resumed branch is checked out again, earlier work intact.
    assertEquals(
      await git(dir, "symbolic-ref", "HEAD"),
      `refs/heads/${BRANCH}`,
    );
    assertEquals(
      await Deno.readTextFile(`${dir}/state.txt`),
      "broken by an earlier attempt\n",
    );
    assertEquals(await git(dir, "status", "--porcelain"), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

for (const dirtyKind of ["unstaged", "staged", "untracked"] as const) {
  Deno.test(`a resumed baseline preserves ${dirtyKind} pre-setup output without measuring it (Issue #4412)`, async () => {
    const dir = await resumedCheckout();
    try {
      // setup.txt is identical at the fork point and resumed HEAD, so Git
      // can carry its dirty edit through a detached checkout. A forced
      // return to the branch would then discard this supported prep work.
      const file = dirtyKind === "untracked" ? "generated.txt" : "setup.txt";
      const prepared = await runPreSetupCommand("org/repo", dir, {
        "org/repo": {
          preSetupCommand: `printf '%s\\n' 'prepared by setup' > ${file}`,
        },
      });
      assertEquals(prepared, { ok: true, value: "completed" });
      if (dirtyKind === "staged") await git(dir, "add", file);
      const beforeHead = await git(dir, "rev-parse", "HEAD");
      const beforeStatus = await git(dir, "status", "--porcelain");
      assert(beforeStatus.length > 0);
      const warnings: string[] = [];
      let gateCalls = 0;
      const phaseState = state(dir, true);
      const result = await workOnIssueBaselineQuality(
        context(),
        phaseState,
        deps(warnings, () => gateCalls++),
      );

      assertEquals(
        await Deno.readTextFile(`${dir}/${file}`),
        "prepared by setup\n",
      );
      assertEquals(await git(dir, "status", "--porcelain"), beforeStatus);
      assertEquals(await git(dir, "rev-parse", "HEAD"), beforeHead);
      assertEquals(
        await git(dir, "symbolic-ref", "HEAD"),
        `refs/heads/${BRANCH}`,
      );
      assertEquals(result.status, "continue");
      assertEquals(gateCalls, 0, "dirty setup must not become a baseline");
      assertEquals(phaseState.baselineQualityPassed, true);
      assertEquals(phaseState.baselineFailedChecks, undefined);
      assertStringIncludes(warnings.join("\n"), "uncommitted");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

for (const failure of ["command error", "nonzero exit"] as const) {
  Deno.test(`a resumed baseline preserves its branch when cleanliness has a ${failure} (Issue #4412)`, async () => {
    const dir = await resumedCheckout();
    try {
      const beforeHead = await git(dir, "rev-parse", "HEAD");
      const warnings: string[] = [];
      let gateCalls = 0;
      const dependencies = deps(warnings, () => gateCalls++);
      dependencies.git.runGitCommand = async (args, options) => {
        if (args[0] !== "status") return await runGitCommand(args, options);
        return failure === "command error"
          ? { ok: false, error: new Error("status unavailable") }
          : {
            ok: true,
            value: { code: 128, stdout: "", stderr: "status unavailable" },
          };
      };
      const phaseState = state(dir, true);
      const result = await workOnIssueBaselineQuality(
        context(),
        phaseState,
        dependencies,
      );

      assertEquals(
        gateCalls,
        0,
        "unverified cleanliness must not become a baseline",
      );
      assertEquals(result.status, "continue");
      assertEquals(phaseState.baselineFailedChecks, undefined);
      assertEquals(await git(dir, "rev-parse", "HEAD"), beforeHead);
      assertEquals(
        await git(dir, "symbolic-ref", "HEAD"),
        `refs/heads/${BRANCH}`,
      );
      assertEquals(await git(dir, "status", "--porcelain"), "");
      assertStringIncludes(warnings.join("\n"), "status unavailable");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("a fresh run's baseline still gates the checkout as it stands (Issue #4412)", async () => {
  const dir = await resumedCheckout();
  try {
    // Not resumed: the checkout is what the run starts from, red or not.
    const phaseState = state(dir, false);
    await workOnIssueBaselineQuality(context(), phaseState, deps());
    assertEquals(phaseState.baselineQualityPassed, false);
    assertEquals(
      phaseState.baselineFailedChecks?.map((check) => check.name),
      ["spawn timeout"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a resumed run whose fork point cannot be found attributes nothing to the default branch (Issue #4412)", async () => {
  const dir = await resumedCheckout();
  try {
    await git(dir, "update-ref", "-d", "refs/remotes/origin/main");
    await git(dir, "branch", "-q", "-D", "main");
    const warnings: string[] = [];
    const phaseState = state(dir, true);
    const result = await workOnIssueBaselineQuality(
      context(),
      phaseState,
      deps(warnings),
    );
    assertEquals(result.status, "continue");
    // Left at its default: the post-change gate cannot call anything
    // pre-existing, so no tracker is filed against the default branch.
    assertEquals(phaseState.baselineQualityPassed, true);
    assertEquals(phaseState.baselineFailedChecks, undefined);
    assertStringIncludes(warnings.join("\n"), "fork point");
    assertEquals(
      await git(dir, "symbolic-ref", "HEAD"),
      `refs/heads/${BRANCH}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The semgrep stage behind the egress proxy (Issue #4412)
// ---------------------------------------------------------------------------

Deno.test("the semgrep rule registry is on the egress allowlist (Issue #4412)", () => {
  const hosts = resolveEgressAllowlist({
    enabledProviderIds: [],
    imgbbConfigured: false,
  });
  assert(hosts.includes(new URL("https://semgrep.dev/c/p/default").hostname));
});

Deno.test("the semgrep scan never runs --quiet, which hides a refused rules download (Issue #4412)", () => {
  assertFalse(semgrepScanArgs(["a.ts"]).includes("--quiet"));
  // What semgrep 1.182.1 prints when the proxy refuses semgrep.dev, as
  // captured in the fleet container.
  assert(isRegistryUnavailable(
    "requests.exceptions.ProxyError: HTTPSConnectionPool(host='semgrep.dev', " +
      "port=443): Max retries exceeded with url: /c/p/default (Caused by " +
      "ProxyError('Unable to connect to proxy', OSError('Tunnel connection " +
      "failed: 403 Forbidden')))",
  ));
});
