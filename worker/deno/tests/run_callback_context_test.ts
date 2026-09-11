/**
 * Tests for the callback context builder and the exactly-once dispatch guard
 * (Issue #806, parent #796).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildCycleCallbackContext,
  buildIssueRunCallbackContext,
  resolveSessionLogPath,
} from "../lib/run_callback_context.ts";
import { IssueCallbackGuard } from "../lib/issue_callback_guard.ts";
import type { TerminalIssueRun } from "../lib/run_callbacks.ts";

function run(overrides: Partial<TerminalIssueRun> = {}): TerminalIssueRun {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 806,
    result: "success",
    startedAtEpochMs: Date.parse("2026-09-02T01:00:00.000Z"),
    finishedAtEpochMs: Date.parse("2026-09-02T01:05:30.000Z"),
    ...overrides,
  };
}

const IDENTITY = { runId: "vibe-1", host: "worker-1" };

Deno.test("run_callback_context - the required facts are always present", () => {
  const context = buildIssueRunCallbackContext(run(), IDENTITY);
  assertEquals(context.runId, "vibe-1");
  assertEquals(context.host, "worker-1");
  assertEquals(context.repository, "stSoftwareAU/VibeCoder");
  assertEquals(context.issueNumber, 806);
  assertEquals(context.result, "success");
  assertEquals(context.startedAt, "2026-09-02T01:00:00.000Z");
  assertEquals(context.finishedAt, "2026-09-02T01:05:30.000Z");
  assertEquals(context.durationSeconds, 330);
  assertEquals(context.exitCode, 0);
});

Deno.test("run_callback_context - a failed run reports exit code 1", () => {
  const context = buildIssueRunCallbackContext(
    run({ result: "failure" }),
    IDENTITY,
  );
  assertEquals(context.result, "failure");
  assertEquals(context.exitCode, 1);
});

Deno.test("run_callback_context - a clock disagreement never yields a negative duration", () => {
  const context = buildIssueRunCallbackContext(
    run({ startedAtEpochMs: 5_000, finishedAtEpochMs: 0 }),
    IDENTITY,
  );
  assertEquals(context.durationSeconds, 0);
});

Deno.test("run_callback_context - blank optional identity fields are omitted", () => {
  const context = buildIssueRunCallbackContext(run(), {
    ...IDENTITY,
    workerName: "   ",
    provider: "",
    sessionId: undefined,
  });
  assert(!("workerName" in context));
  assert(!("provider" in context));
  assert(!("sessionId" in context));
});

Deno.test("run_callback_context - known optional identity fields are carried", () => {
  const context = buildIssueRunCallbackContext(run(), {
    ...IDENTITY,
    workerName: "fleet-a",
    provider: "claude",
    sessionId: "sess-9",
  });
  assertEquals(context.workerName, "fleet-a");
  assertEquals(context.provider, "claude");
  assertEquals(context.sessionId, "sess-9");
});

Deno.test("run_callback_context - telemetry is carried through when supplied", () => {
  const context = buildIssueRunCallbackContext(
    run({ telemetry: { inputTokens: 7, estimatedCostUsd: 0.1 } }),
    IDENTITY,
  );
  assertEquals(context.telemetry, { inputTokens: 7, estimatedCostUsd: 0.1 });
});

Deno.test("run_callback_context - no transcript path when the tee is off", () => {
  assertEquals(
    resolveSessionLogPath({ ...IDENTITY, home: "/home/vibe" }, 806, {
      transcriptEnabled: () => false,
      exists: () => true,
    }),
    undefined,
  );
});

Deno.test("run_callback_context - no transcript path when no home is known", () => {
  assertEquals(
    resolveSessionLogPath(IDENTITY, 806, {
      transcriptEnabled: () => true,
      exists: () => true,
    }),
    undefined,
  );
});

Deno.test("run_callback_context - a transcript path the tee never wrote is not published", () => {
  const seen: string[] = [];
  assertEquals(
    resolveSessionLogPath({ ...IDENTITY, home: "/home/vibe" }, 806, {
      transcriptEnabled: () => true,
      exists: (path) => {
        seen.push(path);
        return false;
      },
    }),
    undefined,
  );
  assertEquals(seen.length, 1);
  assert(seen[0]!.startsWith("/home/vibe/logs/"), seen[0]);
});

Deno.test("run_callback_context - a transcript that exists is published", () => {
  const path = resolveSessionLogPath({ ...IDENTITY, home: "/home/vibe" }, 806, {
    transcriptEnabled: () => true,
    exists: () => true,
  });
  assert(path?.startsWith("/home/vibe/logs/"), `${path}`);
  const context = buildIssueRunCallbackContext(
    run(),
    { ...IDENTITY, home: "/home/vibe" },
    { transcriptEnabled: () => true, exists: () => true },
  );
  assertEquals(context.sessionLogPath, path);
  assert(!("sessionLogAbsentReason" in context));
});

Deno.test("run_callback_context - tee off names sessionLogAbsentReason tee_disabled (Issue #1948)", () => {
  const context = buildIssueRunCallbackContext(
    run(),
    { ...IDENTITY, home: "/home/vibe" },
    { transcriptEnabled: () => false, exists: () => true },
  );
  assert(!("sessionLogPath" in context));
  assertEquals(context.sessionLogAbsentReason, "tee_disabled");
});

Deno.test("run_callback_context - missing file names sessionLogAbsentReason file_missing (Issue #1948)", () => {
  const context = buildIssueRunCallbackContext(
    run(),
    { ...IDENTITY, home: "/home/vibe" },
    { transcriptEnabled: () => true, exists: () => false },
  );
  assert(!("sessionLogPath" in context));
  assertEquals(context.sessionLogAbsentReason, "file_missing");
});

Deno.test("run_callback_context - no telemetry names agent_not_invoked (Issue #1948)", () => {
  const context = buildIssueRunCallbackContext(run(), IDENTITY);
  assert(!("telemetry" in context));
  assertEquals(context.telemetryAbsentReason, "agent_not_invoked");
});

Deno.test("run_callback_context - telemetry and its reason are never both present (Issue #1948)", () => {
  const context = buildIssueRunCallbackContext(
    run({ telemetry: { inputTokens: 1 } }),
    IDENTITY,
  );
  assertEquals(context.telemetry, { inputTokens: 1 });
  assert(!("telemetryAbsentReason" in context));
});

Deno.test("run_callback_context - a no_pr outcome carries kind, category, phase and failureClass (Issue #1947)", () => {
  const context = buildIssueRunCallbackContext(
    run({
      result: "failure",
      outcome: {
        kind: "no_pr",
        category: "evidence_missing",
        phase: "completion",
        elapsedSeconds: 12,
        message: "No evidence recorded",
      },
    }),
    IDENTITY,
  );
  assertEquals(context.outcome?.kind, "no_pr");
  assertEquals(context.outcome?.category, "evidence_missing");
  assertEquals(context.outcome?.phase, "completion");
  assertEquals(context.outcome?.failureClass, "agent-outcome");
  assertEquals(context.result, "failure");
  assertEquals(context.exitCode, 1);
});

Deno.test("run_callback_context - a PR-then-later-step failure still carries prNumber (Issue #1947)", () => {
  const context = buildIssueRunCallbackContext(
    run({
      result: "failure",
      phase: "completion",
      outcome: {
        kind: "summary_incomplete",
        phase: "completion",
        prUrl: "https://github.com/o/r/pull/123",
        prNumber: 123,
        problem: "missing reviewer verdict",
      },
    }),
    IDENTITY,
  );
  assertEquals(context.outcome?.kind, "summary_incomplete");
  assertEquals(context.outcome?.prNumber, 123);
  assertEquals(context.outcome?.phase, "completion");
});

Deno.test("run_callback_context - a deliberate hand-back is distinguishable from a gate failure (Issue #1947)", () => {
  const context = buildIssueRunCallbackContext(
    run({
      result: "failure",
      outcome: {
        kind: "no_pr_expected",
        phase: "execute",
        summary: "out of scope",
      },
    }),
    IDENTITY,
  );
  assertEquals(context.outcome?.kind, "no_pr_expected");
  assertEquals(context.outcome?.phase, "execute");
  assert(!("category" in (context.outcome ?? {})));
  assertEquals(context.result, "failure");
});

Deno.test("run_callback_context - no home names sessionLogAbsentReason log_dir_unavailable (Issue #1948)", () => {
  const context = buildIssueRunCallbackContext(
    run(),
    IDENTITY,
    { transcriptEnabled: () => true, exists: () => true },
  );
  assert(!("sessionLogPath" in context));
  assertEquals(context.sessionLogAbsentReason, "log_dir_unavailable");
});

Deno.test("run_callback_context - a cycle context names the end reason (Issue #1955)", () => {
  const context = buildCycleCallbackContext(
    {
      startedAtEpochMs: Date.parse("2026-09-11T00:00:00.000Z"),
      finishedAtEpochMs: Date.parse("2026-09-11T00:05:00.000Z"),
      issuesScanned: 4,
      claimsAttempted: 0,
      claimsTaken: 0,
      endReason: "no_eligible_work",
      fleetSummary: {
        claims: 0,
        successes: 0,
        failures: 0,
        skips: 0,
        idleSeconds: 300,
        occupiedSeconds: 0,
        rateLimitedSeconds: 0,
        tokenBlockedSeconds: 0,
      },
    },
    IDENTITY,
  );
  assertEquals(context.runId, "vibe-1");
  assertEquals(context.host, "worker-1");
  assertEquals(context.durationSeconds, 300);
  assertEquals(context.endReason, "no_eligible_work");
  assertEquals(context.claimsTaken, 0);
});

Deno.test("run_callback_context - a setup refusal without RunOutcome still names the phase (Issue #1947)", () => {
  const context = buildIssueRunCallbackContext(
    run({ result: "failure", phase: "setup" }),
    IDENTITY,
  );
  assertEquals(context.outcome, {
    kind: "no_pr",
    category: "unknown",
    phase: "setup",
  });
});

// --- Exactly-once guard ----------------------------------------------------

Deno.test("issue_callback_guard - the first claim wins and later ones are refused", () => {
  const guard = new IssueCallbackGuard();
  assertEquals(guard.tryClaim("o/a", 1), true);
  assertEquals(guard.tryClaim("o/a", 1), false);
  assertEquals(guard.tryClaim("o/a", 1), false);
  assertEquals(guard.size, 1);
});

Deno.test("issue_callback_guard - different claims are independent", () => {
  const guard = new IssueCallbackGuard();
  assertEquals(guard.tryClaim("o/a", 1), true);
  assertEquals(guard.tryClaim("o/a", 2), true);
  assertEquals(guard.tryClaim("o/b", 1), true);
  assertEquals(guard.size, 3);
});

Deno.test("issue_callback_guard - a fresh guard starts empty", () => {
  assertEquals(new IssueCallbackGuard().size, 0);
  assertEquals(new IssueCallbackGuard().tryClaim("o/a", 1), true);
});
