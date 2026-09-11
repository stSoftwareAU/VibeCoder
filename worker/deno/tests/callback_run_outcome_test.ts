/**
 * The structured run outcome published to the post-run callbacks (Issue
 * #1947).
 *
 * `result: "failure"` was the only outcome fact a callback consumer had, so an
 * archive built from it could not tell "PR raised, later step failed" from
 * "quality gate red" from "deliberate hand-back". These tests pin the summary
 * that now travels with it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { summariseRunOutcome } from "../lib/callback_run_outcome.ts";
import {
  claimStaleOutcome,
  deriveRunOutcome,
  summaryIncompleteOutcome,
  supersededOutcome,
} from "../lib/run_outcome.ts";

Deno.test("summariseRunOutcome - a PR run publishes its kind and PR number", () => {
  const summary = summariseRunOutcome({
    result: "success",
    outcome: deriveRunOutcome({
      success: true,
      phase: "completion",
      reason: "PR raised",
      prUrl: "https://github.com/o/r/pull/123",
      prNumber: 123,
    }),
  });

  assertEquals(summary, { kind: "pr", prNumber: 123 });
});

Deno.test("summariseRunOutcome - a PR run that failed a later step carries the PR number and the failing phase", () => {
  const summary = summariseRunOutcome({
    result: "failure",
    phase: "completion",
    outcome: deriveRunOutcome({
      success: false,
      phase: "completion",
      reason: "gh pr create refused: API rate limit exceeded",
      prUrl: "https://github.com/o/r/pull/77",
      prNumber: 77,
    }),
  });

  assertEquals(summary?.kind, "pr");
  assertEquals(summary?.prNumber, 77);
  assertEquals(summary?.phase, "completion");
});

Deno.test("summariseRunOutcome - a quality-gate failure carries its category, phase and failure class", () => {
  const summary = summariseRunOutcome({
    result: "failure",
    outcome: deriveRunOutcome({
      success: false,
      phase: "quality_gate",
      reason: "quality checks failed: deno lint reported 3 problems",
      elapsedSeconds: 900,
    }),
  });

  assertEquals(summary, {
    kind: "no_pr",
    category: "quality_check",
    phase: "quality_gate",
    failureClass: "agent-outcome",
  });
});

Deno.test("summariseRunOutcome - a rate-limited failure is classified apart from a gate failure", () => {
  const summary = summariseRunOutcome({
    result: "failure",
    outcome: deriveRunOutcome({
      success: false,
      phase: "execute",
      reason: "Claude usage limit reached — rate limit",
      elapsedSeconds: 30,
    }),
  });

  assertEquals(summary?.category, "rate_limit");
  assertEquals(summary?.failureClass, "usage-limit");
});

Deno.test("summariseRunOutcome - a deliberate hand-back is not a failure kind", () => {
  const summary = summariseRunOutcome({
    result: "success",
    outcome: deriveRunOutcome({
      success: true,
      phase: "execute",
      reason: "issue judged out of scope; follow-up filed",
    }),
  });

  assertEquals(summary, { kind: "no_pr_expected", phase: "execute" });
});

Deno.test("summariseRunOutcome - a superseded run names the PR that overtook it", () => {
  const summary = summariseRunOutcome({
    result: "success",
    outcome: supersededOutcome({
      phase: "setup",
      prUrl: "https://github.com/o/r/pull/9",
      prNumber: 9,
      prState: "MERGED",
    }),
  });

  assertEquals(summary, { kind: "superseded", phase: "setup", prNumber: 9 });
});

Deno.test("summariseRunOutcome - an incomplete summary keeps the PR it delivered", () => {
  const summary = summariseRunOutcome({
    result: "failure",
    outcome: summaryIncompleteOutcome({
      phase: "completion",
      prUrl: "https://github.com/o/r/pull/42",
      prNumber: 42,
      problem: "a criterion entry names no reviewer verdict",
    }),
  });

  assertEquals(summary, {
    kind: "summary_incomplete",
    phase: "completion",
    prNumber: 42,
  });
});

Deno.test("summariseRunOutcome - a stale claim publishes its kind without a category", () => {
  const summary = summariseRunOutcome({
    result: "success",
    outcome: claimStaleOutcome({
      phase: "setup",
      stale: { reason: "issue_closed", detail: "the issue closed mid-cycle" },
    }),
  });

  assertEquals(summary, { kind: "claim_stale", phase: "setup" });
});

Deno.test("summariseRunOutcome - a failure with no computed outcome is still a no_pr the loop can name", () => {
  const summary = summariseRunOutcome({
    result: "failure",
    message: "claim rejected: the issue is assigned to another host",
  });

  assertEquals(summary?.kind, "no_pr");
  assertEquals(summary?.phase, "claim");
});

Deno.test("summariseRunOutcome - a failure with no outcome keeps the phase the loop knew", () => {
  const summary = summariseRunOutcome({
    result: "failure",
    phase: "setup",
    message: "git clone refused: permission denied",
  });

  assertEquals(summary?.phase, "setup");
});

Deno.test("summariseRunOutcome - a success with no computed outcome publishes nothing rather than a guess", () => {
  assertEquals(summariseRunOutcome({ result: "success" }), undefined);
});
