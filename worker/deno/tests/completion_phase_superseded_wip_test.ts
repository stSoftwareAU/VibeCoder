/**
 * The completion phase's "no commits ahead" branch preserves the run's
 * uncommitted work and recognises a superseding PR (Issue #218).
 *
 * On VibeCoder#185 this branch fired with a dirty tree and reported
 * "uncommitted changes are present in the working tree, so Claude likely
 * modified files but did not commit them" — an accurate description of a
 * loss it then went ahead and caused. The branch was level with `main`
 * because a sibling host's PR #215 had merged mid-run, so the run was
 * released as `no_pr:unknown:completion` and the issue was labelled failed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { describeRunOutcome, type RunOutcome } from "../lib/run_outcome.ts";
import { WIP_PRESERVED_RELEASE_MARKER } from "../lib/wip_markers.ts";
import type { GitHubClient } from "../types.ts";

const BRANCH = "issue-185-forgeable-escape-hatch-resolution";
const PR_URL = "https://github.com/org/repo/pull/215";

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

interface CompletionRun {
  status: string;
  reason?: string;
  outcome?: RunOutcome;
  commits: Array<{ branch: string; message: string }>;
}

/**
 * Run the completion phase against a branch level with its base, a dirty
 * working tree, and an existing PR in the given state (or none).
 */
async function runCompletionLevelWithBase(
  options: { prState?: string; dirty: boolean; hasPr: boolean },
): Promise<CompletionRun> {
  const repoPath = await Deno.makeTempDir();
  const commits: Array<{ branch: string; message: string }> = [];
  const config = buildDefaultWorkerConfig();
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 185,
    issueTitle: "Forgeable escape hatch",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "vibe-worker",
    config,
  };
  const state: PhaseState = {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "the agent did plenty, none of it committed",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => stubClient(),
      runGhCommand: ((args: string[]) => {
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(
            JSON.stringify({
              state: options.prState ?? "MERGED",
              headRefName: BRANCH,
            }),
          );
        }
        return Promise.resolve(PR_URL);
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve(
          options.hasPr
            ? { ok: true, value: PR_URL }
            : { ok: false, error: new Error("No PR found") },
        )) as never,
    },
    git: {
      runGitCommand: ((args: string[]) => {
        const ok = (stdout: string) =>
          Promise.resolve({ ok: true, value: { code: 0, stdout, stderr: "" } });
        // The branch is level with its base — the #185 shape.
        if (args[0] === "rev-list") return ok("0\n");
        if (args[0] === "status") {
          return ok(options.dirty ? " M worker/deno/lib/a.ts\n?? b.ts\n" : "");
        }
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return ok(BRANCH);
        }
        return ok("");
      }) as never,
      commitAndPushPending: ((branch: string, message: string) => {
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

  const result = await workOnIssueCompletion(ctx, state, deps) as CompletionRun;
  return { ...result, commits };
}

Deno.test("completion_phase - a dirty tree with no commits ahead is preserved, not just described (Issue #218)", async () => {
  const run = await runCompletionLevelWithBase({ dirty: true, hasPr: false });

  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason ?? "", "no commits ahead");
  // The work is on the branch, and the message says so instead of blaming
  // the agent for "not committing".
  assertEquals(run.commits.length, 1);
  assertEquals(run.commits[0]!.branch, BRANCH);
  assert(
    run.commits[0]!.message.startsWith("wip:"),
    `preservation must be recognisable WIP: ${run.commits[0]!.message}`,
  );
  assertStringIncludes(run.reason ?? "", WIP_PRESERVED_RELEASE_MARKER);
});

Deno.test("completion_phase - a branch level with base because a merged PR resolved the issue releases as superseded (Issue #218)", async () => {
  const run = await runCompletionLevelWithBase({
    dirty: true,
    hasPr: true,
    prState: "MERGED",
  });

  assertEquals(run.status, "early_exit");
  assert(
    (run.reason ?? "").startsWith("superseded:pr#215"),
    `reason must name the superseding PR: ${run.reason}`,
  );
  assertEquals(describeRunOutcome(run.outcome), "superseded:pr#215");
  assert(run.outcome?.kind === "superseded");
  assertEquals(run.outcome.phase, "completion");
  // The work still reached the branch before the run stopped.
  assertEquals(run.commits.length, 1);
});

Deno.test("completion_phase - a clean tree with no commits ahead and no PR fails as before (Issue #218)", async () => {
  const run = await runCompletionLevelWithBase({ dirty: false, hasPr: false });

  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason ?? "", "no commits ahead");
  assertEquals(run.commits.length, 0, "nothing to preserve, nothing committed");
});
