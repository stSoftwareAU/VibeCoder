/**
 * Release the failure labels a worker-host fault left behind (Issue #2890).
 *
 * A failure whose cause lives on the worker host itself — a corrupt shared
 * clone, a full disk, a container image that could not be built — is not a
 * fault of the issue it happened to be attempted on. `lib/host_fault.ts`
 * classifies such a failure and appends a machine-readable marker to the
 * comment, but nothing released the label once the host was repaired: a
 * human had to notice the failure record named the host, not the issue, and
 * strip the label by hand.
 *
 * Modelled closely on `lib/milestone_branch_refusal_release.ts` (Issue
 * #2220): the run that successfully creates a feature branch off a fresh
 * clone is the first witness that the host is healthy again, so it sweeps
 * every `failed-once`/`failed` issue in the repository and releases the ones
 * whose failure records are entirely host faults.
 */

import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import {
  describeHostFault,
  detectHostFault,
  type HostFaultKind,
  parseHostFaultMarker,
} from "./host_fault.ts";
import { parseCommentRows, parseLabelledIssues } from "./issue_sweep_parse.ts";
import { DEFAULT_LABEL_CONFIG } from "./label_types.ts";

/** Function signature for running gh CLI commands. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** The two failure labels this sweep is allowed to remove. */
export interface HostFaultReleaseLabels {
  failedLabel: string;
  failedOnceLabel: string;
}

/** Everything {@link releaseHostFaultFailureLabels} needs. */
export interface HostFaultReleaseOptions {
  /** `owner/repo` of the repository a clone on this host just succeeded on. */
  repo: string;
  /** Failure labels to release. Defaults to the canonical names. */
  labels?: HostFaultReleaseLabels;
  /** gh CLI runner. */
  ghCommandFn: GhCommandFn;
  /** Cap on issues fetched per label. Defaults to 100. */
  limit?: number;
  /**
   * Fleet identity inputs for the failure-record author check. Omitted
   * means "read the configured fleet identity", which is what every
   * production caller does.
   */
  authorOptions?: AlertDedupAuthorOptions;
  /** Sink for the author-check warnings. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/** What one sweep did. */
export interface HostFaultReleaseOutcome {
  /** Issues whose failure labels were removed, ascending. */
  released: number[];
  /** Issues inspected and deliberately left labelled, ascending. */
  retained: number[];
  /** True when this run had already swept this repo — nothing was done. */
  alreadySwept: boolean;
  /**
   * Non-fatal faults, never swallowed: the caller logs them so a sweep that
   * only half-ran is visible rather than reported as a clean pass.
   */
  errors: string[];
}

/**
 * Repos already swept in this process.
 *
 * Process-lifetime only, like the Issue #2220 sweep registry: one sweep per
 * run releases the whole backlog, and a fresh run should sweep again (a
 * sibling host may have failed issues in between).
 */
const swept = new Set<string>();

/**
 * Record a sweep and report whether this run has already done one.
 *
 * @returns `true` on the first sweep of this repo in this process.
 */
export function claimHostFaultReleaseSweep(repo: string): boolean {
  if (swept.has(repo)) return false;
  swept.add(repo);
  return true;
}

/** Reset the registry. Tests only — production state is per process. */
export function resetHostFaultReleaseSweepsForTest(): void {
  swept.clear();
}

/** Whether a comment body is a failure record: it starts with the heading. */
function isFailureRecord(body: string): boolean {
  return body.trimStart().startsWith("## Automated Processing Failed");
}

/**
 * Classify one failure record's body as a host fault, or `null`.
 *
 * The marker the worker itself appends as the trimmed final line of the
 * comment is authoritative. A body with no marker predates this change
 * (Issue #2890); the only pre-change failure this sweep is allowed to treat
 * as a host fault is `clone-corrupt` — a corrupt shared object store or a
 * broken ref, both unambiguous and narrow (`detectHostFault`).
 */
function classifyFailureRecord(body: string): HostFaultKind | null {
  const marked = parseHostFaultMarker(body);
  if (marked !== null) return marked;
  return detectHostFault(body) === "clone-corrupt" ? "clone-corrupt" : null;
}

/**
 * Build the comment posted on an issue whose labels were released.
 * Exported so tests assert the wording without driving gh.
 */
export function buildHostFaultReleaseComment(
  kinds: readonly HostFaultKind[],
): string {
  const list = kinds
    .map((kind) => `\`${kind}\` — ${describeHostFault(kind)}`)
    .join("; ");
  return `## Host fault cleared — failure label released\n\n` +
    `This issue's failure record${
      kinds.length === 1 ? " was" : "s were"
    } caused by ${list}, a fault of the worker host, not of this issue. ` +
    `The host is healthy again — a clone of this repository just ` +
    `succeeded — so the label has been removed and the issue is back in ` +
    `the queue (Issue #2890).`;
}

/**
 * Sweep a repository's issues and release the failure labels a worker-host
 * fault applied.
 *
 * Called by the setup phase once a feature branch has been successfully
 * created from a fresh clone on this host. Best-effort by design — the
 * branch exists and the run must proceed — but never silent: every fault is
 * returned in {@link HostFaultReleaseOutcome.errors} for the caller to log.
 */
export async function releaseHostFaultFailureLabels(
  options: HostFaultReleaseOptions,
): Promise<HostFaultReleaseOutcome> {
  const { repo, ghCommandFn, limit = 100 } = options;
  const log = options.log ?? ((message: string) => console.warn(message));
  const labels = options.labels ?? {
    failedLabel: DEFAULT_LABEL_CONFIG.failedLabel,
    failedOnceLabel: DEFAULT_LABEL_CONFIG.failedOnceLabel,
  };
  const outcome: HostFaultReleaseOutcome = {
    released: [],
    retained: [],
    alreadySwept: false,
    errors: [],
  };

  if (!claimHostFaultReleaseSweep(repo)) {
    outcome.alreadySwept = true;
    return outcome;
  }

  // One list call per label — `gh issue list` ANDs repeated `--label` flags,
  // so a single call would only find issues carrying both.
  const candidates = new Map<number, Set<string>>();
  for (const label of [labels.failedOnceLabel, labels.failedLabel]) {
    let raw: string;
    try {
      raw = await ghCommandFn([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--label",
        label,
        "--json",
        "number,labels",
        "--limit",
        String(limit),
      ]);
    } catch (err) {
      outcome.errors.push(
        `listing '${label}' issues on ${repo}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    try {
      for (const issue of parseLabelledIssues(raw)) {
        const existing = candidates.get(issue.number);
        if (existing) {
          for (const name of issue.labels) existing.add(name);
        } else {
          candidates.set(issue.number, issue.labels);
        }
      }
    } catch (err) {
      outcome.errors.push(
        `parsing the '${label}' issue list: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  for (const issueNumber of [...candidates.keys()].sort((a, b) => a - b)) {
    const present = candidates.get(issueNumber) ?? new Set<string>();
    let bodies: string[];
    try {
      const raw = await ghCommandFn([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        repo,
        "--json",
        "comments",
      ]);
      // Only the comment AUTHOR is authenticated: a failure record is plain
      // Markdown anyone who can comment on the repository may write, and
      // here a forged one REMOVES a `failed` label and puts the issue back
      // in the queue. Filter every comment through the fleet identity before
      // it is read as a record (the `alert_dedup_authors.ts` chokepoint).
      // Fail direction: an unresolvable fleet set discards every comment, so
      // no record is found and the label is kept.
      const rows = await selectFleetAuthoredComments(
        parseCommentRows(raw),
        `host-fault release ${repo}#${issueNumber}`,
        options.authorOptions ?? {},
        log,
        "no failure record is recognised and the issue keeps its labels",
      );
      bodies = rows.map((row) => row.body).filter(isFailureRecord);
    } catch (err) {
      outcome.errors.push(
        `reading comments on #${issueNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    if (bodies.length === 0) {
      outcome.retained.push(issueNumber);
      continue;
    }

    const kinds: HostFaultKind[] = [];
    let allHostFaults = true;
    for (const body of bodies) {
      const kind = classifyFailureRecord(body);
      if (kind === null) {
        allHostFaults = false;
        break;
      }
      if (!kinds.includes(kind)) kinds.push(kind);
    }

    if (!allHostFaults) {
      outcome.retained.push(issueNumber);
      continue;
    }

    const removable = [labels.failedOnceLabel, labels.failedLabel]
      .filter((l) => present.has(l));
    if (removable.length === 0) {
      outcome.retained.push(issueNumber);
      continue;
    }

    const args = ["issue", "edit", String(issueNumber), "--repo", repo];
    for (const label of removable) args.push("--remove-label", label);
    try {
      await ghCommandFn(args);
    } catch (err) {
      outcome.errors.push(
        `removing ${removable.join(", ")} from #${issueNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    outcome.released.push(issueNumber);

    try {
      await ghCommandFn([
        "issue",
        "comment",
        String(issueNumber),
        "--repo",
        repo,
        "--body",
        buildHostFaultReleaseComment(kinds),
      ]);
    } catch (err) {
      // The label removal is the substantive outcome and it succeeded, so
      // the issue is released either way — but say the comment failed.
      outcome.errors.push(
        `commenting the release on #${issueNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // A sweep that hit a gh fault did not finish, so it must not count as this
  // run's one attempt — release the claim and let a later run in the same
  // process try again. A clean sweep keeps the claim.
  if (outcome.errors.length > 0) {
    swept.delete(repo);
  }

  return outcome;
}
