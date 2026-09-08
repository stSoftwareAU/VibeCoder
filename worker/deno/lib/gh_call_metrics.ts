/**
 * Per-iteration GitHub API call telemetry (Issue #1671).
 *
 * Tracks the number of `gh` CLI invocations (split by sub-command),
 * cache hits/misses/expiries, and calls saved by the cache. Used to
 * baseline and measure the impact of caching/optimisation work in
 * the broader Reduce-GH-Calls milestone (#1662).
 *
 * Counters are in-memory only and intended to be reset at the start
 * of each main-loop iteration. Use `formatGhCallSummary()` to produce
 * a one-line log entry at the end of the iteration.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isQuotaExemptGhCall } from "./primary_quota_latch.ts";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Snapshot of the metrics at a point in time.
 */
export interface GhCallMetricsSnapshot {
  /** Total number of `gh` invocations (across all sub-commands). */
  total: number;
  /** Counts grouped by sub-command bucket (e.g. "issue list", "pr view", "api"). */
  bySubCommand: Record<string, number>;
  /**
   * Counts grouped by current priority context (Issue #1845). Only calls
   * issued while a priority context was active are attributed; calls
   * outside any context are not recorded here.
   */
  byPriority: Record<string, number>;
  /** Cache hits — entry was present and within TTL. */
  cacheHits: number;
  /** Cache misses — no entry present. */
  cacheMisses: number;
  /** Cache TTL-expired — entry present but stale. */
  cacheExpired: number;
  /** Estimated calls saved by the cache (== cacheHits). */
  savedByCache: number;
  /** Per-iteration comment-cache hits (Issue #1841). */
  commentsCacheHits: number;
  /** Per-iteration comment-cache misses (Issue #1841). */
  commentsCacheMisses: number;
  /**
   * Total GraphQL-backed invocations issued this iteration (Issue #1485):
   * every `gh` sub-command (`issue list`, `pr view`, `search`, …) and the
   * explicit `gh api graphql`. Only a plain REST `gh api <path>` is not
   * GraphQL — the same predicate the primary-quota latch uses, so the two
   * cannot disagree. Before #1485 only `api graphql` was counted, and the
   * `graphql-calls:` line was a fraction of the real burn. Each GraphQL
   * request consumes at least one point from the 5000-point hourly quota,
   * so this counter is the proxy for GraphQL-budget burn rate (Issue #1924).
   */
  graphqlTotal: number;
  /**
   * Counts grouped by GraphQL caller source (Issue #1924). The source is
   * resolved in four steps: the explicit `enterGraphQLSource()` stack
   * (innermost wins), else the async-scoped `withGraphQLSource()` context
   * (Issue #1585, so two lanes running at once attribute independently),
   * else the active priority emitted as `priority:<name>` (Issue #1586),
   * else the `"unattributed"` bucket. The `priority:` prefix keeps a derived
   * bucket distinguishable from an explicit source. These values sum exactly
   * to `graphqlTotal`: every counted call chooses a bucket.
   */
  graphqlBySource: Record<string, number>;
}

const state = {
  total: 0,
  bySubCommand: new Map<string, number>(),
  byPriority: new Map<string, number>(),
  priorityStack: [] as string[],
  cacheHits: 0,
  cacheMisses: 0,
  cacheExpired: 0,
  savedByCache: 0,
  commentsCacheHits: 0,
  commentsCacheMisses: 0,
  // Issue #1924: GraphQL-specific telemetry.
  graphqlTotal: 0,
  graphqlBySource: new Map<string, number>(),
  graphqlSourceStack: [] as string[],
};

/**
 * Prefix marking a GraphQL bucket derived from the active priority rather
 * than an explicit `enterGraphQLSource()` (Issue #1586). It keeps a derived
 * bucket distinguishable from an explicit one, so a priority named the same
 * as a source cannot silently merge with it.
 */
const PRIORITY_SOURCE_PREFIX = "priority:";

/**
 * Normalise a priority name for telemetry output: lowercase, with
 * whitespace collapsed to single hyphens. The dispatch table uses
 * human-readable names like "PR Feedback"; the log line uses the
 * compact `pr-feedback` form so it parses cleanly with `awk`/`grep`.
 */
function normalisePriorityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Push a new priority context onto the stack (Issue #1845).
 *
 * Subsequent `recordGhCall` invocations attribute to the top of the
 * stack until the matching `exitPriority()` is called. Nested contexts
 * are supported — the innermost (top-of-stack) priority is credited.
 *
 * @param name - Human-readable priority name (e.g. "Stale Workflow Detection").
 */
export function enterPriority(name: string): void {
  state.priorityStack.push(normalisePriorityName(name));
}

/**
 * Pop the current priority context off the stack (Issue #1845).
 *
 * Calling this with an empty stack is a no-op so accidental
 * mismatched pairs degrade gracefully rather than throwing inside
 * the main loop.
 */
export function exitPriority(): void {
  state.priorityStack.pop();
}

/**
 * Run `fn` inside an `enterPriority(name)` / `exitPriority()` pair,
 * even if `fn` throws (Issue #1845). Returns the value of `fn`.
 */
export async function withPriority<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  enterPriority(name);
  try {
    return await fn();
  } finally {
    exitPriority();
  }
}

/**
 * Async-scoped priority attribution (Issue #213).
 *
 * The `enterPriority`/`exitPriority` stack above is process-wide, which is
 * exact only while priorities run strictly one after another. Once the
 * maintenance lane runs beside the Priority-2 pool, two priorities are in
 * flight at once and a shared stack credits each one's `gh` calls to
 * whichever pushed last. This storage binds the priority to the async chain
 * that entered it instead, so concurrent lanes attribute independently.
 *
 * The explicit stack still wins when one is active, so a nested
 * `enterPriority()` inside a handler keeps its innermost-wins semantics.
 */
const priorityStorage = new AsyncLocalStorage<string>();

/**
 * Run `fn` with its `gh` calls attributed to `name`, for the whole async
 * chain and for nothing running beside it (Issue #213).
 */
export function withPriorityContext<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return priorityStorage.run(normalisePriorityName(name), fn);
}

/** The priority the current async chain runs under, if any (Issue #213). */
export function currentPriorityContext(): string | undefined {
  return priorityStorage.getStore();
}

/**
 * Classify a `gh` argument list into a sub-command bucket.
 *
 * Returns a short label for telemetry: `"issue list"`, `"pr view"`,
 * `"api"`, etc. Skips leading flags so `gh --version issue list`
 * still resolves to `"issue list"`.
 *
 * @param args - Argument list passed to the `gh` binary.
 */
export function classifyGhArgs(args: readonly string[]): string {
  // Find first non-flag token
  let i = 0;
  let cur = args[i];
  while (cur !== undefined && cur.startsWith("-")) {
    i++;
    cur = args[i];
  }
  const head = cur;
  if (!head) return "unknown";

  // For two-word sub-commands (issue/pr/repo/etc.), include the verb.
  const twoWordRoots = new Set([
    "issue",
    "pr",
    "repo",
    "label",
    "release",
    "run",
    "workflow",
    "secret",
    "variable",
    "ssh-key",
    "gist",
    "auth",
    "cache",
  ]);

  if (twoWordRoots.has(head)) {
    // Find next non-flag token
    let j = i + 1;
    let next = args[j];
    while (next !== undefined && next.startsWith("-")) {
      j++;
      next = args[j];
    }
    if (next) {
      return `${head} ${next}`;
    }
    return head;
  }

  // Issue #1924: split `api graphql` from REST `api` calls so the
  // bySubCommand bucket and downstream telemetry can distinguish the
  // 5000-point/hour GraphQL quota from the 5000-call/hour REST quota.
  if (head === "api") {
    let j = i + 1;
    let next = args[j];
    while (next !== undefined && next.startsWith("-")) {
      j++;
      next = args[j];
    }
    if (next === "graphql") {
      return "api graphql";
    }
    return "api";
  }

  return head;
}

/**
 * Push a GraphQL caller source onto the stack (Issue #1924).
 *
 * Subsequent `recordGhCall` invocations that match the GraphQL shape
 * attribute to the top of the stack until the matching
 * `exitGraphQLSource()` is called. Use a short, stable identifier
 * (e.g. `pr-linkage`, `milestone-health`) so log readers can group
 * across runs.
 */
export function enterGraphQLSource(name: string): void {
  state.graphqlSourceStack.push(normalisePriorityName(name));
}

/**
 * Pop the current GraphQL caller source off the stack (Issue #1924).
 * No-op on an empty stack so mismatched pairs degrade gracefully.
 */
export function exitGraphQLSource(): void {
  state.graphqlSourceStack.pop();
}

/**
 * Async-scoped GraphQL source attribution (Issue #1585).
 *
 * The `enterGraphQLSource`/`exitGraphQLSource` stack above is process-wide,
 * which is exact only while sources run strictly one after another. Every
 * wrapper is `await`-ed around a `gh` spawn, so while `comment_batch.ts` is
 * awaiting its `api graphql` call, any `gh issue list` or `gh pr view` issued
 * by a lane running beside it was credited to `comments-batch`. This storage
 * binds the source to the async chain that entered it instead, so concurrent
 * lanes attribute independently — the same fix Issue #213 applied to the
 * priority axis.
 *
 * The explicit stack still wins when one is active, so an `enterGraphQLSource()`
 * nested inside a wrapped chain keeps its innermost-wins semantics. The reverse
 * nesting changed with this fix, and it is the trade-off the priority axis
 * already made: an explicit source wrapping a `withGraphQLSource` chain now
 * wins over the inner one, because the stack is consulted first. No production
 * call site enters a source explicitly, so nothing depends on the old order.
 *
 * Finding (Issue #1571) — the parent's unresolved caveat, that the attributed
 * buckets summed to 40 against an `api-graphql` sub-command counter of 23 for
 * the same cycle. Which answer holds depends on which 40 was read, and both
 * readings are now accounted for:
 *
 * - Summed over the NAMED buckets only, cross-crediting explains it. Every
 *   `withGraphQLSource` call site wraps exactly one `gh api graphql` spawn, so
 *   absent concurrency the named buckets sum to exactly the `api graphql`
 *   count. The reproduction in `tests/gh_call_metrics_test.ts` ("concurrent
 *   chains do not cross-credit GraphQL sources") shows a suspended
 *   `comments-batch` chain absorbing two unrelated sub-command calls from the
 *   lane beside it — the only mechanism by which a named bucket can outgrow
 *   that count. This fix removes it.
 * - Summed over ALL buckets including `unattributed`, no cross-crediting is
 *   needed: since Issue #1485 `graphqlBySource` counts every GraphQL-backed
 *   sub-command (`issue list`, `pr view`, `search`, …), while
 *   `bySubCommand["api graphql"]` counts only the explicit ones. The two
 *   counters measure different sets by design, so a total above the
 *   `api graphql` count is expected and is not a defect.
 */
const graphqlSourceStorage = new AsyncLocalStorage<string>();

/**
 * Run `fn` with its GraphQL-backed `gh` calls attributed to `name`, for the
 * whole async chain and for nothing running beside it (Issue #1585).
 */
export function withGraphQLSourceContext<T>(
  name: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return graphqlSourceStorage.run(
    normalisePriorityName(name),
    async () => await fn(),
  );
}

/** The GraphQL source the current async chain runs under, if any (#1585). */
export function currentGraphQLSourceContext(): string | undefined {
  return graphqlSourceStorage.getStore();
}

/**
 * Run `fn` attributed to the GraphQL caller source `name` (Issue #1924).
 *
 * Issue #1585: implemented on the async-scoped context above, so every
 * existing call site became concurrency-safe with no edit. An explicit
 * `enterGraphQLSource()` nested inside `fn` still wins.
 */
export function withGraphQLSource<T>(
  name: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withGraphQLSourceContext(name, fn);
}

/**
 * Record a single `gh` invocation with the given argument list.
 *
 * If a priority context is active (see `enterPriority`), the call is
 * also attributed to the innermost priority for the per-priority
 * breakdown emitted at end of iteration (Issue #1845).
 */
export function recordGhCall(args: readonly string[]): void {
  state.total++;
  const bucket = classifyGhArgs(args);
  state.bySubCommand.set(bucket, (state.bySubCommand.get(bucket) ?? 0) + 1);

  // Issue #1845: attribute to the innermost priority context, if any.
  // Issue #213: an explicit stack entry still wins (innermost-wins for a
  // nested `enterPriority` inside a handler); otherwise the async-scoped
  // context attributes the call, so concurrent lanes do not cross-credit.
  const top = state.priorityStack[state.priorityStack.length - 1] ??
    priorityStorage.getStore();
  if (top) {
    state.byPriority.set(top, (state.byPriority.get(top) ?? 0) + 1);
  }

  // Issue #1924: GraphQL-specific attribution. Issue #1485: what counts as
  // GraphQL is decided once, in primary_quota_latch.ts — every `gh`
  // sub-command is GraphQL-backed; only a plain REST `gh api <path>` is not.
  if (!isQuotaExemptGhCall(args)) {
    state.graphqlTotal++;
    // Issue #1585: an explicit stack entry still wins (innermost-wins for a
    // nested `enterGraphQLSource`); otherwise the async-scoped context
    // attributes the call, so concurrent lanes do not cross-credit.
    // Issue #1586: failing both, fall back to the priority resolved above so
    // the ordinary `issue list` / `pr list` traffic — which no module wraps in
    // a GraphQL source — lands in a named bucket rather than `unattributed`.
    const src = state.graphqlSourceStack[state.graphqlSourceStack.length - 1] ??
      graphqlSourceStorage.getStore() ??
      (top ? `${PRIORITY_SOURCE_PREFIX}${top}` : "unattributed");
    state.graphqlBySource.set(
      src,
      (state.graphqlBySource.get(src) ?? 0) + 1,
    );
  }
}

/** Record a cache hit (saved one `gh` call). */
export function recordCacheHit(): void {
  state.cacheHits++;
  state.savedByCache++;
}

/** Record a cache miss (no entry present). */
export function recordCacheMiss(): void {
  state.cacheMisses++;
}

/** Record a TTL-expired cache lookup. */
export function recordCacheExpired(): void {
  state.cacheExpired++;
}

/** Record a comment-cache hit (Issue #1841). */
export function recordCommentsCacheHit(): void {
  state.commentsCacheHits++;
}

/** Record a comment-cache miss (Issue #1841). */
export function recordCommentsCacheMiss(): void {
  state.commentsCacheMisses++;
}

/**
 * Reset all counters to zero. Call at the start of each iteration.
 *
 * Issue #1845: also clears the per-priority counts and the active
 * priority stack so counts cannot leak across the run-core loop
 * boundary.
 */
export function resetGhCallMetrics(): void {
  state.total = 0;
  state.bySubCommand.clear();
  state.byPriority.clear();
  state.priorityStack.length = 0;
  state.cacheHits = 0;
  state.cacheMisses = 0;
  state.cacheExpired = 0;
  state.savedByCache = 0;
  state.commentsCacheHits = 0;
  state.commentsCacheMisses = 0;
  // Issue #1924: reset GraphQL counters and source stack.
  state.graphqlTotal = 0;
  state.graphqlBySource.clear();
  state.graphqlSourceStack.length = 0;
}

/**
 * Get a snapshot of the current metrics.
 */
export function getGhCallMetrics(): GhCallMetricsSnapshot {
  const bySubCommand: Record<string, number> = {};
  for (const [name, count] of state.bySubCommand) {
    bySubCommand[name] = count;
  }
  const byPriority: Record<string, number> = {};
  for (const [name, count] of state.byPriority) {
    byPriority[name] = count;
  }
  const graphqlBySource: Record<string, number> = {};
  for (const [name, count] of state.graphqlBySource) {
    graphqlBySource[name] = count;
  }
  return {
    total: state.total,
    bySubCommand,
    byPriority,
    cacheHits: state.cacheHits,
    cacheMisses: state.cacheMisses,
    cacheExpired: state.cacheExpired,
    savedByCache: state.savedByCache,
    commentsCacheHits: state.commentsCacheHits,
    commentsCacheMisses: state.commentsCacheMisses,
    graphqlTotal: state.graphqlTotal,
    graphqlBySource,
  };
}

/**
 * Format a one-line summary of the current metrics for end-of-iteration
 * logging.
 *
 * Example: `gh-calls: 17 total, 12 saved-by-cache, 0 expired, issue-list=5, pr-list=3, api=9`
 */
export function formatGhCallSummary(): string {
  const snap = getGhCallMetrics();
  const buckets = Object.entries(snap.bySubCommand)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name.replace(/\s+/g, "-")}=${count}`)
    .join(", ");

  const parts = [
    `${snap.total} total`,
    `${snap.savedByCache} saved-by-cache`,
    `${snap.cacheExpired} expired`,
  ];

  // Issue #1841: surface comments-cache hits/misses when the cache
  // has been touched this iteration. Suppress the field entirely when
  // both counters are zero so existing log readers and tests are not
  // distracted by inert noise.
  if (snap.commentsCacheHits > 0 || snap.commentsCacheMisses > 0) {
    parts.push(
      `comments-cache=hit:${snap.commentsCacheHits}/miss:${snap.commentsCacheMisses}`,
    );
  }

  if (buckets) parts.push(buckets);

  return `gh-calls: ${parts.join(", ")}`;
}

/**
 * Format the per-priority `gh` call breakdown for end-of-iteration
 * logging (Issue #1845). Priorities are sorted descending by call
 * count so the noisiest priority is named first.
 *
 * Returns `gh-calls-by-priority: none` when no priority context
 * recorded any calls in the current iteration, so log readers always
 * see one well-formed line per cycle.
 *
 * Example:
 *   `gh-calls-by-priority: stale-workflow-detection=42 milestone-completions=15 auto-merge=12`
 */
export function formatGhCallsByPrioritySummary(): string {
  const snap = getGhCallMetrics();
  const entries = Object.entries(snap.byPriority);
  if (entries.length === 0) {
    return "gh-calls-by-priority: none";
  }
  const parts = entries
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
  return `gh-calls-by-priority: ${parts}`;
}

/**
 * Format a one-line GraphQL breakdown for end-of-iteration logging
 * (Issue #1924). Surfaces the total number of GraphQL invocations this
 * iteration plus a per-caller-source attribution sorted descending, so
 * the hottest GraphQL path is named first.
 *
 * GraphQL is metered separately from REST (5000 points/hour vs
 * 5000 calls/hour), and each GraphQL-backed request consumes at least one
 * point. This summary is the operator-facing signal for the 5000-point
 * quota burn rate, and since Issue #1485 it counts every GraphQL-backed
 * call the process makes — `gh issue list`, `gh pr view`, `gh search`, as
 * well as `gh api graphql` — recorded at the `gh` spawn chokepoint, so no
 * module can issue one uncounted.
 *
 * Example:
 *   `graphql-calls: 245 total, pr-linkage=110, milestone-health=45,
 *   check-runs=30`
 *
 * Each call is attributed by the four-step resolution in `recordGhCall`:
 * the explicit `enterGraphQLSource()` stack, else the async-scoped
 * `withGraphQLSource()` context, else the active priority — emitted with a
 * `priority:` prefix (Issue #1586) so a derived bucket is never confused with
 * an explicit source — else `unattributed`. Since #1586 the ordinary
 * `issue list` / `pr list` / `issue view` traffic lands under its priority,
 * so `unattributed` is an anomaly signal: a call issued outside both a source
 * and a priority context, i.e. a pass that forgot to wrap itself. The buckets
 * sum exactly to the total.
 */
export function formatGraphQLSummary(): string {
  const snap = getGhCallMetrics();
  if (snap.graphqlTotal === 0) {
    return "graphql-calls: 0 total";
  }
  const parts = Object.entries(snap.graphqlBySource)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}=${count}`);
  return `graphql-calls: ${snap.graphqlTotal} total, ${parts.join(", ")}`;
}
