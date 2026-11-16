/**
 * The log line for a failed issue run (Issue #5077).
 *
 * A host-disk park is a protective stop, not a worker error, so it logs at
 * WARN. A scheduled release (the finish deadline or run hard cap stopped a
 * progressing run) is the schedule working, not a fault, so it logs as
 * "released on schedule" at INFO when the run kept its work and at WARN when
 * it kept nothing (Issue #5118). Every other failure keeps the ERROR line it
 * has always had.
 */

import type { Logger } from "../types.ts";
import type { RunOutcome } from "./run_outcome.ts";
import { isRoutineClaimRefusal } from "./issue_finder_logger.ts";

/**
 * Log one failed phase result for `ref` (`owner/repo#N`).
 *
 * @param logger - The run's logger.
 * @param ref - The issue reference the line names.
 * @param result - The failed phase result: its reason, phase and category,
 *   plus the derived run outcome when known. A `scheduled_release` whose
 *   outcome carries `preservedWip` kept work and logs at INFO; without it the
 *   line is a WARN (Issue #5118).
 * @param expectedSkip - Whether the phase declared the run an expected bounce.
 */
export function logIssueRunFailure(
  logger: Logger,
  ref: string,
  result: {
    reason: string;
    phase?: string;
    category?: string;
    outcome?: RunOutcome;
  },
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
  if (result.category === "scheduled_release") {
    // Issue #5118: the run stopped on schedule; INFO when its work is on a
    // pushed branch, WARN when nothing was kept.
    const line =
      `Issue ${ref} released on schedule at phase '${result.phase}': ${result.reason}`;
    if (
      result.outcome?.kind === "no_pr" &&
      result.outcome.preservedWip !== undefined
    ) {
      logger.info(line);
    } else {
      logger.warn(line);
    }
    return;
  }
  logger.error(
    `Issue ${ref} failed at phase '${result.phase}': ${result.reason}`,
  );
}
