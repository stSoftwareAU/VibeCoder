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
}): Promise<FailureDetectionRepairParent[]> {
  const label = opts.label ?? FAILURE_DETECTION_REPAIR_LABEL;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const parents: FailureDetectionRepairParent[] = [];

  for (const repo of new Set(opts.repos)) {
    if (!REPO_RE.test(repo)) {
      opts.logger.warn(
        "Failure-Detection resume: skipping malformed repository name (Issue #60)",
        { repo },
      );
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
      // Loud but non-fatal: this repository's outstanding repairs are invisible
      // this cycle, and the remaining repositories are still scanned.
      opts.logger.warn(
        "Failure-Detection resume: could not list labelled parents for this repository (Issue #60)",
        { repo, error: err instanceof Error ? err.message : String(err) },
      );
      continue;
    }

    parents.push(...parseRepairParents(repo, raw, opts.logger));
  }

  return parents;
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
