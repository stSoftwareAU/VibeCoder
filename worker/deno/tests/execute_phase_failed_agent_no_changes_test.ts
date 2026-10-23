/**
 * An agent that crashed is a failed run, never "no changes" (Issue #4116).
 *
 * #4148 taught `execute_claude_phase.ts` this, but the `work-on` pipeline
 * decides "no changes" in `phases/execute_phase.ts`. There, a non-zero agent
 * exit with an empty diff still returned `early_exit: no_changes`, and the
 * no-changes phase posted the CLI's own error ("Autocompact is thrashing…")
 * as a "Partial Answer" and handed the issue to a human. That was 12 of the
 * 13 `needs-human` issues on GRQ-AutoTrader on 2026-10-23, and 37 of 44
 * analysis-only hand-offs in GRQ-23's launch logs from 2026-10-20 to 2026-10-23.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { isInfrastructureFailure } from "../lib/failure_diagnosis.ts";
import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";
import { lookupStreamSession } from "../lib/resume_state_store.ts";
import { resolveStreamId } from "../lib/stream_identity.ts";

/** The stream session a sibling issue left, which this run resumed. */
const STREAM_SESSION_ID = "0199fd1e-2a4b-4c3d-8e5f-000000004116";

/** The CLI's own abort, verbatim from GRQ-AutoTrader#3902 on 2026-10-23. */
const THRASH_OUTPUT =
  "Autocompact is thrashing: the context refilled to the limit within 3 " +
  "turns of the previous compact, 3 times in a row. A file being read or a " +
  "tool output is likely too large for the context window. Try reading in " +
  "smaller chunks, or use /clear to start fresh.";

function makeConfig(): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 1 };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 3902,
    issueTitle: "Remove a policy knob and all its code",
    issueBody: "Remove it.",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(): PhaseState {
  return {
    branchName: "issue-3902-remove-a-policy-knob",
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

/** Run the phase over an empty diff with the runner returning `value`. */
async function runWith(
  value: Record<string, unknown>,
  setup: (config: WorkerConfig, state: PhaseState) => void = () => {},
): Promise<{ result: PhaseResult; runnerCalls: number }> {
  let runnerCalls = 0;
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() => {
        runnerCalls++;
        return Promise.resolve({ ok: true, value });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });
  const config = makeConfig();
  const state = makeState();
  setup(config, state);
  const result = await workOnIssueExecuteClaude(
    makeContext(config),
    state,
    deps,
  );
  return { result, runnerCalls };
}

Deno.test("execute_phase #4116 - an agent that exited non-zero with no changes is a retryable failure, not no_changes", async () => {
  const { result } = await runWith({
    output: THRASH_OUTPUT,
    exitCode: 1,
    rawExitCode: 1,
    timedOut: false,
  });
  assertEquals(result.status, "failure");
  assertNotEquals(
    (result as { reason?: string }).reason,
    "no_changes",
    "a crashed agent must never reach the analysis-only hand-off",
  );
  const category = (result as { category?: string }).category;
  assertEquals(category, "interrupted");
  // Retried, never blamed on the issue or escalated to a human.
  assertEquals(isInfrastructureFailure("interrupted"), true);
});

Deno.test("execute_phase #4116 - a clean exit with no changes is still no_changes", async () => {
  // The other direction: the fix must not turn a completed run that chose to
  // change nothing into a failure.
  const { result } = await runWith({
    output: "I read the code. Nothing needs changing.",
    exitCode: 0,
    rawExitCode: 0,
    timedOut: false,
  });
  assertEquals(result.status, "early_exit");
  assertEquals((result as { reason?: string }).reason, "no_changes");
});

/** Run one exit code on a resumed stream and report what the stream holds. */
async function streamAfterRun(exitCode: number): Promise<string> {
  const workDir = await Deno.makeTempDir({ prefix: "issue4116-stream-" });
  const stream = resolveStreamId("org/repo", undefined);
  try {
    await runWith(
      {
        output: exitCode === 0
          ? "Read the code; nothing to change."
          : THRASH_OUTPUT,
        exitCode,
        rawExitCode: exitCode,
        timedOut: false,
        provider: "claude",
      },
      (config, state) => {
        config.workDir = workDir;
        state.sessionResumeState = {
          sessionId: STREAM_SESSION_ID,
          phaseCount: 1,
          providerId: "claude",
        };
        state.streamSession = { stream, providerId: "claude" };
      },
    );
    return (await lookupStreamSession(workDir, stream, "claude")).status;
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

Deno.test("execute_phase #4116 - a failed agent hands no session on to the stream", async () => {
  // The broken conversation must not become the stream's next issue's
  // starting point: GRQ-AutoTrader issues died one after another on the same
  // stream session on 2026-10-23.
  assertEquals(await streamAfterRun(1), "none");
});

Deno.test("execute_phase #4116 - a clean run still hands its session on to the stream", async () => {
  assertEquals(await streamAfterRun(0), "usable");
});
