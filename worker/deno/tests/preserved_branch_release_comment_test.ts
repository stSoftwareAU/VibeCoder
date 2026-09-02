/**
 * The claim-release comment names the branch the work was preserved on
 * (Issue #770, part of #764).
 *
 * "WIP preserved" told a reader that work survived but not *where*: finding it
 * meant running `ls-remote` and pattern-matching `issue-<N>-*`, which is what
 * `git_issue_branch_resume.ts` does internally and what a human — or a Codex
 * worker that cannot read a Claude session id — had to reinvent.
 *
 * The load-bearing assertion is not "a branch is named" but "the branch named
 * is the branch the push actually targeted": a comment confidently naming a
 * title-derived branch that was never pushed is worse than the old vague
 * wording, because it sends a reader to a dead ref. Retitling #211 between two
 * claims orphaned a 20-file WIP commit exactly that way.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createBranchName } from "../lib/git_branch.ts";
import { deriveRunOutcome, type RunOutcome } from "../lib/run_outcome.ts";
import { renderRunOutcomeClause } from "../lib/heartbeat_storage.ts";
import {
  detectFailureCategory,
  getFailureDiagnosis,
  getFailureDiagnosisOneliner,
} from "../lib/failure_diagnosis.ts";
import { handoverFilePath } from "../lib/preserved_wip_branch.ts";
import { WIP_PRESERVED_RELEASE_MARKER } from "../lib/wip_markers.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";

/** The issue was retitled after the first claim parked its work. */
const ISSUE = 770;
const NEW_TITLE = "Now called something else entirely";
/** The branch setup resumed — the one every push in this run targets. */
const RESUMED_BRANCH = "issue-770-name-the-preserved-branch-in-the-release-c";
/** What the CURRENT title would derive — a branch nothing ever pushed. */
const TITLE_BRANCH = createBranchName(ISSUE, NEW_TITLE);

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: ISSUE,
    issueTitle: NEW_TITLE,
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(): PhaseState {
  return {
    // Setup rewrites this to the resumed branch on a re-claim
    // (setup_branch_phase.ts) — the state the execute phase sees.
    branchName: RESUMED_BRANCH,
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

interface Stop {
  /** How the run was stopped. */
  kind: "timeout" | "hard-cap" | "cycle-ended";
  /** Whether a handover file (Issue #769) is committed on the branch. */
  handover?: boolean;
}

interface RunRecord {
  status: string;
  reason: string;
  /** Branch/message pairs the preservation push targeted. */
  commits: Array<{ branch: string; message: string }>;
  state: PhaseState;
}

/** Drive the execute phase to a stop with a dirty tree to preserve. */
async function runStoppedRun(stop: Stop): Promise<RunRecord> {
  const commits: Array<{ branch: string; message: string }> = [];
  const runnerValue: Record<string, unknown> = stop.kind === "cycle-ended"
    ? {
      output: "halfway through the refactor",
      exitCode: 143,
      rawExitCode: 143,
      timedOut: false,
      terminated: true,
    }
    : {
      output: "wiring the production side; tests next",
      exitCode: 124,
      rawExitCode: 143,
      timedOut: true,
      timeoutReason: "hard-timeout",
      ...(stop.kind === "hard-cap" ? { scheduledRelease: "hard-cap" } : {}),
    };

  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({ ok: true, value: runnerValue })) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({
          ok: false,
          error: new Error("No PR found"),
        })) as never,
    },
    git: {
      runGitCommand: ((args: string[]) => {
        const ok = (stdout: string) =>
          Promise.resolve({ ok: true, value: { code: 0, stdout, stderr: "" } });
        if (args[0] === "status") {
          return ok(" M worker/deno/lib/a.ts\n?? b.ts\n");
        }
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return ok(RESUMED_BRANCH);
        }
        // The handover-file lookup asks what is in the branch's tree.
        if (args[0] === "ls-tree") {
          return ok(stop.handover ? handoverFilePath(ISSUE) : "");
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

  const config: WorkerConfig = {
    ...buildDefaultWorkerConfig(),
    infraRetryBackoffMs: 10,
  };
  const state = makeState();
  const result = await workOnIssueExecuteClaude(
    makeContext(config),
    state,
    deps,
  ) as { status: string; reason?: string };
  return {
    status: result.status,
    reason: result.reason ?? "",
    commits,
    state,
  };
}

/** The release comment a human reads, built from the phase's reason. */
function releaseComment(run: RunRecord): string {
  const outcome: RunOutcome = deriveRunOutcome({
    success: false,
    phase: "execute",
    reason: run.reason,
    elapsedSeconds: 10_800,
    ...(run.state.preservedWip ? { preservedWip: run.state.preservedWip } : {}),
  });
  return renderRunOutcomeClause(outcome);
}

/**
 * Assert the comment names the branch the push actually targeted — and only
 * that branch.
 */
function assertNamesPushedBranch(run: RunRecord, comment: string): void {
  assertEquals(run.commits.length, 1, "the run preserved its work once");
  const pushedTo = run.commits[0]!.branch;
  assertEquals(pushedTo, RESUMED_BRANCH);
  assertEquals(run.state.preservedWip?.branch, pushedTo);
  assertStringIncludes(comment, pushedTo);
  assert(
    !comment.includes(TITLE_BRANCH),
    `the comment must never name the title-derived branch ${TITLE_BRANCH}: ${comment}`,
  );
  assertStringIncludes(comment, "holds the work in progress");
  assertStringIncludes(comment, "the next claim resumes from it");
}

Deno.test("release comment #770 - a timeout names the preserved branch", async () => {
  const run = await runStoppedRun({ kind: "timeout" });
  assertEquals(run.status, "failure");
  assertEquals(detectFailureCategory(run.reason), "timeout");
  const comment = releaseComment(run);
  assertStringIncludes(comment, "**Work in progress:**");
  assertNamesPushedBranch(run, comment);
});

Deno.test("release comment #770 - a hard-cap wind-down names the preserved branch", async () => {
  const run = await runStoppedRun({ kind: "hard-cap" });
  assertEquals(run.status, "failure");
  assertEquals(detectFailureCategory(run.reason), "scheduled_release");
  // The reason itself names the branch, not just the rendered comment: the
  // marker readers (resume state, category detection) see the same text.
  assertStringIncludes(run.reason, "Released on schedule:");
  assertStringIncludes(run.reason, "run hard cap");
  assertStringIncludes(run.reason, WIP_PRESERVED_RELEASE_MARKER);
  assertStringIncludes(run.reason, RESUMED_BRANCH);
  assertNamesPushedBranch(run, releaseComment(run));
});

Deno.test("release comment #770 - a scheduled release at cycle end names the preserved branch", async () => {
  const run = await runStoppedRun({ kind: "cycle-ended" });
  assertEquals(run.status, "failure");
  assertEquals(detectFailureCategory(run.reason), "scheduled_release");
  assertStringIncludes(run.reason, "the cycle ended");
  assertStringIncludes(run.reason, RESUMED_BRANCH);
  assertNamesPushedBranch(run, releaseComment(run));
});

Deno.test("release comment #770 - a scheduled release still never blames the clock", async () => {
  const run = await runStoppedRun({ kind: "hard-cap" });
  const category = detectFailureCategory(run.reason);
  for (
    const text of [
      run.reason,
      releaseComment(run),
      getFailureDiagnosis(category),
      getFailureDiagnosisOneliner(category),
    ]
  ) {
    assert(
      !text.includes("ran out of time"),
      `a scheduled release must never say the agent ran out of time: ${text}`,
    );
    assert(
      !text.includes("sub-issues"),
      `a scheduled release must never advise splitting the issue: ${text}`,
    );
  }
});

Deno.test("release comment #770 - the branch is named exactly once, without repeating the note", async () => {
  const run = await runStoppedRun({ kind: "hard-cap" });
  const occurrences = run.reason.split(RESUMED_BRANCH).length - 1;
  assertEquals(
    occurrences,
    1,
    `the reason must state where the work is once: ${run.reason}`,
  );
});

Deno.test("release comment #770 - the handover file is linked when one is committed on the branch (Issue #769)", async () => {
  const run = await runStoppedRun({ kind: "timeout", handover: true });
  const path = handoverFilePath(ISSUE);
  assertEquals(run.state.preservedWip?.handoverPath, path);
  const comment = releaseComment(run);
  assertNamesPushedBranch(run, comment);
  assertStringIncludes(comment, `Handover: [${path}]`);
  assertStringIncludes(
    comment,
    `https://github.com/stSoftwareAU/VibeCoder/blob/${RESUMED_BRANCH}/${path}`,
  );
});

Deno.test("release comment #770 - no handover file: the comment still names the branch and links nothing", async () => {
  const run = await runStoppedRun({ kind: "timeout", handover: false });
  assertEquals(run.state.preservedWip?.handoverPath, undefined);
  const comment = releaseComment(run);
  assertNamesPushedBranch(run, comment);
  assert(
    !comment.includes("Handover:"),
    `no handover file was written, so nothing may be advertised: ${comment}`,
  );
  assert(
    !comment.includes(".vibe/handover"),
    `a path nothing wrote must never appear: ${comment}`,
  );
});

Deno.test("release comment #770 - a failed handover lookup is logged, and the branch is still named", async () => {
  // A git fault is not the same answer as "no handover file": the comment
  // degrades to the branch alone, but the fault is stated rather than passed
  // off as a clean absence.
  const warnings: string[] = [];
  const commits: Array<{ branch: string }> = [];
  const deps = createMockDeps({
    logger: { warn: (message: string) => warnings.push(message) },
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: {
            output: "wiring the production side; tests next",
            exitCode: 124,
            rawExitCode: 143,
            timedOut: true,
            timeoutReason: "hard-timeout",
          },
        })) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({
          ok: false,
          error: new Error("No PR found"),
        })) as never,
    },
    git: {
      runGitCommand: ((args: string[]) => {
        const ok = (stdout: string, code = 0, stderr = "") =>
          Promise.resolve({ ok: true, value: { code, stdout, stderr } });
        if (args[0] === "status") {
          return ok(" M worker/deno/lib/a.ts\n?? b.ts\n");
        }
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return ok(RESUMED_BRANCH);
        }
        if (args[0] === "ls-tree") return ok("", 128, "fatal: not a tree");
        return ok("");
      }) as never,
      commitAndPushPending: ((branch: string) => {
        commits.push({ branch });
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
  const config: WorkerConfig = {
    ...buildDefaultWorkerConfig(),
    infraRetryBackoffMs: 10,
  };
  const state = makeState();
  await workOnIssueExecuteClaude(makeContext(config), state, deps);

  assertEquals(state.preservedWip?.branch, RESUMED_BRANCH);
  assertEquals(state.preservedWip?.handoverPath, undefined);
  assert(
    warnings.some((w) => w.includes("Could not look up the handover file")),
    `the failed lookup must be reported, not swallowed: ${
      warnings.join(" | ")
    }`,
  );
});

Deno.test("release comment #770 - a run that preserved nothing names no branch at all", async () => {
  // The default git mock reports a clean tree and no commits since the
  // execute start, so nothing was pushed. Naming a branch here would be the
  // dead-ref mistake this issue exists to avoid.
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: {
            output: "",
            exitCode: 124,
            rawExitCode: 143,
            timedOut: true,
            timeoutReason: "hard-timeout",
            scheduledRelease: "hard-cap",
          },
        })) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({
          ok: false,
          error: new Error("No PR found"),
        })) as never,
    },
  });
  const config: WorkerConfig = {
    ...buildDefaultWorkerConfig(),
    infraRetryBackoffMs: 10,
  };
  const state = makeState();
  const result = await workOnIssueExecuteClaude(
    makeContext(config),
    state,
    deps,
  ) as { status: string; reason?: string };

  assertEquals(result.status, "failure");
  assertEquals(state.preservedWip, undefined);
  const reason = result.reason ?? "";
  assert(
    !reason.includes(RESUMED_BRANCH) && !reason.includes(TITLE_BRANCH),
    `nothing was pushed, so no branch may be named: ${reason}`,
  );
  // The pre-#770 wording stands when there is nothing to point at.
  assertStringIncludes(reason, "WIP preserved, resumes next cycle");
});
