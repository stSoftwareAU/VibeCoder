/**
 * Repo leases for the concurrent maintenance lane (Issue #213).
 *
 * The agent-backed Priority-1.x maintenance passes (PR feedback, spelling,
 * CI fix, merge-conflict resolution) used to run serially *ahead* of the
 * Priority-2 issue-scan pool. One CI fix with a 30–60 minute agent budget
 * therefore held both issue slots idle for up to half the cycle: the slots
 * that exist precisely to run agents concurrently sat doing nothing.
 *
 * Those passes now run in a **maintenance lane** beside the pool. The one
 * thing concurrency forces is repository exclusion: every flow — a slot's
 * issue run and a maintenance pass alike — checks out into the single
 * per-repo clone `${WORK_DIR}/<repo>`, and `setupRepo` opens with
 * `reset --hard` + `clean -fd`. Two writers in one working tree would
 * destroy each other's work.
 *
 * The lane therefore takes a **lease** on the repository it has selected,
 * from the very `InFlightRepoRegistry` the slot pool uses, before it touches
 * that clone:
 *
 * - a repository a slot holds is refused, so the pass defers to the next
 *   cycle rather than colliding;
 * - a repository the lane holds is in the pool's exclusion set, so no slot
 *   claims an issue there while the pass runs.
 *
 * Outside the lane — the serial dispatch ladder at `max_concurrent_issues: 1`,
 * and the single-shot CLI processors — there is nothing to exclude, so
 * `acquireMaintenanceRepoLease` grants a no-op lease and behaviour is
 * unchanged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Slot id the lane's registry holds are attributed to in the log. */
export const MAINTENANCE_LANE_SLOT_ID = "m1";

/**
 * A held repository. Release exactly once, from a `finally` — a leaked lease
 * locks every slot out of that repository for the rest of the cycle.
 */
export interface RepoLease {
  release(): void;
}

/** The registry operations the lane needs; the pool's registry satisfies it. */
export interface MaintenanceLaneBroker {
  /** True when this call won `repo`; false when a slot already holds it. */
  tryAcquire(repo: string, ref: number): boolean;
  /** Give `repo` back. */
  release(repo: string): void;
}

const storage = new AsyncLocalStorage<MaintenanceLaneBroker>();

/** Run `fn` with every async continuation leasing through `broker`. */
export function runInMaintenanceLane<T>(
  broker: MaintenanceLaneBroker,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(broker, fn);
}

/** Whether the current async chain runs inside the maintenance lane. */
export function inMaintenanceLane(): boolean {
  return storage.getStore() !== undefined;
}

/** Granted outside the lane: nothing runs concurrently, nothing to exclude. */
const UNCONTENDED_LEASE: RepoLease = { release() {} };

/**
 * Take the working tree of `repo` for the current maintenance pass.
 *
 * @param repo - `owner/name` of the repository about to be checked out.
 * @param ref - The PR or issue number the pass is servicing, for the hold's
 *   log attribution. Defaults to 0 when the pass has no such number.
 * @returns The lease, or `null` when a slot holds the repository and the
 *   pass must defer.
 */
export function acquireMaintenanceRepoLease(
  repo: string,
  ref = 0,
): RepoLease | null {
  const broker = storage.getStore();
  if (broker === undefined) return UNCONTENDED_LEASE;
  if (!broker.tryAcquire(repo, ref)) return null;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      broker.release(repo);
    },
  };
}
