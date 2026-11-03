/**
 * The completion recovery turns (summary-rule, screenshot, PR-body-length)
 * commit and push the issue branch before completion's own gate runs. Each must
 * pass the repository's checks first, so a failed or unavailable gate leaves
 * origin unmoved (Issue #4625).
 */
import { assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../lib/issue_worker_types.ts";
import { recoverFromSummaryRuleBlock } from "../lib/summary_rule_gate_retry.ts";
import { recoverFromScreenshotGateBlock } from "../lib/screenshot_gate_retry.ts";
import { recoverFromPrBodyLength } from "../lib/pr_body_length.ts";
import { commitAndPushPending } from "../lib/git_push.ts";
import { reconcileHeadToBranch } from "../lib/git_branch.ts";
import type { validateRepositoryForPublication } from "../lib/publication_validation.ts";

async function gitIn(cwd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_CONFIG_COUNT: "0",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).output();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

type Verdict = "failed" | "unavailable" | "passed";
type Recovery = "summary" | "screenshot" | "pr-body";

async function runRecovery(
  recovery: Recovery,
  verdict: Verdict,
): Promise<{ moved: boolean; pushAttempted: boolean }> {
  const root = await Deno.makeTempDir({ prefix: "recovery-guard-" });
  try {
    const branch = "issue-4625";
    const upstream = `${root}/upstream.git`;
    const seed = `${root}/seed`;
    const work = `${root}/work`;
    await gitIn(root, ["init", "--bare", "-q", "-b", "main", upstream]);
    await gitIn(root, ["clone", "-q", upstream, seed]);
    await Deno.writeTextFile(`${seed}/README.md`, "seed\n");
    await gitIn(seed, ["add", "README.md"]);
    await gitIn(seed, ["commit", "-q", "-m", "seed"]);
    await gitIn(seed, ["push", "-q", "origin", "main"]);
    await gitIn(root, ["clone", "-q", upstream, work]);
    await gitIn(work, ["checkout", "-q", "-b", branch]);
    await gitIn(work, ["push", "-q", "-u", "origin", branch]);
    const remoteHead = async () =>
      (await gitIn(work, ["ls-remote", "origin", `refs/heads/${branch}`]))
        .trim();
    const before = await remoteHead();

    const config = buildDefaultWorkerConfig();
    config.workDir = `${root}/state`;
    const ctx: IssueContext = {
      repo: "acme/widgets",
      issueNumber: 4625,
      issueTitle: "Recovery guard",
      issueBody: "",
      issueLabels: [],
      issueComments: "",
      githubUser: "testbot",
      config,
    };
    const state: PhaseState = {
      branchName: branch,
      baseBranch: "main",
      defaultBranch: "main",
      repoPath: work,
      clarityStatus: "not_assessed",
      claudeOutput: "done",
      executeStartTime: Date.now(),
      baselineQualityPassed: true,
      baselineQualityOutput: "",
      baselineFailedChecks: [],
      summaryRuleBlocks: [{ reason: "summary incomplete", comment: "Fix it." }],
      screenshotGateBlock: { failureMessage: "Capture evidence." },
      prBodyLengthBlock: { prompt: "Shorten it." },
    };
    let pushAttempted = false;
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: async () => {
          // The recovery turn leaves its work uncommitted in the checkout.
          await Deno.writeTextFile(`${work}/recovered.md`, "recovered\n");
          return {
            ok: true as const,
            value: { exitCode: 0, output: "done", timedOut: false },
          };
        },
      },
      git: {
        reconcileHeadToBranch,
        commitAndPushPending: ((
          ...args: Parameters<
            typeof commitAndPushPending
          >
        ) => {
          pushAttempted = true;
          return commitAndPushPending(...args);
        }) as typeof commitAndPushPending,
        validatePublication: (() =>
          Promise.resolve(
            verdict === "failed"
              ? { status: "failed", head: null, output: "GATE OUTPUT" }
              : verdict === "unavailable"
              ? { status: "unavailable", head: null, reason: "docker is down" }
              : { status: "passed", head: "0".repeat(40), gate: "ran" },
          )) as unknown as typeof validateRepositoryForPublication,
      },
    });
    const rerun = (): Promise<PhaseResult> =>
      Promise.resolve({
        status: "failure",
        category: "unknown",
        reason: "rerun",
      });
    if (recovery === "summary") {
      await recoverFromSummaryRuleBlock(ctx, state, deps, {
        status: "failure",
        category: "summary_incomplete",
        reason: "summary incomplete",
      }, rerun);
    } else if (recovery === "screenshot") {
      await recoverFromScreenshotGateBlock(ctx, state, deps, rerun);
    } else {
      await recoverFromPrBodyLength(ctx, state, deps, rerun);
    }
    return { moved: (await remoteHead()) !== before, pushAttempted };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

for (const recovery of ["summary", "screenshot", "pr-body"] as const) {
  for (const verdict of ["failed", "unavailable"] as const) {
    Deno.test(`${recovery} recovery turn - a ${verdict} repository gate leaves origin unmoved (Issue #4625)`, async () => {
      const result = await runRecovery(recovery, verdict);
      assertEquals(result.pushAttempted, true, "the recovery turn pushed");
      assertEquals(result.moved, false);
    });
  }
  Deno.test(`${recovery} recovery turn - a passing repository gate publishes the recovered work (Issue #4625)`, async () => {
    const result = await runRecovery(recovery, "passed");
    assertEquals(result.moved, true);
  });
}
