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

/** A gh runner that records every call and answers each with "". */
function makeGhRecorder(): {
  calls: string[][];
  fn: (args: string[]) => Promise<string>;
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: (args) => {
      calls.push(args);
      return Promise.resolve("");
    },
  };
}

/** Whether any recorded gh call comments on, or labels, the PR. */
function handsBack(calls: readonly string[][]): boolean {
  return calls.some((args) =>
    args.includes("comment") || args.includes("--add-label") ||
    args.some((a) => a.includes("needs-human"))
  );
}

/** A logger that keeps its warnings, so a retry can be shown to be loud. */
function makeWarnLogger(): { warns: string[]; logger: Logger } {
  const warns: string[] = [];
  return {
    warns,
    logger: {
      ...makeSilentLogger(),
      warn: (msg: string) => warns.push(msg),
    } as unknown as Logger,
  };
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

Deno.test("classifyMergeAttempt - a green PR that will not merge is retried, never handed to a human (Issue #4304)", () => {
  assertEquals(
    classifyMergeAttempt({
      kind: "merge_error",
      message: "GraphQL: Pull request is not mergeable",
    }),
    "retry",
  );
});

Deno.test("classifyMergeAttempt - a head with no checks is retried, never handed to a human (Issue #4304)", () => {
  assertEquals(classifyMergeAttempt({ kind: "no_checks" }), "retry");
});

// ---------------------------------------------------------------------------
// handleMergeAttempt — silent branches
// ---------------------------------------------------------------------------

Deno.test("handleMergeAttempt - landed PR neither comments nor escalates", async () => {
  const gh = makeGhRecorder();
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 7,
    outcome: { kind: "landed" },
    logger: makeSilentLogger(),
    ghFn: gh.fn,
  });

  assertEquals(result.disposition, "landed");
  assertEquals(result.branchUpdateRequested, false);
  assertEquals(gh.calls.length, 0);
});

Deno.test("handleMergeAttempt - pending checks do not escalate (gate must stay tight)", async () => {
  const gh = makeGhRecorder();
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 7,
    outcome: { kind: "checks_pending" },
    logger: makeSilentLogger(),
    ghFn: gh.fn,
  });

  assertEquals(result.disposition, "await_checks");
  assertEquals(gh.calls.length, 0);
});

Deno.test("handleMergeAttempt - failed checks do not escalate from the merge path", async () => {
  const gh = makeGhRecorder();
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 7,
    outcome: { kind: "checks_failed" },
    logger: makeSilentLogger(),
    ghFn: gh.fn,
  });

  assertEquals(result.disposition, "await_checks");
  assertEquals(gh.calls.length, 0);
});

// ---------------------------------------------------------------------------
// handleMergeAttempt — stale base
// ---------------------------------------------------------------------------

Deno.test("handleMergeAttempt - stale base requests a branch update, no escalation", async () => {
  const gh = makeGhRecorder();
  const updated: Array<{ repo: string; prNumber: number }> = [];
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 42,
    outcome: { kind: "behind_target" },
    logger: makeSilentLogger(),
    ghFn: gh.fn,
    updateBranchFn: (repo, prNumber) => {
      updated.push({ repo, prNumber });
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
  });

  assertEquals(result.disposition, "update_branch");
  assertEquals(result.branchUpdateRequested, true);
  assertEquals(updated, [{ repo: "owner/repo", prNumber: 42 }]);
  assertEquals(handsBack(gh.calls), false);
});

Deno.test("handleMergeAttempt - a failed branch update is retried next cycle, never handed to a human (Issue #4304)", async () => {
  const gh = makeGhRecorder();
  const { warns, logger } = makeWarnLogger();
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 42,
    outcome: { kind: "behind_target" },
    logger,
    ghFn: gh.fn,
    updateBranchFn: () =>
      Promise.resolve({
        ok: false,
        error: new Error("merge conflict between base and head"),
      } as Result<void>),
  });

  assertEquals(result.disposition, "retry");
  assertEquals(result.branchUpdateRequested, false);
  assertEquals(handsBack(gh.calls), false);
  assertEquals(warns.length, 1);
  assertStringIncludes(warns[0]!, "merge conflict");
});

// ---------------------------------------------------------------------------
// handleMergeAttempt — retry (Issue #4304: no hand-back to a human)
// ---------------------------------------------------------------------------

Deno.test("handleMergeAttempt - an unmergeable green PR updates its branch and is retried, with no comment or label (Issue #4304)", async () => {
  const gh = makeGhRecorder();
  const { warns, logger } = makeWarnLogger();
  const updated: number[] = [];
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 99,
    outcome: {
      kind: "merge_error",
      message: "GraphQL: At least 1 approving review is required",
    },
    logger,
    ghFn: gh.fn,
    updateBranchFn: (_repo, prNumber) => {
      updated.push(prNumber);
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
  });

  assertEquals(result.disposition, "retry");
  assertEquals(result.branchUpdateRequested, true);
  assertEquals(updated, [99]);
  assertEquals(handsBack(gh.calls), false);
  assertEquals(warns.length, 1);
  assertStringIncludes(warns[0]!, "At least 1 approving review is required");
});

Deno.test("handleMergeAttempt - a head with no checks is retried with no comment or label (Issue #4304)", async () => {
  const gh = makeGhRecorder();
  const result = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 5,
    outcome: { kind: "no_checks" },
    logger: makeSilentLogger(),
    ghFn: gh.fn,
    updateBranchFn: () =>
      Promise.resolve({
        ok: false,
        error: new Error("HTTP 422 no new commits"),
      } as Result<void>),
  });

  assertEquals(result.disposition, "retry");
  assertEquals(result.branchUpdateRequested, false);
  assertEquals(handsBack(gh.calls), false);
});

Deno.test("handleMergeAttempt - secrets in the merge error are redacted before they are logged", async () => {
  const { warns, logger } = makeWarnLogger();
  // Split literal so the synthetic token is not itself a scannable secret.
  const token = "ghp_" + "F".repeat(36);
  await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 5,
    outcome: {
      kind: "merge_error",
      message: `HTTP 401 using token ${token}`,
    },
    logger,
    ghFn: () => Promise.resolve(""),
    updateBranchFn: () =>
      Promise.resolve({ ok: true, value: undefined } as Result<void>),
  });

  assertEquals(warns.length, 1);
  assert(!warns[0]!.includes(token), "raw token must not reach the log");
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

Deno.test("classifyMergeAttempt - a retired sync PR is neither escalated nor counted as landed (Issue #1967)", () => {
  // The arming chokepoint already closed it, so there is nothing for a
  // human to look at and nothing left to merge.
  assertEquals(
    classifyMergeAttempt({ kind: "sync_pr_retired" }),
    "await_checks",
  );
});

Deno.test("classifyMergeAttempt - a milestone with unmerged declared dependencies is a wait, not an escalation (Issue #3014)", () => {
  assertEquals(
    classifyMergeAttempt({ kind: "milestone_dependencies_pending" }),
    "await_checks",
  );
});

Deno.test("handleMergeAttempt - a retired sync PR is not escalated to a human (Issue #1967)", async () => {
  const calls: string[][] = [];
  const handling = await handleMergeAttempt({
    repo: "owner/repo",
    prNumber: 1957,
    outcome: { kind: "sync_pr_retired" },
    logger: makeSilentLogger(),
    ghFn: (args: string[]) => {
      calls.push(args);
      return Promise.resolve("");
    },
  });

  assertEquals(handling.disposition, "await_checks");
  assertEquals(calls, []);
});
