/**
 * The completion phase refuses to raise a PR from an earlier run's WIP
 * commits alone (Issue #148, follow-up to #47).
 *
 * A timed-out execute now preserves its dirty tree as a `wip:` commit on the
 * claim-locked issue branch. That commit makes the branch "ahead of base", so
 * the next claim — even one that adds nothing — used to sail past the
 * ahead-of-base guard and raise a half-done PR from work nobody finished.
 * The resume must advance the branch first.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { GitHubClient } from "../types.ts";
import { WIP_CHECKPOINT_COMMIT_MESSAGE } from "../lib/wip_checkpoint.ts";

const BRANCH = "issue-148-preserve-wip";
const WIP_TIP = "1111111111111111111111111111111111111111";
const REAL_TIP = "2222222222222222222222222222222222222222";
const TIMED_OUT_WIP =
  "wip: execute timed out after 1800s at the cycle deadline — preserving 6 " +
  "uncommitted file(s) (Issue #47)";

function stubClient(): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

/**
 * Run the completion phase over a branch whose commit log is `commits`
 * (newest first, `[sha, subject]` pairs) with `executeStartHeadSha` set to
 * `startSha` (omitted when undefined).
 */
async function runCompletion(options: {
  commits: Array<[string, string]>;
  startSha?: string;
}): Promise<{ status: string; reason: string; prCreated: boolean }> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-148.md`,
    "## Summary\n\nPreserve the WIP. Closes #148.\n",
  );
  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 148,
    issueTitle: "Preserve a timed-out run's WIP",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    ...(options.startSha ? { executeStartHeadSha: options.startSha } : {}),
  };
  let prCreated = false;
  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => stubClient(),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") prCreated = true;
        return Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/pull/1",
        );
      },
    },
    git: {
      reconcileHeadToBranch: () =>
        Promise.resolve({
          ok: true as const,
          value: { action: "already-on-branch" as const, fromRef: BRANCH },
        }),
      pushUnpushedCommits: () =>
        Promise.resolve({ ok: true as const, value: 1 }),
      runGitCommand: (args: string[]) => {
        let stdout = "";
        if (args[0] === "rev-list" && args[1] === "--count") {
          stdout = `${options.commits.length}\n`;
        } else if (args[0] === "log" && args[1] === "--format=%H%x09%s") {
          stdout = options.commits.map(([sha, subject]) =>
            `${sha}\t${subject}`
          ).join("\n") + "\n";
        }
        return Promise.resolve({
          ok: true as const,
          value: { code: 0, stdout, stderr: "" },
        });
      },
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });
  return {
    status: result.status,
    reason: "reason" in result ? result.reason : "",
    prCreated,
  };
}

Deno.test(
  "completion - refuses a PR when the branch carries only WIP commits and this run added nothing (Issue #148)",
  async () => {
    const outcome = await runCompletion({
      commits: [[WIP_TIP, TIMED_OUT_WIP]],
      startSha: WIP_TIP,
    });

    assertEquals(outcome.status, "failure");
    assertStringIncludes(outcome.reason, "WIP");
    assertStringIncludes(outcome.reason, BRANCH);
    assertEquals(
      outcome.prCreated,
      false,
      "gh pr create MUST NOT run for a branch holding only an earlier run's WIP commits",
    );
  },
);

Deno.test(
  "completion - raises the PR when this run advanced the branch, even if every commit is a checkpoint (Issue #148)",
  async () => {
    // The agent finished the work but left it to the phase-end checkpoint to
    // commit: the branch tip moved during this run, so the work is real.
    const outcome = await runCompletion({
      commits: [
        [REAL_TIP, WIP_CHECKPOINT_COMMIT_MESSAGE],
        [WIP_TIP, TIMED_OUT_WIP],
      ],
      startSha: WIP_TIP,
    });

    assertEquals(outcome.status, "continue", outcome.reason);
    assertEquals(outcome.prCreated, true);
  },
);

Deno.test(
  "completion - raises the PR for pre-existing real commits an earlier run left behind (Issue #148)",
  async () => {
    // Nothing new this run, but the branch holds a genuine commit — that work
    // deserves its PR; only WIP-only branches are half-done.
    const outcome = await runCompletion({
      commits: [
        [WIP_TIP, "Add the claim-runway floor (Issue #47)"],
        ["3333333333333333333333333333333333333333", TIMED_OUT_WIP],
      ],
      startSha: WIP_TIP,
    });

    assertEquals(outcome.status, "continue", outcome.reason);
    assertEquals(outcome.prCreated, true);
  },
);

Deno.test(
  "completion - the WIP-only gate fails open when the pre-execute HEAD is unknown (Issue #148)",
  async () => {
    // No `executeStartHeadSha` (Claude never ran, or the capture failed): the
    // gate cannot tell whether the run advanced the branch, so it must not
    // block a PR on a guess.
    const outcome = await runCompletion({
      commits: [[WIP_TIP, TIMED_OUT_WIP]],
    });

    assertEquals(outcome.status, "continue", outcome.reason);
    assertEquals(outcome.prCreated, true);
  },
);
