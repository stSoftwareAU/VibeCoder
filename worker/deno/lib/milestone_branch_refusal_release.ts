/**
 * Release the failure labels a repo-level milestone-branch refusal left
 * behind (Issue #2220).
 *
 * Issue #853 stopped the *escalation* repeating and #2067 / #2079 fixed the
 * ruleset, but nothing ever released the issues the refusal had already
 * labelled. On GRQ-FX-validation the ruleset was repaired at 2026-09-15
 * 11:52 UTC with sixteen sub-issues still carrying `failed-once` — eight of
 * them `failed` — for a fault that no longer existed. A human stripped every
 * one by hand.
 *
 * A refusal that clears itself must clear its own record: the run that
 * successfully opens the milestone branch is the first witness that the
 * repository is fixed, so it sweeps the milestone's issues and removes the
 * labels whose most recent failure record was that refusal. Any other
 * failure record is left exactly as it is — a genuine `failed` issue is not
 * released by a branch being created.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import { detectFailureCategory } from "./failure_diagnosis.ts";
import { DEFAULT_LABEL_CONFIG } from "./label_types.ts";

/** Function signature for running gh CLI commands. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** The two failure labels this sweep is allowed to remove. */
export interface RefusalReleaseLabels {
  failedLabel: string;
  failedOnceLabel: string;
}

/** Everything {@link releaseMilestoneBranchRefusalLabels} needs. */
export interface RefusalReleaseOptions {
  /** `owner/repo` of the repository whose milestone branch now exists. */
  repo: string;
  /** Milestone title, used to scope the issue list. */
  milestoneTitle: string;
  /** The milestone branch that was just created or fetched. */
  milestoneBranch: string;
  /** Failure labels to release. Defaults to the canonical names. */
  labels?: RefusalReleaseLabels;
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
export interface RefusalReleaseOutcome {
  /** Issues whose failure labels were removed, ascending. */
  released: number[];
  /** Issues inspected and deliberately left labelled, ascending. */
  retained: number[];
  /** True when this run had already swept this branch — nothing was done. */
  alreadySwept: boolean;
  /**
   * Non-fatal faults, never swallowed: the caller logs them so a sweep that
   * only half-ran is visible rather than reported as a clean pass.
   */
  errors: string[];
}

/**
 * Headings the worker writes on a failure record. The newest comment
 * matching one of these is the issue's most recent failure record, and it
 * alone decides whether the labels are released.
 */
const FAILURE_RECORD_RE =
  /^##\s+(?:Automated Processing (?:Failed|Paused)|Milestone branch unavailable)/m;

/**
 * Branches already swept in this process, keyed `repo branch`.
 *
 * Process-lifetime only, like the Issue #853 rejection registry: one sweep
 * per run releases the whole backlog, and a fresh run should sweep again
 * (a sibling host may have failed issues in between).
 */
const swept = new Set<string>();

const key = (repo: string, branch: string): string => `${repo} ${branch}`;

/**
 * Record a sweep and report whether this run has already done one.
 *
 * @returns `true` on the first sweep of this branch in this process.
 */
export function claimMilestoneBranchRefusalSweep(
  repo: string,
  branch: string,
): boolean {
  const k = key(repo, branch);
  if (swept.has(k)) return false;
  swept.add(k);
  return true;
}

/** Reset the registry. Tests only — production state is per process. */
export function resetMilestoneBranchRefusalSweepsForTest(): void {
  swept.clear();
}

/** One labelled issue as read from `gh issue list`. */
interface LabelledIssue {
  number: number;
  labels: Set<string>;
}

/** Parse `gh issue list --json number,labels` output, or throw. */
function parseLabelledIssues(raw: string): LabelledIssue[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("expected an array of issues");
  }
  const out: LabelledIssue[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { number?: unknown; labels?: unknown };
    if (typeof record.number !== "number") continue;
    const labels = new Set<string>();
    if (Array.isArray(record.labels)) {
      for (const label of record.labels) {
        const name = (label as { name?: unknown })?.name;
        if (typeof name === "string") labels.add(name);
      }
    }
    out.push({ number: record.number, labels });
  }
  return out;
}

/** One comment as read from `gh issue view --json comments`. */
interface CommentRow {
  /** Login of whoever wrote it — the only authenticated part of a comment. */
  author?: string | null;
  body: string;
}

/**
 * Parse `gh issue view --json comments` output, oldest first, or throw.
 *
 * `author` is rendered as `{ login }` by `gh` and as a bare login by the
 * worker's own `GitHubComment`, so both shapes are accepted — the same
 * normalisation `idle_task_freshness.ts` does at its own comment read.
 */
function parseCommentRows(raw: string): CommentRow[] {
  const parsed = JSON.parse(raw) as { comments?: unknown };
  if (!Array.isArray(parsed?.comments)) {
    throw new Error("expected a 'comments' array");
  }
  const rows: CommentRow[] = [];
  for (const entry of parsed.comments) {
    const record = entry as { body?: unknown; author?: unknown };
    if (typeof record?.body !== "string") continue;
    const author = record.author;
    const login = typeof author === "string"
      ? author
      : typeof (author as { login?: unknown })?.login === "string"
      ? (author as { login: string }).login
      : null;
    rows.push({ author: login, body: record.body });
  }
  return rows;
}

/**
 * Whether the issue's most recent failure record is the repo-level
 * milestone-branch refusal.
 *
 * Reads newest-first and stops at the first failure record: an issue that
 * failed the refusal and then failed its quality gate keeps its labels,
 * because the newer record is a genuine fault of its own.
 *
 * The record is judged by `detectFailureCategory`, not by a bare refusal
 * pattern, so the whole precedence order applies here exactly as it does at
 * failure time. A quality-gate record that happens to quote the milestone
 * branch and the words "required status checks" is `quality_check` there and
 * `quality_check` here, so its label survives — matching the refusal pattern
 * against the comment body alone would have released it.
 */
export function refusalIsMostRecentFailure(
  commentBodies: readonly string[],
): boolean {
  for (let i = commentBodies.length - 1; i >= 0; i--) {
    const body = commentBodies[i];
    if (body === undefined || !FAILURE_RECORD_RE.test(body)) continue;
    return detectFailureCategory(body) === "repo_config";
  }
  return false;
}

/**
 * Build the comment posted on an issue whose labels were released.
 * Exported so tests assert the wording without driving gh.
 */
export function buildRefusalReleaseComment(
  milestoneBranch: string,
  removed: readonly string[],
): string {
  const list = removed.map((l) => `\`${l}\``).join(", ");
  return `## Milestone branch restored — failure labels released\n\n` +
    `\`${milestoneBranch}\` now exists on the remote. This issue's most ` +
    `recent failure record was the repository refusing to create that ` +
    `branch — a repository configuration fault shared by every issue in the ` +
    `milestone, not a property of this issue — so ${list} ` +
    `${removed.length === 1 ? "has" : "have"} been removed and the issue is ` +
    `claimable again (Issue #2220).`;
}

/**
 * Sweep a milestone's issues and release the failure labels a repo-level
 * branch refusal applied.
 *
 * Called by the setup phase once the milestone branch has been successfully
 * ensured. Best-effort by design — the branch exists and the run must
 * proceed — but never silent: every fault is returned in
 * {@link RefusalReleaseOutcome.errors} for the caller to log.
 */
export async function releaseMilestoneBranchRefusalLabels(
  options: RefusalReleaseOptions,
): Promise<RefusalReleaseOutcome> {
  const {
    repo,
    milestoneTitle,
    milestoneBranch,
    ghCommandFn,
    limit = 100,
  } = options;
  const log = options.log ?? ((message: string) => console.warn(message));
  const labels = options.labels ?? {
    failedLabel: DEFAULT_LABEL_CONFIG.failedLabel,
    failedOnceLabel: DEFAULT_LABEL_CONFIG.failedOnceLabel,
  };
  const outcome: RefusalReleaseOutcome = {
    released: [],
    retained: [],
    alreadySwept: false,
    errors: [],
  };

  if (!claimMilestoneBranchRefusalSweep(repo, milestoneBranch)) {
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
        "--milestone",
        milestoneTitle,
        "--label",
        label,
        "--json",
        "number,labels",
        "--limit",
        String(limit),
      ]);
    } catch (err) {
      outcome.errors.push(
        `listing '${label}' issues on milestone '${milestoneTitle}': ${
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
      // Only the comment AUTHOR is authenticated: a failure record is
      // plain Markdown anyone who can comment on the repository may write,
      // and here a forged one REMOVES a `failed` label and puts the issue
      // back in the queue. Filter every comment through the fleet identity
      // before it is read as a record (the `alert_dedup_authors.ts`
      // chokepoint). Fail direction: an unresolvable fleet set discards
      // every comment, so no record is found and the label is kept.
      const rows = await selectFleetAuthoredComments(
        parseCommentRows(raw),
        `milestone-branch refusal release ${repo}#${issueNumber}`,
        options.authorOptions ?? {},
        log,
        "no failure record is recognised and the issue keeps its labels",
      );
      bodies = rows.map((row) => row.body);
    } catch (err) {
      outcome.errors.push(
        `reading comments on #${issueNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    if (!refusalIsMostRecentFailure(bodies)) {
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
        buildRefusalReleaseComment(milestoneBranch, removable),
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
  // run's one attempt — release the claim and let a later milestone setup in
  // the same process try again. A clean sweep keeps the claim.
  if (outcome.errors.length > 0) {
    swept.delete(key(repo, milestoneBranch));
  }

  return outcome;
}
