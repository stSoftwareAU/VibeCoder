/**
 * Host-local registry of the work streams currently held (Issue #4176, part
 * of #4168 — concurrent issue slots per host; re-keyed by Issue #1091).
 *
 * The unit of exclusion is the **work stream** — `(repository, milestone)`,
 * with the default branch as the stream for issues carrying no milestone.
 * The operator's rule is one issue in flight per stream, and a repository
 * holds many streams that are worked in parallel by design.
 *
 * It was the *repository* until Issue #1091, because every slot checked out
 * into the one clone `${WORK_DIR}/<repo>`. That is no longer true — Issue
 * #923 gives each slot its own lane worktree and Issue #1322 scopes the
 * Claude session store per work stream — and keying by repository cost a
 * two-slot host half its throughput: one slot holding `VibeCoder#1082` made
 * all 29 claimable issues in that repository invisible to its sibling.
 *
 * The **maintenance lane** (Issue #213) is the one holder that still takes a
 * whole repository: it is servicing a PR, may touch any branch of the clone,
 * and its `issueNumber` is a PR number rather than a claimed issue. Such a
 * lease excludes every stream in the repository, and is refused while any
 * slot holds one of them.
 *
 * Acquisition is atomic against concurrent slot starts by construction:
 * Deno is single-threaded, and `tryAcquire` is synchronous — two slots
 * racing on the same stream interleave at await points, never inside
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
import {
  DEFAULT_BRANCH_STREAM,
  type InFlightClaim,
  workStreamKey,
} from "./work_stream.ts";

/** What a slot holds. */
export interface InFlightHold {
  repo: string;
  issueNumber: number;
  /**
   * The work stream the hold occupies (Issue #1091) — the issue's milestone
   * title, or {@link DEFAULT_BRANCH_STREAM} for an issue with none.
   *
   * The registry is the source of truth for what a slot holds, so the stream
   * identity lives here rather than being re-derived by each reader. A
   * maintenance-lane lease carries the default-branch stream and is keyed
   * repository-wide regardless (see {@link InFlightHold.maintenance}).
   */
  milestone: string;
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

/**
 * Map key for a maintenance-lane lease on `repo` (Issue #213).
 *
 * Deliberately outside {@link workStreamKey}'s space — a lease is not a
 * stream, it is every stream of one repository — so a lease and a slot's
 * default-branch hold can never alias.
 */
function repoLeaseKey(repo: string): string {
  return `lease:${repo}`;
}

/** In-process registry of held work streams. */
export class InFlightRepoRegistry {
  readonly #held = new Map<string, InFlightHold>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Try to take a work stream for a slot, or a whole repository for the
   * maintenance lane.
   *
   * A slot wins when no sibling holds the same `(repo, milestone)` stream and
   * the maintenance lane holds no lease on the repository. The lane wins only
   * when the repository is completely free, because its pass may touch any
   * branch of the clone (Issue #213).
   *
   * Synchronous, so two racing slots cannot both win.
   *
   * @param repo - `owner/name`
   * @param issueNumber - The claimed issue, or the serviced PR for the lane
   * @param slotId - Stable slot id, for log attribution
   * @param options - The stream to take, and whether this is a lane lease
   * @returns True when this call won
   */
  tryAcquire(
    repo: string,
    issueNumber: number,
    slotId: string,
    options?: { maintenance?: boolean; milestone?: string },
  ): boolean {
    const maintenance = options?.maintenance === true;
    const milestone = options?.milestone ?? DEFAULT_BRANCH_STREAM;
    // The lane leases the whole repository, so any hold on it refuses the
    // lease — and any lease refuses every stream of it.
    if (maintenance) {
      for (const hold of this.#held.values()) {
        if (hold.repo === repo) return false;
      }
    } else if (this.#held.has(repoLeaseKey(repo))) {
      return false;
    }
    const key = maintenance
      ? repoLeaseKey(repo)
      : workStreamKey(repo, milestone);
    if (this.#held.has(key)) return false;
    this.#held.set(key, {
      repo,
      issueNumber,
      milestone,
      slotId,
      sinceMs: this.#now(),
      ...(maintenance ? { maintenance: true } : {}),
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
  noteRunDeadline(
    repo: string,
    milestone: string,
    state: RunDeadlineState,
  ): boolean {
    const hold = this.#held.get(workStreamKey(repo, milestone));
    if (hold === undefined) return false;
    hold.runDeadline = state;
    return true;
  }

  /**
   * Release a slot's hold on one work stream. Idempotent — releasing a
   * stream nobody holds is a no-op.
   *
   * @param repo - `owner/name`
   * @param milestone - The stream released; defaults to the default branch
   */
  release(repo: string, milestone: string = DEFAULT_BRANCH_STREAM): void {
    this.#held.delete(workStreamKey(repo, milestone));
  }

  /** Release the maintenance lane's lease on `repo` (Issue #213). */
  releaseRepoLease(repo: string): void {
    this.#held.delete(repoLeaseKey(repo));
  }

  /** Whether any hold at all — slot or lease — covers `repo`. */
  isHeld(repo: string): boolean {
    for (const hold of this.#held.values()) {
      if (hold.repo === repo) return true;
    }
    return false;
  }

  /** Whether one work stream is currently held (Issue #1091). */
  isStreamHeld(
    repo: string,
    milestone: string = DEFAULT_BRANCH_STREAM,
  ): boolean {
    return this.#held.has(workStreamKey(repo, milestone)) ||
      this.#held.has(repoLeaseKey(repo));
  }

  /** Every repository with a hold of any kind on it. */
  heldRepos(): ReadonlySet<string> {
    return new Set([...this.#held.values()].map((hold) => hold.repo));
  }

  /**
   * Repositories excluded from a claim scan **wholesale** (Issue #1091).
   *
   * Only the maintenance lane's leases: a slot's hold occupies one work
   * stream, which the scan evaluates and refuses as `milestone-occupied`
   * rather than skipping unseen.
   */
  leasedRepos(): ReadonlySet<string> {
    return new Set(
      [...this.#held.values()]
        .filter((hold) => hold.maintenance === true)
        .map((hold) => hold.repo),
    );
  }

  /** The claims currently held, each with the work stream it occupies — the
   * finder's occupancy overlay (Issue #1091) and the drain's claim release.
   * Maintenance-lane holds are excluded (Issue #213): their number is a PR,
   * not a claimed issue. */
  heldIssues(): ReadonlyArray<InFlightClaim> {
    return [...this.#held.values()]
      .filter((hold) => hold.maintenance !== true)
      .map(({ repo, issueNumber, milestone }) => ({
        repo,
        issueNumber,
        milestone,
      }));
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
    return [...this.#held.values()].map((
      { repo, issueNumber, maintenance },
    ) => ({
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

  /** Number of holds — work streams plus maintenance-lane leases. */
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
