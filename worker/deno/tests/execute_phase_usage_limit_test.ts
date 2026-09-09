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
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";
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
  /** The `--resume` session id each invocation was given, in order. */
  sessionIds: string[];
  /** The execute budget each invocation was given, in seconds. */
  timeouts: number[];
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

function makeConfig(workDir: string, claudeTimeout?: number): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    workDir,
    infraRetryBackoffMs: 10,
    enableSessionResume: true,
    ...(claudeTimeout !== undefined ? { claudeTimeout } : {}),
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
  options: { claudeTimeout?: number } = {},
): Promise<UsageLimitRun> {
  const repoPath = await Deno.makeTempDir({ prefix: "issue1670-repo-" });
  const workDir = await Deno.makeTempDir({ prefix: "issue1670-work-" });
  const calls: string[] = [];
  const commits: string[] = [];
  let noteAtCommit: string | undefined;
  let invocations = 0;
  const sessionIds: string[] = [];
  const timeouts: number[] = [];
  // The uncommitted work the agent left: preserved by the first `wip:`
  // commit, so git reports a clean tree afterwards, exactly as it would.
  let dirty = ["worker/deno/lib/parser.ts"];
  try {
    await Deno.mkdir(`${repoPath}/.git`);
    const config = makeConfig(workDir, options.claudeTimeout);
    const state = makeState(repoPath);
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (async (options: Record<string, unknown>) => {
          const resume = options.sessionResumeState as
            | { sessionId: string }
            | undefined;
          const persisted = await loadResumeState(workDir, REPO, ISSUE);
          // The id itself, never a "same"/"none" verdict the fake computes:
          // a verdict cannot disagree with the code that wrote it.
          sessionIds.push(resume?.sessionId ?? "");
          timeouts.push(Number(options.timeoutSeconds));
          calls.push(
            `invoke#${++invocations} resumeState=${
              persisted ? persisted.branch : "absent"
            }`,
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
      sessionIds,
      timeouts,
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
  // The second invocation resumes the SAME session — the id itself, compared
  // — and finds the pointer to the checkpointed branch already on disk.
  assert(run.sessionIds[0], "the first invocation must carry a session id");
  assertEquals(run.sessionIds[1], run.sessionIds[0]);
  assertStringIncludes(at(run, 2), `resumeState=${BRANCH}`);
  // …inside the phase deadline: the switch gets what is left of the execute
  // budget, never a fresh one on top of it.
  assert(
    (run.timeouts[1] ?? 0) <= (run.timeouts[0] ?? 0),
    `switch budget ${run.timeouts[1]}s must not exceed ${run.timeouts[0]}s`,
  );

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
  // Infrastructure, not the issue's fault: the class drives the retry and
  // cooldown handling, and a `timeout`/`unknown` reading here would blame it.
  assertEquals(detectFailureCategory(run.reason), "rate_limit");
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

Deno.test("execute #1670 - the switch is bounded: a second usage limit parks rather than switching again", async () => {
  const run = await runExhausted([USAGE_LIMIT, USAGE_LIMIT]);

  // One switch per phase — the second limit ends the sequence.
  assertEquals(
    run.calls.filter((c) => c.startsWith("invoke")).length,
    2,
    run.calls.join("\n"),
  );
  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason, BRANCH);
  assertEquals(run.preservedBranch, BRANCH);
});

Deno.test("execute #1670 - too little execute budget left to finish parks instead of billing a switch", async () => {
  // A phase whose whole budget is under the switch floor cannot give a
  // switched-to credential enough runway to finish: park the work rather
  // than spend an invocation that must be killed part-way.
  const run = await runExhausted([USAGE_LIMIT, SUCCESS], { claudeTimeout: 30 });

  assertEquals(
    run.calls.filter((c) => c.startsWith("invoke")).length,
    1,
    run.calls.join("\n"),
  );
  assertEquals(run.status, "failure");
  assertEquals(run.preservedBranch, BRANCH);
});

Deno.test("execute #1670 - exit 2 without usage-limit evidence is not a credential problem", async () => {
  // The #3648 invocation budget gives up with the same exit status and no
  // `usageLimit`. Switching credential would not help it, so nothing is
  // preserved and nothing is re-invoked.
  const run = await runExhausted([{
    output: "ran out of invocations",
    exitCode: 2,
    timedOut: false,
  }]);

  // Nothing was checkpointed and no credential switch was made: the second
  // invocation in the log is the pre-existing #1550 infrastructure retry.
  assertEquals(run.commits.length, 0, run.commits.join(" | "));
  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason, "Claude rate limit — retries exhausted");
});
