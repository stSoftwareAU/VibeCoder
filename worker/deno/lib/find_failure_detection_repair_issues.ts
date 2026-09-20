/**
 * Find planning parents carrying `needs-failure-detection-repair` (Issue #60,
 * part of #54).
 *
 * A partially-repaired planning run leaves its parent labelled
 * `needs-failure-detection-repair` rather than `failed-once` (Issue #59). That
 * state is only better than a failure if something later **finishes** the job,
 * so this finder is the resume pass's discovery step: it lists the open issues
 * in the configured repositories carrying that label.
 *
 * Deliberately thinner than `find_planning_issues.ts`: the resume pass does not
 * claim an issue, so there is no `nice` tiering, cooldown filtering or candidate
 * ordering to apply — every labelled parent is work the worker owes, and the
 * pass processes them in discovery order.
 *
 * Per-repo failures are non-fatal but never silent: the error is logged and the
 * remaining repositories are still scanned, so one unreachable repository cannot
 * hide every other repository's outstanding repairs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GateLogger } from "./failure_detection_gate.ts";
import { RepoLoopQuotaStop } from "./repo_loop_quota_stop.ts";
import { FAILURE_DETECTION_REPAIR_LABEL } from "./config_defaults.ts";

/** An open planning parent carrying the resume label. */
export interface FailureDetectionRepairParent {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** The planning (parent) issue number. */
  number: number;
  /** The parent issue title, for logging and comments. */
  title: string;
}

/** Default cap on issues listed per repository. */
const DEFAULT_LIMIT = 50;

/** "owner/repo" — anything else can never be listed. */
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * List the open issues carrying the resume label across the configured
 * repositories.
 *
 * @param opts.repos - Configured repositories ("owner/repo"); duplicates and
 *   malformed names are skipped.
 * @param opts.ghCommandFn - Injected gh runner, so the whole path is unit-tested
 *   without a network.
 * @param opts.logger - Logger for the non-fatal per-repo warnings.
 * @param opts.label - Label to search for (defaults to the resume label).
 * @param opts.limit - Maximum issues listed per repository.
 * @returns Parents in repository order (empty when none carry the label).
 */
export async function findFailureDetectionRepairParents(opts: {
  repos: readonly string[];
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: GateLogger;
  label?: string;
  limit?: number;
  /**
   * The open-issue listing the scan already holds for a repository — the
   * cached `fetchAllIssues` (Issue #2409).
   *
   * Without it this finder cost one GraphQL call per monitored repository on
   * **every cycle** — 20 calls every ~3 minutes, per host, to learn "none" —
   * while that listing, which carries every label, already held the answer.
   * The fleet was spending its hourly GitHub quota in ~25 minutes and sitting
   * locked out for the rest of the hour.
   *
   * A listing can only prove a label's absence when it is **complete**: one
   * that came back full ({@link listingLimit} rows) may have a labelled issue
   * beyond it, and one that cannot be read proves nothing. Both fall back to
   * the direct label query for that repository, so the change can miss nothing
   * the old path found.
   */
  listOpenIssues?: (repo: string) => Promise<readonly ListedOpenIssue[]>;
  /** Rows at which {@link listOpenIssues} is treated as truncated. */
  listingLimit?: number;
}): Promise<FailureDetectionRepairParent[]> {
  const label = opts.label ?? FAILURE_DETECTION_REPAIR_LABEL;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const parents: FailureDetectionRepairParent[] = [];
  const repos = new Set(opts.repos);
  // Issue #1515: one quota exhaustion is one line, not one per repository.
  const quota = new RepoLoopQuotaStop(
    "Failure-Detection resume",
    repos.size,
    (message) => opts.logger.warn(message),
  );

  for (const repo of repos) {
    if (quota.latchedBeforeRepo()) break;
    if (!REPO_RE.test(repo)) {
      opts.logger.warn(
        "Failure-Detection resume: skipping malformed repository name (Issue #60)",
        { repo },
      );
      quota.repoDone();
      continue;
    }

    const listed = await labelledFromListing(repo, label, opts);
    if (listed !== null) {
      parents.push(...listed);
      quota.repoDone();
      continue;
    }

    let raw: string;
    try {
      raw = await opts.ghCommandFn([
        "issue",
        "list",
        "--repo",
        repo,
        "--label",
        label,
        "--state",
        "open",
        "--limit",
        String(limit),
        "--json",
        "number,title",
      ]);
    } catch (err) {
      // The quota is one condition for every repository, said once.
      if (quota.isQuotaFailure(err)) break;
      // Loud but non-fatal: this repository's outstanding repairs are invisible
      // this cycle, and the remaining repositories are still scanned.
      opts.logger.warn(
        "Failure-Detection resume: could not list labelled parents for this repository (Issue #60)",
        { repo, error: err instanceof Error ? err.message : String(err) },
      );
      quota.repoDone();
      continue;
    }

    parents.push(...parseRepairParents(repo, raw, opts.logger));
    quota.repoDone();
  }

  return parents;
}

/** One row of the scan's open-issue listing, as far as this finder reads it. */
export interface ListedOpenIssue {
  number: number;
  title: string;
  labels: readonly string[];
}

/** The scan lists up to this many open issues per repository. */
const DEFAULT_LISTING_LIMIT = 200;

/**
 * The labelled parents, read from the scan's own listing — or `null` when that
 * listing cannot answer (none supplied, unreadable, or truncated) and the
 * caller must ask GitHub directly.
 */
async function labelledFromListing(
  repo: string,
  label: string,
  opts: {
    logger: GateLogger;
    listOpenIssues?: (repo: string) => Promise<readonly ListedOpenIssue[]>;
    listingLimit?: number;
  },
): Promise<FailureDetectionRepairParent[] | null> {
  if (!opts.listOpenIssues) return null;
  let issues: readonly ListedOpenIssue[];
  try {
    issues = await opts.listOpenIssues(repo);
  } catch (err) {
    opts.logger.warn(
      "Failure-Detection resume: the scan's issue listing could not be read — asking GitHub directly (Issue #2409)",
      { repo, error: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
  if (issues.length >= (opts.listingLimit ?? DEFAULT_LISTING_LIMIT)) {
    // Full listing: a labelled issue may sit beyond it. Absence is unproven.
    return null;
  }
  return issues
    .filter((issue) => issue.labels.includes(label))
    .map((issue) => ({ repo, number: issue.number, title: issue.title }));
}

/**
 * Parse one repository's `gh issue list --json number,title` response.
 *
 * Exported for direct unit testing. A malformed body yields no parents and a
 * warning — never a thrown error, and never a fabricated issue number.
 */
export function parseRepairParents(
  repo: string,
  raw: string,
  logger: GateLogger,
): FailureDetectionRepairParent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn(
      "Failure-Detection resume: unparseable issue list for this repository (Issue #60)",
      { repo },
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warn(
      "Failure-Detection resume: unexpected issue-list shape for this repository (Issue #60)",
      { repo },
    );
    return [];
  }

  const parents: FailureDetectionRepairParent[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const number = record.number;
    if (
      typeof number !== "number" || !Number.isInteger(number) || number <= 0
    ) {
      continue;
    }
    parents.push({
      repo,
      number,
      title: typeof record.title === "string" ? record.title : "",
    });
  }
  return parents;
}
