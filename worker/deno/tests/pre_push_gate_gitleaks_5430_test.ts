/**
 * Behaviour tests for the pre-push gate's gitleaks stage (Issue #5430).
 *
 * PR #5322 merged secret-shaped findings from commits pushed after the PR was
 * raised, and the pre-push gate that guards the fleet's pushes to an open PR
 * ran no gitleaks — only `./quality.sh` did.
 * The stage scans each pushed branch's commit range `<fork>..<head>`, the range
 * CI's `gitleaks.yml` scans (`<base tip>..<head>`), through `runPrePushGate`.
 *
 * Covered:
 *   - the real gitleaks refuses a push whose PR range holds a fake token that an
 *     earlier, already-pushed commit added (the full PR range is scanned);
 *   - a fake token already on the base branch is not scanned (CI excludes base
 *     commits, and so does the stage);
 *   - the scanned range is `merge-base..head`, asserted by sha through the seam;
 *   - no workflow tracked, or `secretScan: "off"`, means no scan;
 *   - blocked, infrastructure and skipped outcomes map to a verdict, an
 *     infrastructure failure and a warning;
 *   - a base that cannot place the range is an infrastructure failure, and with
 *     no base at all the stage warns and goes on.
 *
 * The fake token is built at runtime, so this file holds no matchable secret.
 * Git calls go through the shared fixture helpers, which shut them away from the
 * host's config and hooks (Issue #5309). Australian English spelling throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { commitFile, gitOk } from "./support/git_repo_fixture.ts";
import {
  PrePushGateInfrastructureError,
  runPrePushGate,
} from "../lib/pre_push_gate.ts";
import type { GitleaksRangeOutcome } from "../lib/gitleaks_check.ts";
import { probe } from "../lib/semgrep_check.ts";

/** The workflow whose presence in the tracked files registers the stage. */
const WORKFLOW = ".github/workflows/gitleaks.yml";
const WORKFLOW_TEXT = "name: Gitleaks\non:\n  workflow_call: {}\n";

/** A token-shaped string built at runtime, so this file holds no matchable secret. */
const FAKE_TOKEN = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(
  "",
);

const ZERO_SHA = "0".repeat(40);

/** Whether a gitleaks binary runs on this host. Probed once, at load. */
const gitleaksAvailable = (await probe("gitleaks", ["version"])) !== null;

/** The seam's signature: the pre-push gate's `secretScan` option. */
type Scan = (
  cwd: string,
  base: string,
  head: string,
) => Promise<GitleaksRangeOutcome>;

/** A scan seam that records each `[cwd, base, head]` and answers `outcome`. */
function recordingScan(outcome: GitleaksRangeOutcome = {
  kind: "passed",
  summary: "gitleaks: PASSED (fake)",
}): { calls: string[][]; scan: Scan } {
  const calls: string[][] = [];
  return {
    calls,
    scan: (cwd, base, head) => {
      calls.push([cwd, base, head]);
      return Promise.resolve(outcome);
    },
  };
}

/** Run `fn` and capture the lines it writes with console.warn. */
async function captureWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

/** A push of `local` over `remote` on the `feature` branch, as git's hook reads it. */
function pushStdin(local: string, remote: string = ZERO_SHA): string {
  return `refs/heads/feature ${local} refs/heads/feature ${remote}\n`;
}

/** A temporary repository on `main` with an identity, removed by `cleanup`. */
async function makeRepo(): Promise<{
  repo: string;
  cleanup: () => Promise<void>;
}> {
  const root = await Deno.makeTempDir({ prefix: "pre-push-5430-" });
  const repo = `${root}/repo`;
  await gitOk(["init", "-q", "-b", "main", repo], root);
  await gitOk(["config", "user.email", "t@example.com"], repo);
  await gitOk(["config", "user.name", "Test"], repo);
  return {
    repo,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

/** Commit the gitleaks workflow on the current branch, as the repository tracks it. */
async function commitWorkflow(repo: string): Promise<string> {
  await Deno.mkdir(`${repo}/.github/workflows`, { recursive: true });
  return await commitFile(repo, WORKFLOW, WORKFLOW_TEXT, "add gitleaks.yml");
}

/**
 * The merge-base fixture: `main` holds the base commit `m1` (the workflow when
 * `withWorkflow`), `feature` branches there with `f1`, and `main` then moves
 * on to `m2`, which `origin/main` names. The merge-base of `origin/main` and
 * `f1` is therefore `m1`, not the tip of `origin/main`.
 */
async function mergeBaseFixture(
  repo: string,
  withWorkflow: boolean,
): Promise<{ m1: string; f1: string }> {
  const m1 = withWorkflow
    ? await commitWorkflow(repo)
    : await commitFile(repo, "README.md", "base\n", "base");
  await gitOk(["checkout", "-q", "-b", "feature"], repo);
  const f1 = await commitFile(repo, "feature.txt", "feature\n", "feature");
  await gitOk(["checkout", "-q", "main"], repo);
  const m2 = await commitFile(repo, "main.txt", "moved on\n", "main moves on");
  await gitOk(["update-ref", "refs/remotes/origin/main", m2], repo);
  return { m1, f1 };
}

Deno.test({
  name:
    "pre-push gate - real gitleaks refuses a push whose PR range holds a fake token an earlier pushed commit added (skipped where gitleaks is not installed)",
  ignore: !gitleaksAvailable,
  fn: async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      const base = await commitWorkflow(repo);
      await gitOk(
        ["update-ref", "refs/remotes/origin/milestone/x", base],
        repo,
      );
      await gitOk(["checkout", "-q", "-b", "feature"], repo);
      // A is already on the remote; only B is the push. The leak sits in A,
      // so only a scan of the whole PR range (not the unpushed commits) finds it.
      const leaked = await commitFile(
        repo,
        "notes.txt",
        `token = "${FAKE_TOKEN}"\n`,
        "feature: add a note",
      );
      await gitOk(["update-ref", "refs/remotes/origin/feature", leaked], repo);
      const clean = await commitFile(
        repo,
        "clean.txt",
        "clean\n",
        "feature: a clean follow-up",
      );

      const result = await runPrePushGate({
        cwd: repo,
        stdin: pushStdin(clean, leaked),
        preFlightCommands: [],
        baselineBranch: "milestone/x",
      });

      assert(!result.ok, "a range holding a fake token must be refused");
      assert(
        !(result.error instanceof PrePushGateInfrastructureError),
        `a finding is a verdict, not an infrastructure fault: ${result.error.message}`,
      );
      assertStringIncludes(result.error.message, "github-pat");
      assert(
        !result.error.message.includes(FAKE_TOKEN),
        "the raw token must not reach the gate's error",
      );
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  name:
    "pre-push gate - real gitleaks passes a clean push when the base branch already holds a fake token (skipped where gitleaks is not installed)",
  ignore: !gitleaksAvailable,
  fn: async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      // The token is committed on the base before the fork, so it is reachable
      // from origin/milestone/x. CI's base..head range excludes it, and so must
      // the stage. The workflow is tracked, so the stage runs.
      await commitWorkflow(repo);
      const baseTip = await commitFile(
        repo,
        "old.txt",
        `token = "${FAKE_TOKEN}"\n`,
        "base: an old token",
      );
      await gitOk(
        ["update-ref", "refs/remotes/origin/milestone/x", baseTip],
        repo,
      );
      await gitOk(["checkout", "-q", "-b", "feature"], repo);
      const clean = await commitFile(repo, "clean.txt", "clean\n", "feature");

      const result = await runPrePushGate({
        cwd: repo,
        stdin: pushStdin(clean),
        preFlightCommands: [],
        baselineBranch: "milestone/x",
      });

      assert(result.ok, result.ok ? "" : result.error.message);
      assertEquals(
        result.value.checksRun.includes(
          `gitleaks (${baseTip.slice(0, 12)}..${clean.slice(0, 12)})`,
        ),
        true,
        `checksRun: ${JSON.stringify(result.value.checksRun)}`,
      );
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  name:
    "pre-push gate - real gitleaks is not run when secretScan is off, even with the workflow tracked and a fake token pushed (skipped where gitleaks is not installed)",
  ignore: !gitleaksAvailable,
  fn: async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      const base = await commitWorkflow(repo);
      await gitOk(["checkout", "-q", "-b", "feature"], repo);
      const leaked = await commitFile(
        repo,
        "notes.txt",
        `token = "${FAKE_TOKEN}"\n`,
        "feature: add a note",
      );

      const result = await runPrePushGate({
        cwd: repo,
        stdin: pushStdin(leaked),
        preFlightCommands: [],
        baseRef: base,
        secretScan: "off",
      });

      assert(result.ok, result.ok ? "" : result.error.message);
      assertEquals(
        result.value.checksRun.some((entry) => entry.startsWith("gitleaks")),
        false,
      );
    } finally {
      await cleanup();
    }
  },
});

Deno.test("pre-push gate - the seam receives the merge-base and the pushed head, exactly", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const { m1, f1 } = await mergeBaseFixture(repo, true);
    const seam = recordingScan();

    const result = await runPrePushGate({
      cwd: repo,
      stdin: pushStdin(f1),
      preFlightCommands: [],
      baseRef: "origin/main",
      secretScan: seam.scan,
    });

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(seam.calls, [[repo, m1, f1]]);
    assertEquals(
      result.value.checksRun.includes(
        `gitleaks (${m1.slice(0, 12)}..${f1.slice(0, 12)})`,
      ),
      true,
      `checksRun: ${JSON.stringify(result.value.checksRun)}`,
    );
  } finally {
    await cleanup();
  }
});

Deno.test("pre-push gate - without a tracked gitleaks workflow the stage never scans", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const { f1 } = await mergeBaseFixture(repo, false);
    const seam = recordingScan();

    const result = await runPrePushGate({
      cwd: repo,
      stdin: pushStdin(f1),
      preFlightCommands: [],
      baseRef: "origin/main",
      secretScan: seam.scan,
    });

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(seam.calls, []);
    assertEquals(
      result.value.checksRun.some((entry) => entry.startsWith("gitleaks (")),
      false,
    );
  } finally {
    await cleanup();
  }
});

Deno.test("pre-push gate - a blocked scan is a verdict carrying the scan's message", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const { f1 } = await mergeBaseFixture(repo, true);
    const message =
      "gitleaks: FAILED (leaks found in commit range fake, gitleaks 8.30.1)\n\nRuleID: github-pat";

    const result = await runPrePushGate({
      cwd: repo,
      stdin: pushStdin(f1),
      preFlightCommands: [],
      baseRef: "origin/main",
      secretScan: recordingScan({ kind: "blocked", message }).scan,
    });

    assert(!result.ok, "a blocked scan must refuse the push");
    assert(
      !(result.error instanceof PrePushGateInfrastructureError),
      "a finding is a verdict, not an infrastructure fault",
    );
    assertEquals(result.error.message, message);
  } finally {
    await cleanup();
  }
});

Deno.test("pre-push gate - an infrastructure scan outcome is an infrastructure failure carrying its message", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const { f1 } = await mergeBaseFixture(repo, true);
    const message =
      "gitleaks: scan of commit range fake exceeded the 300s local deadline — an infrastructure fault, not a finding";

    const result = await runPrePushGate({
      cwd: repo,
      stdin: pushStdin(f1),
      preFlightCommands: [],
      baseRef: "origin/main",
      secretScan: recordingScan({ kind: "infrastructure", message }).scan,
    });

    assert(!result.ok, "an infrastructure scan must fail the push");
    assert(
      result.error instanceof PrePushGateInfrastructureError,
      `expected an infrastructure failure: ${result.error.message}`,
    );
    assertEquals(result.error.message, message);
  } finally {
    await cleanup();
  }
});

Deno.test("pre-push gate - a skipped scan warns, passes and records no gitleaks check", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const { f1 } = await mergeBaseFixture(repo, true);
    const message =
      "gitleaks: SKIPPED (gitleaks is not installed — install gitleaks 8.30.1)";

    const { value: result, warnings } = await captureWarnings(() =>
      runPrePushGate({
        cwd: repo,
        stdin: pushStdin(f1),
        preFlightCommands: [],
        baseRef: "origin/main",
        secretScan: recordingScan({ kind: "skipped", message }).scan,
      })
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(
      result.value.checksRun.some((entry) => entry.startsWith("gitleaks (")),
      false,
    );
    assertEquals(warnings, [`[PRE_PUSH_WARNING] ${message}`]);
  } finally {
    await cleanup();
  }
});

Deno.test("pre-push gate - a base that cannot place the range is an infrastructure failure, and nothing is scanned", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const { f1 } = await mergeBaseFixture(repo, true);
    const seam = recordingScan();

    // `origin/nosuch` has no remote-tracking ref, so no merge-base can be found.
    const result = await runPrePushGate({
      cwd: repo,
      stdin: pushStdin(f1),
      preFlightCommands: [],
      baselineBranch: "nosuch",
      secretScan: seam.scan,
    });

    assert(!result.ok, "an unplaceable range must fail the push");
    assert(
      result.error instanceof PrePushGateInfrastructureError,
      `expected an infrastructure failure: ${result.error.message}`,
    );
    assertStringIncludes(result.error.message, "merge-base of origin/nosuch");
    assertStringIncludes(result.error.message, "never scanned");
    assertEquals(seam.calls, []);
  } finally {
    await cleanup();
  }
});

Deno.test("pre-push gate - with no base and no unpushed commit to place the range, it warns and passes unscanned", async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    const base = await commitWorkflow(repo);
    await gitOk(["checkout", "-q", "-b", "feature"], repo);
    const pushed = await commitFile(repo, "clean.txt", "clean\n", "feature");
    // The branch is already on the remote, so nothing is unpushed.
    await gitOk(["update-ref", "refs/remotes/origin/feature", pushed], repo);
    const seam = recordingScan();

    const { value: result, warnings } = await captureWarnings(() =>
      runPrePushGate({
        cwd: repo,
        stdin: pushStdin(pushed, base),
        preFlightCommands: [],
        secretScan: seam.scan,
      })
    );

    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(seam.calls, []);
    assertEquals(
      warnings.some((line) =>
        line.startsWith("[PRE_PUSH_WARNING] gitleaks: no PR base is known")
      ),
      true,
      `warnings: ${JSON.stringify(warnings)}`,
    );
  } finally {
    await cleanup();
  }
});
