/**
 * Checkpointing an exhausted execute run, then switching credential or
 * parking the work (Issue #1670, part of #1653).
 *
 * A usage-limit result used to fail the phase outright: nothing was pushed,
 * no resume pointer was written, and the release comment told a reader only
 * that agent work was "paused". The order pinned here is the whole point —
 * the WIP commit and the resume pointer are durable BEFORE any further
 * invocation, so a switch that fails, a park, or a host that dies while the
 * window is shut all leave the work findable on the issue branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { handoverFilePath } from "../lib/preserved_wip_branch.ts";
import { loadResumeState } from "../lib/resume_state_store.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";

const REPO = "org/repo";
const ISSUE = 1670;
const BRANCH = "issue-1670-checkpoint-an-exhausted-run";
const NOTE = handoverFilePath(ISSUE);

/** The runner gave up on the subscription's five-hour window. */
const USAGE_LIMIT = {
  output: "edited the parser, ran deno test",
  exitCode: 2,
  timedOut: false,
  usageLimit: { waitSeconds: 3600, resetEpochMs: 1_800_000_000_000 },
};

/** The same, from a pre-spawn gate that found nothing eligible (#1669). */
const NO_ELIGIBLE_CREDENTIAL = {
  output: "",
  exitCode: 2,
  timedOut: false,
  usageLimit: { waitSeconds: 3600, resetEpochMs: 1_800_000_000_000 },
  noEligibleCredential: true,
};

/** The switched-to credential carried the session to completion. */
const SUCCESS = {
  output: "implemented the change and committed it",
  exitCode: 0,
  timedOut: false,
};

interface UsageLimitRun {
  /** Every event, in the order it happened. */
  calls: string[];
  /** Commit subjects `commitAndPushPending` was asked to preserve. */
  commits: string[];
  /** The handover note as it stood when the preserving commit ran. */
  noteAtCommit?: string;
  status: string;
  reason: string;
  /** Where the phase recorded the work as preserved (Issue #770). */
  preservedBranch?: string;
  /** The resume pointer left on disk for the next claim. */
  resumeBranch?: string;
  resumeSessionId?: string;
}

function makeConfig(workDir: string): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    workDir,
    infraRetryBackoffMs: 10,
    enableSessionResume: true,
  };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Checkpoint an exhausted run",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(repoPath: string): PhaseState {
  return {
    branchName: BRANCH,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    executeStartHeadSha: "abc123",
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/** One event from a run's log, or "" when the run stopped short of it. */
function at(run: UsageLimitRun, index: number): string {
  return run.calls[index] ?? "";
}

/**
 * Drive one execute phase whose invocations return `results` in order, and
 * report what happened around each one.
 */
async function runExhausted(
  results: readonly Record<string, unknown>[],
): Promise<UsageLimitRun> {
  const repoPath = await Deno.makeTempDir({ prefix: "issue1670-repo-" });
  const workDir = await Deno.makeTempDir({ prefix: "issue1670-work-" });
  const calls: string[] = [];
  const commits: string[] = [];
  let noteAtCommit: string | undefined;
  let invocations = 0;
  // The uncommitted work the agent left: preserved by the first `wip:`
  // commit, so git reports a clean tree afterwards, exactly as it would.
  let dirty = ["worker/deno/lib/parser.ts"];
  try {
    await Deno.mkdir(`${repoPath}/.git`);
    const config = makeConfig(workDir);
    const state = makeState(repoPath);
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (async (options: Record<string, unknown>) => {
          const resume = options.sessionResumeState as
            | { sessionId: string }
            | undefined;
          const persisted = await loadResumeState(workDir, REPO, ISSUE);
          calls.push(
            `invoke#${++invocations} session=${
              resume?.sessionId ? "same" : "none"
            } resumeState=${persisted ? persisted.branch : "absent"}`,
          );
          const value = results[Math.min(invocations - 1, results.length - 1)];
          return { ok: true, value };
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
          if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("abc\n");
          if (args[0] === "log" && args[1] === "--format=%s") {
            return ok("wip: earlier snapshot\n");
          }
          if (args[0] === "log") return ok("abc1234 real work\n");
          if (args[0] === "diff") return ok("");
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
          calls.push(`commit:${message}`);
          commits.push(message);
          try {
            noteAtCommit = Deno.readTextFileSync(`${repoPath}/${NOTE}`);
          } catch {
            noteAtCommit = undefined;
          }
          dirty = [];
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

    const result = await workOnIssueExecuteClaude(
      makeContext(config),
      state,
      deps,
    );
    const persisted = await loadResumeState(workDir, REPO, ISSUE);
    return {
      calls,
      commits,
      noteAtCommit,
      status: result.status,
      reason: "reason" in result ? result.reason ?? "" : "",
      ...(state.preservedWip
        ? { preservedBranch: state.preservedWip.branch }
        : {}),
      ...(persisted
        ? {
          resumeBranch: persisted.branch,
          ...(persisted.sessionId
            ? { resumeSessionId: persisted.sessionId }
            : {}),
        }
        : {}),
    };
  } finally {
    await Deno.remove(repoPath, { recursive: true }).catch(() => undefined);
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("execute #1670 - a usage limit checkpoints the work and the resume pointer BEFORE switching credential", async () => {
  const run = await runExhausted([USAGE_LIMIT, SUCCESS]);

  // The order is the requirement: push, pointer, only then the switch.
  assertEquals(run.calls.length, 3, run.calls.join("\n"));
  assertStringIncludes(at(run, 0), "invoke#1");
  assertStringIncludes(at(run, 0), "resumeState=absent");
  assertStringIncludes(
    at(run, 1),
    "commit:wip: execute hit the Claude subscription usage limit",
  );
  assertStringIncludes(at(run, 2), "invoke#2");
  // The second invocation resumes the SAME session, and finds the pointer to
  // the checkpointed branch already on disk.
  assertStringIncludes(at(run, 2), "session=same");
  assertStringIncludes(at(run, 2), `resumeState=${BRANCH}`);

  // The handover note (Issue #769) rode the same commit, naming the cause.
  assert(run.noteAtCommit, "the preserving commit must carry the note");
  assertStringIncludes(run.noteAtCommit, `# Handover — issue #${ISSUE}`);
  assertStringIncludes(
    run.noteAtCommit,
    "hit the Claude subscription usage limit",
  );

  // With the credential switched, the phase runs on to completion.
  assertEquals(run.status, "continue", run.reason);
});

Deno.test("execute #1670 - with no eligible credential the run parks on the branch and stops", async () => {
  const run = await runExhausted([USAGE_LIMIT, NO_ELIGIBLE_CREDENTIAL]);

  // Two invocations only: the refused spawn ends the sequence.
  assertEquals(
    run.calls.filter((c) => c.startsWith("invoke")).length,
    2,
    run.calls.join("\n"),
  );

  // Infrastructure failure — the issue is not blamed — naming where the work
  // is (Issue #770) and what it is waiting for.
  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason, "Claude usage limit reached");
  assertStringIncludes(run.reason, BRANCH);
  assertStringIncludes(run.reason, NOTE);
  assertEquals(run.preservedBranch, BRANCH);
  // The pause sentence is gone: the loop moves on to other work (Issue #1669).
  assertFalse(
    run.reason.includes("Agent work is paused"),
    run.reason,
  );

  // The pointer the next claim reads survives, naming the branch and session.
  assertEquals(run.resumeBranch, BRANCH);
  assert(run.resumeSessionId, "the exhausted session id must be persisted");
});

Deno.test("execute #1670 - a refused spawn keeps the exhausted invocation's output as the run's evidence", async () => {
  const run = await runExhausted([USAGE_LIMIT, NO_ELIGIBLE_CREDENTIAL]);
  assertStringIncludes(run.reason, "edited the parser");
});

Deno.test("execute #1670 - a refused first spawn parks at once, with no switch to make", async () => {
  const run = await runExhausted([NO_ELIGIBLE_CREDENTIAL]);

  assertEquals(
    run.calls.filter((c) => c.startsWith("invoke")).length,
    1,
    run.calls.join("\n"),
  );
  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason, "Claude usage limit reached");
});
