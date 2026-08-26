/**
 * Host-local registry of repositories currently held by a slot (Issue #4176,
 * part of #4168 — concurrent issue slots per host).
 *
 * The concurrency design requires slots to be in strictly different
 * repositories: no two slots share a clone, so there are never concurrent
 * writes to one working tree. `findNextIssue` consults this registry to
 * skip candidates whose repository is already held and return the next
 * eligible issue from a *different* repository, instead of returning
 * `null` and idling a free slot.
 *
 * Acquisition is atomic against concurrent slot starts by construction:
 * Deno is single-threaded, and `tryAcquire` is synchronous — two slots
 * racing on the same repository interleave at await points, never inside
 * the check-and-set. Every terminal exit (success, skip, failure, throw,
 * shutdown) must release; callers hold the release in a `finally`.
 *
 * Host-local only — GitHub claim-before-work covers cross-host
 * coordination.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { HeartbeatKind } from "./heartbeat.ts";
import { describeRunDeadline, type RunDeadlineState } from "./run_deadline.ts";

/** What a slot holds. */
export interface InFlightHold {
  repo: string;
  issueNumber: number;
  /** Stable slot id for log attribution (Issue #4181). */
  slotId: string;
  /** Epoch-ms the hold was taken. */
  sinceMs: number;
  /**
   * The deadline the agent run under this hold is working to (Issue #4297),
   * once it has reported one. A progress-extended run refreshes this on
   * every grant, so the drain path sees a run that legitimately outlives the
   * original hour as in-flight rather than as a hang.
   */
  runDeadline?: RunDeadlineState;
  /**
   * Taken by the maintenance lane rather than by an issue slot (Issue #213).
   *
   * The lane holds a repository so no slot writes the clone its CI fix /
   * PR-feedback / merge-conflict agent is working in, but it is servicing a
   * **PR**, not a claimed issue: `issueNumber` is that PR's number. Anything
   * that treats a hold as an issue claim — the finder's exclusion set, the
   * shutdown drain's claim release — must skip it, or it would unassign a PR
   * number as though it were an issue.
   *
   * The heartbeat sweep is **not** one of those (Issue #391): it asks whether
   * anything on this host still uses a heartbeat, and the lane takes
   * heartbeats, so it reads `heldHeartbeatKeys()` instead.
   */
  maintenance?: boolean;
}

/** In-process registry of held repositories. */
export class InFlightRepoRegistry {
  readonly #held = new Map<string, InFlightHold>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Try to take `repo` for a slot. Returns true when this call won the
   * repository; false when another slot already holds it. Synchronous, so
   * two racing slots cannot both win.
   */
  tryAcquire(
    repo: string,
    issueNumber: number,
    slotId: string,
    options?: { maintenance?: boolean },
  ): boolean {
    if (this.#held.has(repo)) return false;
    this.#held.set(repo, {
      repo,
      issueNumber,
      slotId,
      sinceMs: this.#now(),
      ...(options?.maintenance === true ? { maintenance: true } : {}),
    });
    return true;
  }

  /**
   * Record the deadline the run holding `repo` is working to (Issue #4297).
   *
   * Called at run start and after every progress extension. A report for a
   * repo no longer held is dropped: the run has already finished and its
   * slot been released, and a late report must not resurrect the hold.
   *
   * @returns True when the report was stored against a live hold.
   */
  noteRunDeadline(repo: string, state: RunDeadlineState): boolean {
    const hold = this.#held.get(repo);
    if (hold === undefined) return false;
    hold.runDeadline = state;
    return true;
  }

  /** Release `repo`. Idempotent — releasing an unheld repo is a no-op. */
  release(repo: string): void {
    this.#held.delete(repo);
  }

  /** Whether `repo` is currently held by any slot. */
  isHeld(repo: string): boolean {
    return this.#held.has(repo);
  }

  /** The repositories currently held, for a finder's exclusion set. */
  heldRepos(): ReadonlySet<string> {
    return new Set(this.#held.keys());
  }

  /** The `(repo, issue)` pairs currently claimed, for a finder's exclusion
   * set and the drain's claim release. Maintenance-lane holds are excluded
   * (Issue #213): their number is a PR, not a claimed issue. */
  heldIssues(): ReadonlyArray<{ repo: string; issueNumber: number }> {
    return [...this.#held.values()]
      .filter((hold) => hold.maintenance !== true)
      .map(({ repo, issueNumber }) => ({ repo, issueNumber }));
  }

  /**
   * Every hold that owns a heartbeat — the live set the heartbeat sweep must
   * not touch (Issue #4178, corrected by Issue #391).
   *
   * Maintenance-lane holds are **included** here, unlike `heldIssues()`: the
   * lane takes a real heartbeat for the PR it is servicing, so sweeping it
   * would clear a live pass's heartbeat and let the
   * assigned-without-heartbeat recovery hand its work to another worker
   * mid-edit. The kind rides along so a PR's heartbeat and an issue's
   * heartbeat of the same number cannot alias.
   */
  heldHeartbeatKeys(): ReadonlyArray<
    { repo: string; issueNumber: number; kind: HeartbeatKind }
  > {
    return [...this.#held.values()].map(({ repo, issueNumber, maintenance }) => ({
      repo,
      issueNumber,
      kind: maintenance === true ? "pr" as const : "issue" as const,
    }));
  }

  /** Every hold, for status rendering (Issue #4181). */
  holds(): ReadonlyArray<InFlightHold> {
    return [...this.#held.values()];
  }

  /** Only the holds an issue slot took (Issue #213) — the set the drain
   * releases claims for, and the set a slot counts as its siblings. */
  slotHolds(): ReadonlyArray<InFlightHold> {
    return [...this.#held.values()].filter((hold) => hold.maintenance !== true);
  }

  /** Number of repositories held. */
  get size(): number {
    return this.#held.size;
  }
}

/**
 * Render one hold for a drain / shutdown log line (Issue #4297).
 *
 * `s2 owner/repo#12 (extended 2×, deadline in 870s)` when the run reported a
 * deadline; `s2 owner/repo#12` when it has not, which is what every
 * pre-#4297 line looked like.
 *
 * @param hold - The live hold.
 * @param nowMs - Current epoch-ms.
 */
export function formatInFlightHold(
  hold: InFlightHold,
  nowMs: number = Date.now(),
): string {
  const base = `${hold.slotId} ${hold.repo}#${hold.issueNumber}`;
  const deadline = describeRunDeadline(hold.runDeadline, nowMs);
  return deadline ? `${base} (${deadline})` : base;
}
