/**
 * Combined 8-hour liveness guard (Issue #2478, the core guard for #2472).
 *
 * Unions two independently-collected signals and fires a single ALERT only
 * when BOTH have been silent for at least the threshold (default 8 hours):
 *
 *   1. **Productive work** (#2476) — a PR opened/merged or a commit pushed
 *      to the default branch, via `latestProductiveWorkEpoch`.
 *   2. **Idle-task activity** (#2477) — an idle-task wrapper raised AND
 *      claimed, via `latestIdleTaskActivity`. The alive-signal is the
 *      **claimed** epoch, never the raised epoch: a wrapper that is raised
 *      but never claimed does NOT prove the fleet is alive (a wedged loop
 *      can keep filing wrappers it never claims).
 *
 * The guard computes `liveEpoch = max(lastIdleClaimedEpoch,
 * lastProductiveEpoch)`. While `liveEpoch` is silent (null, or older than
 * `now - threshold`), the first observation starts the countdown
 * (`firstDetectedDualZero`); once the threshold has elapsed since that first
 * observation and no alert has yet been posted, exactly one ALERT is emitted
 * and the `alerted` flag is set so the period is not re-alerted. As soon as
 * either signal becomes fresh again the entry resets, so a future dual-zero
 * period can alert anew (mirrors `clearRepoBlocked`).
 *
 * Encodes the user's "one or the other" principle from #2472: the *absence
 * of idle tasks alone is not a fault* — a single productive event anywhere
 * proves the fleet alive. This catches both failure modes with one signal:
 * a wedged main loop (no productive work) AND an all-gates-blocked idle
 * filer (raises but never claims).
 *
 * ## Scope decision — fleet-wide (documented per the issue)
 *
 * The guard is **fleet-wide**: a single PR, commit, or idle-task claim
 * *anywhere* across the monitored repos proves the fleet alive, matching the
 * "something productive happened in an 8-hour window" wording of #2472. The
 * scope is stored under the single `fleet` entry. **Trade-off:** a
 * fleet-wide guard can mask a single-repo stall — if repo A is wedged but
 * repo B is busy, the fleet-wide `liveEpoch` stays fresh and no alert fires
 * for A. Per-repo stalls are the remit of the existing per-repo guards
 * (e.g. `repo_blocked_alert.ts`); this guard answers the strictly different
 * question "is the fleet as a whole doing *anything*?".
 *
 * ## State file
 *
 * `$workDir/.liveness_window`, pipe-delimited, one line per scope:
 *
 *   `scope | lastIdleRaised | lastIdleClaimed | lastProductive |
 *    firstDetectedDualZero | alerted`
 *
 * Null epochs are written as the empty string. `firstDetectedDualZero` is
 * `0` when the scope is not currently in a dual-zero period. Reuses the
 * atomic temp-write + rename pattern and `Result<T>` from
 * `repo_blocked_alert.ts`.
 *
 * ## Injection
 *
 * Both signal collectors, the clock (`nowFn`), and the `gh` runner
 * (`ghCommandFn`) are injectable so the unit path never touches a real
 * clock or `gh`. Defaults bind the production collectors.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
import { latestIdleTaskActivity } from "./idle_task_activity.ts";
import { latestProductiveWorkEpoch } from "./productive_work_check.ts";
import { atomicWrite } from "./file_utils.ts";

/** Default liveness threshold in hours. */
export const DEFAULT_LIVENESS_THRESHOLD_HOURS = 8;

/** State file name (relative to `workDir`). */
export const LIVENESS_STATE_FILENAME = ".liveness_window";

/** The single fleet-wide scope key. */
export const FLEET_SCOPE = "fleet";

/**
 * Minimal idle-task signal shape consumed by the guard. Structurally
 * compatible with `IdleTaskActivity` from `idle_task_activity.ts`.
 */
export interface IdleTaskActivitySignal {
  /** Most-recent idle-task raise (Unix seconds), or null when none. */
  lastRaisedEpoch: number | null;
  /** Most-recent idle-task claim (Unix seconds), or null when none. */
  lastClaimedEpoch: number | null;
}

/** A designated issue on which to post the best-effort fleet-health comment. */
export interface FleetHealthIssue {
  /** `owner/repo` of the issue. */
  repo: string;
  /** Issue number. */
  number: number;
}

/** Options for {@link checkLivenessWindow}. */
export interface LivenessGuardOptions {
  /** Working directory holding the state file. */
  workDir: string;
  /** Threshold in hours before a dual-zero period alerts (default 8). */
  thresholdHours?: number;
  /** Monitored repos to union signals across (fleet-wide scope). */
  repos: string[];
  /** Injectable productive-work collector — returns the epoch or null. */
  latestProductiveWorkEpochFn?: (repo: string) => Promise<number | null>;
  /** Injectable idle-task collector — returns raised + claimed epochs. */
  latestIdleTaskActivityFn?: (repo: string) => Promise<IdleTaskActivitySignal>;
  /** Injectable clock returning Unix seconds. Defaults to the system clock. */
  nowFn?: () => number;
  /** Injectable `gh` runner. Defaults to the production retry wrapper. */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /** Optional issue for a best-effort once-per-period health comment. */
  fleetHealthIssue?: FleetHealthIssue;
  /**
   * Injectable sink for the `[liveness] ALERT` line. Defaults to
   * `console.log`. Production threads the shared worker logger so the
   * line reaches `~/logs/worker-*.log` instead of the inherited tty
   * (Issue #2479).
   */
  log?: (message: string) => void;
}

/** Result of a {@link checkLivenessWindow} call. */
export interface LivenessCheckResult {
  /** True when this call emitted a fresh ALERT. */
  alerted: boolean;
  /** `max(claimed, productive)` across the fleet, or null when both silent. */
  liveEpoch: number | null;
  /** Freshest idle-task raise across the fleet. */
  lastIdleRaisedEpoch: number | null;
  /** Freshest idle-task claim across the fleet. */
  lastIdleClaimedEpoch: number | null;
  /** Freshest productive-work epoch across the fleet. */
  lastProductiveEpoch: number | null;
  /** When the current dual-zero period started (0 when not in one). */
  firstDetectedDualZero: number;
  /** Hours stalled at alert time, else null. */
  stalledForHours: number | null;
}

/** A single line in the liveness state file. */
interface LivenessEntry {
  scope: string;
  lastIdleRaisedEpoch: number | null;
  lastIdleClaimedEpoch: number | null;
  lastProductiveEpoch: number | null;
  firstDetectedDualZero: number;
  alerted: boolean;
}

function stateFilePath(workDir: string): string {
  return `${workDir}/${LIVENESS_STATE_FILENAME}`;
}

/** Parse an epoch field: empty string → null, otherwise a base-10 integer. */
function parseEpoch(field: string): number | null {
  if (!field) return null;
  const n = parseInt(field, 10);
  return Number.isNaN(n) ? null : n;
}

/** Serialise an epoch field: null → empty string. */
function serialiseEpoch(epoch: number | null): string {
  return epoch === null ? "" : String(epoch);
}

/** Read the state file into entries (missing/unreadable → empty list). */
async function readStateEntries(workDir: string): Promise<LivenessEntry[]> {
  try {
    const content = await Deno.readTextFile(stateFilePath(workDir));
    const entries: LivenessEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length < 6) continue;
      entries.push({
        scope: parts[0]!,
        lastIdleRaisedEpoch: parseEpoch(parts[1]!),
        lastIdleClaimedEpoch: parseEpoch(parts[2]!),
        lastProductiveEpoch: parseEpoch(parts[3]!),
        firstDetectedDualZero: parseInt(parts[4]!, 10) || 0,
        alerted: parts[5] === "true",
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/** Write entries back atomically (temp file + rename). */
async function writeStateEntries(
  workDir: string,
  entries: LivenessEntry[],
): Promise<Result<void>> {
  const lines = entries.map((e) =>
    [
      e.scope,
      serialiseEpoch(e.lastIdleRaisedEpoch),
      serialiseEpoch(e.lastIdleClaimedEpoch),
      serialiseEpoch(e.lastProductiveEpoch),
      String(e.firstDetectedDualZero),
      String(e.alerted),
    ].join("|")
  );
  const result = await atomicWrite({
    targetFile: stateFilePath(workDir),
    content: lines.length > 0 ? lines.join("\n") + "\n" : "",
  });
  if (result.ok) return result;
  return {
    ok: false,
    error: new Error(`Failed to write liveness state: ${result.error.message}`),
  };
}

/** Return the maximum non-null epoch, or null when every value is null. */
function maxEpoch(values: Array<number | null>): number | null {
  const usable = values.filter((v): v is number => v !== null);
  return usable.length > 0 ? Math.max(...usable) : null;
}

/** Render an epoch for the structured log line: null → `none`. */
function logEpoch(epoch: number | null): string {
  return epoch === null ? "none" : String(epoch);
}

/** Post the best-effort once-per-period fleet-health comment. */
async function postFleetHealthComment(
  gh: (args: string[]) => Promise<string>,
  issue: FleetHealthIssue,
  body: string,
): Promise<void> {
  try {
    await gh([
      "issue",
      "comment",
      String(issue.number),
      "--repo",
      issue.repo,
      "--body",
      body,
    ]);
  } catch {
    // Best-effort — a gh failure must never sink the liveness check.
  }
}

/**
 * Check the combined liveness window and alert if the fleet has been
 * dual-silent for at least the threshold. See the module header for the
 * full state machine and the fleet-wide scope decision.
 */
export async function checkLivenessWindow(
  options: LivenessGuardOptions,
): Promise<Result<LivenessCheckResult>> {
  const {
    workDir,
    thresholdHours = DEFAULT_LIVENESS_THRESHOLD_HOURS,
    repos,
    nowFn = () => Math.floor(Date.now() / 1000),
    ghCommandFn = runGhCommand,
    fleetHealthIssue,
    log = (message: string) => console.log(message),
  } = options;

  const idleFn = options.latestIdleTaskActivityFn ??
    ((repo: string) => latestIdleTaskActivity({ repo, ghCommandFn, nowFn }));
  const productiveFn = options.latestProductiveWorkEpochFn ??
    ((repo: string) =>
      latestProductiveWorkEpoch({ repo, ghCommandFn, nowFn }).then(
        (r) => r.lastProductiveEpoch,
      ));

  const now = nowFn();
  const thresholdSeconds = thresholdHours * 3600;

  // Union the signals across every monitored repo (fleet-wide scope).
  const idleResults = await Promise.all(repos.map((r) => idleFn(r)));
  const productiveResults = await Promise.all(
    repos.map((r) => productiveFn(r)),
  );

  const lastIdleRaisedEpoch = maxEpoch(
    idleResults.map((r) => r.lastRaisedEpoch),
  );
  const lastIdleClaimedEpoch = maxEpoch(
    idleResults.map((r) => r.lastClaimedEpoch),
  );
  const lastProductiveEpoch = maxEpoch(productiveResults);

  // The alive-signal is claimed (NOT raised) unioned with productive work.
  const liveEpoch = maxEpoch([lastIdleClaimedEpoch, lastProductiveEpoch]);

  const entries = await readStateEntries(workDir);
  let entry = entries.find((e) => e.scope === FLEET_SCOPE);
  if (!entry) {
    entry = {
      scope: FLEET_SCOPE,
      lastIdleRaisedEpoch: null,
      lastIdleClaimedEpoch: null,
      lastProductiveEpoch: null,
      firstDetectedDualZero: 0,
      alerted: false,
    };
    entries.push(entry);
  }

  // Refresh the recorded signals every call (aids the aggregator / resume).
  entry.lastIdleRaisedEpoch = lastIdleRaisedEpoch;
  entry.lastIdleClaimedEpoch = lastIdleClaimedEpoch;
  entry.lastProductiveEpoch = lastProductiveEpoch;

  // Fresh when there is an alive-signal within the threshold window.
  const isFresh = liveEpoch !== null && liveEpoch >= now - thresholdSeconds;

  let alerted = false;
  let stalledForHours: number | null = null;

  if (isFresh) {
    // Any signal fresh again — reset the period (mirror clearRepoBlocked).
    entry.firstDetectedDualZero = 0;
    entry.alerted = false;
  } else {
    // Dual-silent. Start the countdown on first observation.
    if (entry.firstDetectedDualZero === 0) {
      entry.firstDetectedDualZero = now;
    }
    const elapsed = now - entry.firstDetectedDualZero;
    if (elapsed >= thresholdSeconds && !entry.alerted) {
      // Stall measured from the freshest live-signal when one exists, else
      // from the first dual-zero observation.
      const stallSeconds = liveEpoch !== null
        ? now - liveEpoch
        : now - entry.firstDetectedDualZero;
      stalledForHours = Math.floor(stallSeconds / 3600);

      log(
        `[liveness] ALERT stalled_for_hours=${stalledForHours} ` +
          `last_idle_raised=${logEpoch(lastIdleRaisedEpoch)} ` +
          `last_idle_claimed=${logEpoch(lastIdleClaimedEpoch)} ` +
          `last_productive=${logEpoch(lastProductiveEpoch)}`,
      );

      if (fleetHealthIssue) {
        await postFleetHealthComment(
          ghCommandFn,
          fleetHealthIssue,
          `## ⚠️ Fleet liveness ALERT\n\n` +
            `No productive work AND no idle-task claim across the monitored ` +
            `fleet for approximately **${stalledForHours} hours** ` +
            `(threshold: ${thresholdHours}h).\n\n` +
            `- last idle-task raised: ${logEpoch(lastIdleRaisedEpoch)}\n` +
            `- last idle-task claimed: ${logEpoch(lastIdleClaimedEpoch)}\n` +
            `- last productive work: ${logEpoch(lastProductiveEpoch)}\n\n` +
            `_Automated alert from the VibeCoder liveness guard (Issue ` +
            `#2478). Posted once per stall period._`,
        );
      }

      entry.alerted = true;
      alerted = true;
    }
  }

  const writeResult = await writeStateEntries(workDir, entries);
  if (!writeResult.ok) return writeResult as Result<LivenessCheckResult>;

  return {
    ok: true,
    value: {
      alerted,
      liveEpoch,
      lastIdleRaisedEpoch,
      lastIdleClaimedEpoch,
      lastProductiveEpoch,
      firstDetectedDualZero: entry.firstDetectedDualZero,
      stalledForHours,
    },
  };
}
