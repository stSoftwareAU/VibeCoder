/**
 * Structured events log for self-healing actions (Issue #1497).
 *
 * Self-healing modules (disk_space, branch_cleanup, git_state_recovery,
 * crash_cleanup, session_compaction, ...) call {@link emitSelfHealEvent}
 * to append a JSON Lines record to `${workDir}/logs/self-heal.jsonl`.
 *
 * Operators can summarise recent activity via the `self-heal-summary`
 * command. Size-based rotation is handled by {@link rotateAllLogs} — this
 * file is named `self-heal.jsonl` so rotation is opt-in via the
 * additional-extensions option.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/** Events file name, relative to the logs directory. */
export const SELF_HEAL_EVENTS_FILENAME = "self-heal.jsonl";

/** Default retention window used by {@link summariseSelfHealEvents}. */
export const DEFAULT_SUMMARY_WINDOW_DAYS = 7;

/** Number of most-recent events included in a summary. */
export const DEFAULT_SUMMARY_RECENT_LIMIT = 10;

/** Result type for a self-heal action. */
export type SelfHealResult = "ok" | "failed" | "skipped" | "noop";

/** A single self-healing event record. */
export interface SelfHealEvent {
  /** ISO 8601 timestamp (UTC) recorded when the event was emitted. */
  timestamp: string;
  /** Source module (e.g. "disk_space", "branch_cleanup"). */
  module: string;
  /** Action taken (e.g. "threshold_cleanup", "merged_branch_delete"). */
  action: string;
  /** Short human-readable reason for the action. */
  reason: string;
  /** Outcome of the action. */
  result: SelfHealResult;
  /** Optional bytes reclaimed (disk cleanup tiers). */
  bytesReclaimed?: number;
  /** Optional JSON-serialisable details for debugging. */
  details?: Record<string, unknown>;
}

/** Options for {@link emitSelfHealEvent}. */
export interface EmitOptions {
  /** Root work directory (events go to `${workDir}/logs/self-heal.jsonl`). */
  workDir: string;
  /** Optional explicit timestamp — defaults to `new Date().toISOString()`. */
  now?: () => Date;
}

/** Resolve the path of the self-heal events log given a work directory. */
export function eventsLogPath(workDir: string): string {
  return `${workDir}/logs/${SELF_HEAL_EVENTS_FILENAME}`;
}

/**
 * The directory production wired via {@link setSelfHealEventsWorkDir}.
 * Module-level on purpose: it is set exactly once, by the worker driver's
 * entry, and never by tests that merely import an emitting module.
 */
let configuredEventsWorkDir: string | undefined;

/**
 * Wire the auto-emission sink (Issue #4250). The worker driver calls this
 * once at entry; until then {@link emitSelfHealEventAuto} without an
 * explicit override writes nothing.
 *
 * The old resolution fell back to the `WORK_DIR` env var, then `$HOME` —
 * which made leaking opt-out: any test that forgot to sandbox forged
 * events into the operator's real `~/logs/self-heal.jsonl` (~350
 * fabricated entries across #4209, #4226 and #4250, spread over four
 * modules). With an explicit sink, a test that forgets simply emits
 * nothing, and `self-heal.jsonl` stays a trustworthy answer to "what did
 * the fleet actually repair". Pass `undefined` to unwire (tests).
 */
export function setSelfHealEventsWorkDir(dir: string | undefined): void {
  configuredEventsWorkDir = dir && dir.trim() ? dir : undefined;
}

/**
 * Resolve the work directory to use for event emission from a caller that
 * does not know the worker config: an explicit override wins, then the
 * production-wired sink. Returns an empty string when neither is set;
 * callers treat that as "do not emit" (Issue #4250 — never fall back to
 * the environment).
 */
export function resolveEventsWorkDir(override?: string | null): string {
  if (override && typeof override === "string") return override;
  return configuredEventsWorkDir ?? "";
}

/**
 * Fire-and-forget wrapper around {@link emitSelfHealEvent} that resolves
 * the work directory via {@link resolveEventsWorkDir}. Safe to call from
 * self-healing paths that do not want to thread a workDir through.
 */
export async function emitSelfHealEventAuto(
  event: Omit<SelfHealEvent, "timestamp"> & { timestamp?: string },
  workDirOverride?: string | null,
): Promise<boolean> {
  const workDir = resolveEventsWorkDir(workDirOverride);
  if (!workDir) return false;
  return await emitSelfHealEvent(event, { workDir });
}

/**
 * Append a structured self-healing event to the events log.
 *
 * Failures are swallowed — self-healing paths must not fail when telemetry
 * cannot be written. The events log directory is created on demand.
 *
 * @returns `true` if the event was written, `false` if it was suppressed.
 */
export async function emitSelfHealEvent(
  event: Omit<SelfHealEvent, "timestamp"> & { timestamp?: string },
  options: EmitOptions,
): Promise<boolean> {
  if (!options.workDir) return false;

  const logDir = `${options.workDir}/logs`;
  try {
    await Deno.mkdir(logDir, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) return false;
  }

  const now = options.now ? options.now() : new Date();
  const record: SelfHealEvent = {
    timestamp: event.timestamp ?? now.toISOString(),
    module: event.module,
    action: event.action,
    reason: event.reason,
    result: event.result,
  };
  if (typeof event.bytesReclaimed === "number") {
    record.bytesReclaimed = event.bytesReclaimed;
  }
  if (event.details && Object.keys(event.details).length > 0) {
    record.details = event.details;
  }

  const line = `${JSON.stringify(record)}\n`;
  const path = eventsLogPath(options.workDir);

  try {
    // Append atomically — Deno writes one line per call so concurrent writers
    // stay line-aligned on POSIX filesystems provided each line is <4096 B.
    await Deno.writeTextFile(path, line, { append: true });
    return true;
  } catch {
    return false;
  }
}

/** Per-module summary entry in a {@link SelfHealSummary}. */
export interface ModuleStat {
  module: string;
  eventCount: number;
  lastTimestamp: string | null;
  bytesReclaimed: number;
}

/** Aggregate summary of self-healing activity. */
export interface SelfHealSummary {
  /** Number of events considered (after the time window filter). */
  totalEvents: number;
  /** Per-module counts and timestamps, sorted by descending event count. */
  perModule: ModuleStat[];
  /** Total bytes reclaimed across all events in the window. */
  totalBytesReclaimed: number;
  /** Most recent events (newest first), up to the recent-limit option. */
  recent: SelfHealEvent[];
  /** Number of malformed lines encountered while parsing. */
  malformedLines: number;
  /** Inclusive lower bound of the window (ISO 8601), or null when unfiltered. */
  windowStart: string | null;
}

/** Options for {@link summariseSelfHealEvents}. */
export interface SummaryOptions {
  workDir: string;
  /** Retention window in days (defaults to {@link DEFAULT_SUMMARY_WINDOW_DAYS}). */
  windowDays?: number;
  /** Limit on recent events in the summary (defaults to 10). */
  recentLimit?: number;
  /** Override "now" for deterministic tests. */
  now?: () => Date;
}

/**
 * Parse the events log and return aggregated statistics.
 *
 * Handles missing and empty files by returning an empty summary. Malformed
 * lines are counted but do not abort parsing — this keeps the summary
 * available even if one line is truncated.
 */
export async function summariseSelfHealEvents(
  options: SummaryOptions,
): Promise<SelfHealSummary> {
  const windowDays = options.windowDays ?? DEFAULT_SUMMARY_WINDOW_DAYS;
  const recentLimit = options.recentLimit ?? DEFAULT_SUMMARY_RECENT_LIMIT;
  const now = options.now ? options.now() : new Date();

  const windowStartDate = windowDays > 0
    ? new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)
    : null;
  const windowStart = windowStartDate ? windowStartDate.toISOString() : null;

  const empty: SelfHealSummary = {
    totalEvents: 0,
    perModule: [],
    totalBytesReclaimed: 0,
    recent: [],
    malformedLines: 0,
    windowStart,
  };

  if (!options.workDir) return empty;

  const path = eventsLogPath(options.workDir);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    // Missing file → empty summary.
    return empty;
  }
  if (!text) return empty;

  const perModuleMap = new Map<string, ModuleStat>();
  const events: SelfHealEvent[] = [];
  let malformedLines = 0;
  let totalBytesReclaimed = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }

    const event = coerceEvent(parsed);
    if (!event) {
      malformedLines++;
      continue;
    }

    if (windowStartDate) {
      const eventDate = new Date(event.timestamp);
      if (isNaN(eventDate.getTime()) || eventDate < windowStartDate) continue;
    }

    events.push(event);
    const stat = perModuleMap.get(event.module) ?? {
      module: event.module,
      eventCount: 0,
      lastTimestamp: null,
      bytesReclaimed: 0,
    };
    stat.eventCount++;
    if (
      stat.lastTimestamp === null ||
      event.timestamp > stat.lastTimestamp
    ) {
      stat.lastTimestamp = event.timestamp;
    }
    if (typeof event.bytesReclaimed === "number") {
      stat.bytesReclaimed += event.bytesReclaimed;
      totalBytesReclaimed += event.bytesReclaimed;
    }
    perModuleMap.set(event.module, stat);
  }

  const perModule = [...perModuleMap.values()].sort((a, b) =>
    b.eventCount - a.eventCount || a.module.localeCompare(b.module)
  );

  const recent = events
    .slice()
    .sort((
      a,
      b,
    ) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
    .slice(0, recentLimit);

  return {
    totalEvents: events.length,
    perModule,
    totalBytesReclaimed,
    recent,
    malformedLines,
    windowStart,
  };
}

/**
 * Format a summary as human-readable text for CLI display.
 */
export function formatSummary(summary: SelfHealSummary): string {
  const lines: string[] = [];
  const window = summary.windowStart
    ? `since ${summary.windowStart}`
    : "(no window filter)";
  lines.push(`Self-healing summary ${window}`);
  lines.push(`  Total events: ${summary.totalEvents}`);
  lines.push(`  Total bytes reclaimed: ${summary.totalBytesReclaimed}`);
  if (summary.malformedLines > 0) {
    lines.push(`  Malformed lines: ${summary.malformedLines}`);
  }

  if (summary.perModule.length === 0) {
    lines.push("  No modules have emitted events in the window.");
  } else {
    lines.push("  Per-module:");
    for (const stat of summary.perModule) {
      const last = stat.lastTimestamp ?? "never";
      lines.push(
        `    ${stat.module}: ${stat.eventCount} events, ` +
          `${stat.bytesReclaimed} bytes reclaimed, last ${last}`,
      );
    }
  }

  if (summary.recent.length > 0) {
    lines.push(`  Most recent ${summary.recent.length} events:`);
    for (const event of summary.recent) {
      const bytes = typeof event.bytesReclaimed === "number"
        ? ` (${event.bytesReclaimed} bytes)`
        : "";
      lines.push(
        `    ${event.timestamp} ${event.module}/${event.action} ` +
          `[${event.result}]${bytes} — ${event.reason}`,
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function coerceEvent(value: unknown): SelfHealEvent | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : null;
  const module = typeof obj.module === "string" ? obj.module : null;
  const action = typeof obj.action === "string" ? obj.action : null;
  const reason = typeof obj.reason === "string" ? obj.reason : null;
  const result = typeof obj.result === "string" ? obj.result : null;
  if (!timestamp || !module || !action || !reason || !result) return null;

  if (!isValidResult(result)) return null;

  const event: SelfHealEvent = { timestamp, module, action, reason, result };

  if (typeof obj.bytesReclaimed === "number" && isFinite(obj.bytesReclaimed)) {
    event.bytesReclaimed = obj.bytesReclaimed;
  }
  if (
    obj.details && typeof obj.details === "object" &&
    !Array.isArray(obj.details)
  ) {
    event.details = obj.details as Record<string, unknown>;
  }
  return event;
}

function isValidResult(v: string): v is SelfHealResult {
  return v === "ok" || v === "failed" || v === "skipped" || v === "noop";
}
