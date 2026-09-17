/**
 * A post-run callback that fails on every issue is recorded once, locally
 * (Issues #1092, #2039, #2111).
 *
 * `invokeRunCallbacks` reports each hook fault loudly and leaves the run's own
 * outcome alone — which is right for a hook that fails once. It is wrong for a
 * hook that fails **every** time: observed on GRQ-23 on 2026-09-05, the
 * `always` hook failed on every issue across at least five runs, each failure
 * costing about 100 seconds of slot time, and the only trace was one line per
 * issue among the thousands the fleet writes:
 *
 * ```text
 * ERROR: [s2 …/NEAT-AI-Lamarck#206] callback always (…/always.sh) failed — exit 1, 100.9s
 * ERROR: [s2 …/VibeCoder#984]       callback always … failed — exit 1, 100.7s
 * ERROR: [s1 …/NEAT-AI-Rebase#82]   callback always … failed — exit 1, 101.0s
 * ```
 *
 * So the worker counts the streak per event and, on the run that takes it to
 * {@link CALLBACK_FAILURE_ESCALATION_THRESHOLD}, writes **one** `ERROR` record
 * carrying every fact a human needs to act: the hook, how long it has been
 * failing, how the last invocation ended, its redacted stderr, the callback
 * schema version this worker exports, and the remedy in `docs/CALLBACKS.md`.
 * Later failures in the same streak add nothing, so a hook broken for days
 * produces one record rather than one per issue. A single success ends the
 * streak, and a success that ends a streak long enough to have been recorded
 * writes one line saying so.
 *
 * **The record is local and stays local.** This module runs inside the
 * container and fires no hook, spawns no process and writes nothing to GitHub:
 * the count lives in `WORK_DIR` so it survives the run boundary the condition
 * survives, and the worker log is the host's own record. Filing a public issue
 * for a fault that belongs to one host's hook deployment put host-local
 * operational detail in a public tracker, and closing it again was a second
 * GitHub write on the recovery path — both are gone (Issue #2111).
 *
 * **Local is not the same as unreadable** (Issue #2297). A record only the
 * worker log holds is a record nobody reads until the board has been red for a
 * day — which is exactly what GRQ-25 did on 2026-09-16, when the `success`
 * hook (a health heartbeat) failed on every terminal run for two days. So the
 * same count is published as JSON to the host log directory as well as
 * `WORK_DIR`, and read back from there when the work volume has been reset.
 * See `callback_failure_publication.ts`; nothing about the boundary above
 * changes — it is still a file and a log line on the host that owns the hook.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { CallbackEvent } from "./run_callbacks_config.ts";
import {
  CALLBACK_SCHEMA_VERSION,
  type CallbackInvocation,
} from "./run_callbacks.ts";
import {
  CALLBACK_FAILURE_STREAK_FILE,
  CALLBACK_FAILURE_STREAK_SCHEMA_VERSION,
  callbackFailureStreakCounts,
  type CallbackFailureStreakEntry,
  type CallbackFailureStreaks,
  type CallbackFailureStreakSnapshot,
  emptyCallbackFailureSnapshot,
  publishCallbackFailureSnapshot,
  PUBLISHED_STDERR_HEAD_CHARS,
  readCallbackFailureSnapshot,
} from "./callback_failure_publication.ts";
import { redactSecrets } from "./secret_redaction.ts";

/**
 * Consecutive failing issues before the condition is recorded.
 *
 * Three, not one: a hook can fail on one issue for reasons belonging to that
 * issue, and a record per issue is the noise this exists to avoid. Three
 * consecutive issues is reached inside a single run on a busy host, so the
 * operator hears about a permanent fault on the run it starts.
 */
export const CALLBACK_FAILURE_ESCALATION_THRESHOLD = 3;

export {
  /** File holding the per-event consecutive-failure counts. */
  CALLBACK_FAILURE_STREAK_FILE,
  /** Consecutive failures per callback event. */
  type CallbackFailureStreaks,
};

/** One callback condition worth telling the host's operator about. */
export interface CallbackFailureReport {
  /** Which hook — `success`, `failure` or `always`. */
  event: CallbackEvent;
  /** The configured hook path. */
  path: string;
  /** Consecutive issues the hook has failed on. */
  streak: number;
  /** ISO-8601 timestamp of the first failure of this streak. */
  firstFailureAt: string;
  /** `owner/repo` of the run that tipped it over. */
  repository: string;
  /** Issue number of the run that tipped it over. */
  issueNumber: number;
  /** How the last invocation ended. */
  status: CallbackInvocation["status"];
  /** Exit code of the last invocation. */
  exitCode: number;
  /** Wall-clock seconds the last invocation cost. */
  durationSeconds: number;
  /** Redacted stderr of the last invocation. */
  stderr: string;
}

/** A recorded hook that has succeeded again (Issue #2039). */
export interface CallbackRecoveryReport {
  /** Which hook — `success`, `failure` or `always`. */
  event: CallbackEvent;
  /** The configured hook path. */
  path: string;
  /** Consecutive issues the hook had failed on before this success. */
  streak: number;
  /** `owner/repo` of the run whose invocation succeeded. */
  repository: string;
  /** Issue number of the run whose invocation succeeded. */
  issueNumber: number;
}

/** Injectable seams so the streak is testable without touching `WORK_DIR`. */
export interface CallbackFailureStreakDeps {
  /**
   * The host log directory the streak is published to beside `WORK_DIR`
   * (Issue #2297). Absent, only the work-volume copy is kept — which is what
   * a host with no mounted log directory had before.
   */
  hostLogDir?: string;
  /** Reads the persisted streak. Defaults to the two on-disk copies. */
  readStreaks?: (
    workDir: string,
    hostLogDir?: string,
  ) => Promise<CallbackFailureStreakSnapshot>;
  /** Persists the streak. Defaults to writing both copies. */
  writeStreaks?: (
    workDir: string,
    snapshot: CallbackFailureStreakSnapshot,
    hostLogDir?: string,
  ) => Promise<void>;
  /** Clock behind the streak's timestamps. Defaults to `Date.now`. */
  now?: () => number;
  /** Informational sink. Defaults to a no-op. */
  log?: (message: string) => void;
  /** Fault sink — where the threshold record is written. */
  logError?: (message: string) => void;
  /**
   * Degraded-but-continuing sink: a streak copy that could not be read or
   * written. The run carries on regardless, so this is a warning rather than a
   * fault — it defaults to {@link CallbackFailureStreakDeps.logError} so a
   * caller that wires only a fault sink still hears about it.
   */
  logWarn?: (message: string) => void;
}

/**
 * The multi-line `ERROR` record the threshold crossing writes.
 *
 * It names the schema version this worker exports because the one fleet-wide
 * outage so far (2026-09-11) was the worker's own contract bump, not a
 * deployment fault: a hook that refuses the version predates the contract,
 * and the remedy is an extension upgrade the worker cannot perform itself.
 */
function failureRecord(report: CallbackFailureReport): string {
  return [
    `The ${report.event} callback has failed on ${report.streak} consecutive ` +
    "issues — recording it once (Issues #1092, #2111). It runs after every " +
    "terminal issue run, so the cost is paid on every issue this host works; " +
    "the run's own result is unaffected.",
    `  hook: ${report.path}`,
    `  failing since ${report.firstFailureAt}`,
    `  last run: ${report.repository}#${report.issueNumber}`,
    `  outcome: ${report.status}, exit ${report.exitCode}, ` +
    `${report.durationSeconds.toFixed(1)}s`,
    `  stderr: ${report.stderr || "(none captured)"}`,
    `  callback schema version this worker exports: ` +
    `${CALLBACK_SCHEMA_VERSION}`,
    "  remedy: a hook that refuses that version was written against an older " +
    "contract — upgrade the extension on this host, or fix the hook or " +
    "remove it from `callbacks` in `.config.json`. See docs/CALLBACKS.md.",
  ].join("\n");
}

/**
 * Record how this run's callbacks ended and report a permanent failure.
 *
 * A hook that exited 0 resets its streak. Any other outcome — failed, timed
 * out, un-spawnable — extends it, and the run that takes the streak to
 * {@link CALLBACK_FAILURE_ESCALATION_THRESHOLD} writes the one error record
 * for it. Later failures in the same streak add nothing. A success that ends
 * a streak long enough to have been recorded writes one line saying so; a
 * success that ends a shorter streak has nothing to say.
 *
 * A fault in the count file never alters the run's own outcome — the read is
 * best-effort and a copy that cannot be written is reported rather than
 * thrown, because the log is the record and the count an aid to reading it.
 * That boundary is the one the whole callback layer holds.
 *
 * @param workDir - The worker's work directory, where the streaks live
 * @param invocations - What {@link CallbackInvocation}s this run produced
 * @param run - Repository and issue the run worked, for the record
 * @param deps - Injected storage and log sinks
 * @returns The streaks after recording, so a caller can assert on them
 */
export async function recordCallbackOutcomes(
  workDir: string,
  invocations: readonly CallbackInvocation[],
  run: { repository: string; issueNumber: number },
  deps: CallbackFailureStreakDeps = {},
): Promise<CallbackFailureStreaks> {
  if (invocations.length === 0) return {};

  const log = deps.log ?? (() => {});
  const logError = deps.logError ?? (() => {});
  const now = deps.now ?? Date.now;
  const logWarn = deps.logWarn ?? logError;
  const readStreaks = deps.readStreaks ??
    ((dir: string, hostLogDir?: string) =>
      readCallbackFailureSnapshot({
        workDir: dir,
        ...(hostLogDir === undefined ? {} : { hostLogDir }),
        warn: logWarn,
      }));
  const writeStreaks = deps.writeStreaks ??
    ((
      dir: string,
      snapshot: CallbackFailureStreakSnapshot,
      hostLogDir?: string,
    ) =>
      publishCallbackFailureSnapshot({
        workDir: dir,
        ...(hostLogDir === undefined ? {} : { hostLogDir }),
        snapshot,
        warn: logWarn,
      }));

  let snapshot: CallbackFailureStreakSnapshot;
  try {
    snapshot = await readStreaks(workDir, deps.hostLogDir);
  } catch {
    snapshot = emptyCallbackFailureSnapshot();
  }
  const events = { ...snapshot.events };
  // One reading of the clock for the whole record, so every timestamp this
  // call writes agrees with the others.
  const at = new Date(now()).toISOString();

  const due: CallbackFailureReport[] = [];
  const recovered: CallbackRecoveryReport[] = [];
  for (const invocation of invocations) {
    const prior = events[invocation.event];
    if (invocation.status === "ok") {
      const ended = prior?.streak ?? 0;
      if (ended >= CALLBACK_FAILURE_ESCALATION_THRESHOLD) {
        recovered.push({
          event: invocation.event,
          path: invocation.path,
          streak: ended,
          repository: run.repository,
          issueNumber: run.issueNumber,
        });
      }
      // The event stays in the file at zero: "this hook ran and is healthy"
      // is what a host-side reader needs, and absence cannot say it.
      events[invocation.event] = {
        event: invocation.event,
        path: invocation.path,
        streak: 0,
      };
      continue;
    }
    const streak = (prior?.streak ?? 0) + 1;
    // The streak began when its first failure did — a count carried over from
    // the host copy keeps the timestamp that came with it (Issue #2297).
    const firstFailureAt = (prior && prior.streak > 0 && prior.firstFailureAt)
      ? prior.firstFailureAt
      : at;
    const entry: CallbackFailureStreakEntry = {
      event: invocation.event,
      path: invocation.path,
      streak,
      firstFailureAt,
      lastFailureAt: at,
      status: invocation.status,
      exitCode: invocation.exitCode,
      durationSeconds: invocation.durationMs / 1000,
      stderr: redactSecrets(invocation.stderr).slice(
        0,
        PUBLISHED_STDERR_HEAD_CHARS,
      ),
    };
    events[invocation.event] = entry;
    if (streak !== CALLBACK_FAILURE_ESCALATION_THRESHOLD) continue;
    due.push({
      event: invocation.event,
      path: invocation.path,
      streak,
      firstFailureAt,
      repository: run.repository,
      issueNumber: run.issueNumber,
      status: invocation.status,
      exitCode: invocation.exitCode,
      durationSeconds: invocation.durationMs / 1000,
      stderr: redactSecrets(invocation.stderr),
    });
  }

  snapshot = {
    version: CALLBACK_FAILURE_STREAK_SCHEMA_VERSION,
    updatedAt: at,
    events,
  };
  await writeStreaks(workDir, snapshot, deps.hostLogDir);

  for (const report of due) logError(failureRecord(report));

  for (const report of recovered) {
    log(
      `The ${report.event} callback (${report.path}) succeeded on ` +
        `${report.repository}#${report.issueNumber} after ${report.streak} ` +
        "consecutive failing issues — the recorded fault has cleared " +
        "(Issues #2039, #2111)",
    );
  }

  return callbackFailureStreakCounts(snapshot);
}
