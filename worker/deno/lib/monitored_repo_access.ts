/**
 * Per-repo access state for monitored repos (Issue #4036).
 *
 * Probe outcomes used to be logged per tick and discarded, so nothing in
 * the worker could answer the question the fleet health gate needs to
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
 */

import type { ProbeFailureKind } from "./idle_detect_diagnostics.ts";

/**
 * Outcome of a single repo probe. The failure kinds are exactly those
 * {@link ProbeFailureKind} produces, so this store stays in lockstep
 * with the classifier added in #4035.
 */
export type RepoProbeOutcome = "ok" | ProbeFailureKind;

/**
 * Last known outcome for a repo. `unknown` means the repo has never
 * been probed in this process — it is never reported inaccessible.
 */
export type RepoAccessOutcome = RepoProbeOutcome | "unknown";

/** Access state the store holds for one monitored repo. */
export interface RepoAccessState {
  /** Repo in `owner/repo` form, trimmed. */
  repo: string;
  /** Outcome of the most recent probe, or `unknown` if never probed. */
  lastOutcome: RepoAccessOutcome;
  /** Consecutive `access_denied` probes; any `ok` resets it to 0. */
  consecutiveAccessDenied: number;
  /** Epoch milliseconds of the last successful probe, if any. */
  lastOkAt?: number;
}

/**
 * Consecutive access-denied probes required before a repo counts as
 * inaccessible. Two, not one: a lone denial is far more likely to be a
 * misclassified blip than a genuine loss of access, and flipping the
 * whole fleet unhealthy on it would train operators to ignore the
 * signal.
 */
export const ACCESS_FAILURE_THRESHOLD = 2;

/** Repo → state. Process-local; `resetRepoAccessState()` clears it. */
const accessStates = new Map<string, RepoAccessState>();

/**
 * Validate and normalise a repo identifier. Blank input is a caller bug
 * that would otherwise silently create a phantom entry, so it fails
 * loud rather than being swallowed.
 */
function normaliseRepo(repo: string): string {
  const trimmed = typeof repo === "string" ? repo.trim() : "";
  if (trimmed === "") {
    throw new TypeError("repo must be a non-empty string");
  }
  return trimmed;
}

/** Fresh, never-probed state for `repo`. */
function unknownState(repo: string): RepoAccessState {
  return { repo, lastOutcome: "unknown", consecutiveAccessDenied: 0 };
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
 */
export function recordRepoProbe(
  repo: string,
  outcome: RepoProbeOutcome,
  now: number = Date.now(),
): void {
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
 */
export function getInaccessibleRepos(): string[] {
  const inaccessible: string[] = [];
  for (const state of accessStates.values()) {
    if (state.consecutiveAccessDenied >= ACCESS_FAILURE_THRESHOLD) {
      inaccessible.push(state.repo);
    }
  }
  return inaccessible.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Current state for `repo`. A repo that has never been probed returns
 * an `unknown` state rather than `undefined`, so callers never have to
 * special-case the first tick. The returned object is a copy — mutating
 * it does not affect the store.
 */
export function getRepoAccessState(repo: string): RepoAccessState {
  const key = normaliseRepo(repo);
  const state = accessStates.get(key);
  return state ? { ...state } : unknownState(key);
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
 */
export function recordRepoProbeBestEffort(
  repo: string,
  outcome: RepoProbeOutcome,
  now?: number,
): void {
  try {
    recordRepoProbe(repo, outcome, now ?? Date.now());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[repo-access] failed to record ${outcome} probe for "${repo}": ${message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Operator-facing status line and reason (Issue #4039)
// ---------------------------------------------------------------------------

/**
 * Stable prefix of the structured status line. Operators grep for this
 * to recover the state of a past outage from a worker log, so it must
 * not change.
 */
export const REPO_ACCESS_LOG_PREFIX = "[repo-access]";

/**
 * Human-readable reason naming the inaccessible repos, in the store's
 * stable (lexicographic) order — e.g.
 * `repos inaccessible: TitlePage/foo, TitlePage/bar`.
 *
 * `lastHealthCheckPassed = false` on its own is not actionable: the fix
 * depends entirely on *which* repos went dark (#4031). This is the
 * string carried onto the FLEET-health report payload.
 */
export function formatInaccessibleReposReason(repos: string[]): string {
  return `repos inaccessible: ${repos.join(", ")}`;
}

/**
 * Highest consecutive access-denied count across `repos` — how long the
 * outage has run for the worst-affected repo.
 *
 * A repo the store has never seen contributes 0 rather than being
 * guessed at, so the number never overstates what was actually observed.
 */
export function maxConsecutiveAccessDenied(repos: string[]): number {
  let highest = 0;
  for (const repo of repos) {
    const state = accessStates.get(repo.trim());
    if (state && state.consecutiveAccessDenied > highest) {
      highest = state.consecutiveAccessDenied;
    }
  }
  return highest;
}

/** Short host id (domain suffix trimmed), or `unknown` when unavailable. */
function readHostId(): string {
  let host: string;
  try {
    host = Deno.hostname();
  } catch {
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
 */
export function formatRepoAccessLogLine(
  hostId: string,
  repos: string[],
): string {
  return `${REPO_ACCESS_LOG_PREFIX} host=${hostId} status=inaccessible ` +
    `repos=${repos.join(",")} consecutive=${maxConsecutiveAccessDenied(repos)}`;
}

/** Last line emitted, so identical alerts are not repeated. */
let lastLoggedLine: string | null = null;

/**
 * Emit the structured status line at most once per iteration.
 *
 * Several call sites observe the same condition in one iteration — the
 * health gate in `run_core.ts` and the FLEET-health report — and logging
 * from each would turn one outage into per-call-site spam. The line is
 * therefore suppressed when it is byte-identical to the previous one;
 * {@link resetRepoAccessLogState} is called at the iteration boundary so
 * an ongoing outage still leaves exactly one line per iteration. A
 * changed repo set is new information and is always logged.
 *
 * Healthy hosts log nothing at all: an empty `repos` is a no-op.
 *
 * @returns `true` when a line was written, `false` when suppressed.
 */
export function logRepoAccessOnce(
  repos: string[],
  sink: (line: string) => void,
  options: { hostId?: string; suffix?: string } = {},
): boolean {
  if (repos.length === 0) return false;

  const line = formatRepoAccessLogLine(options.hostId ?? readHostId(), repos);
  if (line === lastLoggedLine) return false;
  lastLoggedLine = line;

  sink(options.suffix ? `${line} — ${options.suffix}` : line);
  return true;
}

/** Forget the last emitted line. Called at each iteration boundary. */
export function resetRepoAccessLogState(): void {
  lastLoggedLine = null;
}

/** Clear all recorded state. Test seam. */
export function resetRepoAccessState(): void {
  accessStates.clear();
  resetRepoAccessLogState();
}
