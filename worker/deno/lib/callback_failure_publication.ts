/**
 * Where the callback-failure streak is published, and in what shape
 * (Issue #2297).
 *
 * The streak itself is counted by `callback_failure_streak.ts`; this module
 * owns the file it lives in. Two facts about GRQ-25 on 2026-09-16 shaped it:
 *
 *  1. The `success` hook — the GRQ-health heartbeat — failed on **every**
 *     terminal run for two days. The worker recorded it exactly as designed,
 *     into `worker.log`, and nothing on the host consumed it: the board read a
 *     working host as dead for a day and a half. So the streak is written as
 *     JSON to the **host log directory** (`${HOME}/logs`, the mount
 *     `worker.log` and `host-disk.json` already use) as well as to `WORK_DIR`,
 *     carrying the facts the log record carries — event, hook, streak, first
 *     failure, last exit code and duration, redacted stderr head.
 *  2. The record fired four times rather than once, because the count lived
 *     only in `WORK_DIR` — the `vibe-work` volume the launcher recreated three
 *     times that day (Issue #2077). The host log directory survives that
 *     reset, so a missing work-volume copy falls back to the host copy and
 *     "failing since" stays honest across it.
 *
 * Nothing here reaches GitHub or spawns anything: the boundary Issue #2111
 * drew around this fault — host-local, log and file only — is unchanged. It is
 * the same record, put where the host's own health reporting can read it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type CallbackEvent,
  RUN_CALLBACK_EVENTS,
} from "./run_callbacks_config.ts";
import type { CallbackStatus } from "./run_callbacks.ts";

/** File holding the per-event consecutive-failure counts. */
export const CALLBACK_FAILURE_STREAK_FILE = "callback-failure-streaks.json";

/** Format marker of {@link CallbackFailureStreakSnapshot}. */
export const CALLBACK_FAILURE_STREAK_SCHEMA_VERSION = 1;

/**
 * Characters of redacted stderr kept in the published file. The head is what
 * names the fault; the log record already carries the full captured stream,
 * and this file is read by a health reporter, not by a debugger.
 */
export const PUBLISHED_STDERR_HEAD_CHARS = 500;

/** Consecutive failures per callback event. */
export type CallbackFailureStreaks = Partial<Record<CallbackEvent, number>>;

/** What the published file says about one run hook. */
export interface CallbackFailureStreakEntry {
  /** Which hook — `success`, `failure` or `always`. */
  event: CallbackEvent;
  /** Consecutive issues the hook has failed on; `0` once it succeeds again. */
  streak: number;
  /** The configured hook path, when one has been seen. */
  path?: string;
  /** ISO-8601 timestamp of the first failure of the current streak. */
  firstFailureAt?: string;
  /** ISO-8601 timestamp of the most recent failure. */
  lastFailureAt?: string;
  /** How the last failing invocation ended. */
  status?: CallbackStatus;
  /** Exit code of the last failing invocation. */
  exitCode?: number;
  /** Wall-clock seconds the last failing invocation cost. */
  durationSeconds?: number;
  /** Redacted head of the last failing invocation's stderr. */
  stderr?: string;
}

/** The whole published file. */
export interface CallbackFailureStreakSnapshot {
  /** {@link CALLBACK_FAILURE_STREAK_SCHEMA_VERSION}. */
  version: number;
  /** ISO-8601 timestamp of this write, so a stale file is recognisable. */
  updatedAt?: string;
  /** Per-event detail. An event never invoked on this host is absent. */
  events: Partial<Record<CallbackEvent, CallbackFailureStreakEntry>>;
}

/** Nothing recorded yet. */
export function emptyCallbackFailureSnapshot(): CallbackFailureStreakSnapshot {
  return { version: CALLBACK_FAILURE_STREAK_SCHEMA_VERSION, events: {} };
}

/** The streak file inside a directory. */
export function callbackFailureStreakPath(directory: string): string {
  return `${directory}/${CALLBACK_FAILURE_STREAK_FILE}`;
}

/**
 * The host's log directory as the container sees it — `${HOME}/logs`, the
 * read-write mount `worker.log` and `host-disk.json` already land in.
 *
 * @param env - Environment reader
 * @returns The directory, or null when `HOME` names nowhere to publish to
 */
export function hostLogDirectory(
  env: (name: string) => string | undefined,
): string | null {
  const home = env("HOME")?.trim();
  if (!home) return null;
  return `${home}/logs`;
}

/** The per-event counts alone, for a caller that only wants the numbers. */
export function callbackFailureStreakCounts(
  snapshot: CallbackFailureStreakSnapshot,
): CallbackFailureStreaks {
  const counts: CallbackFailureStreaks = {};
  for (const event of RUN_CALLBACK_EVENTS) {
    const entry = snapshot.events[event];
    if (entry) counts[event] = entry.streak;
  }
  return counts;
}

/** A finite, non-negative integer, or undefined. */
function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One `events` member, or null when it carries no usable count. */
function parseEntry(
  event: CallbackEvent,
  value: unknown,
): CallbackFailureStreakEntry | null {
  // The pre-#2297 format: `{"always": 3}`, a bare count per event. A host that
  // upgrades mid-streak keeps its count rather than restarting it.
  const legacy = positiveInteger(value);
  if (legacy !== undefined) return { event, streak: legacy };
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const streak = positiveInteger(o.streak);
  if (streak === undefined) return null;
  const duration = typeof o.durationSeconds === "number" &&
      Number.isFinite(o.durationSeconds) && o.durationSeconds >= 0
    ? o.durationSeconds
    : undefined;
  const exitCode = typeof o.exitCode === "number" && Number.isFinite(o.exitCode)
    ? o.exitCode
    : undefined;
  return {
    event,
    streak,
    ...(text(o.path) === undefined ? {} : { path: text(o.path)! }),
    ...(text(o.firstFailureAt) === undefined
      ? {}
      : { firstFailureAt: text(o.firstFailureAt)! }),
    ...(text(o.lastFailureAt) === undefined
      ? {}
      : { lastFailureAt: text(o.lastFailureAt)! }),
    ...(text(o.status) === undefined
      ? {}
      : { status: text(o.status)! as CallbackStatus }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(duration === undefined ? {} : { durationSeconds: duration }),
    ...(text(o.stderr) === undefined ? {} : { stderr: text(o.stderr)! }),
  };
}

/**
 * Parse a streak file. Anything unparseable reads as null so the caller can
 * fall back to the other copy rather than inherit a corrupt count.
 *
 * @param body - The file's contents
 * @returns The snapshot, or null when the body is not one
 */
export function parseCallbackFailureSnapshot(
  body: string,
): CallbackFailureStreakSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  // Either the current `{version, events}` shape or the pre-#2297 flat map.
  const source = (typeof o.events === "object" && o.events !== null)
    ? o.events as Record<string, unknown>
    : o;
  const snapshot = emptyCallbackFailureSnapshot();
  const updatedAt = text(o.updatedAt);
  if (updatedAt !== undefined) snapshot.updatedAt = updatedAt;
  for (const event of RUN_CALLBACK_EVENTS) {
    const entry = parseEntry(event, source[event]);
    if (entry) snapshot.events[event] = entry;
  }
  return snapshot;
}

/** The file body for a snapshot. */
export function serialiseCallbackFailureSnapshot(
  snapshot: CallbackFailureStreakSnapshot,
): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** Read one copy; missing, unreadable or malformed all read as null. */
async function readCopy(
  directory: string,
): Promise<CallbackFailureStreakSnapshot | null> {
  try {
    return parseCallbackFailureSnapshot(
      await Deno.readTextFile(callbackFailureStreakPath(directory)),
    );
  } catch {
    return null;
  }
}

/** Where the streak is read from and written to. */
export interface CallbackFailureStreakLocations {
  /** The worker's work directory — the primary copy. */
  workDir: string;
  /** The host log directory, when one is mounted. Survives a volume reset. */
  hostLogDir?: string;
}

/**
 * Read the streak, preferring the work-volume copy and falling back to the
 * host copy when it is missing.
 *
 * The fallback is the whole point of the host copy (Issue #2297): the
 * `vibe-work` volume is recreated whenever the launcher resets it, and a
 * zeroed count re-records an ongoing streak as if it had just begun. The host
 * log directory outlives that reset.
 *
 * @param where - The two copies' directories
 * @returns The streak, or an empty snapshot when neither copy is readable
 */
export async function readCallbackFailureSnapshot(
  where: CallbackFailureStreakLocations,
): Promise<CallbackFailureStreakSnapshot> {
  const fromWork = await readCopy(where.workDir);
  if (fromWork) return fromWork;
  if (where.hostLogDir) {
    const fromHost = await readCopy(where.hostLogDir);
    if (fromHost) return fromHost;
  }
  return emptyCallbackFailureSnapshot();
}

/** Write one copy, creating the directory when it is absent. */
async function writeCopy(
  directory: string,
  body: string,
): Promise<void> {
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(callbackFailureStreakPath(directory), body);
}

/** Inputs to {@link publishCallbackFailureSnapshot}. */
export interface PublishCallbackFailureOptions
  extends CallbackFailureStreakLocations {
  /** The streak to publish. */
  snapshot: CallbackFailureStreakSnapshot;
  /**
   * Where a copy that could not be written is reported. A publish failure is
   * never swallowed: the host copy is what host-side health reporting reads,
   * so losing it silently is the fault this issue exists to remove.
   */
  warn?: (message: string) => void;
}

/**
 * Write the streak to the work volume and to the host log directory.
 *
 * Both writes are attempted even when the first fails, so one unwritable
 * directory never costs the other copy. Neither failure throws — the streak is
 * an aid to the operator, never the run's own result — but each is reported.
 *
 * @param options - The copies, the snapshot and the fault sink
 */
export async function publishCallbackFailureSnapshot(
  options: PublishCallbackFailureOptions,
): Promise<void> {
  const body = serialiseCallbackFailureSnapshot(options.snapshot);
  const warn = options.warn ?? (() => {});
  const targets = [options.workDir];
  if (options.hostLogDir && options.hostLogDir !== options.workDir) {
    targets.push(options.hostLogDir);
  }
  for (const directory of targets) {
    try {
      await writeCopy(directory, body);
    } catch (err) {
      warn(
        `Could not write ${CALLBACK_FAILURE_STREAK_FILE} to ${directory} — ` +
          `the callback-failure streak is not published there: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * The per-cycle liveness line's hook fields:
 * `hook_fail_success=0 hook_fail_failure=0 hook_fail_always=0`.
 *
 * Every run hook is named on every line, whether failing or not, so a
 * host-side reader parses a fixed set of fields rather than inferring absence.
 *
 * @param counts - Consecutive failures per event
 * @returns The fields, space-separated, in {@link RUN_CALLBACK_EVENTS} order
 */
export function formatHookFailureFields(
  counts: CallbackFailureStreaks,
): string {
  return RUN_CALLBACK_EVENTS
    .map((event) => `hook_fail_${event}=${counts[event] ?? 0}`)
    .join(" ");
}
