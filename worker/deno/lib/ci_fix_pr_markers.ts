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
 * unknown; the processor is told so loudly (`capEnforced: false`) and the log
 * names the configuration that would restore it, rather than a quiet zero
 * reading as a fresh budget. The two are reported apart (`readFailed`)
 * because the caller answers them differently — see that field.
 *
 * The scanner half (Issue #1881) reads the same record from the other end:
 * {@link findOpenDeferrals} lists the checks a fleet-authored
 * `vibe-ci-fix-deferred` marker has parked on an issue that is **still
 * open**, so `findFailedCiChecks` can leave them alone until the blocker
 * closes. Both halves resolve a blocker through {@link parseBlockerRef} and
 * {@link isBlockerOpen}, so the `owner/repo#N` form is parsed in one place.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { GitHubComment, Logger } from "../types.ts";
import {
  type CiFixAttemptOutcome,
  type CiFixAttemptRecord,
  type CiFixDeferralRecord,
  type CiFixMarkerComment,
  collectFleetCiFixMarkers,
  type FleetCiFixMarkers,
} from "./ci_fix_attempt_markers.ts";
import type { AutoFixCapAttempt } from "./auto_fix_attempt_tracker.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { createIssueFetcher } from "./issue_finder_common.ts";

/** What one pull request's comments say about the fleet's CI-fix attempts. */
export interface PrCiFixMarkerState {
  /** The comments the read returned, in API order (oldest first). */
  comments: GitHubComment[];
  /** Fleet-authored markers, grouped by failure signature. */
  markers: FleetCiFixMarkers;
  /**
   * False when the tally could not be established — the comment read failed,
   * or the fleet login set was empty. An empty tally is then "cannot
   * decide", never "no attempt has been made".
   */
  capEnforced: boolean;
  /**
   * True when the comment read itself failed.
   *
   * Distinct from an unresolved fleet, because the two deserve opposite
   * answers. A failed read is **transient**: the caller stands down and the
   * next scan retries at no cost, which is what
   * `ci_fix_attempt_markers.ts` means by "treat `false` as cannot decide".
   * An empty fleet login set is a **configuration** fault that would never
   * resolve itself, so standing down on it would stop every repair on the
   * host for ever; the caller proceeds and the error above names the keys
   * that restore the tally.
   */
  readFailed: boolean;
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
    // Loud, and reported as a read failure rather than an empty tally: the
    // caller stands this cycle down instead of spending an attempt it could
    // not count.
    logger.error(
      "Could not read the pull request's CI-fix markers — the fleet-wide " +
        "attempt cap cannot be evaluated, so this cycle stands down " +
        "(Issue #1879)",
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
      readFailed: true,
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
  return {
    comments,
    markers,
    capEnforced: markers.fleetResolved,
    readFailed: false,
  };
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

// ---------------------------------------------------------------------------
// Blocker references (Issues #1880, #1881)
// ---------------------------------------------------------------------------

/** The issue a deferral marker names, split out of its `owner/repo#N` form. */
export interface BlockerRef {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue (or pull request) number. */
  number: number;
}

/**
 * Split a `dependsOn` reference into repository and number.
 *
 * `parseCiFixDeferralMarkers` validates the shape when a marker is read, so
 * a `null` here is a defect rather than data — callers name it and take the
 * loud path rather than guessing a repository.
 *
 * @param ref - The reference, e.g. `owner/repo#149`.
 * @returns The split reference, or `null` when it is not `owner/repo#N`.
 */
export function parseBlockerRef(ref: string): BlockerRef | null {
  const hash = ref.lastIndexOf("#");
  if (hash <= 0) return null;
  const repo = ref.slice(0, hash);
  const number = Number(ref.slice(hash + 1));
  if (!/^[^\s/]+\/[^\s/#]+$/.test(repo)) return null;
  if (!Number.isInteger(number) || number < 1) return null;
  return { repo, number };
}

/**
 * Is the blocking issue still open?
 *
 * No iteration cache is consulted: a blocker that closed moments ago must
 * read as closed here, not as whatever an earlier scan cached. A merged
 * pull request named as the blocker reads as closed (`normaliseIssueState`).
 *
 * @param ref - The parsed blocker.
 * @param ghCommandFn - Runs `gh`.
 * @returns `true` while the issue is open.
 * @throws when the state cannot be read — the caller decides what a missing
 *   answer means for it; nothing here guesses.
 */
export async function isBlockerOpen(
  ref: BlockerRef,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<boolean> {
  const state = await createIssueFetcher(ghCommandFn).getIssueState(
    ref.repo,
    ref.number,
  );
  return state.state === "OPEN";
}

// ---------------------------------------------------------------------------
// Open deferrals, for the scanner (Issue #1881)
// ---------------------------------------------------------------------------

/** One failing check the fleet has parked on an issue that is still open. */
export interface OpenDeferral {
  /** Name of the deferred check, as the marker's `check` attribute has it. */
  checkName: string;
  /** The open blocker, in `owner/repo#N` form. */
  dependsOn: string;
  /** Failure signature the deferral was recorded against. */
  signature: string;
}

/** Inputs for {@link findOpenDeferrals}. */
export interface FindOpenDeferralsOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Pull request number — pull requests share the issue-comments endpoint. */
  prNumber: number;
  /** Runs `gh`; the scanner's own runner, so its quota accounting applies. */
  ghCommandFn: (args: string[]) => Promise<string>;
  /** Logins whose markers count as the fleet's own record. */
  fleetLogins: readonly string[];
  /** Logger — every degraded read is reported through it. */
  logger: Logger;
}

/**
 * Reduce the raw `repos/…/issues/…/comments` rows to the marker reader's
 * shape. A row missing its author or body is kept with those fields null:
 * `collectFleetCiFixMarkers` treats it as not evidence, which is what an
 * unattributable comment is.
 */
function markerCommentsFromRest(
  rows: readonly unknown[],
): CiFixMarkerComment[] {
  const comments: CiFixMarkerComment[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as {
      id?: unknown;
      body?: unknown;
      created_at?: unknown;
      user?: unknown;
    };
    if (typeof row.id !== "number") continue;
    const login = typeof row.user === "object" && row.user !== null
      ? (row.user as { login?: unknown }).login
      : undefined;
    comments.push({
      id: row.id,
      author: typeof login === "string" ? login : null,
      body: typeof row.body === "string" ? row.body : null,
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
    });
  }
  return comments;
}

/**
 * The checks on a pull request that a fleet-authored deferral marker has
 * parked on an issue that is still open (Issue #1881).
 *
 * The base-branch deferral (#1880) posts the agent's diagnosis once with a
 * `vibe-ci-fix-deferred` marker naming the blocker. Until that issue closes,
 * nothing on the pull request's own branch can turn the check green, so the
 * scanner has no business re-diagnosing it — on this host or any other. Once
 * the blocker closes the check is returned as usual, and #1880's loop guard
 * refuses a silent second deferral on the same closed issue.
 *
 * **The fail direction is towards scanning.** A comment thread that cannot
 * be read, a marker from outside the fleet, an unresolved fleet identity, a
 * reference that is not `owner/repo#N`, or an issue whose state cannot be
 * read all leave the check *undeferred*: each is reported, and the ordinary
 * scan goes ahead. A suppressed real failure is the outcome nobody would
 * notice, so no error is allowed to produce one.
 *
 * @param options - Repo, PR, `gh` runner, fleet logins and logger.
 * @returns One entry per deferred check, in marker order. Empty when nothing
 *   is deferred or nothing could be trusted.
 */
export async function findOpenDeferrals(
  options: FindOpenDeferralsOptions,
): Promise<OpenDeferral[]> {
  const { repo, prNumber, ghCommandFn, fleetLogins, logger } = options;

  let rows: unknown[];
  try {
    rows = await fetchIssueCommentPages(repo, prNumber, ghCommandFn);
  } catch (error: unknown) {
    logger.error(
      "Could not read the pull request's comments, so no CI-fix deferral " +
        "can be honoured — every failing check is scanned as usual " +
        "(Issue #1881)",
      {
        repo,
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return [];
  }

  const markers = collectFleetCiFixMarkers(
    markerCommentsFromRest(rows),
    fleetLogins,
    (message) => logger.warn(message),
  );
  if (markers.deferrals.size === 0) return [];

  const open: OpenDeferral[] = [];
  const seen = new Set<string>();
  // One state read per distinct blocker, however many markers name it.
  const blockerOpen = new Map<string, Promise<boolean | undefined>>();
  const readBlocker = (dependsOn: string): Promise<boolean | undefined> => {
    let pending = blockerOpen.get(dependsOn);
    if (pending === undefined) {
      pending = resolveBlockerOpen(dependsOn, {
        repo,
        prNumber,
        ghCommandFn,
        logger,
      });
      blockerOpen.set(dependsOn, pending);
    }
    return pending;
  };

  const records: CiFixDeferralRecord[] = [...markers.deferrals.values()]
    .flat()
    .sort((a, b) => a.commentId - b.commentId);
  for (const record of records) {
    if (seen.has(record.checkName)) continue;
    if (await readBlocker(record.dependsOn) !== true) continue;
    seen.add(record.checkName);
    open.push({
      checkName: record.checkName,
      dependsOn: record.dependsOn,
      signature: record.signature,
    });
  }
  return open;
}

/**
 * Whether one blocker is open, with every failure named and answered
 * `undefined` — which {@link findOpenDeferrals} reads as "not deferred".
 */
async function resolveBlockerOpen(
  dependsOn: string,
  context: {
    repo: string;
    prNumber: number;
    ghCommandFn: (args: string[]) => Promise<string>;
    logger: Logger;
  },
): Promise<boolean | undefined> {
  const { repo, prNumber, ghCommandFn, logger } = context;
  const ref = parseBlockerRef(dependsOn);
  if (ref === null) {
    logger.error(
      "A recorded CI-fix deferral names a dependency that is not in " +
        "`owner/repo#N` form — the check is scanned as usual (Issue #1881)",
      { repo, prNumber, dependsOn },
    );
    return undefined;
  }
  try {
    return await isBlockerOpen(ref, ghCommandFn);
  } catch (error: unknown) {
    logger.error(
      "Could not read the state of the issue a CI-fix deferral names — " +
        "the check is scanned as usual (Issue #1881)",
      {
        repo,
        prNumber,
        dependsOn,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }
}
