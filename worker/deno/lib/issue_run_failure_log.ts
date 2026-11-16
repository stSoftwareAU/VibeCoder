/**
 * The log line for a failed issue run (Issue #5077).
 *
 * A host-disk park is a protective stop, not a worker error, so it logs at
 * WARN. Every other failure keeps the ERROR line it has always had.
 */

import type { Logger } from "../types.ts";
import { isRoutineClaimRefusal } from "./issue_finder_logger.ts";

/**
 * Log one failed phase result for `ref` (`owner/repo#N`).
 *
 * @param logger - The run's logger.
 * @param ref - The issue reference the line names.
 * @param result - The failed phase result: its reason, phase and category.
 * @param expectedSkip - Whether the phase declared the run an expected bounce.
 */
export function logIssueRunFailure(
  logger: Logger,
  ref: string,
  result: { reason: string; phase?: string; category?: string },
  expectedSkip: boolean,
): void {
  if (expectedSkip) {
    // Issue #4063: another worker holding the issue (or it already being
    // done) is the expected path; any other skip stays loud.
    const line = `Skipped ${ref}: ${result.reason}`;
    if (isRoutineClaimRefusal(result.reason)) {
      logger.info(line);
    } else {
      logger.warn(line);
    }
    return;
  }
  if (result.category === "host_disk") {
    logger.warn(
      `Issue ${ref} parked for the host disk at phase '${result.phase}': ${result.reason}`,
    );
    return;
  }
  logger.error(
    `Issue ${ref} failed at phase '${result.phase}': ${result.reason}`,
  );
}
