/**
 * Sweep for the leftovers of the retired PR escalation (Issue #2805, part of
 * #2788).
 *
 * The blocking-PR and conflict-queue stall watchdogs used to answer a stuck PR
 * by filing a `PR #N cannot land: …` issue and labelling the PR `escalated`.
 * Stall self-repair (#2802, #2803) replaced both, so nothing adds either any
 * more — but the ones already filed still sit open in the monitored repos.
 * This per-cycle sweep clears them:
 *
 * - an open PR labelled `escalated` loses the label, so it flows through the
 *   stall-repair ladder like any other PR;
 * - an open `PR #N cannot land: …` issue a **fleet account** authored gets one
 *   comment and is closed. The author check is the shared
 *   `selectFleetAuthoredMatches`: a title is text anyone can choose, so a
 *   human-filed issue with the same title is never touched, and an unresolved
 *   fleet identity closes nothing.
 *
 * Idempotent: a clean repository costs two list reads and no writes. Every
 * `gh` failure is logged with the repository and number and counted — none is
 * swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Logger } from "../types.ts";
import {
  ALERT_DEDUP_TITLE_JSON_FIELDS,
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import {
  acquireMaintenanceRepoLease,
  type RepoLease,
} from "./maintenance_lane.ts";

/** Label the retired escalation put on a stuck PR (Issue #569). */
export const ESCALATED_LABEL = "escalated";

/** Title shape of a retired escalation issue; group 1 is the PR number. */
export const CANNOT_LAND_TITLE = /^PR #(\d+) cannot land: /;

// SIMPLE-ON-PURPOSE: one page per list, fine to 100 leftovers per repo per cycle — upgrade when a repo holds more than the sweep can drain in a few cycles.
const LIST_LIMIT = "100";

/** Seams for {@link sweepEscalatedLeftovers}. */
export interface EscalatedCleanupDeps extends AlertDedupAuthorOptions {
  /** Runs `gh`, returning stdout; throws on failure. */
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
  /** Lease override (tests); defaults to the maintenance-lane lease. */
  acquireLease?: (repo: string) => RepoLease | null;
}

/** What one sweep of one repository did. */
export interface EscalatedCleanupOutcome {
  repo: string;
  /** True when the repository was leased elsewhere and nothing was read. */
  deferred: boolean;
  /** PR numbers the `escalated` label was removed from. */
  labelsRemoved: number[];
  /** Issue numbers commented on and closed. */
  issuesClosed: number[];
  /** `gh` calls that failed, each already logged. */
  failures: number;
}

/** The closing comment for a retired escalation issue about PR `prNumber`. */
export function buildCannotLandClosingComment(prNumber: number): string {
  return [
    "Closing: stuck PRs are no longer escalated as separate issues.",
    "",
    `If #${prNumber} is still open, stall self-repair now handles it — the ` +
    "worker syncs the branch and reruns its lane once, then abandons the PR " +
    "and redoes its originating issue. If it is already merged or closed, " +
    "there is nothing left to do here. (Issue #2805)",
  ].join("\n");
}

/**
 * Sweep one repository: unlabel `escalated` PRs and close fleet-filed
 * `PR #N cannot land:` issues, under the maintenance-lane lease.
 */
export async function sweepEscalatedLeftovers(
  repo: string,
  deps: EscalatedCleanupDeps,
): Promise<EscalatedCleanupOutcome> {
  const outcome: EscalatedCleanupOutcome = {
    repo,
    deferred: false,
    labelsRemoved: [],
    issuesClosed: [],
    failures: 0,
  };
  const acquire = deps.acquireLease ??
    ((r: string) => acquireMaintenanceRepoLease(r));
  const lease = acquire(repo);
  if (lease === null) {
    deps.logger.warn(
      "Escalated cleanup deferred: the repository is leased elsewhere",
      { repo },
    );
    return { ...outcome, deferred: true };
  }
  try {
    await unlabelEscalatedPrs(repo, deps, outcome);
    await closeCannotLandIssues(repo, deps, outcome);
  } finally {
    lease.release();
  }
  return outcome;
}

async function unlabelEscalatedPrs(
  repo: string,
  deps: EscalatedCleanupDeps,
  outcome: EscalatedCleanupOutcome,
): Promise<void> {
  const rows = await listRows(repo, deps, outcome, "escalated PRs", [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    ESCALATED_LABEL,
    "--json",
    "number",
    "--limit",
    LIST_LIMIT,
  ]);
  for (const row of rows) {
    try {
      await deps.ghCommandFn([
        "pr",
        "edit",
        String(row.number),
        "--repo",
        repo,
        "--remove-label",
        ESCALATED_LABEL,
      ]);
      outcome.labelsRemoved.push(row.number);
      deps.logger.info("Escalated cleanup: removed the escalated label", {
        repo,
        pr: row.number,
      });
    } catch (err) {
      fail(deps, outcome, "could not remove the escalated label", {
        repo,
        pr: row.number,
        error: errorMessage(err),
      });
    }
  }
}

async function closeCannotLandIssues(
  repo: string,
  deps: EscalatedCleanupDeps,
  outcome: EscalatedCleanupOutcome,
): Promise<void> {
  const rows = await listRows(repo, deps, outcome, "cannot-land issues", [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    'in:title "cannot land"',
    "--json",
    ALERT_DEDUP_TITLE_JSON_FIELDS,
    "--limit",
    LIST_LIMIT,
  ]);
  const titled = rows.filter((row) =>
    typeof row.title === "string" && CANNOT_LAND_TITLE.test(row.title)
  );
  const fleetFiled = await selectFleetAuthoredMatches(
    titled,
    `escalated cleanup ${repo}`,
    deps,
    (message) => deps.logger.warn(message, { repo }),
    "none is closed — an issue the fleet cannot attribute is never touched",
  );
  for (const row of fleetFiled) {
    const prNumber = Number(CANNOT_LAND_TITLE.exec(row.title ?? "")?.[1]);
    try {
      // One call comments and closes, so a retry never stacks comments on an
      // issue that closed.
      await deps.ghCommandFn([
        "issue",
        "close",
        String(row.number),
        "--repo",
        repo,
        "--comment",
        buildCannotLandClosingComment(prNumber),
      ]);
      outcome.issuesClosed.push(row.number);
      deps.logger.info("Escalated cleanup: closed a cannot-land issue", {
        repo,
        issue: row.number,
        pr: prNumber,
      });
    } catch (err) {
      fail(deps, outcome, "could not close a cannot-land issue", {
        repo,
        issue: row.number,
        error: errorMessage(err),
      });
    }
  }
}

type ListedRow = AlertDedupRow & { title?: string };

/** Run a list call; a failure or malformed payload is logged and counted. */
async function listRows(
  repo: string,
  deps: EscalatedCleanupDeps,
  outcome: EscalatedCleanupOutcome,
  what: string,
  args: string[],
): Promise<ListedRow[]> {
  let raw: string;
  try {
    raw = await deps.ghCommandFn(args);
  } catch (err) {
    fail(deps, outcome, `could not list ${what}`, {
      repo,
      error: errorMessage(err),
    });
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "[]");
  } catch (err) {
    fail(deps, outcome, `unparseable listing of ${what}`, {
      repo,
      error: errorMessage(err),
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    fail(deps, outcome, `listing of ${what} is not an array`, { repo });
    return [];
  }
  return parsed.filter((row): row is ListedRow =>
    typeof row === "object" && row !== null &&
    Number.isInteger((row as ListedRow).number)
  );
}

function fail(
  deps: EscalatedCleanupDeps,
  outcome: EscalatedCleanupOutcome,
  message: string,
  context: Record<string, unknown>,
): void {
  outcome.failures += 1;
  deps.logger.error(`Escalated cleanup: ${message}`, context);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
