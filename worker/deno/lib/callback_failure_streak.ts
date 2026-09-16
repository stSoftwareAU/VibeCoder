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
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { CallbackEvent } from "./run_callbacks_config.ts";
import {
  CALLBACK_SCHEMA_VERSION,
  type CallbackInvocation,
} from "./run_callbacks.ts";
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

/** File in `WORK_DIR` holding the per-event consecutive-failure counts. */
export const CALLBACK_FAILURE_STREAK_FILE = "callback-failure-streaks.json";

/** Consecutive failures per callback event. */
export type CallbackFailureStreaks = Partial<Record<CallbackEvent, number>>;

/** One callback condition worth telling the host's operator about. */
export interface CallbackFailureReport {
  /** Which hook — `success`, `failure` or `always`. */
  event: CallbackEvent;
  /** The configured hook path. */
  path: string;
  /** Consecutive issues the hook has failed on. */
  streak: number;
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
  /** Reads the persisted streaks. Defaults to the `WORK_DIR` file. */
  readStreaks?: (workDir: string) => Promise<CallbackFailureStreaks>;
  /** Persists the streaks. Defaults to the `WORK_DIR` file. */
  writeStreaks?: (
    workDir: string,
    streaks: CallbackFailureStreaks,
  ) => Promise<void>;
  /** Informational sink. Defaults to a no-op. */
  log?: (message: string) => void;
  /** Fault sink — where the threshold record is written. */
  logError?: (message: string) => void;
}

function streakFilePath(workDir: string): string {
  return `${workDir}/${CALLBACK_FAILURE_STREAK_FILE}`;
}

/** Read the persisted streaks; absent or unreadable reads as none. */
async function defaultReadStreaks(
  workDir: string,
): Promise<CallbackFailureStreaks> {
  try {
    const text = await Deno.readTextFile(streakFilePath(workDir));
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const streaks: CallbackFailureStreaks = {};
    for (const event of ["success", "failure", "always"] as const) {
      const value = parsed[event];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        streaks[event] = Math.floor(value);
      }
    }
    return streaks;
  } catch {
    return {};
  }
}

/** Persist the streaks. Best-effort — a write failure only loses the count. */
async function defaultWriteStreaks(
  workDir: string,
  streaks: CallbackFailureStreaks,
): Promise<void> {
  try {
    await Deno.writeTextFile(
      streakFilePath(workDir),
      `${JSON.stringify(streaks, null, 2)}\n`,
    );
  } catch {
    // The count is an optimisation over the log, never the record itself.
  }
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
 * A fault in the count file never alters the run's own outcome — the read and
 * the write are both best-effort, because the log is the record and the count
 * only an optimisation over it. That boundary is the one the whole callback
 * layer holds.
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

  const readStreaks = deps.readStreaks ?? defaultReadStreaks;
  const writeStreaks = deps.writeStreaks ?? defaultWriteStreaks;
  const log = deps.log ?? (() => {});
  const logError = deps.logError ?? (() => {});

  let streaks: CallbackFailureStreaks;
  try {
    streaks = await readStreaks(workDir);
  } catch {
    streaks = {};
  }

  const due: CallbackFailureReport[] = [];
  const recovered: CallbackRecoveryReport[] = [];
  for (const invocation of invocations) {
    if (invocation.status === "ok") {
      const ended = streaks[invocation.event] ?? 0;
      if (ended >= CALLBACK_FAILURE_ESCALATION_THRESHOLD) {
        recovered.push({
          event: invocation.event,
          path: invocation.path,
          streak: ended,
          repository: run.repository,
          issueNumber: run.issueNumber,
        });
      }
      streaks[invocation.event] = 0;
      continue;
    }
    const streak = (streaks[invocation.event] ?? 0) + 1;
    streaks[invocation.event] = streak;
    if (streak !== CALLBACK_FAILURE_ESCALATION_THRESHOLD) continue;
    due.push({
      event: invocation.event,
      path: invocation.path,
      streak,
      repository: run.repository,
      issueNumber: run.issueNumber,
      status: invocation.status,
      exitCode: invocation.exitCode,
      durationSeconds: invocation.durationMs / 1000,
      stderr: redactSecrets(invocation.stderr),
    });
  }

  await writeStreaks(workDir, streaks);

  for (const report of due) logError(failureRecord(report));

  for (const report of recovered) {
    log(
      `The ${report.event} callback (${report.path}) succeeded on ` +
        `${report.repository}#${report.issueNumber} after ${report.streak} ` +
        "consecutive failing issues — the recorded fault has cleared " +
        "(Issues #2039, #2111)",
    );
  }

  return streaks;
}
