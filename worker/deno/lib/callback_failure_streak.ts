/**
 * Escalating a post-run callback that fails on every issue (Issue #1092).
 *
 * `invokeRunCallbacks` reports each hook fault loudly and leaves the run's own
 * outcome alone — which is right for a hook that fails once. It is wrong for a
 * hook that fails **every** time: observed on GRQ-23 on 2026-09-05, the
 * `always` hook failed on every issue across at least five runs, each failure
 * costing about 100 seconds of slot time, and raised nothing:
 *
 * ```text
 * ERROR: [s2 …/NEAT-AI-Lamarck#206] callback always (…/always.sh) failed — exit 1, 100.9s
 * ERROR: [s2 …/VibeCoder#984]       callback always … failed — exit 1, 100.7s
 * ERROR: [s1 …/NEAT-AI-Rebase#82]   callback always … failed — exit 1, 101.0s
 * ```
 *
 * By the project's own principle that a fault needing a human is itself a bug,
 * a condition nobody is told about is not "reported" merely because a line
 * exists in a log the fleet writes thousands of. So a hook that fails on
 * {@link CALLBACK_FAILURE_ESCALATION_THRESHOLD} consecutive issues raises one
 * deduplicated issue in the worker's own repository, keyed on the host and the
 * hook — exactly one report per streak, however long the streak runs. A single
 * success ends the streak, so the report says something true about now.
 *
 * The streak is per callback event and lives in `WORK_DIR`, so it survives the
 * run boundary the condition itself survives.
 *
 * The report retires itself (Issues #2039, #2041). When a reported hook
 * succeeds again, the worker closes the issue it raised, with the recovery
 * as the closing comment. Observed 2026-09-12: a contract bump broke every
 * hook on every host, eight reports were raised, every host recovered, and
 * all eight stayed open until a human closed them — the manual step the
 * streak exists to remove, moved rather than removed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { CallbackEvent } from "./run_callbacks_config.ts";
import {
  CALLBACK_SCHEMA_VERSION,
  type CallbackInvocation,
} from "./run_callbacks.ts";
import {
  closeResolvedIssue,
  escalationHostId,
  fileOrCommentIssue,
  resolveEscalationGhEnv,
  resolveOriginRepo,
} from "./host_escalation.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import { redactSecrets } from "./secret_redaction.ts";

/**
 * Consecutive failing issues before the condition is reported.
 *
 * Three, not one: a hook can fail on one issue for reasons belonging to that
 * issue, and a report per issue is the noise this exists to avoid. Three
 * consecutive issues is reached inside a single run on a busy host, so the
 * operator hears about a permanent fault on the run it starts.
 */
export const CALLBACK_FAILURE_ESCALATION_THRESHOLD = 3;

/** File in `WORK_DIR` holding the per-event consecutive-failure counts. */
export const CALLBACK_FAILURE_STREAK_FILE = "callback-failure-streaks.json";

/** Consecutive failures per callback event. */
export type CallbackFailureStreaks = Partial<Record<CallbackEvent, number>>;

/** One callback condition worth telling a human about. */
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

/** A reported hook that has succeeded again (Issue #2039). */
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

/** Injectable seams so the escalation is testable without git or GitHub. */
export interface CallbackFailureStreakDeps {
  /** Reads the persisted streaks. Defaults to the `WORK_DIR` file. */
  readStreaks?: (workDir: string) => Promise<CallbackFailureStreaks>;
  /** Persists the streaks. Defaults to the `WORK_DIR` file. */
  writeStreaks?: (
    workDir: string,
    streaks: CallbackFailureStreaks,
  ) => Promise<void>;
  /** Delivers the report. Defaults to {@link escalateCallbackFailure}. */
  escalate?: (report: CallbackFailureReport) => Promise<void>;
  /** Retires the report. Defaults to {@link resolveCallbackFailure}. */
  resolve?: (report: CallbackRecoveryReport) => Promise<void>;
  /** Informational sink. Defaults to a no-op. */
  log?: (message: string) => void;
  /** Fault sink — an escalation that could not be delivered. */
  logError?: (message: string) => void;
  /** Environment reader for the checkout location. */
  env?: EnvLookup;
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
 * The worker's own checkout, whose `origin` names the repository the report
 * is filed into.
 *
 * `VIBE_BASE_DIR` is what the container launcher names (Issue #4302); the
 * module-relative fallback is the same one `prompt_manager.ts` uses, and
 * resolves to the repository root from `worker/deno/lib/`.
 */
export function workerCheckoutDir(env: EnvLookup = processEnvLookup): string {
  try {
    const baseDir = env("VIBE_BASE_DIR");
    if (baseDir) return baseDir;
  } catch {
    // A denied `--allow-env` falls through to the module-relative path.
  }
  return new URL("../../../", import.meta.url).pathname;
}

/** The title the report is filed under — the deduplication key. */
export function callbackFailureTitle(
  event: CallbackEvent,
  host: string,
): string {
  return `Post-run ${event} callback failing on ${host}`;
}

/**
 * The report body. Pure, so its promises can be tested.
 *
 * It names the schema version this worker exports because the one fleet-wide
 * outage so far (2026-09-11) was the worker's own contract bump, not a
 * deployment fault: a hook that refuses the version predates the contract,
 * and the remedy is an extension upgrade the worker cannot perform itself.
 */
export function callbackFailureReportBody(
  report: CallbackFailureReport,
  host: string,
): string {
  return [
    `The \`${report.event}\` callback on \`${host}\` has failed on ` +
    `${report.streak} consecutive issues (Issue #1092). It runs after every ` +
    "terminal issue run, so the cost is paid on every issue this host works; " +
    "the run's own result is unaffected.",
    "",
    `- Hook: \`${report.path}\``,
    `- Last run: ${report.repository}#${report.issueNumber}`,
    `- Outcome: ${report.status}, exit ${report.exitCode}, ` +
    `${report.durationSeconds.toFixed(1)}s`,
    "",
    report.stderr
      ? ["Last captured stderr:", "", "```", report.stderr, "```"].join("\n")
      : "The hook captured no stderr.",
    "",
    `This worker exports callback schema version ${CALLBACK_SCHEMA_VERSION}. ` +
    "A hook that refuses that version was written against an older " +
    "contract. The contract is additive — every field an older version " +
    "exported is still there — so upgrade the extension on this host; the " +
    "worker cannot reinstall an operator's hooks itself (docs/CALLBACKS.md, " +
    '"Versioning").',
    "",
    "Otherwise fix the hook or remove it from `callbacks` in `.config.json`. " +
    "A hook that cannot succeed should fail fast rather than retry: a " +
    "permanent authorisation failure (HTTP 403, `Write access to repository " +
    "not granted`) will not be cleared by a retry or a rebase, and any " +
    "backlog the hook carries forward between runs must be bounded by the " +
    "hook itself. See docs/CALLBACKS.md.",
    "",
    "This report is raised once per failure streak. The worker closes this " +
    "issue itself on the hook's next successful invocation.",
  ].join("\n");
}

/** The closing comment left when a reported hook succeeds again. */
export function callbackRecoveryBody(
  report: CallbackRecoveryReport,
  host: string,
): string {
  return `The \`${report.event}\` callback on \`${host}\` succeeded on ` +
    `${report.repository}#${report.issueNumber} after ${report.streak} ` +
    "consecutive failing issues, so this report no longer describes the " +
    "host. Closing it (Issue #1092).";
}

/**
 * Production escalator: one deduplicated issue in the worker's OWN repository,
 * titled for the host and the hook so an ongoing condition stays ONE incident.
 *
 * Throws when the report could not be delivered — the caller must know, which
 * is the whole point of Issue #556's channel.
 */
export async function escalateCallbackFailure(
  report: CallbackFailureReport,
  env: EnvLookup = processEnvLookup,
): Promise<void> {
  const repo = await resolveOriginRepo(workerCheckoutDir(env));
  const host = escalationHostId(env);
  const ghEnv = await resolveEscalationGhEnv(env);
  await fileOrCommentIssue({
    repo,
    title: callbackFailureTitle(report.event, host),
    body: callbackFailureReportBody(report, host),
    env: ghEnv,
  });
}

/**
 * Production resolver: close the report {@link escalateCallbackFailure}
 * raised, under the same title, with the recovery as its comment.
 *
 * Throws when the close was refused — the report is then still open and the
 * caller says so.
 */
export async function resolveCallbackFailure(
  report: CallbackRecoveryReport,
  env: EnvLookup = processEnvLookup,
): Promise<void> {
  const repo = await resolveOriginRepo(workerCheckoutDir(env));
  const host = escalationHostId(env);
  const ghEnv = await resolveEscalationGhEnv(env);
  await closeResolvedIssue({
    repo,
    title: callbackFailureTitle(report.event, host),
    body: callbackRecoveryBody(report, host),
    env: ghEnv,
  });
}

/**
 * Record how this run's callbacks ended and escalate a permanent failure.
 *
 * A hook that exited 0 resets its streak. Any other outcome — failed, timed
 * out, un-spawnable — extends it, and the run that takes the streak to
 * {@link CALLBACK_FAILURE_ESCALATION_THRESHOLD} raises the one report for it.
 * Later failures in the same streak add nothing, so a hook broken for days
 * produces one incident rather than one per issue. A success that ends a
 * streak long enough to have been reported closes that report (Issue #2039);
 * a success that ends a shorter streak has nothing to close.
 *
 * Never throws: a fault in the reporting path must not alter the run's own
 * outcome, which is the boundary the whole callback layer holds.
 *
 * @param workDir - The worker's work directory, where the streaks live
 * @param invocations - What {@link CallbackInvocation}s this run produced
 * @param run - Repository and issue the run worked, for the report
 * @param deps - Injected storage, escalator and log sinks
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
  const env = deps.env ?? processEnvLookup;
  const escalate = deps.escalate ??
    ((report: CallbackFailureReport) => escalateCallbackFailure(report, env));
  const resolve = deps.resolve ??
    ((report: CallbackRecoveryReport) => resolveCallbackFailure(report, env));
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
      if (ended > 0) {
        log(
          `The ${invocation.event} callback succeeded — clearing its ` +
            `failure streak (Issue #1092)`,
        );
      }
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

  for (const report of due) {
    log(
      `The ${report.event} callback has failed on ${report.streak} ` +
        `consecutive issues — reporting it once (Issue #1092)`,
    );
    try {
      await escalate(report);
    } catch (error) {
      logError(
        `Could not report the failing ${report.event} callback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  for (const report of recovered) {
    log(
      `The ${report.event} callback recovered after ${report.streak} ` +
        `consecutive failing issues — closing its report (Issue #2039)`,
    );
    try {
      await resolve(report);
    } catch (error) {
      logError(
        `Could not close the report for the recovered ${report.event} ` +
          `callback: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return streaks;
}
