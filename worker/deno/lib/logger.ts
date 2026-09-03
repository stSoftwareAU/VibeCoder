/**
 * Logger module for the Vibe Coder worker.
 *
 * Provides consistent logging with timestamps, log levels, structured
 * context (key=value pairs), security event tracking, skip reason logging,
 * timing metrics, scan summaries, and worker summaries.
 *
 * Issue #219 - Add structured logging with log levels
 * Issue #627 - Skip reason and timing metrics
 * Issue #906 - Migrate logging.sh to Deno TypeScript
 */

import type { LogContext, Logger } from "../types.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { attributeToSlot } from "./slot_context.ts";

/**
 * Log level names in order of severity.
 */
export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";

/**
 * Numeric log level values for filtering comparison.
 */
export const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
} as const;

/**
 * Validate a raw `LOG_LEVEL` value (Issue #3649, SEC-d17c4be9026a).
 *
 * `defaultLogger` used an unchecked `as LogLevel` cast, so any value outside
 * the four canonical names reached `shouldLog` as an unknown key: every
 * `LOG_LEVELS[configured]` lookup was `undefined` and every `n >= undefined`
 * comparison false, silently disabling all output — including the
 * `[SECURITY]` lines. Unknown values now fail loud and fall back.
 *
 * @param raw - Raw environment value (case-insensitive, may be padded)
 * @param warn - Sink for the rejection notice (defaults to `console.error`)
 * @returns The matching level, or `undefined` to use the default
 */
export function parseLogLevel(
  raw: string | undefined,
  warn: (message: string) => void = (message) => console.error(message),
): LogLevel | undefined {
  if (raw === undefined) return undefined;
  const candidate = raw.trim().toUpperCase();
  if (candidate === "") return undefined;
  // `hasOwnProperty`, not `in` — `constructor` must not resolve to a level.
  if (Object.prototype.hasOwnProperty.call(LOG_LEVELS, candidate)) {
    return candidate as LogLevel;
  }
  warn(
    `[logger] Ignoring unrecognised LOG_LEVEL "${raw}" — expected one of ` +
      `${Object.keys(LOG_LEVELS).join(", ")}. Falling back to the default ` +
      `level so logging is not silently disabled.`,
  );
  return undefined;
}

/**
 * Logger options for creating a new logger instance.
 */
export interface LoggerOptions {
  /** Function to write log messages (defaults to console.error) */
  write?: (message: string) => void;
  /** Enable debug logging (defaults to false). Kept for backward compatibility. */
  debug?: boolean;
  /** Minimum log level to output (defaults to INFO). Takes precedence over debug flag. */
  logLevel?: LogLevel;
  /**
   * Host identity stamped on every line (Issue #856). Defaults to
   * `<hostname>:<pid>`, matching the form the idle instruments already use.
   * Pass a fixed value in tests; pass `""` to omit the field entirely.
   */
  host?: string;
}

/**
 * Format a date as a timestamp string.
 *
 * Always emits UTC with a trailing `Z` suffix so worker logs are unambiguous
 * across machine moves, daylight savings, and multi-region deployments
 * (Issue #1904).
 *
 * @param date - Date to format
 * @returns Formatted timestamp (YYYY-MM-DD HH:MM:SSZ)
 */
export function formatTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}Z`;
}

/**
 * Format structured context as key=value pairs.
 *
 * @param context - Key-value pairs to format
 * @returns Formatted string of key=value pairs, or empty string if no context
 */
function formatContext(context?: LogContext): string {
  if (!context) return "";
  const pairs = Object.entries(context)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return pairs ? ` ${pairs}` : "";
}

/**
 * Check whether a message at the given level should be output.
 *
 * @param messageLevel - The level of the message
 * @param configuredLevel - The minimum configured level
 * @returns true if the message should be logged
 */
function shouldLog(messageLevel: LogLevel, configuredLevel: LogLevel): boolean {
  return LOG_LEVELS[messageLevel] >= LOG_LEVELS[configuredLevel];
}

/**
 * Resolve the effective log level from options.
 *
 * If logLevel is explicitly set, it takes precedence.
 * Otherwise, if debug is true, use DEBUG; else use INFO.
 */
function resolveLogLevel(options: LoggerOptions): LogLevel {
  if (options.logLevel) return options.logLevel;
  if (options.debug) return "DEBUG";
  return "INFO";
}

/**
 * Format seconds into human-readable duration.
 *
 * @param totalSeconds - Number of seconds
 * @returns Human-readable string (e.g., "14m 5s", "2h 3m", "45s")
 */
export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Create a new logger instance.
 *
 * @param options - Logger configuration options
 * @returns Logger instance with structured logging methods
 */
/**
 * This process's identity, for stamping on every log line (Issue #856).
 *
 * Only 26% of the worker's log lines carried a host — the idle instruments
 * did, and nothing else. Once logs from several hosts are copied to one
 * place, every claim, PR, error, escalation and outcome became unattributable,
 * so "which host is failing?" could not be answered from the merged store.
 *
 * The form matches what `idle_decision_census.ts` and
 * `idle_detect_diagnostics.ts` already emit, so a scraper needs one shape
 * rather than two. Resolved once: the hostname does not change under us, and
 * a syscall per log line would be absurd.
 *
 * Falls back to `unknown-host` when the hostname cannot be read — a log line
 * missing its host is worth far less than a crash in the logger.
 */
let cachedHostId: string | undefined;

function defaultHostId(): string {
  if (cachedHostId !== undefined) return cachedHostId;
  let name = "unknown-host";
  try {
    name = Deno.hostname();
  } catch {
    // `--allow-sys=hostname` not granted; the pid alone still separates
    // concurrent processes on one machine.
  }
  let pid = 0;
  try {
    pid = Deno.pid;
  } catch { /* not addressable; 0 is a legible placeholder */ }
  cachedHostId = `${name}:${pid}`;
  return cachedHostId;
}

/** Reset the cached identity. Tests only. */
export function resetHostIdForTest(): void {
  cachedHostId = undefined;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  // Redact known secret shapes from every line before it reaches the sink
  // (Issue #2417). This is the single chokepoint for worker log output, so
  // wrapping the write here guarantees a tokenised git/gh error, a logged
  // command-output tail, or any other secret-bearing string is masked before
  // it lands in worker-*.log or CI output. Redaction is conservative
  // (specific patterns only) so ordinary log text is untouched; see
  // secret_redaction.ts.
  //
  // This covers logger callers only. Direct console.* writes bypass it, so
  // `installConsoleRedaction()` (console_redaction.ts, Issue #3661) patches
  // the console at process start — together the two make masking hold
  // regardless of which caller produced the string.
  const sink = options.write ?? ((msg: string) => console.error(msg));
  const write = (msg: string) => sink(redactSecrets(msg));
  const minLevel = resolveLogLevel(options);
  // Issue #856: appended rather than prefixed. Several parsers anchor on the
  // `[timestamp] LEVEL: message` shape (`green_gate_report.ts`,
  // `first_run_verification.ts`), and a host inserted before the message
  // would break them for no gain — a trailing field greps and splits just as
  // well in a merged store.
  const hostId = options.host ?? defaultHostId();
  const hostSuffix = hostId === "" ? "" : ` host=${hostId}`;

  const log = (
    level: LogLevel,
    message: string,
    context?: LogContext,
  ): void => {
    if (!shouldLog(level, minLevel)) return;
    const timestamp = formatTimestamp(new Date());
    const contextStr = formatContext(context);
    // Slot attribution (Issue #4181): lines written under a concurrent
    // issue slot carry `[sN owner/repo#issue]`; outside a slot, unchanged.
    write(
      `[${timestamp}] ${level}: ${
        attributeToSlot(message)
      }${contextStr}${hostSuffix}`,
    );
  };

  return {
    info: (message: string, context?: LogContext): void => {
      log("INFO", message, context);
    },

    warn: (message: string, context?: LogContext): void => {
      log("WARNING", message, context);
    },

    error: (message: string, context?: LogContext): void => {
      log("ERROR", message, context);
    },

    debug: (message: string, context?: LogContext): void => {
      log("DEBUG", message, context);
    },

    security: (event: string, details: string): void => {
      const timestamp = formatTimestamp(new Date());
      write(`[${timestamp}] [SECURITY] [${event}] ${details}`);
    },

    skipReason: (reasonCode: string, details: string): void => {
      if (!shouldLog("DEBUG", minLevel)) return;
      const timestamp = formatTimestamp(new Date());
      write(`[${timestamp}] [SKIP] [${reasonCode}] ${details}`);
    },

    timing: (
      operation: string,
      durationSeconds: number,
      details?: string,
    ): void => {
      if (!shouldLog("INFO", minLevel)) return;
      const timestamp = formatTimestamp(new Date());
      const humanDuration = formatDuration(durationSeconds);
      let line = `[${timestamp}] [TIMING] ${
        attributeToSlot(`[${operation}]`)
      } duration=${durationSeconds}s human=${humanDuration}`;
      if (details) {
        line = `${line} ${details}`;
      }
      write(line);
    },

    scanSummary: (
      reposScanned: number,
      issuesFound: number,
      issuesSkipped: number,
      skipReasons?: string,
    ): void => {
      if (!shouldLog("INFO", minLevel)) return;
      const timestamp = formatTimestamp(new Date());
      const reasons = skipReasons ?? "none";
      write(
        `[${timestamp}] [SCAN_SUMMARY] repos_scanned=${reposScanned} issues_found=${issuesFound} issues_skipped=${issuesSkipped} reasons=${reasons}`,
      );
    },

    workerSummary: (issuesProcessed: number, durationSeconds: number): void => {
      if (!shouldLog("INFO", minLevel)) return;
      const timestamp = formatTimestamp(new Date());
      const humanDuration = formatDuration(durationSeconds);
      const avg = issuesProcessed > 0 && durationSeconds > 0
        ? Math.floor(durationSeconds / issuesProcessed)
        : 0;
      write(
        `[${timestamp}] [WORKER_SUMMARY] issues_processed=${issuesProcessed} duration=${durationSeconds}s human=${humanDuration} avg=${avg}s_per_issue`,
      );
    },
  };
}

/**
 * Default logger instance using console output.
 */
export const defaultLogger = createLogger({
  debug: Deno.env.get("DEBUG") === "true",
  logLevel: parseLogLevel(Deno.env.get("LOG_LEVEL")),
});
