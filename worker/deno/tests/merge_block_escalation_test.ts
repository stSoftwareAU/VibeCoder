/**
 * Tests for merge_block_escalation.ts — loud handling of a fix PR that
 * will not land (Issue #3584).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyMergeAttempt,
  handleMergeAttempt,
  requestBranchUpdate,
} from "../lib/merge_block_escalation.ts";
import type { Logger, Result } from "../types.ts";

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    success: noop,
  } as unknown as Logger;
}

/** Capture the arguments handed to the escalation helper. */
interface EscalationCapture {
  calls: Array<{
    repo: string;
    prNumber: number;
    reason: string;
    nextStep: string;
    dedupKey?: string;
  }>;
  fn: NonNullable<Parameters<typeof handleMergeAttempt>[0]["escalateFn"]>;
}

function makeEscalationCapture(
  fail = false,
): EscalationCapture {
  const calls: EscalationCapture["calls"] = [];
  const fn: EscalationCapture["fn"] = (options) => {
    calls.push({
      repo: options.repo,
      prNumber: options.target.number,
      reason: options.reason,
      nextStep: options.nextStep,
      dedupKey: options.dedupKey,
    });
    if (fail) {
      return Promise.resolve({
        ok: false,
        error: new Error("escalation failed"),
      } as Result<never>);
    }
    return Promise.resolve({
      ok: true,
      value: { commentPosted: true, labelAdded: true, dedupSkipped: false },
    });
  };
  return { calls, fn };
}

// ---------------------------------------------------------------------------
// classifyMergeAttempt
// ---------------------------------------------------------------------------

Deno.test("classifyMergeAttempt - a landed PR needs no action", () => {
  assertEquals(classifyMergeAttempt({ kind: "landed" }), "landed");
});

Deno.test("classifyMergeAttempt - pending checks are an expected wait", () => {
  assertEquals(
    classifyMergeAttempt({ kind: "checks_pending" }),
    "await_checks",
  );
});

Deno.test("classifyMergeAttempt - failed checks belong to the CI-fix loop", () => {
  assertEquals(classifyMergeAttempt({ kind: "checks_failed" }), "await_checks");
});

Deno.test("classifyMergeAttempt - a stale base asks for a branch update", () => {
  assertEquals(
    classifyMergeAttempt({ kind: "behind_target" }),
    "update_branch",
  );
});

Deno.test("classifyMergeAttempt - a PR held for a review is a wait, not an escalation", () => {
  // Issue #1082: the default-branch guard is holding the PR until a review
  // outside the fleet arrives. Escalating would hand a human a PR for doing
  // exactly what the guard asked of it; the stall watchdog reports the repo
  // if the hold lasts.
  assertEquals(
    classifyMergeAttempt({ kind: "default_branch_unapproved" }),
    "await_checks",
  );
});

Deno.test("classifyMergeAttempt - a green PR that will not merge escalates", () => {
  assertEquals(
    classifyMergeAttempt({
      kind: "merge_error",
      message: "GraphQL: Pull request is not mergeable",
    }),
    "escalate",
  );
});

// ---------------------------------------------------------------------------
// handleMergeAttempt — silent branches
// ---------------------------------------------------------------------------

Deno.test("handleMergeAttempt - landed PR neither comments nor escalates", async () => {
  const capture = makeEscalationCapture();
  const ghCalls: string[][] = [];
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 7,
    outcome: { kind: "landed" },
    logger: makeSilentLogger(),
    ghFn: (args) => {
      ghCalls.push(args);
      return Promise.resolve("");
    },
    escalateFn: capture.fn,
  });

  assertEquals(result.disposition, "landed");
  assertEquals(result.escalated, false);
  assertEquals(result.branchUpdateRequested, false);
  assertEquals(capture.calls.length, 0);
  assertEquals(ghCalls.length, 0);
});

Deno.test("handleMergeAttempt - pending checks do not escalate (gate must stay tight)", async () => {
  const capture = makeEscalationCapture();
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 7,
    outcome: { kind: "checks_pending" },
    logger: makeSilentLogger(),
    ghFn: () => Promise.resolve(""),
    escalateFn: capture.fn,
  });

  assertEquals(result.disposition, "await_checks");
  assertEquals(result.escalated, false);
  assertEquals(capture.calls.length, 0);
});

Deno.test("handleMergeAttempt - failed checks do not escalate from the merge path", async () => {
  const capture = makeEscalationCapture();
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 7,
    outcome: { kind: "checks_failed" },
    logger: makeSilentLogger(),
    ghFn: () => Promise.resolve(""),
    escalateFn: capture.fn,
  });

  assertEquals(result.disposition, "await_checks");
  assertEquals(result.escalated, false);
  assertEquals(capture.calls.length, 0);
});

// ---------------------------------------------------------------------------
// handleMergeAttempt — stale base
// ---------------------------------------------------------------------------

Deno.test("handleMergeAttempt - stale base requests a branch update, no escalation", async () => {
  const capture = makeEscalationCapture();
  const updated: Array<{ repo: string; prNumber: number }> = [];
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 42,
    outcome: { kind: "behind_target" },
    logger: makeSilentLogger(),
    ghFn: () => Promise.resolve(""),
    escalateFn: capture.fn,
    updateBranchFn: (repo, prNumber) => {
      updated.push({ repo, prNumber });
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
  });

  assertEquals(result.disposition, "update_branch");
  assertEquals(result.branchUpdateRequested, true);
  assertEquals(result.escalated, false);
  assertEquals(updated, [{ repo: "owner/repo", prNumber: 42 }]);
  assertEquals(capture.calls.length, 0);
});

Deno.test("handleMergeAttempt - a failed branch update escalates rather than going quiet", async () => {
  const capture = makeEscalationCapture();
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 42,
    outcome: { kind: "behind_target" },
    logger: makeSilentLogger(),
    ghFn: () => Promise.resolve(""),
    escalateFn: capture.fn,
    updateBranchFn: () =>
      Promise.resolve({
        ok: false,
        error: new Error("merge conflict between base and head"),
      } as Result<void>),
  });

  assertEquals(result.disposition, "escalate");
  assertEquals(result.branchUpdateRequested, false);
  assertEquals(result.escalated, true);
  assertEquals(capture.calls.length, 1);
  assertStringIncludes(capture.calls[0]!.reason, "behind its base branch");
  assertStringIncludes(capture.calls[0]!.reason, "merge conflict");
});

// ---------------------------------------------------------------------------
// handleMergeAttempt — escalation
// ---------------------------------------------------------------------------

Deno.test("handleMergeAttempt - unmergeable green PR comments and escalates", async () => {
  const capture = makeEscalationCapture();
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 99,
    outcome: {
      kind: "merge_error",
      message: "GraphQL: At least 1 approving review is required",
    },
    logger: makeSilentLogger(),
    ghFn: () => Promise.resolve(""),
    escalateFn: capture.fn,
  });

  assertEquals(result.disposition, "escalate");
  assertEquals(result.escalated, true);
  assertEquals(capture.calls.length, 1);
  assertEquals(capture.calls[0]!.repo, "owner/repo");
  assertEquals(capture.calls[0]!.prNumber, 99);
  assertStringIncludes(
    capture.calls[0]!.reason,
    "At least 1 approving review is required",
  );
  assert(capture.calls[0]!.nextStep.length > 0);
});

Deno.test("handleMergeAttempt - escalation is deduplicated per PR", async () => {
  const capture = makeEscalationCapture();
  const outcome = {
    kind: "merge_error" as const,
    message: "protected branch update failed",
  };
  const base = {
    repo: "owner/repo",
    prNumber: 5,
    outcome,
    logger: makeSilentLogger(),
    ghFn: () => Promise.resolve(""),
    escalateFn: capture.fn,
  };
  await handleMergeAttempt(base);
  await handleMergeAttempt(base);

  assertEquals(capture.calls.length, 2);
  assertEquals(capture.calls[0]!.dedupKey, capture.calls[1]!.dedupKey);
  assertStringIncludes(capture.calls[0]!.dedupKey ?? "", "5");
});

Deno.test("handleMergeAttempt - secrets in the merge error are redacted before posting", async () => {
  const capture = makeEscalationCapture();
  // Split literal so the synthetic token is not itself a scannable secret.
  const token = "ghp_" + "F".repeat(36);
  await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 5,
    outcome: {
      kind: "merge_error",
      message: `HTTP 401 using token ${token}`,
    },
    logger: makeSilentLogger(),
    ghFn: () => Promise.resolve(""),
    escalateFn: capture.fn,
  });

  assertEquals(capture.calls.length, 1);
  assert(
    !capture.calls[0]!.reason.includes(token),
    "raw token must not reach the PR comment",
  );
});

Deno.test("handleMergeAttempt - a failing escalation is reported, not swallowed", async () => {
  const capture = makeEscalationCapture(true);
  const errors: string[] = [];
  const logger = {
    ...makeSilentLogger(),
    error: (msg: string) => errors.push(msg),
  } as unknown as Logger;

  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 5,
    outcome: { kind: "merge_error", message: "boom" },
    logger,
    ghFn: () => Promise.resolve(""),
    escalateFn: capture.fn,
  });

  assertEquals(result.disposition, "escalate");
  assertEquals(result.escalated, false);
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0]!, "escalate");
});

// ---------------------------------------------------------------------------
// requestBranchUpdate
// ---------------------------------------------------------------------------

Deno.test("requestBranchUpdate - calls the update-branch endpoint", async () => {
  const calls: string[][] = [];
  const result = await requestBranchUpdate("owner/repo", 12, (args) => {
    calls.push(args);
    return Promise.resolve("{}");
  });

  assertEquals(result.ok, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0], [
    "api",
    "--method",
    "PUT",
    "repos/owner/repo/pulls/12/update-branch",
  ]);
});

Deno.test("requestBranchUpdate - surfaces the API failure", async () => {
  const result = await requestBranchUpdate("owner/repo", 12, () => {
    throw new Error("HTTP 422 merge conflict");
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "HTTP 422 merge conflict");
  }
});

Deno.test("requestBranchUpdate - rejects a malformed repo rather than building a bad path", async () => {
  const calls: string[][] = [];
  const result = await requestBranchUpdate("owner/repo/../evil", 12, (args) => {
    calls.push(args);
    return Promise.resolve("{}");
  });

  assertEquals(result.ok, false);
  assertEquals(calls.length, 0);
});

Deno.test("requestBranchUpdate - rejects a non-positive PR number", async () => {
  const calls: string[][] = [];
  const result = await requestBranchUpdate("owner/repo", 0, (args) => {
    calls.push(args);
    return Promise.resolve("{}");
  });

  assertEquals(result.ok, false);
  assertEquals(calls.length, 0);
});
