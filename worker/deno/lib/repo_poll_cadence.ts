/**
 * Nice-derived per-repo polling cadence (Issue #3667).
 *
 * The Priority 1.x passes (PR feedback, CI fix, branch updates, milestone
 * sync and completions, stale-assignment recovery, …) walk every monitored
 * repo on every 2–3 minute cycle. A deprioritised repo therefore costs as
 * much GitHub API as a priority one, and the fleet's shared account keeps
 * tripping GitHub's secondary (burst) limit while most of its hourly quota is
 * still unspent — a limit the quota-floor gate of Issue #3628 never sees.
 *
 * The cadence polls a repo by its `nice`, always, not only when quota runs
 * low:
 *
 * - `nice <= 0` — every cycle (unchanged).
 * - `0 < nice < parkNice` — every `lowCycles` cycles.
 * - `nice >= parkNice` — every `parkCycles` cycles.
 *
 * Upkeep of a deprioritised repo slows down; it never stops — the Issue #2776
 * invariant that an open PR in a high-`nice` repo must not rot. Each repo
 * remembers the cycle it was last polled, so a repo is due once its cadence
 * has elapsed; first polls are staggered by list position so the
 * low-priority tier does not all land on one cycle (a burst is exactly what
 * trips the secondary limit). A burst refusal since the last cycle holds a
 * due low-priority repo one more cycle, bounded at twice its cadence so a
 * limit that recurs every cycle can never starve it.
 *
 * Pure apart from the cadence's own memory: no I/O, no clock. One log line
 * per cycle is the caller's job, never one per repository.
 *
 * Uses Australian English throughout (behaviour, prioritised, organisation).
 */

/** The configured cadences (from the `poll_cadence_*` config keys). */
export interface RepoPollCadenceConfig {
  /** Cycles between polls of a `0 < nice < parkNice` repo; 1 = every cycle. */
  lowCycles: number;
  /** Cycles between polls of a `nice >= parkNice` repo; 1 = every cycle. */
  parkCycles: number;
  /** The `nice` at or above which a repo is the park tier. */
  parkNice: number;
}

/** One cycle's split of the monitored repos. */
export interface RepoPollSelection {
  /** Repos the per-repo passes poll this cycle, in the input order. */
  due: string[];
  /** Low-priority repos left for a later cycle. */
  deferred: string[];
  /** Whether a burst refusal held at least one otherwise-due repo. */
  burstHeld: boolean;
}

/**
 * How many cycles apart a repo of this `nice` is polled. A cadence that is
 * not a whole number above 1 (a hand-built config missing the keys) reads as
 * every cycle — fail open, never "not due".
 */
export function repoPollCadence(
  nice: number,
  config: RepoPollCadenceConfig,
): number {
  if (nice <= 0) return 1;
  const cycles = nice >= config.parkNice ? config.parkCycles : config.lowCycles;
  return Number.isInteger(cycles) && cycles > 1 ? cycles : 1;
}

/**
 * A cadence that lives for one worker launch. `select` is called once per
 * cycle, before the per-repo passes run.
 */
export function createRepoPollCadence(config: RepoPollCadenceConfig): {
  select(
    repos: readonly string[],
    niceOf: (repo: string) => number,
    burstSinceLastCycle: boolean,
  ): RepoPollSelection;
} {
  let cycle = 0;
  const lastPolled = new Map<string, number>();
  return {
    select(repos, niceOf, burstSinceLastCycle) {
      const due: string[] = [];
      const deferred: string[] = [];
      let burstHeld = false;
      repos.forEach((repo, index) => {
        const cadence = repoPollCadence(niceOf(repo), config);
        if (cadence === 1) {
          due.push(repo);
          return;
        }
        // An unseen repo's first poll is staggered by its list position.
        const last = lastPolled.get(repo) ?? (index % cadence) - cadence;
        const elapsed = cycle - last;
        const hold = burstSinceLastCycle && elapsed < 2 * cadence;
        if (elapsed >= cadence && !hold) {
          lastPolled.set(repo, cycle);
          due.push(repo);
        } else {
          if (elapsed >= cadence) burstHeld = true;
          deferred.push(repo);
        }
      });
      cycle++;
      return { due, deferred, burstHeld };
    },
  };
}

/** The once-per-cycle summary line, or null when nothing was deferred. */
export function formatRepoPollCadenceLine(
  selection: RepoPollSelection,
): string | null {
  const { due, deferred, burstHeld } = selection;
  if (deferred.length === 0) return null;
  return (
    `poll-cadence: polling ${due.length} of ${due.length + deferred.length} ` +
    `repo(s) this cycle — deferred ${deferred.length} low-priority repo(s) ` +
    `(nice > 0) to a later cycle: ${deferred.join(", ")}` +
    (burstHeld
      ? `; a GitHub burst limit since the last cycle held due repos one more cycle`
      : "")
  );
}
