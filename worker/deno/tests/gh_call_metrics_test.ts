/**
 * Tests for gh_call_metrics.ts (Issue #1671).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createRendezvous } from "./support/rendezvous.ts";
import {
  classifyGhArgs,
  currentGraphQLSourceContext,
  enterGraphQLSource,
  enterPriority,
  exitGraphQLSource,
  exitPriority,
  formatGhCallsByPrioritySummary,
  formatGhCallSummary,
  formatGraphQLSummary,
  getGhCallMetrics,
  recordCacheExpired,
  recordCacheHit,
  recordCacheMiss,
  recordCommentsCacheHit,
  recordCommentsCacheMiss,
  recordGhCall,
  resetGhCallMetrics,
  withGraphQLSource,
  withGraphQLSourceContext,
  withPriority,
} from "../lib/gh_call_metrics.ts";

Deno.test("gh_call_metrics - classifyGhArgs categorises common sub-commands", () => {
  assertEquals(
    classifyGhArgs(["issue", "list", "--repo", "o/r"]),
    "issue list",
  );
  assertEquals(classifyGhArgs(["issue", "view", "1"]), "issue view");
  assertEquals(classifyGhArgs(["pr", "list", "--state", "open"]), "pr list");
  assertEquals(classifyGhArgs(["pr", "view", "42"]), "pr view");
  assertEquals(classifyGhArgs(["api", "rate_limit"]), "api");
  assertEquals(
    classifyGhArgs(["api", "-X", "POST", "repos/o/r/labels"]),
    "api",
  );
});

Deno.test("gh_call_metrics - classifyGhArgs skips leading flags", () => {
  assertEquals(
    classifyGhArgs(["--version", "issue", "list"]),
    "issue list",
  );
});

Deno.test("gh_call_metrics - classifyGhArgs handles unknown / empty", () => {
  assertEquals(classifyGhArgs([]), "unknown");
  assertEquals(classifyGhArgs(["--help"]), "unknown");
  assertEquals(classifyGhArgs(["completion", "bash"]), "completion");
});

Deno.test("gh_call_metrics - recordGhCall increments total and per-sub-command counts", () => {
  resetGhCallMetrics();

  recordGhCall(["issue", "list", "--repo", "o/r"]);
  recordGhCall(["issue", "list", "--repo", "o/r"]);
  recordGhCall(["issue", "view", "1"]);
  recordGhCall(["pr", "list"]);
  recordGhCall(["api", "rate_limit"]);

  const snap = getGhCallMetrics();
  assertEquals(snap.total, 5);
  assertEquals(snap.bySubCommand["issue list"], 2);
  assertEquals(snap.bySubCommand["issue view"], 1);
  assertEquals(snap.bySubCommand["pr list"], 1);
  assertEquals(snap.bySubCommand["api"], 1);
});

Deno.test("gh_call_metrics - cache counters increment correctly", () => {
  resetGhCallMetrics();

  recordCacheHit();
  recordCacheHit();
  recordCacheHit();
  recordCacheMiss();
  recordCacheMiss();
  recordCacheExpired();

  const snap = getGhCallMetrics();
  assertEquals(snap.cacheHits, 3);
  assertEquals(snap.cacheMisses, 2);
  assertEquals(snap.cacheExpired, 1);
  assertEquals(snap.savedByCache, 3);
});

Deno.test("gh_call_metrics - resetGhCallMetrics zeroes every counter", () => {
  recordGhCall(["issue", "list"]);
  recordCacheHit();
  recordCacheMiss();
  recordCacheExpired();
  recordCommentsCacheHit();
  recordCommentsCacheMiss();

  resetGhCallMetrics();

  const snap = getGhCallMetrics();
  assertEquals(snap.total, 0);
  assertEquals(snap.cacheHits, 0);
  assertEquals(snap.cacheMisses, 0);
  assertEquals(snap.cacheExpired, 0);
  assertEquals(snap.savedByCache, 0);
  assertEquals(snap.commentsCacheHits, 0);
  assertEquals(snap.commentsCacheMisses, 0);
  assertEquals(Object.keys(snap.bySubCommand).length, 0);
});

Deno.test("gh_call_metrics - comment-cache counters increment correctly", () => {
  resetGhCallMetrics();

  recordCommentsCacheHit();
  recordCommentsCacheHit();
  recordCommentsCacheMiss();

  const snap = getGhCallMetrics();
  assertEquals(snap.commentsCacheHits, 2);
  assertEquals(snap.commentsCacheMisses, 1);
});

Deno.test("gh_call_metrics - formatGhCallSummary surfaces comments-cache field", () => {
  resetGhCallMetrics();

  recordCommentsCacheHit();
  recordCommentsCacheHit();
  recordCommentsCacheMiss();

  const summary = formatGhCallSummary();
  assertStringIncludes(summary, "comments-cache=hit:2/miss:1");
});

Deno.test("gh_call_metrics - formatGhCallSummary omits comments-cache when unused", () => {
  resetGhCallMetrics();
  recordGhCall(["issue", "list"]);

  const summary = formatGhCallSummary();
  // Field should be absent when no comments-cache activity occurred.
  assertEquals(summary.includes("comments-cache"), false);
});

Deno.test("gh_call_metrics - formatGhCallSummary produces single-line summary", () => {
  resetGhCallMetrics();

  recordGhCall(["issue", "list"]);
  recordGhCall(["issue", "list"]);
  recordGhCall(["pr", "view", "1"]);
  recordGhCall(["api", "rate_limit"]);
  recordCacheHit();
  recordCacheHit();
  recordCacheExpired();

  const summary = formatGhCallSummary();
  // Single line — no embedded newlines
  assertEquals(summary.includes("\n"), false);
  // Starts with the prefix
  assertStringIncludes(summary, "gh-calls:");
  // Includes total and saved-by-cache
  assertStringIncludes(summary, "4 total");
  assertStringIncludes(summary, "2 saved-by-cache");
  assertStringIncludes(summary, "1 expired");
  // Includes per-sub-command breakdown
  assertStringIncludes(summary, "issue-list=2");
  assertStringIncludes(summary, "pr-view=1");
  assertStringIncludes(summary, "api=1");
});

Deno.test("gh_call_metrics - formatGhCallSummary with zero calls", () => {
  resetGhCallMetrics();
  const summary = formatGhCallSummary();
  assertStringIncludes(summary, "0 total");
  assertStringIncludes(summary, "0 saved-by-cache");
});

Deno.test("gh_call_metrics - stubbed gh function increments metrics", async () => {
  resetGhCallMetrics();

  // A stubbed runGhCommand-like function that records each invocation
  // before returning canned output. This mirrors how real `gh` calls
  // are instrumented.
  const stubGh = async (args: string[]): Promise<string> => {
    recordGhCall(args);
    await Promise.resolve();
    return "[]";
  };

  await stubGh(["issue", "list", "--repo", "o/r"]);
  await stubGh(["issue", "view", "42"]);
  await stubGh(["pr", "list", "--repo", "o/r"]);
  await stubGh(["api", "rate_limit"]);
  await stubGh(["issue", "list", "--repo", "o/r2"]);

  const snap = getGhCallMetrics();
  assertEquals(snap.total, 5);
  assertEquals(snap.bySubCommand["issue list"], 2);
  assertEquals(snap.bySubCommand["issue view"], 1);
  assertEquals(snap.bySubCommand["pr list"], 1);
  assertEquals(snap.bySubCommand["api"], 1);
});

// ---------------------------------------------------------------------------
// Per-priority context API (Issue #1845)
// ---------------------------------------------------------------------------

Deno.test("gh_call_metrics - byPriority attributes calls to active priority", () => {
  resetGhCallMetrics();

  enterPriority("Stale Workflow Detection");
  recordGhCall(["issue", "list"]);
  recordGhCall(["issue", "list"]);
  recordGhCall(["pr", "list"]);
  exitPriority();

  enterPriority("Milestone Completions");
  recordGhCall(["api", "rate_limit"]);
  exitPriority();

  const snap = getGhCallMetrics();
  assertEquals(snap.byPriority["stale-workflow-detection"], 3);
  assertEquals(snap.byPriority["milestone-completions"], 1);
});

Deno.test("gh_call_metrics - calls outside any priority are not attributed", () => {
  resetGhCallMetrics();

  recordGhCall(["issue", "list"]);
  enterPriority("PR Feedback");
  recordGhCall(["issue", "view", "1"]);
  exitPriority();
  recordGhCall(["pr", "list"]);

  const snap = getGhCallMetrics();
  assertEquals(snap.total, 3);
  // Only the call inside the priority context is attributed.
  assertEquals(Object.keys(snap.byPriority).length, 1);
  assertEquals(snap.byPriority["pr-feedback"], 1);
});

Deno.test("gh_call_metrics - nested priorities credit the innermost", () => {
  resetGhCallMetrics();

  enterPriority("Outer");
  recordGhCall(["issue", "list"]); // outer
  enterPriority("Inner Helper");
  recordGhCall(["pr", "list"]); // inner
  recordGhCall(["pr", "view", "1"]); // inner
  exitPriority();
  recordGhCall(["api", "rate_limit"]); // outer again
  exitPriority();

  const snap = getGhCallMetrics();
  assertEquals(snap.byPriority["outer"], 2);
  assertEquals(snap.byPriority["inner-helper"], 2);
});

Deno.test("gh_call_metrics - withPriority restores stack even when fn throws", async () => {
  resetGhCallMetrics();

  enterPriority("Outer");
  try {
    await withPriority("Inner", () => {
      recordGhCall(["issue", "list"]);
      throw new Error("boom");
    });
  } catch { /* expected */ }
  // Inner must have been popped — this call attributes to Outer.
  recordGhCall(["pr", "list"]);
  exitPriority();

  const snap = getGhCallMetrics();
  assertEquals(snap.byPriority["inner"], 1);
  assertEquals(snap.byPriority["outer"], 1);
});

Deno.test("gh_call_metrics - exitPriority on empty stack is a no-op", () => {
  resetGhCallMetrics();
  // Should not throw — degraded gracefully so a mismatched pair in the
  // main loop cannot crash the worker.
  exitPriority();
  exitPriority();
  recordGhCall(["issue", "list"]);
  const snap = getGhCallMetrics();
  assertEquals(snap.total, 1);
  assertEquals(Object.keys(snap.byPriority).length, 0);
});

Deno.test("gh_call_metrics - resetGhCallMetrics clears byPriority and stack", () => {
  enterPriority("Lingering");
  recordGhCall(["issue", "list"]);
  resetGhCallMetrics();
  // Stack should also be cleared — a subsequent call attributes nowhere.
  recordGhCall(["pr", "list"]);
  const snap = getGhCallMetrics();
  assertEquals(snap.total, 1);
  assertEquals(Object.keys(snap.byPriority).length, 0);
});

Deno.test("gh_call_metrics - formatGhCallsByPrioritySummary sorts descending", () => {
  resetGhCallMetrics();

  enterPriority("Auto Merge");
  for (let i = 0; i < 12; i++) recordGhCall(["pr", "list"]);
  exitPriority();

  enterPriority("Stale Workflow");
  for (let i = 0; i < 42; i++) recordGhCall(["issue", "list"]);
  exitPriority();

  enterPriority("Milestone Completions");
  for (let i = 0; i < 15; i++) recordGhCall(["api", "rate_limit"]);
  exitPriority();

  const summary = formatGhCallsByPrioritySummary();
  assertStringIncludes(summary, "gh-calls-by-priority:");
  // Highest count must come first.
  const stalePos = summary.indexOf("stale-workflow=42");
  const milestonePos = summary.indexOf("milestone-completions=15");
  const autoMergePos = summary.indexOf("auto-merge=12");
  assertEquals(stalePos > -1, true);
  assertEquals(milestonePos > -1, true);
  assertEquals(autoMergePos > -1, true);
  assertEquals(stalePos < milestonePos, true);
  assertEquals(milestonePos < autoMergePos, true);
  // Single line — no embedded newlines.
  assertEquals(summary.includes("\n"), false);
});

Deno.test("gh_call_metrics - formatGhCallsByPrioritySummary emits 'none' on empty iteration", () => {
  resetGhCallMetrics();
  // No priority context entered, no calls recorded.
  assertEquals(formatGhCallsByPrioritySummary(), "gh-calls-by-priority: none");
});

Deno.test("gh_call_metrics - formatGhCallsByPrioritySummary emits 'none' when calls are unattributed", () => {
  resetGhCallMetrics();
  // Calls were made, but none inside a priority context — breakdown
  // is empty so the explicit `none` marker is emitted.
  recordGhCall(["issue", "list"]);
  recordGhCall(["pr", "list"]);
  assertEquals(formatGhCallsByPrioritySummary(), "gh-calls-by-priority: none");
});

// ---------------------------------------------------------------------------
// GraphQL attribution (Issue #1924)
// ---------------------------------------------------------------------------

Deno.test("gh_call_metrics - classifyGhArgs distinguishes api graphql from REST api", () => {
  // GraphQL request — the worker sends `gh api graphql -f query=...`.
  assertEquals(
    classifyGhArgs(["api", "graphql", "-f", "query=..."]),
    "api graphql",
  );
  // REST `api` calls keep their existing bucket.
  assertEquals(classifyGhArgs(["api", "rate_limit"]), "api");
  assertEquals(
    classifyGhArgs(["api", "-X", "POST", "repos/o/r/labels"]),
    "api",
  );
});

Deno.test("gh_call_metrics - recordGhCall counts GraphQL calls separately from REST", () => {
  resetGhCallMetrics();

  recordGhCall(["api", "graphql", "-f", "query=Q1"]);
  recordGhCall(["api", "graphql", "-f", "query=Q2"]);
  recordGhCall(["api", "rate_limit"]);
  recordGhCall(["issue", "list"]);

  const snap = getGhCallMetrics();
  // Issue #1485: `gh issue list` is GraphQL-backed too — three GraphQL
  // calls, and only the plain REST `gh api rate_limit` is not one.
  assertEquals(snap.graphqlTotal, 3);
  // REST api bucket excludes the graphql calls.
  assertEquals(snap.bySubCommand["api"], 1);
  assertEquals(snap.bySubCommand["api graphql"], 2);
  assertEquals(snap.bySubCommand["issue list"], 1);
});

Deno.test("gh_call_metrics - every gh sub-command counts as GraphQL; only REST `gh api <path>` does not (Issue #1485)", () => {
  resetGhCallMetrics();

  // The sub-commands the worker actually issues — all GraphQL-backed.
  recordGhCall(["issue", "list", "--repo", "o/r", "--json", "number"]);
  recordGhCall(["pr", "list", "--repo", "o/r", "--state", "open"]);
  recordGhCall(["pr", "view", "42", "--json", "mergeable"]);
  recordGhCall(["search", "issues", "--assignee", "me"]);
  recordGhCall(["--repo", "o/r", "issue", "view", "1"]); // leading flag
  recordGhCall(["api", "graphql", "-f", "query=Q"]);
  // REST calls ride the core quota and must not be counted.
  recordGhCall(["api", "rate_limit"]);
  recordGhCall(["api", "-X", "PUT", "repos/o/r/pulls/1/update-branch"]);
  recordGhCall(["api", "--paginate", "repos/o/r/issues/1/comments"]);

  const snap = getGhCallMetrics();
  assertEquals(snap.total, 9);
  assertEquals(snap.graphqlTotal, 6);
  assertEquals(snap.bySubCommand["api"], 3);
  assertStringIncludes(formatGraphQLSummary(), "graphql-calls: 6 total");
});

Deno.test("gh_call_metrics - enterGraphQLSource attributes GraphQL calls to the source", () => {
  resetGhCallMetrics();

  enterGraphQLSource("pr-linkage");
  recordGhCall(["api", "graphql", "-f", "query=Q1"]);
  recordGhCall(["api", "graphql", "-f", "query=Q2"]);
  exitGraphQLSource();

  enterGraphQLSource("milestone-health");
  recordGhCall(["api", "graphql", "-f", "query=Q3"]);
  exitGraphQLSource();

  const snap = getGhCallMetrics();
  assertEquals(snap.graphqlTotal, 3);
  assertEquals(snap.graphqlBySource["pr-linkage"], 2);
  assertEquals(snap.graphqlBySource["milestone-health"], 1);
});

Deno.test("gh_call_metrics - GraphQL source ignores non-GraphQL calls", () => {
  resetGhCallMetrics();

  enterGraphQLSource("pr-linkage");
  recordGhCall(["api", "rate_limit"]); // REST inside a GraphQL block — not attributed
  recordGhCall(["api", "graphql", "-f", "query=Q1"]);
  exitGraphQLSource();

  const snap = getGhCallMetrics();
  assertEquals(snap.graphqlTotal, 1);
  assertEquals(snap.graphqlBySource["pr-linkage"], 1);
});

Deno.test("gh_call_metrics - withGraphQLSource pops on throw", async () => {
  resetGhCallMetrics();

  try {
    await withGraphQLSource("pr-linkage", () => {
      recordGhCall(["api", "graphql", "-f", "query=Q1"]);
      throw new Error("boom");
    });
  } catch { /* expected */ }

  // Source must be popped — this call must not attribute to pr-linkage.
  recordGhCall(["api", "graphql", "-f", "query=Q2"]);

  const snap = getGhCallMetrics();
  assertEquals(snap.graphqlTotal, 2);
  assertEquals(snap.graphqlBySource["pr-linkage"], 1);
});

Deno.test("gh_call_metrics - resetGhCallMetrics clears GraphQL counters and stack", () => {
  enterGraphQLSource("lingering");
  recordGhCall(["api", "graphql", "-f", "query=Q"]);
  resetGhCallMetrics();
  // Stack also cleared — a subsequent GraphQL call must not attribute
  // to the prior "lingering" source. It still lands in the
  // "unattributed" bucket so an unwrapped call site is visible.
  recordGhCall(["api", "graphql", "-f", "query=Q"]);

  const snap = getGhCallMetrics();
  assertEquals(snap.graphqlTotal, 1);
  assertEquals(snap.graphqlBySource["lingering"], undefined);
  assertEquals(snap.graphqlBySource["unattributed"], 1);
});

Deno.test("gh_call_metrics - formatGraphQLSummary lists sources descending", () => {
  resetGhCallMetrics();

  enterGraphQLSource("milestone-health");
  for (let i = 0; i < 5; i++) recordGhCall(["api", "graphql", "-f", "query=Q"]);
  exitGraphQLSource();

  enterGraphQLSource("pr-linkage");
  for (let i = 0; i < 20; i++) {
    recordGhCall(["api", "graphql", "-f", "query=Q"]);
  }
  exitGraphQLSource();

  const summary = formatGraphQLSummary();
  assertStringIncludes(summary, "graphql-calls:");
  assertStringIncludes(summary, "25 total");
  const prPos = summary.indexOf("pr-linkage=20");
  const msPos = summary.indexOf("milestone-health=5");
  assertEquals(prPos > -1, true);
  assertEquals(msPos > -1, true);
  assertEquals(prPos < msPos, true);
  assertEquals(summary.includes("\n"), false);
});

Deno.test("gh_call_metrics - formatGraphQLSummary emits zero summary when no GraphQL calls", () => {
  resetGhCallMetrics();
  recordGhCall(["api", "rate_limit"]); // REST only
  const summary = formatGraphQLSummary();
  assertEquals(summary, "graphql-calls: 0 total");
});

Deno.test("gh_call_metrics - formatGraphQLSummary marks unattributed graphql calls", () => {
  resetGhCallMetrics();
  // GraphQL call issued outside any enterGraphQLSource block.
  recordGhCall(["api", "graphql", "-f", "query=Q1"]);
  recordGhCall(["api", "graphql", "-f", "query=Q2"]);
  const summary = formatGraphQLSummary();
  assertStringIncludes(summary, "2 total");
  // The "unattributed" sentinel surfaces unwrapped GraphQL call sites
  // so future regressions are obvious in the log.
  assertStringIncludes(summary, "unattributed=2");
});

/**
 * Issue #1585: the GraphQL source axis must be async-scoped, so two lanes
 * running at once cannot credit each other's `gh` calls. Interleave a
 * wrapped chain and an unwrapped one through a manually resolved promise:
 * the unwrapped chain's calls must land in `unattributed`.
 */
Deno.test("gh_call_metrics - concurrent chains do not cross-credit GraphQL sources", async () => {
  resetGhCallMetrics();

  // Bounded rendezvous, never a sleep: a lane that never arrives fails the
  // assertion below rather than hanging the suite.
  const meeting = createRendezvous(2);

  const wrapped = withGraphQLSource("comments-batch", async () => {
    // Suspend inside the source, exactly as an awaited `gh` spawn does.
    const arrived = await meeting.arrive();
    assertEquals(arrived, 2);
    recordGhCall(["api", "graphql", "-f", "query=Q"]);
  });

  // A second lane, outside any source, runs while the first is suspended.
  const unwrapped = (async () => {
    await Promise.resolve();
    recordGhCall(["issue", "list", "--repo", "o/r"]);
    recordGhCall(["pr", "view", "42", "--json", "mergeable"]);
    assertEquals(await meeting.arrive(), 2);
  })();

  await Promise.all([wrapped, unwrapped]);

  const snap = getGhCallMetrics();
  assertEquals(snap.graphqlTotal, 3);
  assertEquals(snap.graphqlBySource["comments-batch"], 1);
  assertEquals(snap.graphqlBySource["unattributed"], 2);
});

Deno.test("gh_call_metrics - nested enterGraphQLSource still wins inside a wrapped chain", async () => {
  resetGhCallMetrics();

  await withGraphQLSource("comments-batch", async () => {
    await Promise.resolve();
    enterGraphQLSource("timeline-batch");
    recordGhCall(["api", "graphql", "-f", "query=Inner"]);
    exitGraphQLSource();
    recordGhCall(["api", "graphql", "-f", "query=Outer"]);
  });

  const snap = getGhCallMetrics();
  assertEquals(snap.graphqlBySource["timeline-batch"], 1);
  assertEquals(snap.graphqlBySource["comments-batch"], 1);
});

Deno.test("gh_call_metrics - withGraphQLSourceContext scopes currentGraphQLSourceContext", async () => {
  resetGhCallMetrics();

  assertEquals(currentGraphQLSourceContext(), undefined);

  const seen = await withGraphQLSourceContext("Comments Batch", async () => {
    await Promise.resolve();
    return currentGraphQLSourceContext();
  });

  // Names are normalised the same way priority names are.
  assertEquals(seen, "comments-batch");
  assertEquals(currentGraphQLSourceContext(), undefined);

  // Error path: a throwing `fn` propagates and still unwinds the context.
  let thrown: unknown;
  try {
    await withGraphQLSourceContext("comments-batch", async () => {
      await Promise.resolve();
      recordGhCall(["api", "graphql", "-f", "query=Q"]);
      throw new Error("boom");
    });
  } catch (err) {
    thrown = err;
  }
  assertEquals((thrown as Error).message, "boom");
  assertEquals(currentGraphQLSourceContext(), undefined);

  recordGhCall(["api", "graphql", "-f", "query=After"]);
  const snap = getGhCallMetrics();
  assertEquals(snap.graphqlBySource["comments-batch"], 1);
  assertEquals(snap.graphqlBySource["unattributed"], 1);
});
