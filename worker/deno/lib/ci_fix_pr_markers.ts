/**
 * The CI-fix lane's fleet-wide record, read off the pull request itself
 * (Issue #1879, parent #1861).
 *
 * The 3-attempt auto-fix cap and the "one comment per failure" dedup used to
 * live in each host's own `$HOME/auto-issue-work/.ci_check_state` volume.
 * Nothing there is visible to another host, so two accounts working one pull
 * request each spent their own three attempts and posted their own copy of
 * the same diagnosis — the stock text nine times in 76 minutes.
 *
 * This module is the reader half of the replacement: it fetches the pull
 * request's comments once, hands them to `collectFleetCiFixMarkers`, and
 * turns the fleet-authored markers into the two things the processor needs —
 * the attempt tally the cap binds on, and the rows the consolidated cap
 * summary renders.
 *
 * **A failed read is never mistaken for "no attempts yet".** A fetch that
 * throws, or a fleet identity that cannot be resolved, means the tally is
 * unknown; the processor is told so loudly (`capEnforced: false`) and the
 * log names the configuration that would restore it, rather than a quiet
 * zero reading as a fresh budget.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { GitHubComment, Logger } from "../types.ts";
import {
  type CiFixAttemptOutcome,
  type CiFixAttemptRecord,
  collectFleetCiFixMarkers,
  type FleetCiFixMarkers,
} from "./ci_fix_attempt_markers.ts";
import type { AutoFixCapAttempt } from "./auto_fix_attempt_tracker.ts";

/** What one pull request's comments say about the fleet's CI-fix attempts. */
export interface PrCiFixMarkerState {
  /** The comments the read returned, in API order (oldest first). */
  comments: GitHubComment[];
  /** Fleet-authored markers, grouped by failure signature. */
  markers: FleetCiFixMarkers;
  /**
   * False when the tally could not be established — the comment read failed,
   * or the fleet login set was empty. The cap cannot bind on an unknown
   * tally, so the caller proceeds with the fix; it must not read the empty
   * tally as evidence that no attempt has been made.
   */
  capEnforced: boolean;
}

/** Inputs for {@link readPrCiFixMarkers}. */
export interface ReadPrCiFixMarkersOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Pull request number — pull requests share the issue-comments endpoint. */
  prNumber: number;
  /** Reads the pull request's comments (`ghClient.getIssueComments`). */
  getComments: (repo: string, prNumber: number) => Promise<GitHubComment[]>;
  /** Logins whose markers count as the fleet's own record. */
  fleetLogins: readonly string[];
  /** Logger — every degraded read is reported through it. */
  logger: Logger;
}

/**
 * Read the fleet's CI-fix markers off a pull request.
 *
 * @param options - Repo, PR, comment reader, fleet logins and logger.
 * @returns The comments, the collected markers, and whether the resulting
 *   tally is trustworthy enough for the cap to bind on.
 */
export async function readPrCiFixMarkers(
  options: ReadPrCiFixMarkersOptions,
): Promise<PrCiFixMarkerState> {
  const { repo, prNumber, getComments, fleetLogins, logger } = options;

  let comments: GitHubComment[];
  try {
    comments = [...await getComments(repo, prNumber)];
  } catch (error: unknown) {
    // Fail open, loudly — the sibling shape `recordAutoFixAttempt` used for
    // an unwritable state directory (Issue #580). A comment read that failed
    // must not stall the repair, but it must not pass for a clean zero
    // either: this run's attempt is uncounted and the operator is told.
    logger.error(
      "Could not read the pull request's CI-fix markers — the fleet-wide " +
        "attempt cap is not enforced for this run (Issue #1879)",
      {
        repo,
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return {
      comments: [],
      markers: emptyMarkers(),
      capEnforced: false,
    };
  }

  const markers = collectFleetCiFixMarkers(
    comments,
    fleetLogins,
    (message) => logger.warn(message),
  );
  if (!markers.fleetResolved) {
    logger.error(
      "The fleet login set is empty, so no CI-fix marker on this pull " +
        "request can be attributed — the fleet-wide attempt cap is not " +
        "enforced. Configure `github_user` / `fleet_pr_authors` / " +
        "`service_accounts` to restore it (Issue #1879)",
      { repo, prNumber },
    );
  }
  return { comments, markers, capEnforced: markers.fleetResolved };
}

/** An empty tally, used when nothing could be read. */
function emptyMarkers(): FleetCiFixMarkers {
  return {
    attempts: new Map(),
    deferrals: new Map(),
    fleetResolved: false,
    ignoredOutsideFleet: 0,
  };
}

/** Render a marker outcome as the prose the cap summary prints. */
export function describeAttemptOutcome(outcome: CiFixAttemptOutcome): string {
  return outcome === "pushed"
    ? "pushed a fix; the build was still not green"
    : "no change reached the pull request";
}

/**
 * Turn the recorded markers into the rows the cap summary renders.
 *
 * The diagnosis is the attempt comment's own first line, which is the
 * agent's summary of what it found — comment prose, escaped by the summary
 * builder for the table cell it lands in.
 *
 * @param records - Attempt records for one signature, oldest first.
 * @returns One summary row per record.
 */
export function buildCapAttemptRows(
  records: readonly CiFixAttemptRecord[],
): AutoFixCapAttempt[] {
  return records.map((record, index) => ({
    attempt: record.attempt || index + 1,
    outcome: describeAttemptOutcome(record.outcome),
    diagnosis: record.diagnosed,
  }));
}

/**
 * Append a repeat attempt's marker to the comment that already carries the
 * diagnosis.
 *
 * The same failure on a new head is not new information, so the fleet edits
 * its existing comment rather than posting a second copy of it. The note
 * above the marker is what a human reads; the marker is what the next host
 * counts.
 *
 * @param body - The existing comment body.
 * @param note - One line describing this attempt.
 * @param marker - The attempt marker to record.
 * @returns The replacement body.
 */
export function appendAttemptToComment(
  body: string,
  note: string,
  marker: string,
): string {
  return `${body.trimEnd()}\n\n${note}\n${marker}`;
}
