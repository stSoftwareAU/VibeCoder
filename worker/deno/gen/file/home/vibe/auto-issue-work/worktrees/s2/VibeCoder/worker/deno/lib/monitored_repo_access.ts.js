/**
 * Per-repo access state for monitored repos (Issue #4036).
 *
 * Probe outcomes used to be logged per tick and discarded, so nothing in
 * the worker could answer the question the health gate needs to
 * ask: *are all monitored repos reachable right now?* During the host-3
 * incident (#4028) two repos 404'd for days while the worker stayed
 * green.
 *
 * This module is the missing memory: an in-process store folding one
 * probe outcome at a time into a per-repo verdict.
 *
 * # Hysteresis and auto-recovery
 *
 * A single `access_denied` must not flip the fleet, so a repo only
 * counts as inaccessible after {@link ACCESS_FAILURE_THRESHOLD}
 * *consecutive* access-denied probes. Recovery is automatic and
 * immediate: one `ok` probe resets the counter to zero, so health comes
 * back on its own once access is restored — no operator action, no
 * decay window.
 *
 * `transient` and `parse_failed` are deliberately neutral. They neither
 * escalate an untripped repo nor clear a tripped one, because a network
 * blip, a 5xx, a rate-limit window or unparseable JSON says nothing
 * about whether the identity can still see the repo.
 *
 * ```mermaid
 * stateDiagram-v2
 *     [*] --> unknown
 *     unknown --> accessible: ok
 *     unknown --> counting: access_denied
 *     counting --> inaccessible: access_denied (count >= threshold)
 *     counting --> accessible: ok
 *     inaccessible --> accessible: ok (counter reset to 0)
 *     counting --> counting: transient / parse_failed
 *     inaccessible --> inaccessible: transient / parse_failed
 * ```
 *
 * The probe paths that feed it are wired in #4037 — the Priority 2
 * scan's per-repo issue-list fetch (`fetchAllIssues`) and the
 * idle-detect audit (`auditClaimableState`), both via
 * {@link recordRepoProbeBestEffort}. The health gate that reads the
 * store is #4038; the operator-facing reason and status line built from
 * it are #4039.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */ /**
 * Consecutive access-denied probes required before a repo counts as
 * inaccessible. Two, not one: a lone denial is far more likely to be a
 * misclassified blip than a genuine loss of access, and flipping the
 * whole fleet unhealthy on it would train operators to ignore the
 * signal.
 */ export const ACCESS_FAILURE_THRESHOLD = 2;
/** Repo → state. Process-local; `resetRepoAccessState()` clears it. */ const accessStates = new Map();
/**
 * Validate and normalise a repo identifier. Blank input is a caller bug
 * that would otherwise silently create a phantom entry, so it fails
 * loud rather than being swallowed.
 */ function normaliseRepo(repo) {
  const trimmed = typeof repo === "string" ? repo.trim() : "";
  if (trimmed === "") {
    throw new TypeError("repo must be a non-empty string");
  }
  return trimmed;
}
/** Fresh, never-probed state for `repo`. */ function unknownState(repo) {
  return {
    repo,
    lastOutcome: "unknown",
    consecutiveAccessDenied: 0
  };
}
/**
 * Fold one probe result into the store.
 *
 * - `ok` → counter reset to 0, `lastOkAt` stamped with `now`.
 * - `access_denied` → counter incremented.
 * - `transient` / `parse_failed` → counter untouched (neutral).
 *
 * @param repo Repo in `owner/repo` form.
 * @param outcome Probe outcome, as classified by `classifyProbeFailure`.
 * @param now Epoch milliseconds of the probe. Defaults to `Date.now()`.
 */ export function recordRepoProbe(repo, outcome, now = Date.now()) {
  const key = normaliseRepo(repo);
  const state = accessStates.get(key) ?? unknownState(key);
  state.lastOutcome = outcome;
  if (outcome === "ok") {
    state.consecutiveAccessDenied = 0;
    state.lastOkAt = now;
  } else if (outcome === "access_denied") {
    state.consecutiveAccessDenied += 1;
  }
  // `transient` and `parse_failed` are neutral: they record the outcome
  // but leave the hysteresis counter exactly as it was.
  accessStates.set(key, state);
}
/**
 * Repos currently considered inaccessible — those with at least
 * {@link ACCESS_FAILURE_THRESHOLD} consecutive access-denied probes.
 *
 * The list is sorted lexicographically rather than returned in Map
 * insertion order, so health messages built from it are byte-identical
 * between ticks and cannot flap for cosmetic reasons.
 */ export function getInaccessibleRepos() {
  const inaccessible = [];
  for (const state of accessStates.values()){
    if (state.consecutiveAccessDenied >= ACCESS_FAILURE_THRESHOLD) {
      inaccessible.push(state.repo);
    }
  }
  return inaccessible.sort((a, b)=>a < b ? -1 : a > b ? 1 : 0);
}
/**
 * Current state for `repo`. A repo that has never been probed returns
 * an `unknown` state rather than `undefined`, so callers never have to
 * special-case the first tick. The returned object is a copy — mutating
 * it does not affect the store.
 */ export function getRepoAccessState(repo) {
  const key = normaliseRepo(repo);
  const state = accessStates.get(key);
  return state ? {
    ...state
  } : unknownState(key);
}
/**
 * Record a probe outcome without ever disturbing the caller (Issue
 * #4037).
 *
 * The probe paths that feed this store — the Priority 2 scan's per-repo
 * issue-list fetch and the idle-detect audit — are load-bearing worker
 * behaviour. Bookkeeping must never convert a tolerated fetch error into
 * a thrown one, nor abort a scan because a repo identifier was
 * malformed. The failure is still surfaced on stderr rather than
 * swallowed, so a persistently mis-called site is visible in the log.
 */ export function recordRepoProbeBestEffort(repo, outcome, now) {
  try {
    recordRepoProbe(repo, outcome, now ?? Date.now());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[repo-access] failed to record ${outcome} probe for "${repo}": ${message}`);
  }
}
// ---------------------------------------------------------------------------
// Operator-facing status line and reason (Issue #4039)
// ---------------------------------------------------------------------------
/**
 * Stable prefix of the structured status line. Operators grep for this
 * to recover the state of a past outage from a worker log, so it must
 * not change.
 */ export const REPO_ACCESS_LOG_PREFIX = "[repo-access]";
/**
 * Human-readable reason naming the inaccessible repos, in the store's
 * stable (lexicographic) order — e.g.
 * `repos inaccessible: TitlePage/foo, TitlePage/bar`.
 *
 * `lastHealthCheckPassed = false` on its own is not actionable: the fix
 * depends entirely on *which* repos went dark (#4031). This is the
 * string a health-reporting callback carries as its reason.
 */ export function formatInaccessibleReposReason(repos) {
  return `repos inaccessible: ${repos.join(", ")}`;
}
/**
 * Highest consecutive access-denied count across `repos` — how long the
 * outage has run for the worst-affected repo.
 *
 * A repo the store has never seen contributes 0 rather than being
 * guessed at, so the number never overstates what was actually observed.
 */ export function maxConsecutiveAccessDenied(repos) {
  let highest = 0;
  for (const repo of repos){
    const state = accessStates.get(repo.trim());
    if (state && state.consecutiveAccessDenied > highest) {
      highest = state.consecutiveAccessDenied;
    }
  }
  return highest;
}
/** Short host id (domain suffix trimmed), or `unknown` when unavailable. */ function readHostId() {
  let host;
  try {
    host = Deno.hostname();
  } catch  {
    return "unknown";
  }
  const dotIndex = host.indexOf(".");
  return dotIndex > 0 ? host.substring(0, dotIndex) : host;
}
/**
 * The structured, greppable status line — e.g.
 * `[repo-access] host=host-3 status=inaccessible repos=org/a,org/b consecutive=2`.
 *
 * Repos are comma-separated without spaces so the whole line survives a
 * `cut`/`awk` field split on whitespace.
 */ export function formatRepoAccessLogLine(hostId, repos) {
  return `${REPO_ACCESS_LOG_PREFIX} host=${hostId} status=inaccessible ` + `repos=${repos.join(",")} consecutive=${maxConsecutiveAccessDenied(repos)}`;
}
/** Last line emitted, so identical alerts are not repeated. */ let lastLoggedLine = null;
/**
 * Emit the structured status line at most once per iteration.
 *
 * Several call sites observe the same condition in one iteration — the
 * health gate in `run_core.ts` and the repo scan — and logging
 * from each would turn one outage into per-call-site spam. The line is
 * therefore suppressed when it is byte-identical to the previous one;
 * {@link resetRepoAccessLogState} is called at the iteration boundary so
 * an ongoing outage still leaves exactly one line per iteration. A
 * changed repo set is new information and is always logged.
 *
 * Healthy hosts log nothing at all: an empty `repos` is a no-op.
 *
 * @returns `true` when a line was written, `false` when suppressed.
 */ export function logRepoAccessOnce(repos, sink, options = {}) {
  if (repos.length === 0) return false;
  const line = formatRepoAccessLogLine(options.hostId ?? readHostId(), repos);
  if (line === lastLoggedLine) return false;
  lastLoggedLine = line;
  sink(options.suffix ? `${line} — ${options.suffix}` : line);
  return true;
}
/** Forget the last emitted line. Called at each iteration boundary. */ export function resetRepoAccessLogState() {
  lastLoggedLine = null;
}
/** Clear all recorded state. Test seam. */ export function resetRepoAccessState() {
  accessStates.clear();
  resetRepoAccessLogState();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9tb25pdG9yZWRfcmVwb19hY2Nlc3MudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBQZXItcmVwbyBhY2Nlc3Mgc3RhdGUgZm9yIG1vbml0b3JlZCByZXBvcyAoSXNzdWUgIzQwMzYpLlxuICpcbiAqIFByb2JlIG91dGNvbWVzIHVzZWQgdG8gYmUgbG9nZ2VkIHBlciB0aWNrIGFuZCBkaXNjYXJkZWQsIHNvIG5vdGhpbmcgaW5cbiAqIHRoZSB3b3JrZXIgY291bGQgYW5zd2VyIHRoZSBxdWVzdGlvbiB0aGUgaGVhbHRoIGdhdGUgbmVlZHMgdG9cbiAqIGFzazogKmFyZSBhbGwgbW9uaXRvcmVkIHJlcG9zIHJlYWNoYWJsZSByaWdodCBub3c/KiBEdXJpbmcgdGhlIGhvc3QtM1xuICogaW5jaWRlbnQgKCM0MDI4KSB0d28gcmVwb3MgNDA0J2QgZm9yIGRheXMgd2hpbGUgdGhlIHdvcmtlciBzdGF5ZWRcbiAqIGdyZWVuLlxuICpcbiAqIFRoaXMgbW9kdWxlIGlzIHRoZSBtaXNzaW5nIG1lbW9yeTogYW4gaW4tcHJvY2VzcyBzdG9yZSBmb2xkaW5nIG9uZVxuICogcHJvYmUgb3V0Y29tZSBhdCBhIHRpbWUgaW50byBhIHBlci1yZXBvIHZlcmRpY3QuXG4gKlxuICogIyBIeXN0ZXJlc2lzIGFuZCBhdXRvLXJlY292ZXJ5XG4gKlxuICogQSBzaW5nbGUgYGFjY2Vzc19kZW5pZWRgIG11c3Qgbm90IGZsaXAgdGhlIGZsZWV0LCBzbyBhIHJlcG8gb25seVxuICogY291bnRzIGFzIGluYWNjZXNzaWJsZSBhZnRlciB7QGxpbmsgQUNDRVNTX0ZBSUxVUkVfVEhSRVNIT0xEfVxuICogKmNvbnNlY3V0aXZlKiBhY2Nlc3MtZGVuaWVkIHByb2Jlcy4gUmVjb3ZlcnkgaXMgYXV0b21hdGljIGFuZFxuICogaW1tZWRpYXRlOiBvbmUgYG9rYCBwcm9iZSByZXNldHMgdGhlIGNvdW50ZXIgdG8gemVybywgc28gaGVhbHRoIGNvbWVzXG4gKiBiYWNrIG9uIGl0cyBvd24gb25jZSBhY2Nlc3MgaXMgcmVzdG9yZWQg4oCUIG5vIG9wZXJhdG9yIGFjdGlvbiwgbm9cbiAqIGRlY2F5IHdpbmRvdy5cbiAqXG4gKiBgdHJhbnNpZW50YCBhbmQgYHBhcnNlX2ZhaWxlZGAgYXJlIGRlbGliZXJhdGVseSBuZXV0cmFsLiBUaGV5IG5laXRoZXJcbiAqIGVzY2FsYXRlIGFuIHVudHJpcHBlZCByZXBvIG5vciBjbGVhciBhIHRyaXBwZWQgb25lLCBiZWNhdXNlIGEgbmV0d29ya1xuICogYmxpcCwgYSA1eHgsIGEgcmF0ZS1saW1pdCB3aW5kb3cgb3IgdW5wYXJzZWFibGUgSlNPTiBzYXlzIG5vdGhpbmdcbiAqIGFib3V0IHdoZXRoZXIgdGhlIGlkZW50aXR5IGNhbiBzdGlsbCBzZWUgdGhlIHJlcG8uXG4gKlxuICogYGBgbWVybWFpZFxuICogc3RhdGVEaWFncmFtLXYyXG4gKiAgICAgWypdIC0tPiB1bmtub3duXG4gKiAgICAgdW5rbm93biAtLT4gYWNjZXNzaWJsZTogb2tcbiAqICAgICB1bmtub3duIC0tPiBjb3VudGluZzogYWNjZXNzX2RlbmllZFxuICogICAgIGNvdW50aW5nIC0tPiBpbmFjY2Vzc2libGU6IGFjY2Vzc19kZW5pZWQgKGNvdW50ID49IHRocmVzaG9sZClcbiAqICAgICBjb3VudGluZyAtLT4gYWNjZXNzaWJsZTogb2tcbiAqICAgICBpbmFjY2Vzc2libGUgLS0+IGFjY2Vzc2libGU6IG9rIChjb3VudGVyIHJlc2V0IHRvIDApXG4gKiAgICAgY291bnRpbmcgLS0+IGNvdW50aW5nOiB0cmFuc2llbnQgLyBwYXJzZV9mYWlsZWRcbiAqICAgICBpbmFjY2Vzc2libGUgLS0+IGluYWNjZXNzaWJsZTogdHJhbnNpZW50IC8gcGFyc2VfZmFpbGVkXG4gKiBgYGBcbiAqXG4gKiBUaGUgcHJvYmUgcGF0aHMgdGhhdCBmZWVkIGl0IGFyZSB3aXJlZCBpbiAjNDAzNyDigJQgdGhlIFByaW9yaXR5IDJcbiAqIHNjYW4ncyBwZXItcmVwbyBpc3N1ZS1saXN0IGZldGNoIChgZmV0Y2hBbGxJc3N1ZXNgKSBhbmQgdGhlXG4gKiBpZGxlLWRldGVjdCBhdWRpdCAoYGF1ZGl0Q2xhaW1hYmxlU3RhdGVgKSwgYm90aCB2aWFcbiAqIHtAbGluayByZWNvcmRSZXBvUHJvYmVCZXN0RWZmb3J0fS4gVGhlIGhlYWx0aCBnYXRlIHRoYXQgcmVhZHMgdGhlXG4gKiBzdG9yZSBpcyAjNDAzODsgdGhlIG9wZXJhdG9yLWZhY2luZyByZWFzb24gYW5kIHN0YXR1cyBsaW5lIGJ1aWx0IGZyb21cbiAqIGl0IGFyZSAjNDAzOS5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdXNlZCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBQcm9iZUZhaWx1cmVLaW5kIH0gZnJvbSBcIi4vaWRsZV9kZXRlY3RfZGlhZ25vc3RpY3MudHNcIjtcblxuLyoqXG4gKiBPdXRjb21lIG9mIGEgc2luZ2xlIHJlcG8gcHJvYmUuIFRoZSBmYWlsdXJlIGtpbmRzIGFyZSBleGFjdGx5IHRob3NlXG4gKiB7QGxpbmsgUHJvYmVGYWlsdXJlS2luZH0gcHJvZHVjZXMsIHNvIHRoaXMgc3RvcmUgc3RheXMgaW4gbG9ja3N0ZXBcbiAqIHdpdGggdGhlIGNsYXNzaWZpZXIgYWRkZWQgaW4gIzQwMzUuXG4gKi9cbmV4cG9ydCB0eXBlIFJlcG9Qcm9iZU91dGNvbWUgPSBcIm9rXCIgfCBQcm9iZUZhaWx1cmVLaW5kO1xuXG4vKipcbiAqIExhc3Qga25vd24gb3V0Y29tZSBmb3IgYSByZXBvLiBgdW5rbm93bmAgbWVhbnMgdGhlIHJlcG8gaGFzIG5ldmVyXG4gKiBiZWVuIHByb2JlZCBpbiB0aGlzIHByb2Nlc3Mg4oCUIGl0IGlzIG5ldmVyIHJlcG9ydGVkIGluYWNjZXNzaWJsZS5cbiAqL1xuZXhwb3J0IHR5cGUgUmVwb0FjY2Vzc091dGNvbWUgPSBSZXBvUHJvYmVPdXRjb21lIHwgXCJ1bmtub3duXCI7XG5cbi8qKiBBY2Nlc3Mgc3RhdGUgdGhlIHN0b3JlIGhvbGRzIGZvciBvbmUgbW9uaXRvcmVkIHJlcG8uICovXG5leHBvcnQgaW50ZXJmYWNlIFJlcG9BY2Nlc3NTdGF0ZSB7XG4gIC8qKiBSZXBvIGluIGBvd25lci9yZXBvYCBmb3JtLCB0cmltbWVkLiAqL1xuICByZXBvOiBzdHJpbmc7XG4gIC8qKiBPdXRjb21lIG9mIHRoZSBtb3N0IHJlY2VudCBwcm9iZSwgb3IgYHVua25vd25gIGlmIG5ldmVyIHByb2JlZC4gKi9cbiAgbGFzdE91dGNvbWU6IFJlcG9BY2Nlc3NPdXRjb21lO1xuICAvKiogQ29uc2VjdXRpdmUgYGFjY2Vzc19kZW5pZWRgIHByb2JlczsgYW55IGBva2AgcmVzZXRzIGl0IHRvIDAuICovXG4gIGNvbnNlY3V0aXZlQWNjZXNzRGVuaWVkOiBudW1iZXI7XG4gIC8qKiBFcG9jaCBtaWxsaXNlY29uZHMgb2YgdGhlIGxhc3Qgc3VjY2Vzc2Z1bCBwcm9iZSwgaWYgYW55LiAqL1xuICBsYXN0T2tBdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBDb25zZWN1dGl2ZSBhY2Nlc3MtZGVuaWVkIHByb2JlcyByZXF1aXJlZCBiZWZvcmUgYSByZXBvIGNvdW50cyBhc1xuICogaW5hY2Nlc3NpYmxlLiBUd28sIG5vdCBvbmU6IGEgbG9uZSBkZW5pYWwgaXMgZmFyIG1vcmUgbGlrZWx5IHRvIGJlIGFcbiAqIG1pc2NsYXNzaWZpZWQgYmxpcCB0aGFuIGEgZ2VudWluZSBsb3NzIG9mIGFjY2VzcywgYW5kIGZsaXBwaW5nIHRoZVxuICogd2hvbGUgZmxlZXQgdW5oZWFsdGh5IG9uIGl0IHdvdWxkIHRyYWluIG9wZXJhdG9ycyB0byBpZ25vcmUgdGhlXG4gKiBzaWduYWwuXG4gKi9cbmV4cG9ydCBjb25zdCBBQ0NFU1NfRkFJTFVSRV9USFJFU0hPTEQgPSAyO1xuXG4vKiogUmVwbyDihpIgc3RhdGUuIFByb2Nlc3MtbG9jYWw7IGByZXNldFJlcG9BY2Nlc3NTdGF0ZSgpYCBjbGVhcnMgaXQuICovXG5jb25zdCBhY2Nlc3NTdGF0ZXMgPSBuZXcgTWFwPHN0cmluZywgUmVwb0FjY2Vzc1N0YXRlPigpO1xuXG4vKipcbiAqIFZhbGlkYXRlIGFuZCBub3JtYWxpc2UgYSByZXBvIGlkZW50aWZpZXIuIEJsYW5rIGlucHV0IGlzIGEgY2FsbGVyIGJ1Z1xuICogdGhhdCB3b3VsZCBvdGhlcndpc2Ugc2lsZW50bHkgY3JlYXRlIGEgcGhhbnRvbSBlbnRyeSwgc28gaXQgZmFpbHNcbiAqIGxvdWQgcmF0aGVyIHRoYW4gYmVpbmcgc3dhbGxvd2VkLlxuICovXG5mdW5jdGlvbiBub3JtYWxpc2VSZXBvKHJlcG86IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSB0eXBlb2YgcmVwbyA9PT0gXCJzdHJpbmdcIiA/IHJlcG8udHJpbSgpIDogXCJcIjtcbiAgaWYgKHRyaW1tZWQgPT09IFwiXCIpIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwicmVwbyBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZ1wiKTtcbiAgfVxuICByZXR1cm4gdHJpbW1lZDtcbn1cblxuLyoqIEZyZXNoLCBuZXZlci1wcm9iZWQgc3RhdGUgZm9yIGByZXBvYC4gKi9cbmZ1bmN0aW9uIHVua25vd25TdGF0ZShyZXBvOiBzdHJpbmcpOiBSZXBvQWNjZXNzU3RhdGUge1xuICByZXR1cm4geyByZXBvLCBsYXN0T3V0Y29tZTogXCJ1bmtub3duXCIsIGNvbnNlY3V0aXZlQWNjZXNzRGVuaWVkOiAwIH07XG59XG5cbi8qKlxuICogRm9sZCBvbmUgcHJvYmUgcmVzdWx0IGludG8gdGhlIHN0b3JlLlxuICpcbiAqIC0gYG9rYCDihpIgY291bnRlciByZXNldCB0byAwLCBgbGFzdE9rQXRgIHN0YW1wZWQgd2l0aCBgbm93YC5cbiAqIC0gYGFjY2Vzc19kZW5pZWRgIOKGkiBjb3VudGVyIGluY3JlbWVudGVkLlxuICogLSBgdHJhbnNpZW50YCAvIGBwYXJzZV9mYWlsZWRgIOKGkiBjb3VudGVyIHVudG91Y2hlZCAobmV1dHJhbCkuXG4gKlxuICogQHBhcmFtIHJlcG8gUmVwbyBpbiBgb3duZXIvcmVwb2AgZm9ybS5cbiAqIEBwYXJhbSBvdXRjb21lIFByb2JlIG91dGNvbWUsIGFzIGNsYXNzaWZpZWQgYnkgYGNsYXNzaWZ5UHJvYmVGYWlsdXJlYC5cbiAqIEBwYXJhbSBub3cgRXBvY2ggbWlsbGlzZWNvbmRzIG9mIHRoZSBwcm9iZS4gRGVmYXVsdHMgdG8gYERhdGUubm93KClgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkUmVwb1Byb2JlKFxuICByZXBvOiBzdHJpbmcsXG4gIG91dGNvbWU6IFJlcG9Qcm9iZU91dGNvbWUsXG4gIG5vdzogbnVtYmVyID0gRGF0ZS5ub3coKSxcbik6IHZvaWQge1xuICBjb25zdCBrZXkgPSBub3JtYWxpc2VSZXBvKHJlcG8pO1xuICBjb25zdCBzdGF0ZSA9IGFjY2Vzc1N0YXRlcy5nZXQoa2V5KSA/PyB1bmtub3duU3RhdGUoa2V5KTtcblxuICBzdGF0ZS5sYXN0T3V0Y29tZSA9IG91dGNvbWU7XG4gIGlmIChvdXRjb21lID09PSBcIm9rXCIpIHtcbiAgICBzdGF0ZS5jb25zZWN1dGl2ZUFjY2Vzc0RlbmllZCA9IDA7XG4gICAgc3RhdGUubGFzdE9rQXQgPSBub3c7XG4gIH0gZWxzZSBpZiAob3V0Y29tZSA9PT0gXCJhY2Nlc3NfZGVuaWVkXCIpIHtcbiAgICBzdGF0ZS5jb25zZWN1dGl2ZUFjY2Vzc0RlbmllZCArPSAxO1xuICB9XG4gIC8vIGB0cmFuc2llbnRgIGFuZCBgcGFyc2VfZmFpbGVkYCBhcmUgbmV1dHJhbDogdGhleSByZWNvcmQgdGhlIG91dGNvbWVcbiAgLy8gYnV0IGxlYXZlIHRoZSBoeXN0ZXJlc2lzIGNvdW50ZXIgZXhhY3RseSBhcyBpdCB3YXMuXG5cbiAgYWNjZXNzU3RhdGVzLnNldChrZXksIHN0YXRlKTtcbn1cblxuLyoqXG4gKiBSZXBvcyBjdXJyZW50bHkgY29uc2lkZXJlZCBpbmFjY2Vzc2libGUg4oCUIHRob3NlIHdpdGggYXQgbGVhc3RcbiAqIHtAbGluayBBQ0NFU1NfRkFJTFVSRV9USFJFU0hPTER9IGNvbnNlY3V0aXZlIGFjY2Vzcy1kZW5pZWQgcHJvYmVzLlxuICpcbiAqIFRoZSBsaXN0IGlzIHNvcnRlZCBsZXhpY29ncmFwaGljYWxseSByYXRoZXIgdGhhbiByZXR1cm5lZCBpbiBNYXBcbiAqIGluc2VydGlvbiBvcmRlciwgc28gaGVhbHRoIG1lc3NhZ2VzIGJ1aWx0IGZyb20gaXQgYXJlIGJ5dGUtaWRlbnRpY2FsXG4gKiBiZXR3ZWVuIHRpY2tzIGFuZCBjYW5ub3QgZmxhcCBmb3IgY29zbWV0aWMgcmVhc29ucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEluYWNjZXNzaWJsZVJlcG9zKCk6IHN0cmluZ1tdIHtcbiAgY29uc3QgaW5hY2Nlc3NpYmxlOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHN0YXRlIG9mIGFjY2Vzc1N0YXRlcy52YWx1ZXMoKSkge1xuICAgIGlmIChzdGF0ZS5jb25zZWN1dGl2ZUFjY2Vzc0RlbmllZCA+PSBBQ0NFU1NfRkFJTFVSRV9USFJFU0hPTEQpIHtcbiAgICAgIGluYWNjZXNzaWJsZS5wdXNoKHN0YXRlLnJlcG8pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gaW5hY2Nlc3NpYmxlLnNvcnQoKGEsIGIpID0+IChhIDwgYiA/IC0xIDogYSA+IGIgPyAxIDogMCkpO1xufVxuXG4vKipcbiAqIEN1cnJlbnQgc3RhdGUgZm9yIGByZXBvYC4gQSByZXBvIHRoYXQgaGFzIG5ldmVyIGJlZW4gcHJvYmVkIHJldHVybnNcbiAqIGFuIGB1bmtub3duYCBzdGF0ZSByYXRoZXIgdGhhbiBgdW5kZWZpbmVkYCwgc28gY2FsbGVycyBuZXZlciBoYXZlIHRvXG4gKiBzcGVjaWFsLWNhc2UgdGhlIGZpcnN0IHRpY2suIFRoZSByZXR1cm5lZCBvYmplY3QgaXMgYSBjb3B5IOKAlCBtdXRhdGluZ1xuICogaXQgZG9lcyBub3QgYWZmZWN0IHRoZSBzdG9yZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcG9BY2Nlc3NTdGF0ZShyZXBvOiBzdHJpbmcpOiBSZXBvQWNjZXNzU3RhdGUge1xuICBjb25zdCBrZXkgPSBub3JtYWxpc2VSZXBvKHJlcG8pO1xuICBjb25zdCBzdGF0ZSA9IGFjY2Vzc1N0YXRlcy5nZXQoa2V5KTtcbiAgcmV0dXJuIHN0YXRlID8geyAuLi5zdGF0ZSB9IDogdW5rbm93blN0YXRlKGtleSk7XG59XG5cbi8qKlxuICogUmVjb3JkIGEgcHJvYmUgb3V0Y29tZSB3aXRob3V0IGV2ZXIgZGlzdHVyYmluZyB0aGUgY2FsbGVyIChJc3N1ZVxuICogIzQwMzcpLlxuICpcbiAqIFRoZSBwcm9iZSBwYXRocyB0aGF0IGZlZWQgdGhpcyBzdG9yZSDigJQgdGhlIFByaW9yaXR5IDIgc2NhbidzIHBlci1yZXBvXG4gKiBpc3N1ZS1saXN0IGZldGNoIGFuZCB0aGUgaWRsZS1kZXRlY3QgYXVkaXQg4oCUIGFyZSBsb2FkLWJlYXJpbmcgd29ya2VyXG4gKiBiZWhhdmlvdXIuIEJvb2trZWVwaW5nIG11c3QgbmV2ZXIgY29udmVydCBhIHRvbGVyYXRlZCBmZXRjaCBlcnJvciBpbnRvXG4gKiBhIHRocm93biBvbmUsIG5vciBhYm9ydCBhIHNjYW4gYmVjYXVzZSBhIHJlcG8gaWRlbnRpZmllciB3YXNcbiAqIG1hbGZvcm1lZC4gVGhlIGZhaWx1cmUgaXMgc3RpbGwgc3VyZmFjZWQgb24gc3RkZXJyIHJhdGhlciB0aGFuXG4gKiBzd2FsbG93ZWQsIHNvIGEgcGVyc2lzdGVudGx5IG1pcy1jYWxsZWQgc2l0ZSBpcyB2aXNpYmxlIGluIHRoZSBsb2cuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNvcmRSZXBvUHJvYmVCZXN0RWZmb3J0KFxuICByZXBvOiBzdHJpbmcsXG4gIG91dGNvbWU6IFJlcG9Qcm9iZU91dGNvbWUsXG4gIG5vdz86IG51bWJlcixcbik6IHZvaWQge1xuICB0cnkge1xuICAgIHJlY29yZFJlcG9Qcm9iZShyZXBvLCBvdXRjb21lLCBub3cgPz8gRGF0ZS5ub3coKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgY29uc29sZS53YXJuKFxuICAgICAgYFtyZXBvLWFjY2Vzc10gZmFpbGVkIHRvIHJlY29yZCAke291dGNvbWV9IHByb2JlIGZvciBcIiR7cmVwb31cIjogJHttZXNzYWdlfWAsXG4gICAgKTtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIE9wZXJhdG9yLWZhY2luZyBzdGF0dXMgbGluZSBhbmQgcmVhc29uIChJc3N1ZSAjNDAzOSlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFN0YWJsZSBwcmVmaXggb2YgdGhlIHN0cnVjdHVyZWQgc3RhdHVzIGxpbmUuIE9wZXJhdG9ycyBncmVwIGZvciB0aGlzXG4gKiB0byByZWNvdmVyIHRoZSBzdGF0ZSBvZiBhIHBhc3Qgb3V0YWdlIGZyb20gYSB3b3JrZXIgbG9nLCBzbyBpdCBtdXN0XG4gKiBub3QgY2hhbmdlLlxuICovXG5leHBvcnQgY29uc3QgUkVQT19BQ0NFU1NfTE9HX1BSRUZJWCA9IFwiW3JlcG8tYWNjZXNzXVwiO1xuXG4vKipcbiAqIEh1bWFuLXJlYWRhYmxlIHJlYXNvbiBuYW1pbmcgdGhlIGluYWNjZXNzaWJsZSByZXBvcywgaW4gdGhlIHN0b3JlJ3NcbiAqIHN0YWJsZSAobGV4aWNvZ3JhcGhpYykgb3JkZXIg4oCUIGUuZy5cbiAqIGByZXBvcyBpbmFjY2Vzc2libGU6IFRpdGxlUGFnZS9mb28sIFRpdGxlUGFnZS9iYXJgLlxuICpcbiAqIGBsYXN0SGVhbHRoQ2hlY2tQYXNzZWQgPSBmYWxzZWAgb24gaXRzIG93biBpcyBub3QgYWN0aW9uYWJsZTogdGhlIGZpeFxuICogZGVwZW5kcyBlbnRpcmVseSBvbiAqd2hpY2gqIHJlcG9zIHdlbnQgZGFyayAoIzQwMzEpLiBUaGlzIGlzIHRoZVxuICogc3RyaW5nIGEgaGVhbHRoLXJlcG9ydGluZyBjYWxsYmFjayBjYXJyaWVzIGFzIGl0cyByZWFzb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRJbmFjY2Vzc2libGVSZXBvc1JlYXNvbihyZXBvczogc3RyaW5nW10pOiBzdHJpbmcge1xuICByZXR1cm4gYHJlcG9zIGluYWNjZXNzaWJsZTogJHtyZXBvcy5qb2luKFwiLCBcIil9YDtcbn1cblxuLyoqXG4gKiBIaWdoZXN0IGNvbnNlY3V0aXZlIGFjY2Vzcy1kZW5pZWQgY291bnQgYWNyb3NzIGByZXBvc2Ag4oCUIGhvdyBsb25nIHRoZVxuICogb3V0YWdlIGhhcyBydW4gZm9yIHRoZSB3b3JzdC1hZmZlY3RlZCByZXBvLlxuICpcbiAqIEEgcmVwbyB0aGUgc3RvcmUgaGFzIG5ldmVyIHNlZW4gY29udHJpYnV0ZXMgMCByYXRoZXIgdGhhbiBiZWluZ1xuICogZ3Vlc3NlZCBhdCwgc28gdGhlIG51bWJlciBuZXZlciBvdmVyc3RhdGVzIHdoYXQgd2FzIGFjdHVhbGx5IG9ic2VydmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWF4Q29uc2VjdXRpdmVBY2Nlc3NEZW5pZWQocmVwb3M6IHN0cmluZ1tdKTogbnVtYmVyIHtcbiAgbGV0IGhpZ2hlc3QgPSAwO1xuICBmb3IgKGNvbnN0IHJlcG8gb2YgcmVwb3MpIHtcbiAgICBjb25zdCBzdGF0ZSA9IGFjY2Vzc1N0YXRlcy5nZXQocmVwby50cmltKCkpO1xuICAgIGlmIChzdGF0ZSAmJiBzdGF0ZS5jb25zZWN1dGl2ZUFjY2Vzc0RlbmllZCA+IGhpZ2hlc3QpIHtcbiAgICAgIGhpZ2hlc3QgPSBzdGF0ZS5jb25zZWN1dGl2ZUFjY2Vzc0RlbmllZDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGhpZ2hlc3Q7XG59XG5cbi8qKiBTaG9ydCBob3N0IGlkIChkb21haW4gc3VmZml4IHRyaW1tZWQpLCBvciBgdW5rbm93bmAgd2hlbiB1bmF2YWlsYWJsZS4gKi9cbmZ1bmN0aW9uIHJlYWRIb3N0SWQoKTogc3RyaW5nIHtcbiAgbGV0IGhvc3Q6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBob3N0ID0gRGVuby5ob3N0bmFtZSgpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJ1bmtub3duXCI7XG4gIH1cbiAgY29uc3QgZG90SW5kZXggPSBob3N0LmluZGV4T2YoXCIuXCIpO1xuICByZXR1cm4gZG90SW5kZXggPiAwID8gaG9zdC5zdWJzdHJpbmcoMCwgZG90SW5kZXgpIDogaG9zdDtcbn1cblxuLyoqXG4gKiBUaGUgc3RydWN0dXJlZCwgZ3JlcHBhYmxlIHN0YXR1cyBsaW5lIOKAlCBlLmcuXG4gKiBgW3JlcG8tYWNjZXNzXSBob3N0PWhvc3QtMyBzdGF0dXM9aW5hY2Nlc3NpYmxlIHJlcG9zPW9yZy9hLG9yZy9iIGNvbnNlY3V0aXZlPTJgLlxuICpcbiAqIFJlcG9zIGFyZSBjb21tYS1zZXBhcmF0ZWQgd2l0aG91dCBzcGFjZXMgc28gdGhlIHdob2xlIGxpbmUgc3Vydml2ZXMgYVxuICogYGN1dGAvYGF3a2AgZmllbGQgc3BsaXQgb24gd2hpdGVzcGFjZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFJlcG9BY2Nlc3NMb2dMaW5lKFxuICBob3N0SWQ6IHN0cmluZyxcbiAgcmVwb3M6IHN0cmluZ1tdLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke1JFUE9fQUNDRVNTX0xPR19QUkVGSVh9IGhvc3Q9JHtob3N0SWR9IHN0YXR1cz1pbmFjY2Vzc2libGUgYCArXG4gICAgYHJlcG9zPSR7cmVwb3Muam9pbihcIixcIil9IGNvbnNlY3V0aXZlPSR7bWF4Q29uc2VjdXRpdmVBY2Nlc3NEZW5pZWQocmVwb3MpfWA7XG59XG5cbi8qKiBMYXN0IGxpbmUgZW1pdHRlZCwgc28gaWRlbnRpY2FsIGFsZXJ0cyBhcmUgbm90IHJlcGVhdGVkLiAqL1xubGV0IGxhc3RMb2dnZWRMaW5lOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuLyoqXG4gKiBFbWl0IHRoZSBzdHJ1Y3R1cmVkIHN0YXR1cyBsaW5lIGF0IG1vc3Qgb25jZSBwZXIgaXRlcmF0aW9uLlxuICpcbiAqIFNldmVyYWwgY2FsbCBzaXRlcyBvYnNlcnZlIHRoZSBzYW1lIGNvbmRpdGlvbiBpbiBvbmUgaXRlcmF0aW9uIOKAlCB0aGVcbiAqIGhlYWx0aCBnYXRlIGluIGBydW5fY29yZS50c2AgYW5kIHRoZSByZXBvIHNjYW4g4oCUIGFuZCBsb2dnaW5nXG4gKiBmcm9tIGVhY2ggd291bGQgdHVybiBvbmUgb3V0YWdlIGludG8gcGVyLWNhbGwtc2l0ZSBzcGFtLiBUaGUgbGluZSBpc1xuICogdGhlcmVmb3JlIHN1cHByZXNzZWQgd2hlbiBpdCBpcyBieXRlLWlkZW50aWNhbCB0byB0aGUgcHJldmlvdXMgb25lO1xuICoge0BsaW5rIHJlc2V0UmVwb0FjY2Vzc0xvZ1N0YXRlfSBpcyBjYWxsZWQgYXQgdGhlIGl0ZXJhdGlvbiBib3VuZGFyeSBzb1xuICogYW4gb25nb2luZyBvdXRhZ2Ugc3RpbGwgbGVhdmVzIGV4YWN0bHkgb25lIGxpbmUgcGVyIGl0ZXJhdGlvbi4gQVxuICogY2hhbmdlZCByZXBvIHNldCBpcyBuZXcgaW5mb3JtYXRpb24gYW5kIGlzIGFsd2F5cyBsb2dnZWQuXG4gKlxuICogSGVhbHRoeSBob3N0cyBsb2cgbm90aGluZyBhdCBhbGw6IGFuIGVtcHR5IGByZXBvc2AgaXMgYSBuby1vcC5cbiAqXG4gKiBAcmV0dXJucyBgdHJ1ZWAgd2hlbiBhIGxpbmUgd2FzIHdyaXR0ZW4sIGBmYWxzZWAgd2hlbiBzdXBwcmVzc2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9nUmVwb0FjY2Vzc09uY2UoXG4gIHJlcG9zOiBzdHJpbmdbXSxcbiAgc2luazogKGxpbmU6IHN0cmluZykgPT4gdm9pZCxcbiAgb3B0aW9uczogeyBob3N0SWQ/OiBzdHJpbmc7IHN1ZmZpeD86IHN0cmluZyB9ID0ge30sXG4pOiBib29sZWFuIHtcbiAgaWYgKHJlcG9zLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuXG4gIGNvbnN0IGxpbmUgPSBmb3JtYXRSZXBvQWNjZXNzTG9nTGluZShvcHRpb25zLmhvc3RJZCA/PyByZWFkSG9zdElkKCksIHJlcG9zKTtcbiAgaWYgKGxpbmUgPT09IGxhc3RMb2dnZWRMaW5lKSByZXR1cm4gZmFsc2U7XG4gIGxhc3RMb2dnZWRMaW5lID0gbGluZTtcblxuICBzaW5rKG9wdGlvbnMuc3VmZml4ID8gYCR7bGluZX0g4oCUICR7b3B0aW9ucy5zdWZmaXh9YCA6IGxpbmUpO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIEZvcmdldCB0aGUgbGFzdCBlbWl0dGVkIGxpbmUuIENhbGxlZCBhdCBlYWNoIGl0ZXJhdGlvbiBib3VuZGFyeS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldFJlcG9BY2Nlc3NMb2dTdGF0ZSgpOiB2b2lkIHtcbiAgbGFzdExvZ2dlZExpbmUgPSBudWxsO1xufVxuXG4vKiogQ2xlYXIgYWxsIHJlY29yZGVkIHN0YXRlLiBUZXN0IHNlYW0uICovXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRSZXBvQWNjZXNzU3RhdGUoKTogdm9pZCB7XG4gIGFjY2Vzc1N0YXRlcy5jbGVhcigpO1xuICByZXNldFJlcG9BY2Nlc3NMb2dTdGF0ZSgpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBOENDLEdBNkJEOzs7Ozs7Q0FNQyxHQUNELE9BQU8sTUFBTSwyQkFBMkIsRUFBRTtBQUUxQyxxRUFBcUUsR0FDckUsTUFBTSxlQUFlLElBQUk7QUFFekI7Ozs7Q0FJQyxHQUNELFNBQVMsY0FBYyxJQUFZO0VBQ2pDLE1BQU0sVUFBVSxPQUFPLFNBQVMsV0FBVyxLQUFLLElBQUksS0FBSztFQUN6RCxJQUFJLFlBQVksSUFBSTtJQUNsQixNQUFNLElBQUksVUFB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
// denoCacheMetadata=3043151065353353123,15299061036827414311