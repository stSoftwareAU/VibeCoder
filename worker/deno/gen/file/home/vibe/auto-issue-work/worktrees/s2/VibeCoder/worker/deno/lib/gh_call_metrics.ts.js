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
 */ import { ghCallKindOf, ghFlagNames, ghPositionalArgs } from "./gh_argv.ts";
import { isQuotaExemptGhCall } from "./primary_quota_latch.ts";
import { AsyncLocalStorage } from "node:async_hooks";
const state = {
  total: 0,
  bySubCommand: new Map(),
  byPriority: new Map(),
  priorityStack: [],
  cacheHits: 0,
  cacheMisses: 0,
  cacheExpired: 0,
  savedByCache: 0,
  commentsCacheHits: 0,
  commentsCacheMisses: 0,
  // Issue #1924: GraphQL-specific telemetry.
  graphqlTotal: 0,
  graphqlBySource: new Map(),
  graphqlSourceStack: [],
  // Issue #2409: GraphQL spend by call shape.
  graphqlByShape: new Map()
};
/**
 * Prefix marking a GraphQL bucket derived from the active priority rather
 * than an explicit source (Issue #1586). See `recordGhCall` for the
 * resolution order it is applied in.
 */ const PRIORITY_SOURCE_PREFIX = "priority:";
/**
 * Normalise a priority name for telemetry output: lowercase, with
 * whitespace collapsed to single hyphens. The dispatch table uses
 * human-readable names like "PR Feedback"; the log line uses the
 * compact `pr-feedback` form so it parses cleanly with `awk`/`grep`.
 */ function normalisePriorityName(name) {
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
 */ export function enterPriority(name) {
  state.priorityStack.push(normalisePriorityName(name));
}
/**
 * Pop the current priority context off the stack (Issue #1845).
 *
 * Calling this with an empty stack is a no-op so accidental
 * mismatched pairs degrade gracefully rather than throwing inside
 * the main loop.
 */ export function exitPriority() {
  state.priorityStack.pop();
}
/**
 * Run `fn` inside an `enterPriority(name)` / `exitPriority()` pair,
 * even if `fn` throws (Issue #1845). Returns the value of `fn`.
 */ export async function withPriority(name, fn) {
  enterPriority(name);
  try {
    return await fn();
  } finally{
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
 */ const priorityStorage = new AsyncLocalStorage();
/**
 * Run `fn` with its `gh` calls attributed to `name`, for the whole async
 * chain and for nothing running beside it (Issue #213).
 */ export function withPriorityContext(name, fn) {
  return priorityStorage.run(normalisePriorityName(name), fn);
}
/** The priority the current async chain runs under, if any (Issue #213). */ export function currentPriorityContext() {
  return priorityStorage.getStore();
}
/**
 * Classify a `gh` argument list into a sub-command bucket.
 *
 * Returns a short label for telemetry: `"issue list"`, `"pr view"`,
 * `"api"`, `"api graphql"`, etc.
 *
 * Issue #1588: the argv itself is parsed by the shared classifier in
 * `gh_argv.ts` — flag-aware, so `gh --version issue list` still resolves to
 * `"issue list"` and a value-taking flag's value is never read as a
 * positional token. That is the same parse `isQuotaExemptGhCall` uses, so the
 * `api graphql` bucket and the GraphQL-quota predicate cannot disagree about
 * what an `api graphql` invocation is.
 *
 * @param args - Argument list passed to the `gh` binary.
 */ export function classifyGhArgs(args) {
  const positionals = ghPositionalArgs(args);
  const head = positionals[0];
  if (!head) return "unknown";
  // Issue #1924: split `api graphql` from REST `api` calls so the
  // bySubCommand bucket and downstream telemetry can distinguish the
  // 5000-point/hour GraphQL quota from the 5000-call/hour REST quota.
  if (head === "api") {
    return ghCallKindOf(positionals) === "api-graphql" ? "api graphql" : "api";
  }
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
    "cache"
  ]);
  if (twoWordRoots.has(head)) {
    const verb = positionals[1];
    return verb ? `${head} ${verb}` : head;
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
 */ export function enterGraphQLSource(name) {
  state.graphqlSourceStack.push(normalisePriorityName(name));
}
/**
 * Pop the current GraphQL caller source off the stack (Issue #1924).
 * No-op on an empty stack so mismatched pairs degrade gracefully.
 */ export function exitGraphQLSource() {
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
 */ const graphqlSourceStorage = new AsyncLocalStorage();
/**
 * Run `fn` with its GraphQL-backed `gh` calls attributed to `name`, for the
 * whole async chain and for nothing running beside it (Issue #1585).
 */ export function withGraphQLSourceContext(name, fn) {
  return graphqlSourceStorage.run(normalisePriorityName(name), async ()=>await fn());
}
/** The GraphQL source the current async chain runs under, if any (#1585). */ export function currentGraphQLSourceContext() {
  return graphqlSourceStorage.getStore();
}
/**
 * Run `fn` attributed to the GraphQL caller source `name` (Issue #1924).
 *
 * Issue #1585: implemented on the async-scoped context above, so every
 * existing call site became concurrency-safe with no edit. An explicit
 * `enterGraphQLSource()` nested inside `fn` still wins.
 */ export function withGraphQLSource(name, fn) {
  return withGraphQLSourceContext(name, fn);
}
/**
 * Record a single `gh` invocation with the given argument list.
 *
 * If a priority context is active (see `enterPriority`), the call is
 * also attributed to the innermost priority for the per-priority
 * breakdown emitted at end of iteration (Issue #1845).
 */ export function recordGhCall(args) {
  state.total++;
  const bucket = classifyGhArgs(args);
  state.bySubCommand.set(bucket, (state.bySubCommand.get(bucket) ?? 0) + 1);
  // Issue #1845: attribute to the innermost priority context, if any.
  // Issue #213: an explicit stack entry still wins (innermost-wins for a
  // nested `enterPriority` inside a handler); otherwise the async-scoped
  // context attributes the call, so concurrent lanes do not cross-credit.
  const top = state.priorityStack[state.priorityStack.length - 1] ?? priorityStorage.getStore();
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
    const src = state.graphqlSourceStack[state.graphqlSourceStack.length - 1] ?? graphqlSourceStorage.getStore() ?? (top ? `${PRIORITY_SOURCE_PREFIX}${top}` : "unattributed");
    state.graphqlBySource.set(src, (state.graphqlBySource.get(src) ?? 0) + 1);
    // Issue #2409: and by shape, so the log names *which* listing is spending
    // the quota, not only that `pr list` is.
    const classified = classifyGhShape(args);
    const shape = state.graphqlByShape.has(classified) || state.graphqlByShape.size < MAX_TRACKED_SHAPES ? classified : OVERFLOW_SHAPE;
    state.graphqlByShape.set(shape, (state.graphqlByShape.get(shape) ?? 0) + 1);
  }
}
/** Distinct shapes tracked per cycle; the worker has a few dozen in all. */ const MAX_TRACKED_SHAPES = 200;
/** Where calls go once {@link MAX_TRACKED_SHAPES} distinct shapes are held. */ const OVERFLOW_SHAPE = "(other shapes)";
/** Longest shape recorded — a bound, not a formatting choice. */ const MAX_SHAPE_CHARS = 160;
// REST path segments that name a route rather than a thing. Anything else in a
// path — an owner, a repository, a branch, a login — is replaced, so a shape
// can never carry one.
const REST_ROUTE_WORDS = new Set([
  "actions",
  "alerts",
  "app",
  "assignees",
  "branches",
  "check-runs",
  "check-suites",
  "code-scanning",
  "collaborators",
  "comments",
  "commits",
  "compare",
  "contents",
  "dependabot",
  "events",
  "git",
  "graphql",
  "heads",
  "installation",
  "issues",
  "jobs",
  "labels",
  "logs",
  "merge",
  "milestones",
  "orgs",
  "pulls",
  "rate_limit",
  "refs",
  "releases",
  "repos",
  "reviews",
  "rulesets",
  "runs",
  "search",
  "secret-scanning",
  "status",
  "statuses",
  "sub_issues",
  "tags",
  "timeline",
  "user",
  "users",
  "workflows"
]);
/** Reduce a REST path to its route: `repos/:owner/:repo/issues/:n/timeline`. */ function restRoute(path) {
  const segments = path.split("?")[0].replace(/^\/+/, "").split("/");
  return segments.map((segment, index)=>{
    if (segments[0] === "repos" && index === 1) return ":owner";
    if (segments[0] === "repos" && index === 2) return ":repo";
    if (/^\d+$/.test(segment)) return ":n";
    return REST_ROUTE_WORDS.has(segment) ? segment : ":x";
  }).join("/");
}
/**
 * The **shape** of a `gh` call: its sub-command and its flag names, sorted
 * (Issue #2409).
 *
 * The fleet was exhausting its GitHub GraphQL quota ~25 minutes into every
 * hour. The metrics could say `pr-list=135` a cycle, but not *which* `pr list`
 * — by author? by head branch? closed? — so the largest consumers could only
 * be guessed at from the code. Two calls have the same shape when they differ
 * only in values, which is what makes a shape countable.
 *
 * **No argument value ever reaches a shape.** A value can be a private
 * repository, a search string, a title or a body, and this string is logged.
 * Flag values are dropped by {@link ghFlagNames}; a REST path is reduced to
 * its route by an allow-list of route words.
 *
 * @param args - Argument list passed to the `gh` binary.
 */ export function classifyGhShape(args) {
  const head = classifyGhArgs(args);
  const route = head === "api" ? [
    restRoute(ghPositionalArgs(args)[1] ?? "")
  ] : [];
  const fields = jsonFieldList(args);
  const stateWord = flagValue(args, "--state");
  const state = stateWord !== undefined && GH_STATE_WORDS.has(stateWord) ? stateWord : undefined;
  const flags = [
    ...new Set(ghFlagNames(args))
  ].sort().map((flag)=>{
    if (flag === "--json" && fields !== undefined) return `--json=${fields}`;
    if (flag === "--state" && state !== undefined) return `--state=${state}`;
    return flag;
  });
  return [
    head,
    ...route,
    ...flags
  ].join(" ").slice(0, MAX_SHAPE_CHARS);
}
/** Longest `--json` field list shown; a longer one keeps the bare flag. */ const MAX_JSON_FIELDS_CHARS = 100;
// A `--json` value the worker wrote itself: GraphQL field names, comma
// separated. Anything else — a slash, a space, an `=` — is not a field list
// and is never shown.
const JSON_FIELD_LIST = /^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/;
/**
 * The `--json` field list of a `gh` invocation, when it is safe to show.
 *
 * `--json` is the one flag whose value is part of the call's *shape* rather
 * than its subject: `issue view --json state` (a dependency check) and
 * `issue view --json title,body,comments` (a content read) cost differently
 * and are fixed differently, and with the bare flag the two are one line
 * (Issue #2409). Every other flag's value stays out.
 *
 * @param args - Argument list passed to the `gh` binary.
 * @returns The field list, or `undefined` when absent or not bare identifiers.
 */ function jsonFieldList(args) {
  const value = flagValue(args, "--json");
  return value !== undefined && value.length <= MAX_JSON_FIELDS_CHARS && JSON_FIELD_LIST.test(value) ? value : undefined;
}
// Every word `gh … --state` accepts. A closed set, so the word is part of the
// call's shape — an open listing must refresh, a merged one need not — and
// anything outside the set is a caller's value and is never shown.
const GH_STATE_WORDS = new Set([
  "open",
  "closed",
  "merged",
  "all"
]);
/** The first value given to `flag`, as `--flag value` or `--flag=value`. */ function flagValue(args, flag) {
  for(let i = 0; i < args.length; i++){
    const token = args[i];
    if (token === "--") return undefined;
    if (token === flag) return args[i + 1];
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}
/** Record a cache hit (saved one `gh` call). */ export function recordCacheHit() {
  state.cacheHits++;
  state.savedByCache++;
}
/** Record a cache miss (no entry present). */ export function recordCacheMiss() {
  state.cacheMisses++;
}
/** Record a TTL-expired cache lookup. */ export function recordCacheExpired() {
  state.cacheExpired++;
}
/** Record a comment-cache hit (Issue #1841). */ export function recordCommentsCacheHit() {
  state.commentsCacheHits++;
}
/** Record a comment-cache miss (Issue #1841). */ export function recordCommentsCacheMiss() {
  state.commentsCacheMisses++;
}
/**
 * Reset all counters to zero. Call at the start of each iteration.
 *
 * Issue #1845: also clears the per-priority counts and the active
 * priority stack so counts cannot leak across the run-core loop
 * boundary.
 */ export function resetGhCallMetrics() {
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
  state.graphqlByShape.clear();
  state.graphqlSourceStack.length = 0;
}
/**
 * Get a snapshot of the current metrics.
 */ export function getGhCallMetrics() {
  const bySubCommand = {};
  for (const [name, count] of state.bySubCommand){
    bySubCommand[name] = count;
  }
  const byPriority = {};
  for (const [name, count] of state.byPriority){
    byPriority[name] = count;
  }
  const graphqlBySource = {};
  for (const [name, count] of state.graphqlBySource){
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
    graphqlBySource
  };
}
/**
 * Format a one-line summary of the current metrics for end-of-iteration
 * logging.
 *
 * Example: `gh-calls: 17 total, 12 saved-by-cache, 0 expired, issue-list=5, pr-list=3, api=9`
 */ export function formatGhCallSummary() {
  const snap = getGhCallMetrics();
  const buckets = Object.entries(snap.bySubCommand).sort((a, b)=>b[1] - a[1]).map(([name, count])=>`${name.replace(/\s+/g, "-")}=${count}`).join(", ");
  const parts = [
    `${snap.total} total`,
    `${snap.savedByCache} saved-by-cache`,
    `${snap.cacheExpired} expired`
  ];
  // Issue #1841: surface comments-cache hits/misses when the cache
  // has been touched this iteration. Suppress the field entirely when
  // both counters are zero so existing log readers and tests are not
  // distracted by inert noise.
  if (snap.commentsCacheHits > 0 || snap.commentsCacheMisses > 0) {
    parts.push(`comments-cache=hit:${snap.commentsCacheHits}/miss:${snap.commentsCacheMisses}`);
  }
  if (buckets) parts.push(buckets);
  return `gh-calls: ${parts.join(", ")}`;
}
/**
 * The busiest GraphQL call shapes this cycle (Issue #2409).
 *
 * GraphQL-backed calls only — REST rides a separate quota. Always one
 * well-formed line, so a cycle with none reads `graphql-shapes: none`.
 *
 * Example:
 *   `graphql-shapes: 41×[pr list --author --json --limit --repo --state], 20×[issue list --json --label --limit --repo --state]`
 *
 * @param topShapes - How many shapes to name, busiest first.
 */ export function formatGhCallShapesSummary(topShapes = 8) {
  const top = [
    ...state.graphqlByShape.entries()
  ].sort((a, b)=>b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.max(0, topShapes)).map(([shape, count])=>`${count}×[${shape}]`).join(", ");
  return `graphql-shapes: ${top || "none"}`;
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
 */ export function formatGhCallsByPrioritySummary() {
  const snap = getGhCallMetrics();
  const entries = Object.entries(snap.byPriority);
  if (entries.length === 0) {
    return "gh-calls-by-priority: none";
  }
  const parts = entries.sort((a, b)=>b[1] - a[1]).map(([name, count])=>`${name}=${count}`).join(" ");
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
 * Each call is attributed by the resolution order in `recordGhCall`, so since
 * Issue #1586 the ordinary `issue list` / `pr list` / `issue view` traffic
 * lands under its priority as `priority:<name>`. `unattributed` is therefore
 * an anomaly signal rather than the normal case: a call issued outside both a
 * source and a priority context, i.e. a pass that forgot to wrap itself.
 */ export function formatGraphQLSummary() {
  const snap = getGhCallMetrics();
  if (snap.graphqlTotal === 0) {
    return "graphql-calls: 0 total";
  }
  const parts = Object.entries(snap.graphqlBySource).sort((a, b)=>b[1] - a[1]).map(([name, count])=>`${name}=${count}`);
  return `graphql-calls: ${snap.graphqlTotal} total, ${parts.join(", ")}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9jYWxsX21ldHJpY3MudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBQZXItaXRlcmF0aW9uIEdpdEh1YiBBUEkgY2FsbCB0ZWxlbWV0cnkgKElzc3VlICMxNjcxKS5cbiAqXG4gKiBUcmFja3MgdGhlIG51bWJlciBvZiBgZ2hgIENMSSBpbnZvY2F0aW9ucyAoc3BsaXQgYnkgc3ViLWNvbW1hbmQpLFxuICogY2FjaGUgaGl0cy9taXNzZXMvZXhwaXJpZXMsIGFuZCBjYWxscyBzYXZlZCBieSB0aGUgY2FjaGUuIFVzZWQgdG9cbiAqIGJhc2VsaW5lIGFuZCBtZWFzdXJlIHRoZSBpbXBhY3Qgb2YgY2FjaGluZy9vcHRpbWlzYXRpb24gd29yayBpblxuICogdGhlIGJyb2FkZXIgUmVkdWNlLUdILUNhbGxzIG1pbGVzdG9uZSAoIzE2NjIpLlxuICpcbiAqIENvdW50ZXJzIGFyZSBpbi1tZW1vcnkgb25seSBhbmQgaW50ZW5kZWQgdG8gYmUgcmVzZXQgYXQgdGhlIHN0YXJ0XG4gKiBvZiBlYWNoIG1haW4tbG9vcCBpdGVyYXRpb24uIFVzZSBgZm9ybWF0R2hDYWxsU3VtbWFyeSgpYCB0byBwcm9kdWNlXG4gKiBhIG9uZS1saW5lIGxvZyBlbnRyeSBhdCB0aGUgZW5kIG9mIHRoZSBpdGVyYXRpb24uXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHsgZ2hDYWxsS2luZE9mLCBnaEZsYWdOYW1lcywgZ2hQb3NpdGlvbmFsQXJncyB9IGZyb20gXCIuL2doX2FyZ3YudHNcIjtcbmltcG9ydCB7IGlzUXVvdGFFeGVtcHRHaENhbGwgfSBmcm9tIFwiLi9wcmltYXJ5X3F1b3RhX2xhdGNoLnRzXCI7XG5pbXBvcnQgeyBBc3luY0xvY2FsU3RvcmFnZSB9IGZyb20gXCJub2RlOmFzeW5jX2hvb2tzXCI7XG5cbi8qKlxuICogU25hcHNob3Qgb2YgdGhlIG1ldHJpY3MgYXQgYSBwb2ludCBpbiB0aW1lLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEdoQ2FsbE1ldHJpY3NTbmFwc2hvdCB7XG4gIC8qKiBUb3RhbCBudW1iZXIgb2YgYGdoYCBpbnZvY2F0aW9ucyAoYWNyb3NzIGFsbCBzdWItY29tbWFuZHMpLiAqL1xuICB0b3RhbDogbnVtYmVyO1xuICAvKiogQ291bnRzIGdyb3VwZWQgYnkgc3ViLWNvbW1hbmQgYnVja2V0IChlLmcuIFwiaXNzdWUgbGlzdFwiLCBcInByIHZpZXdcIiwgXCJhcGlcIikuICovXG4gIGJ5U3ViQ29tbWFuZDogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbiAgLyoqXG4gICAqIENvdW50cyBncm91cGVkIGJ5IGN1cnJlbnQgcHJpb3JpdHkgY29udGV4dCAoSXNzdWUgIzE4NDUpLiBPbmx5IGNhbGxzXG4gICAqIGlzc3VlZCB3aGlsZSBhIHByaW9yaXR5IGNvbnRleHQgd2FzIGFjdGl2ZSBhcmUgYXR0cmlidXRlZDsgY2FsbHNcbiAgICogb3V0c2lkZSBhbnkgY29udGV4dCBhcmUgbm90IHJlY29yZGVkIGhlcmUuXG4gICAqL1xuICBieVByaW9yaXR5OiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xuICAvKiogQ2FjaGUgaGl0cyDigJQgZW50cnkgd2FzIHByZXNlbnQgYW5kIHdpdGhpbiBUVEwuICovXG4gIGNhY2hlSGl0czogbnVtYmVyO1xuICAvKiogQ2FjaGUgbWlzc2VzIOKAlCBubyBlbnRyeSBwcmVzZW50LiAqL1xuICBjYWNoZU1pc3NlczogbnVtYmVyO1xuICAvKiogQ2FjaGUgVFRMLWV4cGlyZWQg4oCUIGVudHJ5IHByZXNlbnQgYnV0IHN0YWxlLiAqL1xuICBjYWNoZUV4cGlyZWQ6IG51bWJlcjtcbiAgLyoqIEVzdGltYXRlZCBjYWxscyBzYXZlZCBieSB0aGUgY2FjaGUgKD09IGNhY2hlSGl0cykuICovXG4gIHNhdmVkQnlDYWNoZTogbnVtYmVyO1xuICAvKiogUGVyLWl0ZXJhdGlvbiBjb21tZW50LWNhY2hlIGhpdHMgKElzc3VlICMxODQxKS4gKi9cbiAgY29tbWVudHNDYWNoZUhpdHM6IG51bWJlcjtcbiAgLyoqIFBlci1pdGVyYXRpb24gY29tbWVudC1jYWNoZSBtaXNzZXMgKElzc3VlICMxODQxKS4gKi9cbiAgY29tbWVudHNDYWNoZU1pc3NlczogbnVtYmVyO1xuICAvKipcbiAgICogVG90YWwgR3JhcGhRTC1iYWNrZWQgaW52b2NhdGlvbnMgaXNzdWVkIHRoaXMgaXRlcmF0aW9uIChJc3N1ZSAjMTQ4NSk6XG4gICAqIGV2ZXJ5IGBnaGAgc3ViLWNvbW1hbmQgKGBpc3N1ZSBsaXN0YCwgYHByIHZpZXdgLCBgc2VhcmNoYCwg4oCmKSBhbmQgdGhlXG4gICAqIGV4cGxpY2l0IGBnaCBhcGkgZ3JhcGhxbGAuIE9ubHkgYSBwbGFpbiBSRVNUIGBnaCBhcGkgPHBhdGg+YCBpcyBub3RcbiAgICogR3JhcGhRTCDigJQgdGhlIHNhbWUgcHJlZGljYXRlIHRoZSBwcmltYXJ5LXF1b3RhIGxhdGNoIHVzZXMsIHNvIHRoZSB0d29cbiAgICogY2Fubm90IGRpc2FncmVlLiBCZWZvcmUgIzE0ODUgb25seSBgYXBpIGdyYXBocWxgIHdhcyBjb3VudGVkLCBhbmQgdGhlXG4gICAqIGBncmFwaHFsLWNhbGxzOmAgbGluZSB3YXMgYSBmcmFjdGlvbiBvZiB0aGUgcmVhbCBidXJuLiBFYWNoIEdyYXBoUUxcbiAgICogcmVxdWVzdCBjb25zdW1lcyBhdCBsZWFzdCBvbmUgcG9pbnQgZnJvbSB0aGUgNTAwMC1wb2ludCBob3VybHkgcXVvdGEsXG4gICAqIHNvIHRoaXMgY291bnRlciBpcyB0aGUgcHJveHkgZm9yIEdyYXBoUUwtYnVkZ2V0IGJ1cm4gcmF0ZSAoSXNzdWUgIzE5MjQpLlxuICAgKi9cbiAgZ3JhcGhxbFRvdGFsOiBudW1iZXI7XG4gIC8qKlxuICAgKiBDb3VudHMgZ3JvdXBlZCBieSBHcmFwaFFMIGNhbGxlciBzb3VyY2UgKElzc3VlICMxOTI0KS4gVGhlIHNvdXJjZSBpc1xuICAgKiByZXNvbHZlZCBpbiBmb3VyIHN0ZXBzOiB0aGUgZXhwbGljaXQgYGVudGVyR3JhcGhRTFNvdXJjZSgpYCBzdGFja1xuICAgKiAoaW5uZXJtb3N0IHdpbnMpLCBlbHNlIHRoZSBhc3luYy1zY29wZWQgYHdpdGhHcmFwaFFMU291cmNlKClgIGNvbnRleHRcbiAgICogKElzc3VlICMxNTg1LCBzbyB0d28gbGFuZXMgcnVubmluZyBhdCBvbmNlIGF0dHJpYnV0ZSBpbmRlcGVuZGVudGx5KSxcbiAgICogZWxzZSB0aGUgYWN0aXZlIHByaW9yaXR5IGVtaXR0ZWQgYXMgYHByaW9yaXR5OjxuYW1lPmAgKElzc3VlICMxNTg2KSxcbiAgICogZWxzZSB0aGUgYFwidW5hdHRyaWJ1dGVkXCJgIGJ1Y2tldC4gVGhlIGBwcmlvcml0eTpgIHByZWZpeCBrZWVwcyBhIGRlcml2ZWRcbiAgICogYnVja2V0IGRpc3Rpbmd1aXNoYWJsZSBmcm9tIGFuIGV4cGxpY2l0IHNvdXJjZS4gVGhlc2UgdmFsdWVzIHN1bSBleGFjdGx5XG4gICAqIHRvIGBncmFwaHFsVG90YWxgOiBldmVyeSBjb3VudGVkIGNhbGwgY2hvb3NlcyBhIGJ1Y2tldC5cbiAgICovXG4gIGdyYXBocWxCeVNvdXJjZTogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbn1cblxuY29uc3Qgc3RhdGUgPSB7XG4gIHRvdGFsOiAwLFxuICBieVN1YkNvbW1hbmQ6IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCksXG4gIGJ5UHJpb3JpdHk6IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCksXG4gIHByaW9yaXR5U3RhY2s6IFtdIGFzIHN0cmluZ1tdLFxuICBjYWNoZUhpdHM6IDAsXG4gIGNhY2hlTWlzc2VzOiAwLFxuICBjYWNoZUV4cGlyZWQ6IDAsXG4gIHNhdmVkQnlDYWNoZTogMCxcbiAgY29tbWVudHNDYWNoZUhpdHM6IDAsXG4gIGNvbW1lbnRzQ2FjaGVNaXNzZXM6IDAsXG4gIC8vIElzc3VlICMxOTI0OiBHcmFwaFFMLXNwZWNpZmljIHRlbGVtZXRyeS5cbiAgZ3JhcGhxbFRvdGFsOiAwLFxuICBncmFwaHFsQnlTb3VyY2U6IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCksXG4gIGdyYXBocWxTb3VyY2VTdGFjazogW10gYXMgc3RyaW5nW10sXG4gIC8vIElzc3VlICMyNDA5OiBHcmFwaFFMIHNwZW5kIGJ5IGNhbGwgc2hhcGUuXG4gIGdyYXBocWxCeVNoYXBlOiBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpLFxufTtcblxuLyoqXG4gKiBQcmVmaXggbWFya2luZyBhIEdyYXBoUUwgYnVja2V0IGRlcml2ZWQgZnJvbSB0aGUgYWN0aXZlIHByaW9yaXR5IHJhdGhlclxuICogdGhhbiBhbiBleHBsaWNpdCBzb3VyY2UgKElzc3VlICMxNTg2KS4gU2VlIGByZWNvcmRHaENhbGxgIGZvciB0aGVcbiAqIHJlc29sdXRpb24gb3JkZXIgaXQgaXMgYXBwbGllZCBpbi5cbiAqL1xuY29uc3QgUFJJT1JJVFlfU09VUkNFX1BSRUZJWCA9IFwicHJpb3JpdHk6XCI7XG5cbi8qKlxuICogTm9ybWFsaXNlIGEgcHJpb3JpdHkgbmFtZSBmb3IgdGVsZW1ldHJ5IG91dHB1dDogbG93ZXJjYXNlLCB3aXRoXG4gKiB3aGl0ZXNwYWNlIGNvbGxhcHNlZCB0byBzaW5nbGUgaHlwaGVucy4gVGhlIGRpc3BhdGNoIHRhYmxlIHVzZXNcbiAqIGh1bWFuLXJlYWRhYmxlIG5hbWVzIGxpa2UgXCJQUiBGZWVkYmFja1wiOyB0aGUgbG9nIGxpbmUgdXNlcyB0aGVcbiAqIGNvbXBhY3QgYHByLWZlZWRiYWNrYCBmb3JtIHNvIGl0IHBhcnNlcyBjbGVhbmx5IHdpdGggYGF3a2AvYGdyZXBgLlxuICovXG5mdW5jdGlvbiBub3JtYWxpc2VQcmlvcml0eU5hbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIG5hbWUudHJpbSgpLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvXFxzKy9nLCBcIi1cIik7XG59XG5cbi8qKlxuICogUHVzaCBhIG5ldyBwcmlvcml0eSBjb250ZXh0IG9udG8gdGhlIHN0YWNrIChJc3N1ZSAjMTg0NSkuXG4gKlxuICogU3Vic2VxdWVudCBgcmVjb3JkR2hDYWxsYCBpbnZvY2F0aW9ucyBhdHRyaWJ1dGUgdG8gdGhlIHRvcCBvZiB0aGVcbiAqIHN0YWNrIHVudGlsIHRoZSBtYXRjaGluZyBgZXhpdFByaW9yaXR5KClgIGlzIGNhbGxlZC4gTmVzdGVkIGNvbnRleHRzXG4gKiBhcmUgc3VwcG9ydGVkIOKAlCB0aGUgaW5uZXJtb3N0ICh0b3Atb2Ytc3RhY2spIHByaW9yaXR5IGlzIGNyZWRpdGVkLlxuICpcbiAqIEBwYXJhbSBuYW1lIC0gSHVtYW4tcmVhZGFibGUgcHJpb3JpdHkgbmFtZSAoZS5nLiBcIlN0YWxlIFdvcmtmbG93IERldGVjdGlvblwiKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudGVyUHJpb3JpdHkobmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIHN0YXRlLnByaW9yaXR5U3RhY2sucHVzaChub3JtYWxpc2VQcmlvcml0eU5hbWUobmFtZSkpO1xufVxuXG4vKipcbiAqIFBvcCB0aGUgY3VycmVudCBwcmlvcml0eSBjb250ZXh0IG9mZiB0aGUgc3RhY2sgKElzc3VlICMxODQ1KS5cbiAqXG4gKiBDYWxsaW5nIHRoaXMgd2l0aCBhbiBlbXB0eSBzdGFjayBpcyBhIG5vLW9wIHNvIGFjY2lkZW50YWxcbiAqIG1pc21hdGNoZWQgcGFpcnMgZGVncmFkZSBncmFjZWZ1bGx5IHJhdGhlciB0aGFuIHRocm93aW5nIGluc2lkZVxuICogdGhlIG1haW4gbG9vcC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4aXRQcmlvcml0eSgpOiB2b2lkIHtcbiAgc3RhdGUucHJpb3JpdHlTdGFjay5wb3AoKTtcbn1cblxuLyoqXG4gKiBSdW4gYGZuYCBpbnNpZGUgYW4gYGVudGVyUHJpb3JpdHkobmFtZSlgIC8gYGV4aXRQcmlvcml0eSgpYCBwYWlyLFxuICogZXZlbiBpZiBgZm5gIHRocm93cyAoSXNzdWUgIzE4NDUpLiBSZXR1cm5zIHRoZSB2YWx1ZSBvZiBgZm5gLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd2l0aFByaW9yaXR5PFQ+KFxuICBuYW1lOiBzdHJpbmcsXG4gIGZuOiAoKSA9PiBQcm9taXNlPFQ+LFxuKTogUHJvbWlzZTxUPiB7XG4gIGVudGVyUHJpb3JpdHkobmFtZSk7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGZuKCk7XG4gIH0gZmluYWxseSB7XG4gICAgZXhpdFByaW9yaXR5KCk7XG4gIH1cbn1cblxuLyoqXG4gKiBBc3luYy1zY29wZWQgcHJpb3JpdHkgYXR0cmlidXRpb24gKElzc3VlICMyMTMpLlxuICpcbiAqIFRoZSBgZW50ZXJQcmlvcml0eWAvYGV4aXRQcmlvcml0eWAgc3RhY2sgYWJvdmUgaXMgcHJvY2Vzcy13aWRlLCB3aGljaCBpc1xuICogZXhhY3Qgb25seSB3aGlsZSBwcmlvcml0aWVzIHJ1biBzdHJpY3RseSBvbmUgYWZ0ZXIgYW5vdGhlci4gT25jZSB0aGVcbiAqIG1haW50ZW5hbmNlIGxhbmUgcnVucyBiZXNpZGUgdGhlIFByaW9yaXR5LTIgcG9vbCwgdHdvIHByaW9yaXRpZXMgYXJlIGluXG4gKiBmbGlnaHQgYXQgb25jZSBhbmQgYSBzaGFyZWQgc3RhY2sgY3JlZGl0cyBlYWNoIG9uZSdzIGBnaGAgY2FsbHMgdG9cbiAqIHdoaWNoZXZlciBwdXNoZWQgbGFzdC4gVGhpcyBzdG9yYWdlIGJpbmRzIHRoZSBwcmlvcml0eSB0byB0aGUgYXN5bmMgY2hhaW5cbiAqIHRoYXQgZW50ZXJlZCBpdCBpbnN0ZWFkLCBzbyBjb25jdXJyZW50IGxhbmVzIGF0dHJpYnV0ZSBpbmRlcGVuZGVudGx5LlxuICpcbiAqIFRoZSBleHBsaWNpdCBzdGFjayBzdGlsbCB3aW5zIHdoZW4gb25lIGlzIGFjdGl2ZSwgc28gYSBuZXN0ZWRcbiAqIGBlbnRlclByaW9yaXR5KClgIGluc2lkZSBhIGhhbmRsZXIga2VlcHMgaXRzIGlubmVybW9zdC13aW5zIHNlbWFudGljcy5cbiAqL1xuY29uc3QgcHJpb3JpdHlTdG9yYWdlID0gbmV3IEFzeW5jTG9jYWxTdG9yYWdlPHN0cmluZz4oKTtcblxuLyoqXG4gKiBSdW4gYGZuYCB3aXRoIGl0cyBgZ2hgIGNhbGxzIGF0dHJpYnV0ZWQgdG8gYG5hbWVgLCBmb3IgdGhlIHdob2xlIGFzeW5jXG4gKiBjaGFpbiBhbmQgZm9yIG5vdGhpbmcgcnVubmluZyBiZXNpZGUgaXQgKElzc3VlICMyMTMpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aFByaW9yaXR5Q29udGV4dDxUPihcbiAgbmFtZTogc3RyaW5nLFxuICBmbjogKCkgPT4gUHJvbWlzZTxUPixcbik6IFByb21pc2U8VD4ge1xuICByZXR1cm4gcHJpb3JpdHlTdG9yYWdlLnJ1bihub3JtYWxpc2VQcmlvcml0eU5hbWUobmFtZSksIGZuKTtcbn1cblxuLyoqIFRoZSBwcmlvcml0eSB0aGUgY3VycmVudCBhc3luYyBjaGFpbiBydW5zIHVuZGVyLCBpZiBhbnkgKElzc3VlICMyMTMpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGN1cnJlbnRQcmlvcml0eUNvbnRleHQoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIHByaW9yaXR5U3RvcmFnZS5nZXRTdG9yZSgpO1xufVxuXG4vKipcbiAqIENsYXNzaWZ5IGEgYGdoYCBhcmd1bWVudCBsaXN0IGludG8gYSBzdWItY29tbWFuZCBidWNrZXQuXG4gKlxuICogUmV0dXJucyBhIHNob3J0IGxhYmVsIGZvciB0ZWxlbWV0cnk6IGBcImlzc3VlIGxpc3RcImAsIGBcInByIHZpZXdcImAsXG4gKiBgXCJhcGlcImAsIGBcImFwaSBncmFwaHFsXCJgLCBldGMuXG4gKlxuICogSXNzdWUgIzE1ODg6IHRoZSBhcmd2IGl0c2VsZiBpcyBwYXJzZWQgYnkgdGhlIHNoYXJlZCBjbGFzc2lmaWVyIGluXG4gKiBgZ2hfYXJndi50c2Ag4oCUIGZsYWctYXdhcmUsIHNvIGBnaCAtLXZlcnNpb24gaXNzdWUgbGlzdGAgc3RpbGwgcmVzb2x2ZXMgdG9cbiAqIGBcImlzc3VlIGxpc3RcImAgYW5kIGEgdmFsdWUtdGFraW5nIGZsYWcncyB2YWx1ZSBpcyBuZXZlciByZWFkIGFzIGFcbiAqIHBvc2l0aW9uYWwgdG9rZW4uIFRoYXQgaXMgdGhlIHNhbWUgcGFyc2UgYGlzUXVvdGFFeGVtcHRHaENhbGxgIHVzZXMsIHNvIHRoZVxuICogYGFwaSBncmFwaHFsYCBidWNrZXQgYW5kIHRoZSBHcmFwaFFMLXF1b3RhIHByZWRpY2F0ZSBjYW5ub3QgZGlzYWdyZWUgYWJvdXRcbiAqIHdoYXQgYW4gYGFwaSBncmFwaHFsYCBpbnZvY2F0aW9uIGlzLlxuICpcbiAqIEBwYXJhbSBhcmdzIC0gQXJndW1lbnQgbGlzdCBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhc3NpZnlHaEFyZ3MoYXJnczogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcge1xuICBjb25zdCBwb3NpdGlvbmFscyA9IGdoUG9zaXRpb25hbEFyZ3MoYXJncyk7XG4gIGNvbnN0IGhlYWQgPSBwb3NpdGlvbmFsc1swXTtcbiAgaWYgKCFoZWFkKSByZXR1cm4gXCJ1bmtub3duXCI7XG5cbiAgLy8gSXNzdWUgIzE5MjQ6IHNwbGl0IGBhcGkgZ3JhcGhxbGAgZnJvbSBSRVNUIGBhcGlgIGNhbGxzIHNvIHRoZVxuICAvLyBieVN1YkNvbW1hbmQgYnVja2V0IGFuZCBkb3duc3RyZWFtIHRlbGVtZXRyeSBjYW4gZGlzdGluZ3Vpc2ggdGhlXG4gIC8vIDUwMDAtcG9pbnQvaG91ciBHcmFwaFFMIHF1b3RhIGZyb20gdGhlIDUwMDAtY2FsbC9ob3VyIFJFU1QgcXVvdGEuXG4gIGlmIChoZWFkID09PSBcImFwaVwiKSB7XG4gICAgcmV0dXJuIGdoQ2FsbEtpbmRPZihwb3NpdGlvbmFscykgPT09IFwiYXBpLWdyYXBocWxcIiA/IFwiYXBpIGdyYXBocWxcIiA6IFwiYXBpXCI7XG4gIH1cblxuICAvLyBGb3IgdHdvLXdvcmQgc3ViLWNvbW1hbmRzIChpc3N1ZS9wci9yZXBvL2V0Yy4pLCBpbmNsdWRlIHRoZSB2ZXJiLlxuICBjb25zdCB0d29Xb3JkUm9vdHMgPSBuZXcgU2V0KFtcbiAgICBcImlzc3VlXCIsXG4gICAgXCJwclwiLFxuICAgIFwicmVwb1wiLFxuICAgIFwibGFiZWxcIixcbiAgICBcInJlbGVhc2VcIixcbiAgICBcInJ1blwiLFxuICAgIFwid29ya2Zsb3dcIixcbiAgICBcInNlY3JldFwiLFxuICAgIFwidmFyaWFibGVcIixcbiAgICBcInNzaC1rZXlcIixcbiAgICBcImdpc3RcIixcbiAgICBcImF1dGhcIixcbiAgICBcImNhY2hlXCIsXG4gIF0pO1xuXG4gIGlmICh0d29Xb3JkUm9vdHMuaGFzKGhlYWQpKSB7XG4gICAgY29uc3QgdmVyYiA9IHBvc2l0aW9uYWxzWzFdO1xuICAgIHJldHVybiB2ZXJiID8gYCR7aGVhZH0gJHt2ZXJifWAgOiBoZWFkO1xuICB9XG5cbiAgcmV0dXJuIGhlYWQ7XG59XG5cbi8qKlxuICogUHVzaCBhIEdyYXBoUUwgY2FsbGVyIHNvdXJjZSBvbnRvIHRoZSBzdGFjayAoSXNzdWUgIzE5MjQpLlxuICpcbiAqIFN1YnNlcXVlbnQgYHJlY29yZEdoQ2FsbGAgaW52b2NhdGlvbnMgdGhhdCBtYXRjaCB0aGUgR3JhcGhRTCBzaGFwZVxuICogYXR0cmlidXRlIHRvIHRoZSB0b3Agb2YgdGhlIHN0YWNrIHVudGlsIHRoZSBtYXRjaGluZ1xuICogYGV4aXRHcmFwaFFMU291cmNlKClgIGlzIGNhbGxlZC4gVXNlIGEgc2hvcnQsIHN0YWJsZSBpZGVudGlmaWVyXG4gKiAoZS5nLiBgcHItbGlua2FnZWAsIGBtaWxlc3RvbmUtaGVhbHRoYCkgc28gbG9nIHJlYWRlcnMgY2FuIGdyb3VwXG4gKiBhY3Jvc3MgcnVucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudGVyR3JhcGhRTFNvdXJjZShuYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgc3RhdGUuZ3JhcGhxbFNvdXJjZVN0YWNrLnB1c2gobm9ybWFsaXNlUHJpb3JpdHlOYW1lKG5hbWUpKTtcbn1cblxuLyoqXG4gKiBQb3AgdGhlIGN1cnJlbnQgR3JhcGhRTCBjYWxsZXIgc291cmNlIG9mZiB0aGUgc3RhY2sgKElzc3VlICMxOTI0KS5cbiAqIE5vLW9wIG9uIGFuIGVtcHR5IHN0YWNrIHNvIG1pc21hdGNoZWQgcGFpcnMgZGVncmFkZSBncmFjZWZ1bGx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXhpdEdyYXBoUUxTb3VyY2UoKTogdm9pZCB7XG4gIHN0YXRlLmdyYXBocWxTb3VyY2VTdGFjay5wb3AoKTtcbn1cblxuLyoqXG4gKiBBc3luYy1zY29wZWQgR3JhcGhRTCBzb3VyY2UgYXR0cmlidXRpb24gKElzc3VlICMxNTg1KS5cbiAqXG4gKiBUaGUgYGVudGVyR3JhcGhRTFNvdXJjZWAvYGV4aXRHcmFwaFFMU291cmNlYCBzdGFjayBhYm92ZSBpcyBwcm9jZXNzLXdpZGUsXG4gKiB3aGljaCBpcyBleGFjdCBvbmx5IHdoaWxlIHNvdXJjZXMgcnVuIHN0cmljdGx5IG9uZSBhZnRlciBhbm90aGVyLiBFdmVyeVxuICogd3JhcHBlciBpcyBgYXdhaXRgLWVkIGFyb3VuZCBhIGBnaGAgc3Bhd24sIHNvIHdoaWxlIGBjb21tZW50X2JhdGNoLnRzYCBpc1xuICogYXdhaXRpbmcgaXRzIGBhcGkgZ3JhcGhxbGAgY2FsbCwgYW55IGBnaCBpc3N1ZSBsaXN0YCBvciBgZ2ggcHIgdmlld2AgaXNzdWVkXG4gKiBieSBhIGxhbmUgcnVubmluZyBiZXNpZGUgaXQgd2FzIGNyZWRpdGVkIHRvIGBjb21tZW50cy1iYXRjaGAuIFRoaXMgc3RvcmFnZVxuICogYmluZHMgdGhlIHNvdXJjZSB0byB0aGUgYXN5bmMgY2hhaW4gdGhhdCBlbnRlcmVkIGl0IGluc3RlYWQsIHNvIGNvbmN1cnJlbnRcbiAqIGxhbmVzIGF0dHJpYnV0ZSBpbmRlcGVuZGVudGx5IOKAlCB0aGUgc2FtZSBmaXggSXNzdWUgIzIxMyBhcHBsaWVkIHRvIHRoZVxuICogcHJpb3JpdHkgYXhpcy5cbiAqXG4gKiBUaGUgZXhwbGljaXQgc3RhY2sgc3RpbGwgd2lucyB3aGVuIG9uZSBpcyBhY3RpdmUsIHNvIGFuIGBlbnRlckdyYXBoUUxTb3VyY2UoKWBcbiAqIG5lc3RlZCBpbnNpZGUgYSB3cmFwcGVkIGNoYWluIGtlZXBzIGl0cyBpbm5lcm1vc3Qtd2lucyBzZW1hbnRpY3MuIFRoZSByZXZlcnNlXG4gKiBuZXN0aW5nIGNoYW5nZWQgd2l0aCB0aGlzIGZpeCwgYW5kIGl0IGlzIHRoZSB0cmFkZS1vZmYgdGhlIHByaW9yaXR5IGF4aXNcbiAqIGFscmVhZHkgbWFkZTogYW4gZXhwbGljaXQgc291cmNlIHdyYXBwaW5nIGEgYHdpdGhHcmFwaFFMU291cmNlYCBjaGFpbiBub3dcbiAqIHdpbnMgb3ZlciB0aGUgaW5uZXIgb25lLCBiZWNhdXNlIHRoZSBzdGFjayBpcyBjb25zdWx0ZWQgZmlyc3QuIE5vIHByb2R1Y3Rpb25cbiAqIGNhbGwgc2l0ZSBlbnRlcnMgYSBzb3VyY2UgZXhwbGljaXRseSwgc28gbm90aGluZyBkZXBlbmRzIG9uIHRoZSBvbGQgb3JkZXIuXG4gKlxuICogRmluZGluZyAoSXNzdWUgIzE1NzEpIOKAlCB0aGUgcGFyZW50J3MgdW5yZXNvbHZlZCBjYXZlYXQsIHRoYXQgdGhlIGF0dHJpYnV0ZWRcbiAqIGJ1Y2tldHMgc3VtbWVkIHRvIDQwIGFnYWluc3QgYW4gYGFwaS1ncmFwaHFsYCBzdWItY29tbWFuZCBjb3VudGVyIG9mIDIzIGZvclxuICogdGhlIHNhbWUgY3ljbGUuIFdoaWNoIGFuc3dlciBob2xkcyBkZXBlbmRzIG9uIHdoaWNoIDQwIHdhcyByZWFkLCBhbmQgYm90aFxuICogcmVhZGluZ3MgYXJlIG5vdyBhY2NvdW50ZWQgZm9yOlxuICpcbiAqIC0gU3VtbWVkIG92ZXIgdGhlIE5BTUVEIGJ1Y2tldHMgb25seSwgY3Jvc3MtY3JlZGl0aW5nIGV4cGxhaW5zIGl0LiBFdmVyeVxuICogICBgd2l0aEdyYXBoUUxTb3VyY2VgIGNhbGwgc2l0ZSB3cmFwcyBleGFjdGx5IG9uZSBgZ2ggYXBpIGdyYXBocWxgIHNwYXduLCBzb1xuICogICBhYnNlbnQgY29uY3VycmVuY3kgdGhlIG5hbWVkIGJ1Y2tldHMgc3VtIHRvIGV4YWN0bHkgdGhlIGBhcGkgZ3JhcGhxbGBcbiAqICAgY291bnQuIFRoZSByZXByb2R1Y3Rpb24gaW4gYHRlc3RzL2doX2NhbGxfbWV0cmljc190ZXN0LnRzYCAoXCJjb25jdXJyZW50XG4gKiAgIGNoYWlucyBkbyBub3QgY3Jvc3MtY3JlZGl0IEdyYXBoUUwgc291cmNlc1wiKSBzaG93cyBhIHN1c3BlbmRlZFxuICogICBgY29tbWVudHMtYmF0Y2hgIGNoYWluIGFic29yYmluZyB0d28gdW5yZWxhdGVkIHN1Yi1jb21tYW5kIGNhbGxzIGZyb20gdGhlXG4gKiAgIGxhbmUgYmVzaWRlIGl0IOKAlCB0aGUgb25seSBtZWNoYW5pc20gYnkgd2hpY2ggYSBuYW1lZCBidWNrZXQgY2FuIG91dGdyb3dcbiAqICAgdGhhdCBjb3VudC4gVGhpcyBmaXggcmVtb3ZlcyBpdC5cbiAqIC0gU3VtbWVkIG92ZXIgQUxMIGJ1Y2tldHMgaW5jbHVkaW5nIGB1bmF0dHJpYnV0ZWRgLCBubyBjcm9zcy1jcmVkaXRpbmcgaXNcbiAqICAgbmVlZGVkOiBzaW5jZSBJc3N1ZSAjMTQ4NSBgZ3JhcGhxbEJ5U291cmNlYCBjb3VudHMgZXZlcnkgR3JhcGhRTC1iYWNrZWRcbiAqICAgc3ViLWNvbW1hbmQgKGBpc3N1ZSBsaXN0YCwgYHByIHZpZXdgLCBgc2VhcmNoYCwg4oCmKSwgd2hpbGVcbiAqICAgYGJ5U3ViQ29tbWFuZFtcImFwaSBncmFwaHFsXCJdYCBjb3VudHMgb25seSB0aGUgZXhwbGljaXQgb25lcy4gVGhlIHR3b1xuICogICBjb3VudGVycyBtZWFzdXJlIGRpZmZlcmVudCBzZXRzIGJ5IGRlc2lnbiwgc28gYSB0b3RhbCBhYm92ZSB0aGVcbiAqICAgYGFwaSBncmFwaHFsYCBjb3VudCBpcyBleHBlY3RlZCBhbmQgaXMgbm90IGEgZGVmZWN0LlxuICovXG5jb25zdCBncmFwaHFsU291cmNlU3RvcmFnZSA9IG5ldyBBc3luY0xvY2FsU3RvcmFnZTxzdHJpbmc+KCk7XG5cbi8qKlxuICogUnVuIGBmbmAgd2l0aCBpdHMgR3JhcGhRTC1iYWNrZWQgYGdoYCBjYWxscyBhdHRyaWJ1dGVkIHRvIGBuYW1lYCwgZm9yIHRoZVxuICogd2hvbGUgYXN5bmMgY2hhaW4gYW5kIGZvciBub3RoaW5nIHJ1bm5pbmcgYmVzaWRlIGl0IChJc3N1ZSAjMTU4NSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3aXRoR3JhcGhRTFNvdXJjZUNvbnRleHQ8VD4oXG4gIG5hbWU6IHN0cmluZyxcbiAgZm46ICgpID0+IFByb21pc2U8VD4gfCBULFxuKTogUHJvbWlzZTxUPiB7XG4gIHJldHVybiBncmFwaHFsU291cmNlU3RvcmFnZS5ydW4oXG4gICAgbm9ybWFsaXNlUHJpb3JpdHlOYW1lKG5hbWUpLFxuICAgIGFzeW5jICgpID0+IGF3YWl0IGZuKCksXG4gICk7XG59XG5cbi8qKiBUaGUgR3JhcGhRTCBzb3VyY2UgdGhlIGN1cnJlbnQgYXN5bmMgY2hhaW4gcnVucyB1bmRlciwgaWYgYW55ICgjMTU4NSkuICovXG5leHBvcnQgZnVuY3Rpb24gY3VycmVudEdyYXBoUUxTb3VyY2VDb250ZXh0KCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBncmFwaHFsU291cmNlU3RvcmFnZS5nZXRTdG9yZSgpO1xufVxuXG4vKipcbiAqIFJ1biBgZm5gIGF0dHJpYnV0ZWQgdG8gdGhlIEdyYXBoUUwgY2FsbGVyIHNvdXJjZSBgbmFtZWAgKElzc3VlICMxOTI0KS5cbiAqXG4gKiBJc3N1ZSAjMTU4NTogaW1wbGVtZW50ZWQgb24gdGhlIGFzeW5jLXNjb3BlZCBjb250ZXh0IGFib3ZlLCBzbyBldmVyeVxuICogZXhpc3RpbmcgY2FsbCBzaXRlIGJlY2FtZSBjb25jdXJyZW5jeS1zYWZlIHdpdGggbm8gZWRpdC4gQW4gZXhwbGljaXRcbiAqIGBlbnRlckdyYXBoUUxTb3VyY2UoKWAgbmVzdGVkIGluc2lkZSBgZm5gIHN0aWxsIHdpbnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3aXRoR3JhcGhRTFNvdXJjZTxUPihcbiAgbmFtZTogc3RyaW5nLFxuICBmbjogKCkgPT4gUHJvbWlzZTxUPiB8IFQsXG4pOiBQcm9taXNlPFQ+IHtcbiAgcmV0dXJuIHdpdGhHcmFwaFFMU291cmNlQ29udGV4dChuYW1lLCBmbik7XG59XG5cbi8qKlxuICogUmVjb3JkIGEgc2luZ2xlIGBnaGAgaW52b2NhdGlvbiB3aXRoIHRoZSBnaXZlbiBhcmd1bWVudCBsaXN0LlxuICpcbiAqIElmIGEgcHJpb3JpdHkgY29udGV4dCBpcyBhY3RpdmUgKHNlZSBgZW50ZXJQcmlvcml0eWApLCB0aGUgY2FsbCBpc1xuICogYWxzbyBhdHRyaWJ1dGVkIHRvIHRoZSBpbm5lcm1vc3QgcHJpb3JpdHkgZm9yIHRoZSBwZXItcHJpb3JpdHlcbiAqIGJyZWFrZG93biBlbWl0dGVkIGF0IGVuZCBvZiBpdGVyYXRpb24gKElzc3VlICMxODQ1KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZEdoQ2FsbChhcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IHZvaWQge1xuICBzdGF0ZS50b3RhbCsrO1xuICBjb25zdCBidWNrZXQgPSBjbGFzc2lmeUdoQXJncyhhcmdzKTtcbiAgc3RhdGUuYnlTdWJDb21tYW5kLnNldChidWNrZXQsIChzdGF0ZS5ieVN1YkNvbW1hbmQuZ2V0KGJ1Y2tldCkgPz8gMCkgKyAxKTtcblxuICAvLyBJc3N1ZSAjMTg0NTogYXR0cmlidXRlIHRvIHRoZSBpbm5lcm1vc3QgcHJpb3JpdHkgY29udGV4dCwgaWYgYW55LlxuICAvLyBJc3N1ZSAjMjEzOiBhbiBleHBsaWNpdCBzdGFjayBlbnRyeSBzdGlsbCB3aW5zIChpbm5lcm1vc3Qtd2lucyBmb3IgYVxuICAvLyBuZXN0ZWQgYGVudGVyUHJpb3JpdHlgIGluc2lkZSBhIGhhbmRsZXIpOyBvdGhlcndpc2UgdGhlIGFzeW5jLXNjb3BlZFxuICAvLyBjb250ZXh0IGF0dHJpYnV0ZXMgdGhlIGNhbGwsIHNvIGNvbmN1cnJlbnQgbGFuZXMgZG8gbm90IGNyb3NzLWNyZWRpdC5cbiAgY29uc3QgdG9wID0gc3RhdGUucHJpb3JpdHlTdGFja1tzdGF0ZS5wcmlvcml0eVN0YWNrLmxlbmd0aCAtIDFdID8/XG4gICAgcHJpb3JpdHlTdG9yYWdlLmdldFN0b3JlKCk7XG4gIGlmICh0b3ApIHtcbiAgICBzdGF0ZS5ieVByaW9yaXR5LnNldCh0b3AsIChzdGF0ZS5ieVByaW9yaXR5LmdldCh0b3ApID8/IDApICsgMSk7XG4gIH1cblxuICAvLyBJc3N1ZSAjMTkyNDogR3JhcGhRTC1zcGVjaWZpYyBhdHRyaWJ1dGlvbi4gSXNzdWUgIzE0ODU6IHdoYXQgY291bnRzIGFzXG4gIC8vIEdyYXBoUUwgaXMgZGVjaWRlZCBvbmNlLCBpbiBwcmltYXJ5X3F1b3RhX2xhdGNoLnRzIOKAlCBldmVyeSBgZ2hgXG4gIC8vIHN1Yi1jb21tYW5kIGlzIEdyYXBoUUwtYmFja2VkOyBvbmx5IGEgcGxhaW4gUkVTVCBgZ2ggYXBpIDxwYXRoPmAgaXMgbm90LlxuICBpZiAoIWlzUXVvdGFFeGVtcHRHaENhbGwoYXJncykpIHtcbiAgICBzdGF0ZS5ncmFwaHFsVG90YWwrKztcbiAgICAvLyBJc3N1ZSAjMTU4NTogYW4gZXhwbGljaXQgc3RhY2sgZW50cnkgc3RpbGwgd2lucyAoaW5uZXJtb3N0LXdpbnMgZm9yIGFcbiAgICAvLyBuZXN0ZWQgYGVudGVyR3JhcGhRTFNvdXJjZWApOyBvdGhlcndpc2UgdGhlIGFzeW5jLXNjb3BlZCBjb250ZXh0XG4gICAgLy8gYXR0cmlidXRlcyB0aGUgY2FsbCwgc28gY29uY3VycmVudCBsYW5lcyBkbyBub3QgY3Jvc3MtY3JlZGl0LlxuICAgIC8vIElzc3VlICMxNTg2OiBmYWlsaW5nIGJvdGgsIGZhbGwgYmFjayB0byB0aGUgcHJpb3JpdHkgcmVzb2x2ZWQgYWJvdmUgc29cbiAgICAvLyB0aGUgb3JkaW5hcnkgYGlzc3VlIGxpc3RgIC8gYHByIGxpc3RgIHRyYWZmaWMg4oCUIHdoaWNoIG5vIG1vZHVsZSB3cmFwcyBpblxuICAgIC8vIGEgR3JhcGhRTCBzb3VyY2Ug4oCUIGxhbmRzIGluIGEgbmFtZWQgYnVja2V0IHJhdGhlciB0aGFuIGB1bmF0dHJpYnV0ZWRgLlxuICAgIGNvbnN0IHNyYyA9IHN0YXRlLmdyYXBocWxTb3VyY2VTdGFja1tzdGF0ZS5ncmFwaHFsU291cmNlU3RhY2subGVuZ3RoIC0gMV0gPz9cbiAgICAgIGdyYXBocWxTb3VyY2VTdG9yYWdlLmdldFN0b3JlKCkgPz9cbiAgICAgICh0b3AgPyBgJHtQUklPUklUWV9TT1VSQ0VfUFJFRklYfSR7dG9wfWAgOiBcInVuYXR0cmlidXRlZFwiKTtcbiAgICBzdGF0ZS5ncmFwaHFsQnlTb3VyY2Uuc2V0KFxuICAgICAgc3JjLFxuICAgICAgKHN0YXRlLmdyYXBocWxCeVNvdXJjZS5nZXQoc3JjKSA/PyAwKSArIDEsXG4gICAgKTtcbiAgICAvLyBJc3N1ZSAjMjQwOTogYW5kIGJ5IHNoYXBlLCBzbyB0aGUgbG9nIG5hbWVzICp3aGljaCogbGlzdGluZyBpcyBzcGVuZGluZ1xuICAgIC8vIHRoZSBxdW90YSwgbm90IG9ubHkgdGhhdCBgcHIgbGlzdGAgaXMuXG4gICAgY29uc3QgY2xhc3NpZmllZCA9IGNsYXNzaWZ5R2hTaGFwZShhcmdzKTtcbiAgICBjb25zdCBzaGFwZSA9IHN0YXRlLmdyYXBocWxCeVNoYXBlLmhhcyhjbGFzc2lmaWVkKSB8fFxuICAgICAgICBzdGF0ZS5ncmFwaHFsQnlTaGFwZS5zaXplIDwgTUFYX1RSQUNLRURfU0hBUEVTXG4gICAgICA/IGNsYXNzaWZpZWRcbiAgICAgIDogT1ZFUkZMT1dfU0hBUEU7XG4gICAgc3RhdGUuZ3JhcGhxbEJ5U2hhcGUuc2V0KHNoYXBlLCAoc3RhdGUuZ3JhcGhxbEJ5U2hhcGUuZ2V0KHNoYXBlKSA/PyAwKSArIDEpO1xuICB9XG59XG5cbi8qKiBEaXN0aW5jdCBzaGFwZXMgdHJhY2tlZCBwZXIgY3ljbGU7IHRoZSB3b3JrZXIgaGFzIGEgZmV3IGRvemVuIGluIGFsbC4gKi9cbmNvbnN0IE1BWF9UUkFDS0VEX1NIQVBFUyA9IDIwMDtcblxuLyoqIFdoZXJlIGNhbGxzIGdvIG9uY2Uge0BsaW5rIE1BWF9UUkFDS0VEX1NIQVBFU30gZGlzdGluY3Qgc2hhcGVzIGFyZSBoZWxkLiAqL1xuY29uc3QgT1ZFUkZMT1dfU0hBUEUgPSBcIihvdGhlciBzaGFwZXMpXCI7XG5cbi8qKiBMb25nZXN0IHNoYXBlIHJlY29yZGVkIOKAlCBhIGJvdW5kLCBub3QgYSBmb3JtYXR0aW5nIGNob2ljZS4gKi9cbmNvbnN0IE1BWF9TSEFQRV9DSEFSUyA9IDE2MDtcblxuLy8gUkVTVCBwYXRoIHNlZ21lbnRzIHRoYXQgbmFtZSBhIHJvdXRlIHJhdGhlciB0aGFuIGEgdGhpbmcuIEFueXRoaW5nIGVsc2UgaW4gYVxuLy8gcGF0aCDigJQgYW4gb3duZXIsIGEgcmVwb3NpdG9yeSwgYSBicmFuY2gsIGEgbG9naW4g4oCUIGlzIHJlcGxhY2VkLCBzbyBhIHNoYXBlXG4vLyBjYW4gbmV2ZXIgY2Fycnkgb25lLlxuY29uc3QgUkVTVF9ST1VURV9XT1JEUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1xuICBcImFjdGlvbnNcIixcbiAgXCJhbGVydHNcIixcbiAgXCJhcHBcIixcbiAgXCJhc3NpZ25lZXNcIixcbiAgXCJicmFuY2hlc1wiLFxuICBcImNoZWNrLXJ1bnNcIixcbiAgXCJjaGVjay1zdWl0ZXNcIixcbiAgXCJjb2RlLXNjYW5uaW5nXCIsXG4gIFwiY29sbGFib3JhdG9yc1wiLFxuICBcImNvbW1lbnRzXCIsXG4gIFwiY29tbWl0c1wiLFxuICBcImNvbXBhcmVcIixcbiAgXCJjb250ZW50c1wiLFxuICBcImRlcGVuZGFib3RcIixcbiAgXCJldmVudHNcIixcbiAgXCJnaXRcIixcbiAgXCJncmFwaHFsXCIsXG4gIFwiaGVhZHNcIixcbiAgXCJpbnN0YWxsYXRpb25cIixcbiAgXCJpc3N1ZXNcIixcbiAgXCJqb2JzXCIsXG4gIFwibGFiZWxzXCIsXG4gIFwibG9nc1wiLFxuICBcIm1lcmdlXCIsXG4gIFwibWlsZXN0b25lc1wiLFxuICBcIm9yZ3NcIixcbiAgXCJwdWxsc1wiLFxuICBcInJhdGVfbGltaXRcIixcbiAgXCJyZWZzXCIsXG4gIFwicmVsZWFzZXNcIixcbiAgXCJyZXBvc1wiLFxuICBcInJldmlld3NcIixcbiAgXCJydWxlc2V0c1wiLFxuICBcInJ1bnNcIixcbiAgXCJzZWFyY2hcIixcbiAgXCJzZWNyZXQtc2Nhbm5pbmdcIixcbiAgXCJzdGF0dXNcIixcbiAgXCJzdGF0dXNlc1wiLFxuICBcInN1Yl9pc3N1ZXNcIixcbiAgXCJ0YWdzXCIsXG4gIFwidGltZWxpbmVcIixcbiAgXCJ1c2VyXCIsXG4gIFwidXNlcnNcIixcbiAgXCJ3b3JrZmxvd3NcIixcbl0pO1xuXG4vKiogUmVkdWNlIGEgUkVTVCBwYXRoIHRvIGl0cyByb3V0ZTogYHJlcG9zLzpvd25lci86cmVwby9pc3N1ZXMvOm4vdGltZWxpbmVgLiAqL1xuZnVuY3Rpb24gcmVzdFJvdXRlKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHNlZ21lbnRzID0gcGF0aC5zcGxpdChcIj9cIilbMF0hLnJlcGxhY2UoL15cXC8rLywgXCJcIikuc3BsaXQoXCIvXCIpO1xuICByZXR1cm4gc2VnbWVudHMubWFwKChzZWdtZW50LCBpbmRleCkgPT4ge1xuICAgIGlmIChzZWdtZW50c1swXSA9PT0gXCJyZXBvc1wiICYmIGluZGV4ID09PSAxKSByZXR1cm4gXCI6b3duZXJcIjtcbiAgICBpZiAoc2VnbWVudHNbMF0gPT09IFwicmVwb3NcIiAmJiBpbmRleCA9PT0gMikgcmV0dXJuIFwiOnJlcG9cIjtcbiAgICBpZiAoL15cXGQrJC8udGVzdChzZWdtZW50KSkgcmV0dXJuIFwiOm5cIjtcbiAgICByZXR1cm4gUkVTVF9ST1VURV9XT1JEUy5oYXMoc2VnbWVudCkgPyBzZWdtZW50IDogXCI6eFwiO1xuICB9KS5qb2luKFwiL1wiKTtcbn1cblxuLyoqXG4gKiBUaGUgKipzaGFwZSoqIG9mIGEgYGdoYCBjYWxsOiBpdHMgc3ViLWNvbW1hbmQgYW5kIGl0cyBmbGFnIG5hbWVzLCBzb3J0ZWRcbiAqIChJc3N1ZSAjMjQwOSkuXG4gKlxuICogVGhlIGZsZWV0IHdhcyBleGhhdXN0aW5nIGl0cyBHaXRIdWIgR3JhcGhRTCBxdW90YSB+MjUgbWludXRlcyBpbnRvIGV2ZXJ5XG4gKiBob3VyLiBUaGUgbWV0cmljcyBjb3VsZCBzYXkgYHByLWxpc3Q9MTM1YCBhIGN5Y2xlLCBidXQgbm90ICp3aGljaCogYHByIGxpc3RgXG4gKiDigJQgYnkgYXV0aG9yPyBieSBoZWFkIGJyYW5jaD8gY2xvc2VkPyDigJQgc28gdGhlIGxhcmdlc3QgY29uc3VtZXJzIGNvdWxkIG9ubHlcbiAqIGJlIGd1ZXNzZWQgYXQgZnJvbSB0aGUgY29kZS4gVHdvIGNhbGxzIGhhdmUgdGhlIHNhbWUgc2hhcGUgd2hlbiB0aGV5IGRpZmZlclxuICogb25seSBpbiB2YWx1ZXMsIHdoaWNoIGlzIHdoYXQgbWFrZXMgYSBzaGFwZSBjb3VudGFibGUuXG4gKlxuICogKipObyBhcmd1bWVudCB2YWx1ZSBldmVyIHJlYWNoZXMgYSBzaGFwZS4qKiBBIHZhbHVlIGNhbiBiZSBhIHByaXZhdGVcbiAqIHJlcG9zaXRvcnksIGEgc2VhcmNoIHN0cmluZywgYSB0aXRsZSBvciBhIGJvZHksIGFuZCB0aGlzIHN0cmluZyBpcyBsb2dnZWQuXG4gKiBGbGFnIHZhbHVlcyBhcmUgZHJvcHBlZCBieSB7QGxpbmsgZ2hGbGFnTmFtZXN9OyBhIFJFU1QgcGF0aCBpcyByZWR1Y2VkIHRvXG4gKiBpdHMgcm91dGUgYnkgYW4gYWxsb3ctbGlzdCBvZiByb3V0ZSB3b3Jkcy5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50IGxpc3QgcGFzc2VkIHRvIHRoZSBgZ2hgIGJpbmFyeS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsYXNzaWZ5R2hTaGFwZShhcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIGNvbnN0IGhlYWQgPSBjbGFzc2lmeUdoQXJncyhhcmdzKTtcbiAgY29uc3Qgcm91dGUgPSBoZWFkID09PSBcImFwaVwiXG4gICAgPyBbcmVzdFJvdXRlKGdoUG9zaXRpb25hbEFyZ3MoYXJncylbMV0gPz8gXCJcIildXG4gICAgOiBbXTtcbiAgY29uc3QgZmllbGRzID0ganNvbkZpZWxkTGlzdChhcmdzKTtcbiAgY29uc3Qgc3RhdGVXb3JkID0gZmxhZ1ZhbHVlKGFyZ3MsIFwiLS1zdGF0ZVwiKTtcbiAgY29uc3Qgc3RhdGUgPSBzdGF0ZVdvcmQgIT09IHVuZGVmaW5lZCAmJiBHSF9TVEFURV9XT1JEUy5oYXMoc3RhdGVXb3JkKVxuICAgID8gc3RhdGVXb3JkXG4gICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGZsYWdzID0gWy4uLm5ldyBTZXQoZ2hGbGFnTmFtZXMoYXJncykpXS5zb3J0KCkubWFwKChmbGFnKSA9PiB7XG4gICAgaWYgKGZsYWcgPT09IFwiLS1qc29uXCIgJiYgZmllbGRzICE9PSB1bmRlZmluZWQpIHJldHVybiBgLS1qc29uPSR7ZmllbGRzfWA7XG4gICAgaWYgKGZsYWcgPT09IFwiLS1zdGF0ZVwiICYmIHN0YXRlICE9PSB1bmRlZmluZWQpIHJldHVybiBgLS1zdGF0ZT0ke3N0YXRlfWA7XG4gICAgcmV0dXJuIGZsYWc7XG4gIH0pO1xuICByZXR1cm4gW2hlYWQsIC4uLnJvdXRlLCAuLi5mbGFnc10uam9pbihcIiBcIikuc2xpY2UoMCwgTUFYX1NIQVBFX0NIQVJTKTtcbn1cblxuLyoqIExvbmdlc3QgYC0tanNvbmAgZmllbGQgbGlzdCBzaG93bjsgYSBsb25nZXIgb25lIGtlZXBzIHRoZSBiYXJlIGZsYWcuICovXG5jb25zdCBNQVhfSlNPTl9GSUVMRFNfQ0hBUlMgPSAxMDA7XG5cbi8vIEEgYC0tanNvbmAgdmFsdWUgdGhlIHdvcmtlciB3cm90ZSBpdHNlbGY6IEdyYXBoUUwgZmllbGQgbmFtZXMsIGNvbW1hXG4vLyBzZXBhcmF0ZWQuIEFueXRoaW5nIGVsc2Ug4oCUIGEgc2xhc2gsIGEgc3BhY2UsIGFuIGA9YCDigJQgaXMgbm90IGEgZmllbGQgbGlzdFxuLy8gYW5kIGlzIG5ldmVyIHNob3duLlxuY29uc3QgSlNPTl9GSUVMRF9MSVNUID0gL15bQS1aYS16XVtBLVphLXowLTldKig/OixbQS1aYS16XVtBLVphLXowLTldKikqJC87XG5cbi8qKlxuICogVGhlIGAtLWpzb25gIGZpZWxkIGxpc3Qgb2YgYSBgZ2hgIGludm9jYXRpb24sIHdoZW4gaXQgaXMgc2FmZSB0byBzaG93LlxuICpcbiAqIGAtLWpzb25gIGlzIHRoZSBvbmUgZmxhZyB3aG9zZSB2YWx1ZSBpcyBwYXJ0IG9mIHRoZSBjYWxsJ3MgKnNoYXBlKiByYXRoZXJcbiAqIHRoYW4gaXRzIHN1YmplY3Q6IGBpc3N1ZSB2aWV3IC0tanNvbiBzdGF0ZWAgKGEgZGVwZW5kZW5jeSBjaGVjaykgYW5kXG4gKiBgaXNzdWUgdmlldyAtLWpzb24gdGl0bGUsYm9keSxjb21tZW50c2AgKGEgY29udGVudCByZWFkKSBjb3N0IGRpZmZlcmVudGx5XG4gKiBhbmQgYXJlIGZpeGVkIGRpZmZlcmVudGx5LCBhbmQgd2l0aCB0aGUgYmFyZSBmbGFnIHRoZSB0d28gYXJlIG9uZSBsaW5lXG4gKiAoSXNzdWUgIzI0MDkpLiBFdmVyeSBvdGhlciBmbGFnJ3MgdmFsdWUgc3RheXMgb3V0LlxuICpcbiAqIEBwYXJhbSBhcmdzIC0gQXJndW1lbnQgbGlzdCBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICogQHJldHVybnMgVGhlIGZpZWxkIGxpc3QsIG9yIGB1bmRlZmluZWRgIHdoZW4gYWJzZW50IG9yIG5vdCBiYXJlIGlkZW50aWZpZXJzLlxuICovXG5mdW5jdGlvbiBqc29uRmllbGRMaXN0KGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgdmFsdWUgPSBmbGFnVmFsdWUoYXJncywgXCItLWpzb25cIik7XG4gIHJldHVybiB2YWx1ZSAhPT0gdW5kZWZpbmVkICYmIHZhbHVlLmxlbmd0aCA8PSBNQVhfSlNPTl9GSUVMRFNfQ0hBUlMgJiZcbiAgICAgIEpTT05fRklFTERfTElTVC50ZXN0KHZhbHVlKVxuICAgID8gdmFsdWVcbiAgICA6IHVuZGVmaW5lZDtcbn1cblxuLy8gRXZlcnkgd29yZCBgZ2gg4oCmIC0tc3RhdGVgIGFjY2VwdHMuIEEgY2xvc2VkIHNldCwgc28gdGhlIHdvcmQgaXMgcGFydCBvZiB0aGVcbi8vIGNhbGwncyBzaGFwZSDigJQgYW4gb3BlbiBsaXN0aW5nIG11c3QgcmVmcmVzaCwgYSBtZXJnZWQgb25lIG5lZWQgbm90IOKAlCBhbmRcbi8vIGFueXRoaW5nIG91dHNpZGUgdGhlIHNldCBpcyBhIGNhbGxlcidzIHZhbHVlIGFuZCBpcyBuZXZlciBzaG93bi5cbmNvbnN0IEdIX1NUQVRFX1dPUkRTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwib3BlblwiLFxuICBcImNsb3NlZFwiLFxuICBcIm1lcmdlZFwiLFxuICBcImFsbFwiLFxuXSk7XG5cbi8qKiBUaGUgZmlyc3QgdmFsdWUgZ2l2ZW4gdG8gYGZsYWdgLCBhcyBgLS1mbGFnIHZhbHVlYCBvciBgLS1mbGFnPXZhbHVlYC4gKi9cbmZ1bmN0aW9uIGZsYWdWYWx1ZShcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGZsYWc6IHN0cmluZyxcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHRva2VuID0gYXJnc1tpXSE7XG4gICAgaWYgKHRva2VuID09PSBcIi0tXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgaWYgKHRva2VuID09PSBmbGFnKSByZXR1cm4gYXJnc1tpICsgMV07XG4gICAgaWYgKHRva2VuLnN0YXJ0c1dpdGgoYCR7ZmxhZ309YCkpIHJldHVybiB0b2tlbi5zbGljZShmbGFnLmxlbmd0aCArIDEpO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKiBSZWNvcmQgYSBjYWNoZSBoaXQgKHNhdmVkIG9uZSBgZ2hgIGNhbGwpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZENhY2hlSGl0KCk6IHZvaWQge1xuICBzdGF0ZS5jYWNoZUhpdHMrKztcbiAgc3RhdGUuc2F2ZWRCeUNhY2hlKys7XG59XG5cbi8qKiBSZWNvcmQgYSBjYWNoZSBtaXNzIChubyBlbnRyeSBwcmVzZW50KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNvcmRDYWNoZU1pc3MoKTogdm9pZCB7XG4gIHN0YXRlLmNhY2hlTWlzc2VzKys7XG59XG5cbi8qKiBSZWNvcmQgYSBUVEwtZXhwaXJlZCBjYWNoZSBsb29rdXAuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkQ2FjaGVFeHBpcmVkKCk6IHZvaWQge1xuICBzdGF0ZS5jYWNoZUV4cGlyZWQrKztcbn1cblxuLyoqIFJlY29yZCBhIGNvbW1lbnQtY2FjaGUgaGl0IChJc3N1ZSAjMTg0MSkuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkQ29tbWVudHNDYWNoZUhpdCgpOiB2b2lkIHtcbiAgc3RhdGUuY29tbWVudHNDYWNoZUhpdHMrKztcbn1cblxuLyoqIFJlY29yZCBhIGNvbW1lbnQtY2FjaGUgbWlzcyAoSXNzdWUgIzE4NDEpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZENvbW1lbnRzQ2FjaGVNaXNzKCk6IHZvaWQge1xuICBzdGF0ZS5jb21tZW50c0NhY2hlTWlzc2VzKys7XG59XG5cbi8qKlxuICogUmVzZXQgYWxsIGNvdW50ZXJzIHRvIHplcm8uIENhbGwgYXQgdGhlIHN0YXJ0IG9mIGVhY2ggaXRlcmF0aW9uLlxuICpcbiAqIElzc3VlICMxODQ1OiBhbHNvIGNsZWFycyB0aGUgcGVyLXByaW9yaXR5IGNvdW50cyBhbmQgdGhlIGFjdGl2ZVxuICogcHJpb3JpdHkgc3RhY2sgc28gY291bnRzIGNhbm5vdCBsZWFrIGFjcm9zcyB0aGUgcnVuLWNvcmUgbG9vcFxuICogYm91bmRhcnkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldEdoQ2FsbE1ldHJpY3MoKTogdm9pZCB7XG4gIHN0YXRlLnRvdGFsID0gMDtcbiAgc3RhdGUuYnlTdWJDb21tYW5kLmNsZWFyKCk7XG4gIHN0YXRlLmJ5UHJpb3JpdHkuY2xlYXIoKTtcbiAgc3RhdGUucHJpb3JpdHlTdGFjay5sZW5ndGggPSAwO1xuICBzdGF0ZS5jYWNoZUhpdHMgPSAwO1xuICBzdGF0ZS5jYWNoZU1pc3NlcyA9IDA7XG4gIHN0YXRlLmNhY2hlRXhwaXJlZCA9IDA7XG4gIHN0YXRlLnNhdmVkQnlDYWNoZSA9IDA7XG4gIHN0YXRlLmNvbW1lbnRzQ2FjaGVIaXRzID0gMDtcbiAgc3RhdGUuY29tbWVudHNDYWNoZU1pc3NlcyA9IDA7XG4gIC8vIElzc3VlICMxOTI0OiByZXNldCBHcmFwaFFMIGNvdW50ZXJzIGFuZCBzb3VyY2Ugc3RhY2suXG4gIHN0YXRlLmdyYXBocWxUb3RhbCA9IDA7XG4gIHN0YXRlLmdyYXBocWxCeVNvdXJjZS5jbGVhcigpO1xuICBzdGF0ZS5ncmFwaHFsQnlTaGFwZS5jbGVhcigpO1xuICBzdGF0ZS5ncmFwaHFsU291cmNlU3RhY2subGVuZ3RoID0gMDtcbn1cblxuLyoqXG4gKiBHZXQgYSBzbmFwc2hvdCBvZiB0aGUgY3VycmVudCBtZXRyaWNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0R2hDYWxsTWV0cmljcygpOiBHaENhbGxNZXRyaWNzU25hcHNob3Qge1xuICBjb25zdCBieVN1YkNvbW1hbmQ6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcbiAgZm9yIChjb25zdCBbbmFtZSwgY291bnRdIG9mIHN0YXRlLmJ5U3ViQ29tbWFuZCkge1xuICAgIGJ5U3ViQ29tbWFuZFtuYW1lXSA9IGNvdW50O1xuICB9XG4gIGNvbnN0IGJ5UHJpb3JpdHk6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcbiAgZm9yIChjb25zdCBbbmFtZSwgY291bnRdIG9mIHN0YXRlLmJ5UHJpb3JpdHkpIHtcbiAgICBieVByaW9yaXR5W25hbWVdID0gY291bnQ7XG4gIH1cbiAgY29uc3QgZ3JhcGhxbEJ5U291cmNlOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge307XG4gIGZvciAoY29uc3QgW25hbWUsIGNvdW50XSBvZiBzdGF0ZS5ncmFwaHFsQnlTb3VyY2UpIHtcbiAgICBncmFwaHFsQnlTb3VyY2VbbmFtZV0gPSBjb3VudDtcbiAgfVxuICByZXR1cm4ge1xuICAgIHRvdGFsOiBzdGF0ZS50b3RhbCxcbiAgICBieVN1YkNvbW1hbmQsXG4gICAgYnlQcmlvcml0eSxcbiAgICBjYWNoZUhpdHM6IHN0YXRlLmNhY2hlSGl0cyxcbiAgICBjYWNoZU1pc3Nlczogc3RhdGUuY2FjaGVNaXNzZXMsXG4gICAgY2FjaGVFeHBpcmVkOiBzdGF0ZS5jYWNoZUV4cGlyZWQsXG4gICAgc2F2ZWRCeUNhY2hlOiBzdGF0ZS5zYXZlZEJ5Q2FjaGUsXG4gICAgY29tbWVudHNDYWNoZUhpdHM6IHN0YXRlLmNvbW1lbnRzQ2FjaGVIaXRzLFxuICAgIGNvbW1lbnRzQ2FjaGVNaXNzZXM6IHN0YXRlLmNvbW1lbnRzQ2FjaGVNaXNzZXMsXG4gICAgZ3JhcGhxbFRvdGFsOiBzdGF0ZS5ncmFwaHFsVG90YWwsXG4gICAgZ3JhcGhxbEJ5U291cmNlLFxuICB9O1xufVxuXG4vKipcbiAqIEZvcm1hdCBhIG9uZS1saW5lIHN1bW1hcnkgb2YgdGhlIGN1cnJlbnQgbWV0cmljcyBmb3IgZW5kLW9mLWl0ZXJhdGlvblxuICogbG9nZ2luZy5cbiAqXG4gKiBFeGFtcGxlOiBgZ2gtY2FsbHM6IDE3IHRvdGFsLCAxMiBzYXZlZC1ieS1jYWNoZSwgMCBleHBpcmVkLCBpc3N1ZS1saXN0PTUsIHByLWxpc3Q9MywgYXBpPTlgXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRHaENhbGxTdW1tYXJ5KCk6IHN0cmluZyB7XG4gIGNvbnN0IHNuYXAgPSBnZXRHaENhbGxNZXRyaWNzKCk7XG4gIGNvbnN0IGJ1Y2tldHMgPSBPYmplY3QuZW50cmllcyhzbmFwLmJ5U3ViQ29tbWFuZClcbiAgICAuc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0pXG4gICAgLm1hcCgoW25hbWUsIGNvdW50XSkgPT4gYCR7bmFtZS5yZXBsYWNlKC9cXHMrL2csIFwiLVwiKX09JHtjb3VudH1gKVxuICAgIC5qb2luKFwiLCBcIik7XG5cbiAgY29uc3QgcGFydHMgPSBbXG4gICAgYCR7c25hcC50b3RhbH0gdG90YWxgLFxuICAgIGAke3NuYXAuc2F2ZWRCeUNhY2hlfSBzYXZlZC1ieS1jYWNoZWAsXG4gICAgYCR7c25hcC5jYWNoZUV4cGlyZWR9IGV4cGlyZWRgLFxuICBdO1xuXG4gIC8vIElzc3VlICMxODQxOiBzdXJmYWNlIGNvbW1lbnRzLWNhY2hlIGhpdHMvbWlzc2VzIHdoZW4gdGhlIGNhY2hlXG4gIC8vIGhhcyBiZWVuIHRvdWNoZWQgdGhpcyBpdGVyYXRpb24uIFN1cHByZXNzIHRoZSBmaWVsZCBlbnRpcmVseSB3aGVuXG4gIC8vIGJvdGggY291bnRlcnMgYXJlIHplcm8gc28gZXhpc3RpbmcgbG9nIHJlYWRlcnMgYW5kIHRlc3RzIGFyZSBub3RcbiAgLy8gZGlzdHJhY3RlZCBieSBpbmVydCBub2lzZS5cbiAgaWYgKHNuYXAuY29tbWVudHNDYWNoZUhpdHMgPiAwIHx8IHNuYXAuY29tbWVudHNDYWNoZU1pc3NlcyA+IDApIHtcbiAgICBwYXJ0cy5wdXNoKFxuICAgICAgYGNvbW1lbnRzLWNhY2hlPWhpdDoke3NuYXAuY29tbWVudHNDYWNoZUhpdHN9L21pc3M6JHtzbmFwLmNvbW1lbnRzQ2FjaGVNaXNzZXN9YCxcbiAgICApO1xuICB9XG5cbiAgaWYgKGJ1Y2tldHMpIHBhcnRzLnB1c2goYnVja2V0cyk7XG5cbiAgcmV0dXJuIGBnaC1jYWxsczogJHtwYXJ0cy5qb2luKFwiLCBcIil9YDtcbn1cblxuLyoqXG4gKiBUaGUgYnVzaWVzdCBHcmFwaFFMIGNhbGwgc2hhcGVzIHRoaXMgY3ljbGUgKElzc3VlICMyNDA5KS5cbiAqXG4gKiBHcmFwaFFMLWJhY2tlZCBjYWxscyBvbmx5IOKAlCBSRVNUIHJpZGVzIGEgc2VwYXJhdGUgcXVvdGEuIEFsd2F5cyBvbmVcbiAqIHdlbGwtZm9ybWVkIGxpbmUsIHNvIGEgY3ljbGUgd2l0aCBub25lIHJlYWRzIGBncmFwaHFsLXNoYXBlczogbm9uZWAuXG4gKlxuICogRXhhbXBsZTpcbiAqICAgYGdyYXBocWwtc2hhcGVzOiA0McOXW3ByIGxpc3QgLS1hdXRob3IgLS1qc29uIC0tbGltaXQgLS1yZXBvIC0tc3RhdGVdLCAyMMOXW2lzc3VlIGxpc3QgLS1qc29uIC0tbGFiZWwgLS1saW1pdCAtLXJlcG8gLS1zdGF0ZV1gXG4gKlxuICogQHBhcmFtIHRvcFNoYXBlcyAtIEhvdyBtYW55IHNoYXBlcyB0byBuYW1lLCBidXNpZXN0IGZpcnN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0R2hDYWxsU2hhcGVzU3VtbWFyeSh0b3BTaGFwZXMgPSA4KTogc3RyaW5nIHtcbiAgY29uc3QgdG9wID0gWy4uLnN0YXRlLmdyYXBocWxCeVNoYXBlLmVudHJpZXMoKV1cbiAgICAuc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0gfHwgYVswXS5sb2NhbGVDb21wYXJlKGJbMF0pKVxuICAgIC5zbGljZSgwLCBNYXRoLm1heCgwLCB0b3BTaGFwZXMpKVxuICAgIC5tYXAoKFtzaGFwZSwgY291bnRdKSA9PiBgJHtjb3VudH3Dl1ske3NoYXBlfV1gKVxuICAgIC5qb2luKFwiLCBcIik7XG4gIHJldHVybiBgZ3JhcGhxbC1zaGFwZXM6ICR7dG9wIHx8IFwibm9uZVwifWA7XG59XG5cbi8qKlxuICogRm9ybWF0IHRoZSBwZXItcHJpb3JpdHkgYGdoYCBjYWxsIGJyZWFrZG93biBmb3IgZW5kLW9mLWl0ZXJhdGlvblxuICogbG9nZ2luZyAoSXNzdWUgIzE4NDUpLiBQcmlvcml0aWVzIGFyZSBzb3J0ZWQgZGVzY2VuZGluZyBieSBjYWxsXG4gKiBjb3VudCBzbyB0aGUgbm9pc2llc3QgcHJpb3JpdHkgaXMgbmFtZWQgZmlyc3QuXG4gKlxuICogUmV0dXJucyBgZ2gtY2FsbHMtYnktcHJpb3JpdHk6IG5vbmVgIHdoZW4gbm8gcHJpb3JpdHkgY29udGV4dFxuICogcmVjb3JkZWQgYW55IGNhbGxzIGluIHRoZSBjdXJyZW50IGl0ZXJhdGlvbiwgc28gbG9nIHJlYWRlcnMgYWx3YXlzXG4gKiBzZWUgb25lIHdlbGwtZm9ybWVkIGxpbmUgcGVyIGN5Y2xlLlxuICpcbiAqIEV4YW1wbGU6XG4gKiAgIGBnaC1jYWxscy1ieS1wcmlvcml0eTogc3RhbGUtd29ya2Zsb3ctZGV0ZWN0aW9uPTQyIG1pbGVzdG9uZS1jb21wbGV0aW9ucz0xNSBhdXRvLW1lcmdlPTEyYFxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0R2hDYWxsc0J5UHJpb3JpdHlTdW1tYXJ5KCk6IHN0cmluZyB7XG4gIGNvbnN0IHNuYXAgPSBnZXRHaENhbGxNZXRyaWNzKCk7XG4gIGNvbnN0IGVudHJpZXMgPSBPYmplY3QuZW50cmllcyhzbmFwLmJ5UHJpb3JpdHkpO1xuICBpZiAoZW50cmllcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gXCJnaC1jYWxscy1ieS1wcmlvcml0eTogbm9uZVwiO1xuICB9XG4gIGNvbnN0IHBhcnRzID0gZW50cmllc1xuICAgIC5zb3J0KChhLCBiKSA9PiBiWzFdIC0gYVsxXSlcbiAgICAubWFwKChbbmFtZSwgY291bnRdKSA9PiBgJHtuYW1lfT0ke2NvdW50fWApXG4gICAgLmpvaW4oXCIgXCIpO1xuICByZXR1cm4gYGdoLWNhbGxzLWJ5LXByaW9yaXR5OiAke3BhcnRzfWA7XG59XG5cbi8qKlxuICogRm9ybWF0IGEgb25lLWxpbmUgR3JhcGhRTCBicmVha2Rvd24gZm9yIGVuZC1vZi1pdGVyYXRpb24gbG9nZ2luZ1xuICogKElzc3VlICMxOTI0KS4gU3VyZmFjZXMgdGhlIHRvdGFsIG51bWJlciBvZiBHcmFwaFFMIGludm9jYXRpb25zIHRoaXNcbiAqIGl0ZXJhdGlvbiBwbHVzIGEgcGVyLWNhbGxlci1zb3VyY2UgYXR0cmlidXRpb24gc29ydGVkIGRlc2NlbmRpbmcsIHNvXG4gKiB0aGUgaG90dGVzdCBHcmFwaFFMIHBhdGggaXMgbmFtZWQgZmlyc3QuXG4gKlxuICogR3JhcGhRTCBpcyBtZXRlcmVkIHNlcGFyYXRlbHkgZnJvbSBSRVNUICg1MDAwIHBvaW50cy9ob3VyIHZzXG4gKiA1MDAwIGNhbGxzL2hvdXIpLCBhbmQgZWFjaCBHcmFwaFFMLWJhY2tlZCByZXF1ZXN0IGNvbnN1bWVzIGF0IGxlYXN0IG9uZVxuICogcG9pbnQuIFRoaXMgc3VtbWFyeSBpcyB0aGUgb3BlcmF0b3ItZmFjaW5nIHNpZ25hbCBmb3IgdGhlIDUwMDAtcG9pbnRcbiAqIHF1b3RhIGJ1cm4gcmF0ZSwgYW5kIHNpbmNlIElzc3VlICMxNDg1IGl0IGNvdW50cyBldmVyeSBHcmFwaFFMLWJhY2tlZFxuICogY2FsbCB0aGUgcHJvY2VzcyBtYWtlcyDigJQgYGdoIGlzc3VlIGxpc3RgLCBgZ2ggcHIgdmlld2AsIGBnaCBzZWFyY2hgLCBhc1xuICogd2VsbCBhcyBgZ2ggYXBpIGdyYXBocWxgIOKAlCByZWNvcmRlZCBhdCB0aGUgYGdoYCBzcGF3biBjaG9rZXBvaW50LCBzbyBub1xuICogbW9kdWxlIGNhbiBpc3N1ZSBvbmUgdW5jb3VudGVkLlxuICpcbiAqIEV4YW1wbGU6XG4gKiAgIGBncmFwaHFsLWNhbGxzOiAyNDUgdG90YWwsIHByLWxpbmthZ2U9MTEwLCBtaWxlc3RvbmUtaGVhbHRoPTQ1LFxuICogICBjaGVjay1ydW5zPTMwYFxuICpcbiAqIEVhY2ggY2FsbCBpcyBhdHRyaWJ1dGVkIGJ5IHRoZSByZXNvbHV0aW9uIG9yZGVyIGluIGByZWNvcmRHaENhbGxgLCBzbyBzaW5jZVxuICogSXNzdWUgIzE1ODYgdGhlIG9yZGluYXJ5IGBpc3N1ZSBsaXN0YCAvIGBwciBsaXN0YCAvIGBpc3N1ZSB2aWV3YCB0cmFmZmljXG4gKiBsYW5kcyB1bmRlciBpdHMgcHJpb3JpdHkgYXMgYHByaW9yaXR5OjxuYW1lPmAuIGB1bmF0dHJpYnV0ZWRgIGlzIHRoZXJlZm9yZVxuICogYW4gYW5vbWFseSBzaWduYWwgcmF0aGVyIHRoYW4gdGhlIG5vcm1hbCBjYXNlOiBhIGNhbGwgaXNzdWVkIG91dHNpZGUgYm90aCBhXG4gKiBzb3VyY2UgYW5kIGEgcHJpb3JpdHkgY29udGV4dCwgaS5lLiBhIHBhc3MgdGhhdCBmb3Jnb3QgdG8gd3JhcCBpdHNlbGYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRHcmFwaFFMU3VtbWFyeSgpOiBzdHJpbmcge1xuICBjb25zdCBzbmFwID0gZ2V0R2hDYWxsTWV0cmljcygpO1xuICBpZiAoc25hcC5ncmFwaHFsVG90YWwgPT09IDApIHtcbiAgICByZXR1cm4gXCJncmFwaHFsLWNhbGxzOiAwIHRvdGFsXCI7XG4gIH1cbiAgY29uc3QgcGFydHMgPSBPYmplY3QuZW50cmllcyhzbmFwLmdyYXBocWxCeVNvdXJjZSlcbiAgICAuc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0pXG4gICAgLm1hcCgoW25hbWUsIGNvdW50XSkgPT4gYCR7bmFtZX09JHtjb3VudH1gKTtcbiAgcmV0dXJuIGBncmFwaHFsLWNhbGxzOiAke3NuYXAuZ3JhcGhxbFRvdGFsfSB0b3RhbCwgJHtwYXJ0cy5qb2luKFwiLCBcIil9YDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7OztDQWFDLEdBRUQsU0FBUyxZQUFZLEVBQUUsV0FBVyxFQUFFLGdCQUFnQixRQUFRLGVBQWU7QUFDM0UsU0FBUyxtQkFBbUIsUUFBUSwyQkFBMkI7QUFDL0QsU0FBUyxpQkFBaUIsUUFBUSxtQkFBbUI7QUFvRHJELE1BQU0sUUFBUTtFQUNaLE9BQU87RUFDUCxjQUFjLElBQUk7RUFDbEIsWUFBWSxJQUFJO0VBQ2hCLGVBQWUsRUFBRTtFQUNqQixXQUFXO0VBQ1gsYUFBYTtFQUNiLGNBQWM7RUFDZCxjQUFjO0VBQ2QsbUJBQW1CO0VBQ25CLHFCQUFxQjtFQUNyQiwyQ0FBMkM7RUFDM0MsY0FBYztFQUNkLGlCQUFpQixJQUFJO0VBQ3JCLG9CQUFvQixFQUFFO0VBQ3RCLDRDQUE0QztFQUM1QyxnQkFBZ0IsSUFBSTtBQUN0QjtBQUVBOzs7O0NBSUMsR0FDRCxNQUFNLHlCQUF5QjtBQUUvQjs7Ozs7Q0FLQyxHQUNELFNBQVMsc0JBQXNCLElBQVk7RUFDekMsT0FBTyxLQUFLLElBQUksR0FBRyxXQUFXLEdBQUcsT0FBTyxDQUFDLFFBQVE7QUFDbkQ7QUFFQTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUyxjQUFjLElBQVk7RUFDeEMsTUFBTSxhQUFhLENBQUMsSUFBSSxDQUFDLHNCQUFzQjtBQUNqRDtBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUztFQUNkLE1BQU0sYUFBYSxDQUFDLEdBQUc7QUFDekI7QUFFQTs7O0NBR0MsR0FDRCxPQUFPLGVBQWUsYUFDcEIsSUFBWSxFQUNaLEVBQW9CO0VBRXBCLGNBQWM7RUFDZCxJQUFJO0lBQ0YsT0FBTyxNQUFNO0VBQ2YsU0FBVTtJQUNSO0VBQ0Y7QUFDRjtBQUVBOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUNELE1BQU0sa0JBQWtCLElBQUk7QUFFNUI7OztDQUdDLEdBQ0QsT0FBTyxTQUFTLG9CQUNkLElBQVksRUFDWixFQUFvQjtFQUVwQixPQUFPLGdCQUFnQixHQUFHLENBQUMsc0JBQXNCLE9BQU87QUFDMUQ7QUFFQSwwRUFBMEUsR0FDMUUsT0FBTyxTQUFTO0VBQ2QsT0FBTyxnQkFBZ0IsUUFBUTtBQUNqQztBQUVBOzs7Ozs7Ozs7Ozs7OztDQWNDLEdBQ0QsT0FBTyxTQUFTLGVBQWUsSUFBdUI7RUFDcEQsTUFBTSxjQUFjLGlCQUFpQjtFQUNyQyxNQUFNLE9BQU8sV0FBVyxDQUFDLEVBQUU7RUFDM0IsSUFBSSxDQUFDLE1BQU0sT0FBTztFQUVsQixnRUFBZ0U7RUFDaEUsbUVBQW1FO0VBQ25FLG9FQUFvRTtFQUNwRSxJQUFJLFNBQVMsT0FBTztJQUNsQixPQUFPLGFBQWEsaUJBQWlCLGdCQUFnQixnQkFBZ0I7RUFDdkU7RUFFQSxvRUFBb0U7RUFDcEUsTUFBTSxlQUFlLElBQUksSUFBSTtJQUMzQjtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtHQUNEO0VBRUQsSUFBSSxhQUFhLEdBQUcsQ0FBQyxPQUFPO0lBQzFCLE1BQU0sT0FBTyxXQUFXLENBQUMsRUFBRTtJQUMzQixPQUFPLE9BQU8sR0FBRyxLQUFLLENBQUMsRUFBRSxNQUFNLEdBQUc7RUFDcEM7RUFFQSxPQUFPO0FBQ1Q7QUFFQTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUyxtQkFBbUIsSUFBWTtFQUM3QyxNQUFNLGtCQUFrQixDQUFDLElBQUksQ0FBQyxzQkFBc0I7QUFDdEQ7QUFFQTs7O0NBR0MsR0FDRCxPQUFPLFNBQVM7RUFDZCxNQUFNLGtCQUFrQixDQUFDLEdBQUc7QUFDOUI7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FzQ0MsR0FDRCxNQUFNLHVCQUF1QixJQUFJO0FBRWpDOzs7Q0FHQyxHQUNELE9BQU8sU0FBUyx5QkFDZCxJQUFZLEVBQ1osRUFBd0I7RUFFeEIsT0FBTyxxQkFBcUIsR0FBRyxDQUM3QixzQkFBc0IsT0FDdEIsVUFBWSxNQUFNO0FBRXRCO0FBRUEsMkVBQTJFLEdBQzNFLE9BQU8sU0FBUztFQUNkLE9BQU8scUJBQXFCLFFBQVE7QUFDdEM7QUFFQTs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsa0JBQ2QsSUFBWSxFQUNaLEVBQXdCO0VBRXhCLE9BQU8seUJBQXlCLE1BQU07QUFDeEM7QUFFQTs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsYUFBYSxJQUF1QjtFQUNsRCxNQUFNLEtBQUs7RUFDWCxNQUFNLFNBQVMsZUFBZTtFQUM5QixNQUFNLFlBQVksQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLE1BQU0sWUFBWSxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsSUFBSTtFQUV2RSxvRUFBb0U7RUFDcEUsdUVBQXVFO0VBQ3ZFLHVFQUF1RTtFQUN2RSx3RUFBd0U7RUFDeEUsTUFBTSxNQUFNLE1BQU0sYUFBYSxDQUFDLE1BQU0sYUFBYSxDQUFDLE1BQU0sR0FBRyxFQUFFLElBQzdELGdCQUFnQixRQUFRO0VBQzFCLElBQUksS0FBSztJQUNQLE1BQU0sVUFBVSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsTUFBTSxVQUFVLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJO0VBQy9EO0VBRUEseUVBQXlFO0VBQ3pFLGtFQUFrRTtFQUNsRSwyRUFBMkU7RUFDM0UsSUFBSSxDQUFDLG9CQUFvQixPQUFPO0lBQzlCLE1BQU0sWUFBWTtJQUNsQix3RUFBd0U7SUFDeEUsbUVBQW1FO0lBQ25FLGdFQUFnRTtJQUNoRSx5RUFBeUU7SUFDekUsMkVBQTJFO0lBQzNFLHlFQUF5RTtJQUN6RSxNQUFNLE1BQU0sTUFBTSxrQkFBa0IsQ0FBQyxNQUFNLGtCQUFrQixDQUFDLE1BQU0sR0FBRyxFQUFFLElBQ3ZFLHFCQUFxQixRQUFRLE1BQzdCLENBQUMsTUFBTSxHQUFHLHlCQUF5QixLQUFLLEdBQUcsY0FBYztJQUMzRCxNQUFNLGVBQWUsQ0FBQyxHQUFHLENBQ3ZCLEtBQ0EsQ0FBQyxNQUFNLGVBQWUsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUk7SUFFMUMsMEVBQTBFO0lBQzFFLHlDQUF5QztJQUN6QyxNQUFNLGFBQWEsZ0JBQWdCO0lBQ25DLE1BQU0sUUFBUSxNQUFNLGNBQWMsQ0FBQyxHQUFHLENBQUMsZUFDbkMsTUFBTSxjQUFjLENBQUMsSUFBSSxHQUFHLHFCQUM1QixhQUNBO0lBQ0osTUFBTSxjQUFjLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxNQUFNLGNBQWMsQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLElBQUk7RUFDM0U7QUFDRjtBQUVBLDBFQUEwRSxHQUMxRSxNQUFNLHFCQUFxQjtBQUUzQiw2RUFBNkUsR0FDN0UsTUFBTSxpQkFBaUI7QUFFdkIsK0RBQStELEdBQy9ELE1BQU0sa0JBQWtCO0FBRXhCLCtFQUErRTtBQUMvRSw2RUFBNkU7QUFDN0UsdUJBQXVCO0FBQ3ZCLE1BQU0sbUJBQXdDLElBQUksSUFBSTtFQUNwRDtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0NBQ0Q7QUFFRCw4RUFBOEUsR0FDOUUsU0FBUyxVQUFVLElBQVk7RUFDN0IsTUFBTSxXQUFXLEtBQUssS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUUsT0FBTyxDQUFDLFFBQVEsSUFBSSxLQUFLLENBQUM7RUFDL0QsT0FBTyxTQUFTLEdBQUcsQ0FBQyxDQUFDLFNBQVM7SUFDNUIsSUFBSSxRQUFRLENBQUMsRUFBRSxLQUFLLFdBQVcsVUFBVSxHQUFHLE9BQU87SUFDbkQsSUFBSSxRQUFRLENBQUMsRUFBRSxLQUFLLFdBQVcsVUFBVSxHQUFHLE9BQU87SUFDbkQsSUFBSSxRQUFRLElBQUksQ0FBQyxVQUFVLE9BQU87SUFDbEMsT0FBTyxpQkFBaUIsR0FBRyxDQUFDLFdBQVcsVUFBVTtFQUNuRCxHQUFHLElBQUksQ0FBQztBQUNWO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FnQkMsR0FDRCxPQUFPLFNBQVMsZ0JBQWdCLElBQXVCO0VBQ3JELE1BQU0sT0FBTyxlQUFlO0VBQzVCLE1BQU0sUUFBUSxTQUFTLFFBQ25CO0lBQUMsVUFBVSxpQkFBaUIsS0FBSyxDQUFDLEVBQUUsSUFBSTtHQUFJLEdBQzVDLEVBQUU7RUFDTixNQUFNLFNBQVMsY0FBYztFQUM3QixNQUFNLFlBQVksVUFBVSxNQUFNO0VBQ2xDLE1BQU0sUUFBUSxjQUFjLGFBQWEsZUFBZSxHQUFHLENBQUMsYUFDeEQsWUFDQTtFQUNKLE1BQU0sUUFBUTtPQUFJLElBQUksSUFBSSxZQUFZO0dBQU8sQ0FBQyxJQUFJLEdBQUcsR0FBRyxDQUFDLENBQUM7SUFDeEQsSUFBSSxTQUFTLFlBQVksV0FBVyxXQUFXLE9BQU8sQ0FBQyxPQUFPLEVBQUUsUUFBUTtJQUN4RSxJQUFJLFNBQVMsYUFBYSxVQUFVLFdBQVcsT0FBTyxDQUFDLFFBQVEsRUFBRSxPQUFPO0lBQ3hFLE9BQU87RUFDVDtFQUNBLE9BQU87SUFBQztPQUFTO09BQVU7R0FBTSxDQUFDLElBQUksQ0FBQyxLQUFLLEtBQUssQ0FBQyxHQUFHO0FBQ3ZEO0FBRUEseUVBQXlFLEdBQ3pFLE1BQU0sd0JBQXdCO0FBRTlCLHVFQUF1RTtBQUN2RSw0RUFBNEU7QUFDNUUsc0JBQXNCO0FBQ3RCLE1BQU0sa0JBQWtCO0FBRXhCOzs7Ozs7Ozs7OztDQVdDLEdBQ0QsU0FBUyxjQUFjLElBQXVCO0VBQzVDLE1BQU0sUUFBUSxVQUFVLE1BQU07RUFDOUIsT0FBTyxVQUFVLGFBQWEsTUFBTSxNQUFNLElBQUkseUJBQzFDLGdCQUFnQixJQUFJLENBQUMsU0FDckIsUUFDQTtBQUNOO0FBRUEsOEVBQThFO0FBQzlFLDJFQUEyRTtBQUMzRSxtRUFBbUU7QUFDbkUsTUFBTSxpQkFBc0MsSUFBSSxJQUFJO0VBQ2xEO0VBQ0E7RUFDQTtFQUNBO0NBQ0Q7QUFFRCwwRUFBMEUsR0FDMUUsU0FBUyxVQUNQLElBQXVCLEVBQ3ZCLElBQVk7RUFFWixJQUFLLElBQUksSUFBSSxHQUFHLElBQUksS0FBSyxNQUFNLEVBQUUsSUFBSztJQUNwQyxNQUFNLFFBQVEsSUFBSSxDQUFDLEVBQUU7SUFDckIsSUFBSSxVQUFVLE1BQU0sT0FBTztJQUMzQixJQUFJLFVBQVUsTUFBTSxPQUFPLElBQUksQ0FBQyxJQUFJLEVBQUU7SUFDdEMsSUFBSSxNQUFNLFVBQVUsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDLEdBQUcsT0FBTyxNQUFNLEtBQUssQ0FBQyxLQUFLLE1BQU0sR0FBRztFQUNyRTtFQUNBLE9BQU87QUFDVDtBQUVBLDhDQUE4QyxHQUM5QyxPQUFPLFNBQVM7RUFDZCxNQUFNLFNBQVM7RUFDZixNQUFNLFlBQVk7QUFDcEI7QUFFQSw0Q0FBNEMsR0FDNUMsT0FBTyxTQUFTO0VBQ2QsTUFBTSxXQUFXO0FBQ25CO0FBRUEsdUNBQXVDLEdBQ3ZDLE9BQU8sU0FBUztFQUNkLE1BQU0sWUFBWTtBQUNwQjtBQUVBLDhDQUE4QyxHQUM5QyxPQUFPLFNBQVM7RUFDZCxNQUFNLGlCQUFpQjtBQUN6QjtBQUVBLCtDQUErQyxHQUMvQyxPQUFPLFNBQVM7RUFDZCxNQUFNLG1CQUFtQjtBQUMzQjtBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUztFQUNkLE1BQU0sS0FBSyxHQUFHO0VBQ2QsTUFBTSxZQUFZLENBQUMsS0FBSztFQUN4QixNQUFNLFVBQVUsQ0FBQyxLQUFLO0VBQ3RCLE1BQU0sYUFBYSxDQUFDLE1BQU0sR0FBRztFQUM3QixNQUFNLFNBQVMsR0FBRztFQUNsQixNQUFNLFdBQVcsR0FBRztFQUNwQixNQUFNLFlBQVksR0FBRztFQUNyQixNQUFNLFlBQVksR0FBRztFQUNyQixNQUFNLGlCQUFpQixHQUFHO0VBQzFCLE1BQU0sbUJBQW1CLEdBQUc7RUFDNUIsd0RBQXdEO0VBQ3hELE1BQU0sWUFBWSxHQUFHO0VBQ3JCLE1BQU0sZUFBZSxDQUFDLEtBQUs7RUFDM0IsTUFBTSxjQUFjLENBQUMsS0FBSztFQUMxQixNQUFNLGtCQUFrQixDQUFDLE1BQU0sR0FBRztBQUNwQztBQUVBOztDQUVDLEdBQ0QsT0FBTyxTQUFTO0VBQ2QsTUFBTSxlQUF1QyxDQUFDO0VBQzlDLEtBQUssTUFBTSxDQUFDLE1BQU0sTUFBTSxJQUFJLE1BQU0sWUFBWSxDQUFFO0lBQzlDLFlBQVksQ0FBQyxLQUFLLEdBQUc7RUFDdkI7RUFDQSxNQUFNLGFBQXFDLENBQUM7RUFDNUMsS0FBSyxNQUFNLENBQUMsTUFBTSxNQUFNLElBQUksTUFBTSxVQUFVLENBQUU7SUFDNUMsVUFBVSxDQUFDLEtBQUssR0FBRztFQUNyQjtFQUNBLE1BQU0sa0JBQTBDLENBQUM7RUFDakQsS0FBSyxNQUFNLENBQUMsTUFBTSxNQUFNLElBQUksTUFBTSxlQUFlLENBQUU7SUFDakQsZUFBZSxDQUFDLEtBQUssR0FBRztFQUMxQjtFQUNBLE9BQU87SUFDTCxPQUFPLE1BQU0sS0FBSztJQUNsQjtJQUNBO0lBQ0EsV0FBVyxNQUFNLFNBQVM7SUFDMUIsYUFBYSxNQUFNLFdBQVc7SUFDOUIsY0FBYyxNQUFNLFlBQVk7SUFDaEMsY0FBYyxNQUFNLFlBQVk7SUFDaEMsbUJBQW1CLE1BQU0saUJBQWlCO0lBQzFDLHFCQUFxQixNQUFNLG1CQUFtQjtJQUM5QyxjQUFjLE1BQU0sWUFBWTtJQUNoQztFQUNGO0FBQ0Y7QUFFQTs7Ozs7Q0FLQyxHQUNELE9BQU8sU0FBUztFQUNkLE1BQU0sT0FBTztFQUNiLE1BQU0sVUFBVSxPQUFPLE9BQU8sQ0FBQyxLQUFLLFlBQVksRUFDN0MsSUFBSSxDQUFDLENBQUMsR0FBRyxJQUFNLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDLEVBQUUsRUFDMUIsR0FBRyxDQUFDLENBQUMsQ0FBQyxNQUFNLE1BQU0sR0FBSyxHQUFHLEtBQUssT0FBTyxDQUFDLFFBQVEsS0FBSyxDQUFDLEVBQUUsT0FBTyxFQUM5RCxJQUFJLENBQUM7RUFFUixNQUFNLFFBQVE7SUFDWixHQUFHLEtBQUssS0FBSyxDQUFDLE1BQU0sQ0FBQztJQUNyQixHQUFHLEtBQUssWUFBWSxDQUFDLGVBQWUsQ0FBQztJQUNyQyxHQUFHLEtBQUssWUFBWSxDQUFDLFFBQVEsQ0FBQztHQUMvQjtFQUVELGlFQUFpRTtFQUNqRSxvRUFBb0U7RUFDcEUsbUVBQW1FO0VBQ25FLDZCQUE2QjtFQUM3QixJQUFJLEtBQUssaUJBQWlCLEdBQUcsS0FBSyxLQUFLLG1CQUFtQixHQUFHLEdBQUc7SUFDOUQsTUFBTSxJQUFJLENBQ1IsQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLGlCQUFpQixDQUFDLE1BQU0sRUFBRSxLQUFLLG1CQUFtQixFQUFFO0VBRW5GO0VBRUEsSUFBSSxTQUFTLE1BQU0sSUFBSSxDQUFDO0VBRXhCLE9BQU8sQ0FBQyxVQUFVLEVBQUUsTUFBTSxJQUFJLENBQUMsT0FBTztBQUN4QztBQUVBOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLFNBQVMsMEJBQTBCLFlBQVksQ0FBQztFQUNyRCxNQUFNLE1BQU07T0FBSSxNQUFNLGNBQWMsQ0FBQyxPQUFPO0dBQUcsQ0FDNUMsSUFBSSxDQUFDLENBQUMsR0FBRyxJQUFNLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsRUFBRSxHQUNyRCxLQUFLLENBQUMsR0FBRyxLQUFLLEdBQUcsQ0FBQyxHQUFHLFlBQ3JCLEdBQUcsQ0FBQyxDQUFDLENBQUMsT0FBTyxNQUFNLEdBQUssR0FBRyxNQUFNLEVBQUUsRUFBRSxNQUFNLENBQUMsQ0FBQyxFQUM3QyxJQUFJLENBQUM7RUFDUixPQUFPLENBQUMsZ0JBQWdCLEVBQUUsT0FBTyxRQUFRO0FBQzNDO0FBRUE7Ozs7Ozs7Ozs7O0NBV0MsR0FDRCxPQUFPLFNBQVM7RUFDZCxNQUFNLE9BQU87RUFDYixNQUFNLFVBQVUsT0FBTyxPQUFPLENBQUMsS0FBSyxVQUFVO0VBQzlDLElBQUksUUFBUSxNQUFNLEtBQUssR0FBRztJQUN4QixPQUFPO0VBQ1Q7RUFDQSxNQUFNLFFBQVEsUUFDWCxJQUFJLENBQUMsQ0FBQyxHQUFHLElBQU0sQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUMsRUFBRSxFQUMxQixHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sTUFBTSxHQUFLLEdBQUcsS0FBSyxDQUFDLEVBQUUsT0FBTyxFQUN6QyxJQUFJLENBQUM7RUFDUixPQUFPLENBQUMsc0JBQXNCLEVBQUUsT0FBTztBQUN6QztBQUVBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXVCQyxHQUNELE9BQU8sU0FBUztFQUNkLE1BQU0sT0FBTztFQUNiLElBQUksS0FBSyxZQUFZLEtBQUssR0FBRztJQUMzQixPQUFPO0VBQ1Q7RUFDQSxNQUFNLFFBQVEsT0FBTyxPQUFPLENBQUMsS0FBSyxlQUFlLEVBQzlDLElBQUksQ0FBQyxDQUFDLEdBQUcsSUFBTSxDQUFDLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQyxFQUFFLEVBQzFCLEdBQUcsQ0FBQyxDQUFDLENBQUMsTUFBTSxNQUFNLEdBQUssR0FBRyxLQUFLLENBQUMsRUFBRSxPQUFPO0VBQzVDLE9BQU8sQ0FBQyxlQUFlLEVBQUUsS0FBSyxZQUFZLENBQUMsUUFBUSxFQUFFLE1BQU0sSUFBSSxDQUFDLE9BQU87QUFDekUifQ==
// denoCacheMetadata=8406592010677723445,15060463982696585138