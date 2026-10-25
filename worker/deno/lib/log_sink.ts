/**
 * Log at a level without writing the level into the message (Issue #4176).
 *
 * A sink is a worker logger (`info` / `warn` / `error`) or a callback. A
 * callback may take the level as a second argument. Callers that ignore the
 * second argument still receive the message, and the message does not repeat
 * the level.
 */

import type { Logger } from "../types.ts";

export type LogLevelName = "info" | "warn" | "error";

/** Logger methods, a level-aware callback, or no sink. */
export type LogSink =
  | ((message: string, level?: LogLevelName) => void)
  | Pick<Logger, LogLevelName>
  | undefined
  | null;

/**
 * Write `message` at `level`.
 *
 * @param log - Logger, callback, or absent
 * @param level - Severity the line claims
 * @param message - Text with no level prefix
 */
export function logAt(
  log: LogSink,
  level: LogLevelName,
  message: string,
): void {
  if (log == null) return;
  if (typeof log === "function") {
    log(message, level);
    return;
  }
  log[level](message);
}

/**
 * Adapt a logger to the `(message, level?)` callback older call sites pass.
 *
 * One argument stays info. `warn` and `error` reach those methods, so a
 * module can name the level without the production wiring hard-coding info.
 */
export function bindLogger(
  logger: Pick<Logger, LogLevelName>,
): (message: string, level?: LogLevelName) => void {
  return (message, level = "info") => {
    logger[level](message);
  };
}
