/**
 * Regression tests for the timed-out execute phase's WIP guarantee and its
 * superseded-by-a-merged-PR stop (Issue #218).
 *
 * Observed live on worker-20260821-070344.log, slot s1, VibeCoder#185:
 *
 *  - 07:14 the run claimed the issue and resumed a branch carrying WIP;
 *  - 07:16 a sibling host opened PR #215 from the SAME branch, which merged;
 *  - 08:06 the run timed out after 3084 s with a dirty tree, and the
 *    "PR already exists despite timeout → continue" shortcut ran BEFORE the
 *    dirty-file count, so 51 minutes of uncommitted work was discarded;
 *  - the run then continued into completion, which failed "no commits ahead"
 *    and released as `no_pr:unknown:completion`, blaming the agent.
 *
 * The guarantee under test: an interrupted run preserves its work FIRST,
 * whatever PRs exist, and a merged/closed PR stops the run as `superseded`
 * rather than as an unknown failure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { describeRunOutcome, type RunOutcome } from "../lib/run_outcome.ts";
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";
import { WIP_PRESERVED_RELEASE_MARKER } from "../lib/wip_markers.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";

const BRANCH = "issue-185-forgeable-escape-hatch-resolution";
const PR_URL = "https://github.com/org/repo/pull/215";

function makeConfig(): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 10 };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 185,
    issueTitle: "Forgeable escape hatch",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

interface RunRecord {
  status: string;
  reason?: string;
  outcome?: RunOutcome;
  /** Branch/message pairs `commitAndPushPending` was asked to preserve. */
  commits: Array<{ branch: string; message: string }>;
}

/**
 * Drive the timed-out execute phase against a dirty working tree and an
 * existing PR in the given state.
 */
async function runTimedOutWith(
  options: { prState?: string; dirty: boolean; prUrl?: string | null },
): Promise<RunRecord> {
  const commits: Array<{ branch: string; message: string }> = [];
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: {
            output: "editing the parser, running deno test",
            exitCode: 124,
            rawExitCode: 143,
            timedOut: true,
            timeoutReason: "hard-timeout",
          },
        })) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve(
          options.prUrl === null
            ? { ok: false, error: new Error("No PR found") }
            : { ok: true, value: options.prUrl ?? PR_URL },
        )) as never,
    },
    github: {
      runGhCommand: ((args: string[]) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(
            JSON.stringify({
              state: options.prState ?? "MERGED",
              headRefName: BRANCH,
            }),
          );
        }
        return Promise.resolve("");
      }) as never,
    },
    git: {
      runGitCommand: ((args: string[]) => {
        const ok = (stdout: string) =>
          Promise.resolve({ ok: true, value: { code: 0, stdout, stderr: "" } });
        if (args[0] === "status") {
          return ok(options.dirty ? " M worker/deno/lib/a.ts\n?? b.ts\n" : "");
        }
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return ok(BRANCH);
        }
        return ok("");
      }) as never,
      commitAndPushPending: ((
        branch: string,
        message: string,
      ) => {
        commits.push({ branch, message });
        return Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: true,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        });
      }) as never,
    },
  });
  const config = makeConfig();
  const result = await workOnIssueExecuteClaude(
    makeContext(config),
    makeState(),
    deps,
  ) as RunRecord;
  return { ...result, commits };
}

Deno.test("execute_phase - a timed-out dirty tree is preserved even though a merged PR exists (Issue #218)", async () => {
  const run = await runTimedOutWith({ prState: "MERGED", dirty: true });

  // Acceptance 1: the WIP reached the claim-locked branch. Before #218 the
  // merged sibling PR short-circuited this entirely.
  assertEquals(run.commits.length, 1);
  assertEquals(run.commits[0]!.branch, BRANCH);
  assert(
    run.commits[0]!.message.startsWith("wip:"),
    `the preservation commit must be recognisable WIP: ${
      run.commits[0]!.message
    }`,
  );

  // Acceptance 2: the run stops as superseded, not as an unknown failure.
  assertEquals(run.status, "early_exit");
  assert(
    (run.reason ?? "").startsWith("superseded:pr#215"),
    `reason must name the superseding PR: ${run.reason}`,
  );
  assert(
    (run.reason ?? "").includes(WIP_PRESERVED_RELEASE_MARKER),
    `reason must report the preserved WIP: ${run.reason}`,
  );
  assertEquals(describeRunOutcome(run.outcome), "superseded:pr#215");
  assert(run.outcome?.kind === "superseded");
  assertEquals(run.outcome.prNumber, 215);
  assertEquals(run.outcome.prState, "MERGED");
});

Deno.test("execute_phase - a timed-out dirty tree is preserved when an OPEN PR exists, and the run continues (Issue #218)", async () => {
  const run = await runTimedOutWith({ prState: "OPEN", dirty: true });

  // An open PR still means work in flight — the #386 self-heal stands …
  assertEquals(run.status, "continue");
  // … but the work is safe first, which is what #218 changed.
  assertEquals(run.commits.length, 1);
  assertEquals(run.commits[0]!.branch, BRANCH);
});

Deno.test("execute_phase - a timed-out dirty tree with no PR still fails, with the WIP preserved (Issue #47)", async () => {
  const run = await runTimedOutWith({ prUrl: null, dirty: true });

  assertEquals(run.status, "failure");
  assertEquals(run.commits.length, 1);
  assert(
    (run.reason ?? "").includes(WIP_PRESERVED_RELEASE_MARKER),
    `reason must report the preserved WIP: ${run.reason}`,
  );
  // Still diagnosed as a timeout, so the existing cooldown/retry behaviour
  // is unchanged by the reordering.
  assertEquals(detectFailureCategory(run.reason ?? ""), "timeout");
});

Deno.test("execute_phase - a timed-out clean tree with a merged PR supersedes without inventing a WIP commit (Issue #218)", async () => {
  const run = await runTimedOutWith({ prState: "MERGED", dirty: false });

  assertEquals(run.commits.length, 0);
  assertEquals(run.status, "early_exit");
  assert((run.reason ?? "").startsWith("superseded:pr#215"), run.reason);
});
