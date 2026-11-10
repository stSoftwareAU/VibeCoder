/**
 * Tests for the fleet execute phase when the Claude CLI stops a run at its
 * per-run turn cap (error_max_turns, Issue #3701).
 *
 * Before Issue #4949 every error from `runClaudeWithRetry` became
 * `internal_error`: the run was filed as a worker crash, the in-process
 * infrastructure retry re-billed the whole capped run, and the work was not
 * preserved. A turn-capped run is a policy stop, so it is preserved on the
 * issue branch with a handover note, released as `interrupted`, and not
 * retried in-process. Every other error keeps the bounded retry.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  TURN_LIMIT_HEADING,
  workOnIssueExecuteClaude,
} from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { handoverFilePath } from "../lib/preserved_wip_branch.ts";
import { AgentTurnLimitError } from "../lib/claude_turn_limit.ts";
import { buildInterruptedWipCommitMessage } from "../lib/wip_checkpoint.ts";
import { classifyRunFailure } from "../lib/run_outcome_classifier.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";

const ISSUE = 4949;
const BRANCH = "issue-4949-turn-limit";
const NOTE = handoverFilePath(ISSUE);
const DIRTY = "worker/deno/lib/parser.ts";
const TURN_LIMIT_MESSAGE =
  "The Claude CLI reached its per-run turn limit (error_max_turns) — evidence: error_max_turns";

function makeConfig(): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 10 };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: ISSUE,
    issueTitle: "Release the turn-capped run as interrupted",
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
    // The turn-capped invocation never reached the success path that fills
    // this, so the realistic state is empty here.
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

interface TurnLimitRun {
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
}): Promise<TurnLimitRun> {
  const repoPath = await Deno.makeTempDir({ prefix: "turn_limit_4949_" });
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

Deno.test("execute_phase #4949 - a turn-capped run with a clean tree is released as interrupted and not retried", async () => {
  const run = await runWithError({
    error: new AgentTurnLimitError(TURN_LIMIT_MESSAGE),
    dirty: [],
  });
  assertEquals(
    run.invocations,
    1,
    "a turn cap is a policy stop: the infrastructure retry must not re-bill it",
  );
  assertEquals(run.result.status, "failure");
  assertEquals(categoryOf(run.result), "interrupted");
  const reason = "reason" in run.result ? run.result.reason ?? "" : "";
  assertStringIncludes(reason, TURN_LIMIT_HEADING);
  assertStringIncludes(reason, "interrupted before completing");

  // The category was asserted to be `interrupted` above; the literal keeps
  // the classifier's parameter type narrow.
  const classification = classifyRunFailure("interrupted", reason, true);
  assertEquals(classification.fixability, "not_code_fixable");
  assertEquals(classification.failureClass, "interrupted");
});

Deno.test("execute_phase #4949 - a turn-capped run with uncommitted work preserves it and writes the handover note", async () => {
  const run = await runWithError({
    error: new AgentTurnLimitError(
      TURN_LIMIT_MESSAGE,
      // The invocation's own output lives on the error: the success path
      // that copies it into state never ran.
      { output: "editing the parser, running deno test" } as never,
    ),
  });
  assertEquals(run.invocations, 1);
  assertEquals(categoryOf(run.result), "interrupted");
  assertEquals(run.commits.length, 1, `commits: ${run.commits.join(" | ")}`);
  assertStringIncludes(
    run.commits[0] ?? "",
    "wip: execute hit the agent turn limit after",
  );
  assert(
    run.noteAtCommit,
    "the handover note must exist when the preserving commit runs",
  );
  assertStringIncludes(run.noteAtCommit, `# Handover — issue #${ISSUE}`);
  assertStringIncludes(run.noteAtCommit, "hit the agent turn limit");
  assertStringIncludes(run.noteAtCommit, DIRTY);
  const reason = "reason" in run.result ? run.result.reason ?? "" : "";
  assertStringIncludes(reason, TURN_LIMIT_HEADING);
  assertStringIncludes(reason, NOTE);
});

Deno.test("execute_phase #4949 - output already on the phase state is enough to inspect the tree when the error carries none", async () => {
  const run = await runWithError({
    error: new AgentTurnLimitError(TURN_LIMIT_MESSAGE),
    stateOutput: "output from an earlier invocation",
  });
  assertEquals(categoryOf(run.result), "interrupted");
  assertEquals(run.commits.length, 1, `commits: ${run.commits.join(" | ")}`);
  assertStringIncludes(
    run.commits[0] ?? "",
    "wip: execute hit the agent turn limit after",
  );
});

Deno.test("execute_phase #4949 - any other error keeps internal_error and the bounded infrastructure retry", async () => {
  const run = await runWithError({
    error: new Error("spawn failed"),
    dirty: [],
  });
  assertEquals(
    run.invocations,
    2,
    "a non-turn-limit error still gets the one bounded retry",
  );
  assertEquals(categoryOf(run.result), "internal_error");
  const reason = "reason" in run.result ? run.result.reason ?? "" : "";
  assertStringIncludes(reason, "Claude execution failed: spawn failed");
});

Deno.test("buildInterruptedWipCommitMessage #4949 - a turn-limit stop has its own subject", () => {
  assertEquals(
    buildInterruptedWipCommitMessage({
      cause: "turn-limit",
      elapsedSeconds: 3600,
      dirtyFiles: 4,
    }),
    "wip: execute hit the agent turn limit after 3600s — preserving 4 uncommitted file(s)",
  );
});
