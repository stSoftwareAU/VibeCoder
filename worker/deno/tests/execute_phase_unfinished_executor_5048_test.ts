/**
 * Tests for the fleet execute phase when a split issue run stops with an
 * executor sub-agent still unfinished (Issue #5048).
 *
 * Before Issue #5048 the runner refused completion with a plain Error, which
 * the phase turned into `internal_error`: the run was filed as a worker crash
 * and the agent's uncommitted work was not preserved. The refusal is now a
 * typed `UnfinishedIssueExecutorError` carrying the invocation's result. The
 * phase preserves the work on the issue branch with a handover note and
 * releases the run as `interrupted`, following the turn-limit precedent
 * (Issue #4949). Completion and PR creation stay refused.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  EXECUTOR_UNFINISHED_HEADING,
  workOnIssueExecuteClaude,
} from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { handoverFilePath } from "../lib/preserved_wip_branch.ts";
import {
  UNFINISHED_ISSUE_EXECUTOR_MESSAGE,
  UnfinishedIssueExecutorError,
} from "../lib/issue_executor_enforcement.ts";
import { buildInterruptedWipCommitMessage } from "../lib/wip_checkpoint.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";

const ISSUE = 5048;
const BRANCH = "issue-5048-executor-unfinished";
const NOTE = handoverFilePath(ISSUE);
const DIRTY = "worker/deno/lib/parser.ts";
const COMMIT_SUBJECT =
  "wip: execute stopped with executor work unfinished after";

function makeConfig(): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 10 };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: ISSUE,
    issueTitle: "Preserve the work of a run with an executor unfinished",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(repoPath: string, claudeOutput = ""): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "assessed_clear",
    // The refused invocation never reached the success path that fills this.
    // State can still hold output from an earlier invocation.
    claudeOutput,
    executeStartTime: Date.now() - 1_800_000,
    executeStartHeadSha: "abc123",
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/** The result's category, or undefined for a result that carries none. */
function categoryOf(
  result: Awaited<ReturnType<typeof workOnIssueExecuteClaude>>,
) {
  return "category" in result ? result.category : undefined;
}

interface UnfinishedExecutorRun {
  result: Awaited<ReturnType<typeof workOnIssueExecuteClaude>>;
  /** How many times the agent was invoked (the infrastructure retry adds one). */
  invocations: number;
  /** Commit subjects `commitAndPushPending` was asked to preserve. */
  commits: string[];
  /** The handover note as it stood when the preserving commit was made. */
  noteAtCommit?: string;
}

/**
 * Drive one execute whose agent invocation fails with `error`, against a
 * real temporary clone, and report what the preserving commit would carry.
 */
async function runWithError(options: {
  error: Error;
  /** Files `git status --porcelain` reports as uncommitted; `[]` is clean. */
  dirty?: string[];
  /** Output already on the phase state, e.g. from an earlier invocation. */
  stateOutput?: string;
}): Promise<UnfinishedExecutorRun> {
  const repoPath = await Deno.makeTempDir({ prefix: "unfinished_5048_" });
  const commits: string[] = [];
  let noteAtCommit: string | undefined;
  let invocations = 0;
  try {
    await Deno.mkdir(`${repoPath}/.git`);
    const dirty = options.dirty ?? [DIRTY];
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() => {
          invocations++;
          return Promise.resolve({ ok: false, error: options.error });
        }) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: false, error: new Error("No PR") })) as never,
      },
      git: {
        runGitCommand: ((args: string[]) => {
          const ok = (stdout: string) =>
            Promise.resolve({
              ok: true,
              value: { code: 0, stdout, stderr: "" },
            });
          if (args[0] === "status") {
            return ok(
              dirty.map((f) =>
                ` M ${f}`
              ).join("\n"),
            );
          }
          if (args[0] === "rev-list" && args[1] === "--count") return ok("2\n");
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return ok("abc123\n");
          }
          if (args[0] === "log") {
            return ok("wip: earlier snapshot\nWIP checkpoint: snapshot\n");
          }
          if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
            return ok(`${BRANCH}\n`);
          }
          if (args[0] === "ls-tree") {
            const path = args[args.length - 1];
            return ok(noteAtCommit === undefined ? "" : `${path}\n`);
          }
          return ok("");
        }) as never,
        commitAndPushPending: ((_branch: string, message: string) => {
          commits.push(message);
          // What `git add -A` would stage: the note as it stands now.
          try {
            noteAtCommit = Deno.readTextFileSync(`${repoPath}/${NOTE}`);
          } catch {
            noteAtCommit = undefined;
          }
          return Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: true,
              commitsPushed: 1,
              finalUnpushedCount: 0,
              finalUnpushedSource: "remote-head" as const,
            },
          });
        }) as never,
      },
    });
    const config = makeConfig();
    const result = await workOnIssueExecuteClaude(
      makeContext(config),
      makeState(repoPath, options.stateOutput),
      deps,
    );
    return { result, invocations, commits, noteAtCommit };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

Deno.test("execute_phase #5048 - an unfinished executor with a dirty tree is preserved and released as interrupted", async () => {
  const run = await runWithError({
    error: new UnfinishedIssueExecutorError(
      UNFINISHED_ISSUE_EXECUTOR_MESSAGE,
      { output: "editing the parser, waiting on the executor" } as never,
    ),
  });
  assertEquals(run.result.status, "failure");
  assertEquals(categoryOf(run.result), "interrupted");
  const reason = "reason" in run.result ? run.result.reason ?? "" : "";
  assertStringIncludes(reason, EXECUTOR_UNFINISHED_HEADING);
  assertStringIncludes(reason, "interrupted before completing");

  // The classification the phase returns is the one run-failure filing and
  // deriveRunOutcome use, so assert it on the result, not on a recomputation.
  const classification = "classification" in run.result
    ? run.result.classification
    : undefined;
  assert(classification !== undefined, "the phase returns its classification");
  assertEquals(classification?.failureClass, "interrupted");
  assertEquals(classification?.fixability, "not_code_fixable");

  assert(run.commits.length >= 1, "the dirty tree is preserved");
  for (const subject of run.commits) {
    assertStringIncludes(subject, COMMIT_SUBJECT);
  }
  assert(
    run.noteAtCommit,
    "the handover note must exist when the preserving commit runs",
  );
  assertStringIncludes(run.noteAtCommit, `# Handover — issue #${ISSUE}`);
  assertStringIncludes(
    run.noteAtCommit,
    "stopped with executor work unfinished",
  );
  assertStringIncludes(run.noteAtCommit, DIRTY);
  assertStringIncludes(reason, NOTE);
});

Deno.test("execute_phase #5048 - the bounded infrastructure retry resumes the unfinished run automatically", async () => {
  const run = await runWithError({
    error: new UnfinishedIssueExecutorError(
      UNFINISHED_ISSUE_EXECUTOR_MESSAGE,
    ),
    dirty: [],
  });
  assertEquals(
    run.invocations,
    2,
    "the interrupted result keeps the single bounded retry, which resumes the branch",
  );
  assertEquals(categoryOf(run.result), "interrupted");
});

Deno.test("execute_phase #5048 - a plain Error with the same message is still internal_error, not interrupted", async () => {
  const run = await runWithError({
    error: new Error(UNFINISHED_ISSUE_EXECUTOR_MESSAGE),
    dirty: [],
  });
  assertEquals(
    run.invocations,
    2,
    "an internal error keeps the bounded infrastructure retry",
  );
  assertEquals(categoryOf(run.result), "internal_error");
  const reason = "reason" in run.result ? run.result.reason ?? "" : "";
  assertStringIncludes(
    reason,
    `Claude execution failed: ${UNFINISHED_ISSUE_EXECUTOR_MESSAGE}`,
  );
});

Deno.test("execute_phase #5048 - the reason quotes the refused invocation's own output, not stale state", async () => {
  const current =
    "current invocation: an executor sub-agent is still editing the parser";
  const stale = "earlier invocation: credentials exhausted";
  const run = await runWithError({
    error: new UnfinishedIssueExecutorError(
      UNFINISHED_ISSUE_EXECUTOR_MESSAGE,
      { output: current } as never,
    ),
    stateOutput: stale,
  });
  assertEquals(categoryOf(run.result), "interrupted");
  const reason = "reason" in run.result ? run.result.reason ?? "" : "";
  assertStringIncludes(reason, current);
  assertEquals(reason.includes(stale), false);
});

Deno.test("buildInterruptedWipCommitMessage #5048 - an executor-unfinished stop has its own subject", () => {
  assertEquals(
    buildInterruptedWipCommitMessage({
      cause: "executor-unfinished",
      elapsedSeconds: 3600,
      dirtyFiles: 4,
    }),
    "wip: execute stopped with executor work unfinished after 3600s — preserving 4 uncommitted file(s)",
  );
});
