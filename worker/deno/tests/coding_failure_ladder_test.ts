/**
 * Tests for the terminal coding-run failure ladder (Issue #1949).
 *
 * The ordinary coding path used to record a flat 600 s cooldown for every
 * failure and never touch the `failed-once` → `failed` ladder, so a run that
 * failed in 40 seconds was re-claimed every cycle for ever. These tests pin
 * both directions: a non-transient failure enters the ladder, a transient
 * infrastructure failure does not.
 */

import { assertEquals } from "@std/assert";
import {
  applyCodingFailureLadder,
  buildRepeatedFailureEscalation,
  classifyCodingFailure,
  planCodingFailure,
} from "../lib/coding_failure_ladder.ts";
import {
  buildScheduledReleaseReason,
  DEADLINE_BOUND_TIMEOUT_MARKER,
} from "../lib/failure_diagnosis.ts";
import type { HandleFailureOptions } from "../lib/label_types.ts";

// ---------------------------------------------------------------------------
// classifyCodingFailure
// ---------------------------------------------------------------------------

Deno.test("classifyCodingFailure - a fast quality-gate failure enters the ladder", () => {
  const decision = classifyCodingFailure(
    "Quality checks failed: ./quality.sh exited 1 (deno lint)",
  );
  assertEquals(decision.disposition, "ladder");
  assertEquals(decision.cooldownKind, "non_transient");
});

Deno.test("classifyCodingFailure - no changes and no useful output enters the ladder", () => {
  const decision = classifyCodingFailure(
    "No code changes and no useful output from Claude",
  );
  assertEquals(decision.disposition, "ladder");
  assertEquals(decision.cooldownKind, "non_transient");
});

Deno.test("classifyCodingFailure - a budget-burning timeout keeps the timeout kind", () => {
  const decision = classifyCodingFailure(
    "Claude timed out after 3600s with no changes",
  );
  assertEquals(decision.disposition, "ladder");
  assertEquals(decision.cooldownKind, "timeout");
});

Deno.test("classifyCodingFailure - a usage limit is transient", () => {
  const decision = classifyCodingFailure(
    "Claude usage limit reached mid-run (subscription window) — no changes",
  );
  assertEquals(decision.disposition, "transient");
  assertEquals(decision.cooldownKind, undefined);
  assertEquals(decision.failureClass, "usage-limit");
});

Deno.test("classifyCodingFailure - an interrupted run is transient", () => {
  const decision = classifyCodingFailure(
    "Run interrupted before completing — the agent was still working (no changes yet)",
  );
  assertEquals(decision.disposition, "transient");
  assertEquals(decision.failureClass, "interrupted");
});

Deno.test("classifyCodingFailure - a scheduled release is transient", () => {
  const decision = classifyCodingFailure(
    buildScheduledReleaseReason("cycle-ended"),
  );
  assertEquals(decision.disposition, "transient");
  assertEquals(decision.failureClass, "scheduled-release");
});

Deno.test("classifyCodingFailure - a deadline-bound timeout is transient (VibeCoder#174)", () => {
  const decision = classifyCodingFailure(
    `Claude timed out after 900s ${DEADLINE_BOUND_TIMEOUT_MARKER} — WIP preserved`,
  );
  assertEquals(decision.disposition, "transient");
  assertEquals(decision.cooldownKind, undefined);
});

Deno.test("classifyCodingFailure - an out-of-credit account state is transient", () => {
  const decision = classifyCodingFailure(
    "The agent stopped: your credit balance is too low to continue",
  );
  assertEquals(decision.disposition, "transient");
  assertEquals(decision.failureClass, "out-of-credit");
});

Deno.test("classifyCodingFailure - an empty reason enters the ladder (fail loud)", () => {
  const decision = classifyCodingFailure("");
  assertEquals(decision.disposition, "ladder");
  assertEquals(decision.cooldownKind, "non_transient");
});

// ---------------------------------------------------------------------------
// applyCodingFailureLadder
// ---------------------------------------------------------------------------

function recordingHandler() {
  const calls: HandleFailureOptions[] = [];
  const handleIssueFailure = (options: HandleFailureOptions) => {
    calls.push(options);
    return Promise.resolve({
      ok: true as const,
      value: {
        markedAsFailed: false,
        markedAsFailedOnce: true,
        failureCategory: "unknown" as const,
        isInfrastructure: false,
      },
    });
  };
  return { calls, handleIssueFailure };
}

Deno.test("applyCodingFailureLadder - a non-transient failure marks the issue failed-once", async () => {
  const { calls, handleIssueFailure } = recordingHandler();

  const outcome = await applyCodingFailureLadder({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "vibe-bot",
    failureReason: "Quality checks failed: ./quality.sh exited 1",
    failurePhase: "quality_gate",
  }, { handleIssueFailure });

  assertEquals(outcome.decision.disposition, "ladder");
  assertEquals(outcome.ladder?.markedAsFailedOnce, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.repo, "owner/repo");
  assertEquals(calls[0]?.issueNumber, 42);
  // The phase travels in the diagnostic context so the comment says where.
  assertEquals(calls[0]?.diagnosticContext?.includes("quality_gate"), true);
});

Deno.test("applyCodingFailureLadder - a rate-limited run never touches the ladder", async () => {
  const { calls, handleIssueFailure } = recordingHandler();

  const outcome = await applyCodingFailureLadder({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "vibe-bot",
    failureReason:
      "Claude usage limit reached mid-run (subscription window) — no changes",
  }, { handleIssueFailure });

  assertEquals(outcome.decision.disposition, "transient");
  assertEquals(outcome.ladder, undefined);
  assertEquals(calls.length, 0);
});

Deno.test("applyCodingFailureLadder - a ladder failure is surfaced, not swallowed", async () => {
  const outcome = await applyCodingFailureLadder({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "vibe-bot",
    failureReason: "Quality checks failed",
  }, {
    handleIssueFailure: () => Promise.reject(new Error("gh exploded")),
  });

  assertEquals(outcome.decision.disposition, "ladder");
  assertEquals(outcome.ladder, undefined);
  assertEquals(outcome.error?.message, "gh exploded");
});

Deno.test("applyCodingFailureLadder - a Result error from the handler is surfaced", async () => {
  const outcome = await applyCodingFailureLadder({
    repo: "owner/repo",
    issueNumber: 42,
    githubUser: "vibe-bot",
    failureReason: "Quality checks failed",
  }, {
    handleIssueFailure: () =>
      Promise.resolve({
        ok: false as const,
        error: new Error("label refused"),
      }),
  });

  assertEquals(outcome.ladder, undefined);
  assertEquals(outcome.error?.message, "label refused");
});

Deno.test("applyCodingFailureLadder - the configured label names are passed through", async () => {
  const { calls, handleIssueFailure } = recordingHandler();

  await applyCodingFailureLadder({
    repo: "owner/repo",
    issueNumber: 7,
    githubUser: "vibe-bot",
    failureReason: "Push failed: protected branch",
    labels: {
      failedLabel: "blocked",
      failedOnceLabel: "blocked-once",
      needsHumanLabel: "needs-human",
      planningLabel: "planning",
      questionLabel: "question",
    },
  }, { handleIssueFailure });

  assertEquals(calls[0]?.labels?.failedLabel, "blocked");
  assertEquals(calls[0]?.labels?.failedOnceLabel, "blocked-once");
});

// ---------------------------------------------------------------------------
// Host faults are the host's, not the issue's (Issue #1949)
// ---------------------------------------------------------------------------

Deno.test("classifyCodingFailure - a full disk is the host's fault, not the issue's", () => {
  const decision = classifyCodingFailure(
    "Claude failed: No space left on device while writing the worktree",
  );
  assertEquals(decision.failureClass, "disk-full");
  assertEquals(decision.disposition, "transient");
  assertEquals(decision.cooldownKind, undefined);
});

Deno.test("classifyCodingFailure - an OOM kill is the host's fault, not the issue's", () => {
  const decision = classifyCodingFailure(
    "Claude was killed by signal SIGKILL — out of memory (exit 137)",
  );
  assertEquals(decision.failureClass, "oom");
  assertEquals(decision.disposition, "transient");
});

Deno.test("classifyCodingFailure - a missing tool is the host's fault, not the issue's", () => {
  const decision = classifyCodingFailure(
    "git: command not found — not available in the worker environment",
  );
  assertEquals(decision.failureClass, "missing-tools");
  assertEquals(decision.disposition, "transient");
});

// ---------------------------------------------------------------------------
// planCodingFailure — what the main loop owes a finished run
// ---------------------------------------------------------------------------

Deno.test("planCodingFailure - a successful run owes nothing", () => {
  const plan = planCodingFailure({
    success: true,
    expectedSkip: false,
    reason: "",
  });
  assertEquals(plan.applyLadder, false);
  assertEquals(plan.cooldownKind, undefined);
  assertEquals(plan.decision, undefined);
});

Deno.test("planCodingFailure - a declared skip is not a failure (Issue #175)", () => {
  const plan = planCodingFailure({
    success: false,
    expectedSkip: true,
    reason: "Quality checks failed: ./quality.sh exited 1",
  });
  assertEquals(plan.applyLadder, false);
  assertEquals(plan.cooldownKind, undefined);
});

Deno.test("planCodingFailure - a non-transient failure steps the ladder and the cooldown", () => {
  const plan = planCodingFailure({
    success: false,
    expectedSkip: false,
    reason: "No code changes and no useful output from Claude",
  });
  assertEquals(plan.applyLadder, true);
  assertEquals(plan.cooldownKind, "non_transient");
});

Deno.test("planCodingFailure - a transient failure steps neither", () => {
  const plan = planCodingFailure({
    success: false,
    expectedSkip: false,
    reason: "Claude usage limit reached (subscription window)",
  });
  assertEquals(plan.applyLadder, false);
  assertEquals(plan.cooldownKind, undefined);
});

Deno.test("planCodingFailure - a phase that already stepped the ladder is not stepped twice", () => {
  const plan = planCodingFailure({
    success: false,
    expectedSkip: false,
    reason: "Quality checks failed: ./quality.sh exited 1 (deno lint)",
    ladderApplied: true,
  });
  assertEquals(plan.applyLadder, false);
  // The attempt still counts: the phase judged it worth a ladder step.
  assertEquals(plan.cooldownKind, "non_transient");
});

Deno.test("planCodingFailure - an applied ladder counts the attempt even when the final reason reads transient", () => {
  // The quality gate stepped the ladder, then the retry was rate-limited —
  // the attempt was still consumed, so the cooldown must not fall back to
  // the flat base.
  const plan = planCodingFailure({
    success: false,
    expectedSkip: false,
    reason: "Claude usage limit reached (subscription window)",
    ladderApplied: true,
  });
  assertEquals(plan.applyLadder, false);
  assertEquals(plan.cooldownKind, "non_transient");
});

// ---------------------------------------------------------------------------
// buildRepeatedFailureEscalation
// ---------------------------------------------------------------------------

Deno.test("buildRepeatedFailureEscalation - a timeout keeps the Issue #4304 wording", () => {
  const escalation = buildRepeatedFailureEscalation("timeout", 3);
  assertEquals(escalation.heading, "Repeated execute timeouts");
  assertEquals(escalation.reason.includes("3 times in a row"), true);
  assertEquals(escalation.nextStep.includes("timeout budget"), true);
});

Deno.test("buildRepeatedFailureEscalation - a non-transient failure points at the failure comments", () => {
  const escalation = buildRepeatedFailureEscalation("non_transient", 4);
  assertEquals(escalation.heading, "Repeated run failures");
  assertEquals(escalation.reason.includes("4 times in a row"), true);
  assertEquals(escalation.reason.includes("timing out"), false);
  assertEquals(
    escalation.nextStep.includes("per-attempt failure comments"),
    true,
  );
});
