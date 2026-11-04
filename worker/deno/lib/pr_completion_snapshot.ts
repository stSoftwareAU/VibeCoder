/**
 * Producer of the PR completion evidence snapshot (Issue #4658).
 *
 * `collectPrCompletionSnapshot` gathers the input that
 * `buildPrCompletionReport` consumes: PR observations and their GitHub
 * events, audit actions verified against their hash chains, CI durations,
 * blockers, regressions, deployment heartbeats and the rollout check. Every
 * GitHub call is a GET through the injected {@link GhJson} seam, so tests
 * never reach the network. Nothing here writes to GitHub or to host
 * configuration.
 *
 * A GitHub event is never attributed to a human or to the fleet from a login:
 * it becomes a `TrustedPrAction` with actor `unknown` unless a verified fleet
 * action of the same kind sits within {@link MATCH_WINDOW_MS} of it. Those
 * actions are audit actions, plus, as a lower-trust source, the review-fleet-prs
 * skill's own review log (`reviewLogs`), which is not hash-chained.
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

import type { AuditEntry } from "./audit_entry.ts";
import { readPrDiscoveryEvents } from "./pr_discovery_events.ts";
import {
  isAuditJournalName,
  loadEntries,
  verifyAllChains,
} from "./audit_journal.ts";
import {
  type AssignmentEvent,
  readLifecycleLedger,
} from "./lifecycle_ledger.ts";
import { runGhCommand } from "./github.ts";
import { REVIEW_RUN_FILE } from "./review_run_record.ts";
import {
  PR_REPO_PATTERN,
  type PrActionKind,
  prActionsFromAuditJournal,
  type PrCompletionInput,
  type PrCompletionRecord,
  type PrState,
  timestamp as utcMillis,
  type TrustedPrAction,
} from "./pr_completion_report.ts";
import { type LogRecord, type Outcome, parseLog } from "./fleet_review_log.ts";

/** Read-only GitHub GET seam: resolves the parsed JSON body of `gh api <path>`. */
export type GhJson = (path: string) => Promise<unknown>;

/** Production seam: `gh api <path>` (a GET), parsed as JSON. */
export const ghApiJson: GhJson = async (path) =>
  JSON.parse(await runGhCommand(["api", path]));

/** Inputs to {@link collectPrCompletionSnapshot}. */
export interface CollectOptions {
  /** Repositories in `owner/name` form. */
  repos: string[];
  /** The dated window and the instant the evidence is observed at (UTC Z). */
  cohort: { start: string; end: string; observedAt: string };
  /** Audit base directories: local or exported journals, one per host. */
  auditDirs: string[];
  /** Directories holding `<round>/review-run.json` records. */
  reviewRunDirs?: string[];
  /**
   * The review-fleet-prs skill's own `log.jsonl` files, one per host. A lower
   * trust source than the audit journals: not hash-chained (see
   * docs/INTERNALS.md). Absent or empty means none is read.
   */
  reviewLogs?: string[];
  /** Per-host lifecycle ledger files. */
  lifecycleLedgers?: string[];
  /** Babysitter state directories holding `deployment-health.json`. */
  babysitterStateDirs?: string[];
  /** The deployment the fleet is expected to run. */
  expected: PrCompletionInput["expectedDeployment"];
  /** When set, the rollout check runs against this verification instant. */
  rolloutVerifiedAt?: string;
  /** Cap on PRs kept per repository in the cohort (default 500). */
  maxPrsPerRepo?: number;
  /** GitHub read seam. */
  gh: GhJson;
}

/** The collected snapshot, its coverage notes and any truncated repositories. */
export interface CollectedSnapshot {
  input: PrCompletionInput;
  coverageNotes: string[];
  truncatedRepos: string[];
}

type Json = Record<string, unknown>;
type DeploymentRow = PrCompletionInput["deployments"][number];
type CiRun = PrCompletionInput["ciRuns"][number];
type Blocker = PrCompletionInput["blockers"][number];
type Regression = PrCompletionInput["regressions"][number];

/** Run identity for actions observed on GitHub rather than journalled. */
const GITHUB_OBSERVATION_RUN = "github-observation";
/** Run identity for review-log records; they are not journalled runs. */
const REVIEW_LOG_RUN = "review-log";
/** Outcomes of a review the skill posted: every one is a posted GitHub review. */
const POSTED_OUTCOMES: ReadonlySet<string> = new Set<Outcome>([
  "approved",
  "changes_requested",
  "held",
]);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** A GitHub event matches a verified fleet action within this window. */
const MATCH_WINDOW_MS = 10 * MINUTE_MS;
/**
 * Slack either side of a PR's lifetime: a push or merge action within it may
 * belong to the PR.
 */
const LIFETIME_SLACK_MS = 10 * MINUTE_MS;
const STRANDED_AGE_MS = DAY_MS;
const PER_PAGE = 100;
/** Pages read for reviews, issue events and commits of one PR. */
const EVENT_PAGE_LIMIT = 10;
const DEFAULT_MAX_PRS_PER_REPO = 500;
const COMPONENT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
/**
 * Free text is sliced before any pattern runs over it: a title to 1,000
 * characters, a body to {@link TEXT_BOUND}. The patterns below have no nested
 * quantifiers and no overlapping alternatives, so each runs in linear time over
 * its slice.
 */
const TEXT_BOUND = 20_000;
const TITLE_BOUND = 1_000;
/** A title that opens `Revert "…"`, with the quoted text at most 300 characters. */
const REVERT_TITLE = /^Revert "[^"\n]{1,300}"/;
/** `Revert #N` or `Reverts #N` in a title or body. */
const REVERT_REFERENCE = /\bReverts?\s+#(\d{1,7})\b/gi;
/** A parenthesised PR number, as a squash merge title ends with `(#N)`. */
const QUOTED_PR_REFERENCE = /\(#(\d{1,7})\)/g;
/** Shown once per collection: the CI scope limit, for the coverage notes. */
const CI_SCOPE_NOTE =
  "CI history is read from observed PR heads and commit heads; truncated API history is called out per PR";

/** A PR observed in the cohort, with the text the regressions and rollups read. */
interface ObservedPr {
  record: PrCompletionRecord;
  title: string;
  body: string;
  mergeCommitSha: string | null;
}

interface Stamped {
  at: string;
  ms: number;
}

interface Review extends Stamped {
  id: string;
  state: string;
  headSha?: string;
}

interface IssueEvent extends Stamped {
  id: string;
  event: string;
  label: string | null;
}

interface Commit extends Stamped {
  sha: string;
}

interface PrEvidence {
  reviews: Review[];
  issueEvents: IssueEvent[];
  commits: Commit[];
}

/** A GitHub-observed event that a fleet action may or may not account for. */
interface GitHubEvent extends Stamped {
  kind: PrActionKind;
  id: string;
  headSha?: string;
}

function keyOf(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function asObject(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return value as Json;
}

function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a JSON list`);
  return value;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The value of a key GitHub always sends. An omitted key is a malformed
 * response and throws; it is never read as the key's empty state.
 */
function requiredKey(raw: Json, key: string, what: string): unknown {
  if (!Object.hasOwn(raw, key)) throw new Error(`${what} is missing ${key}`);
  return raw[key];
}

function asId(value: unknown, what: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${what} has no id`);
}

function stamped(value: unknown, what: string): Stamped {
  const at = asText(value);
  if (at === null) throw new Error(`${what} is missing`);
  return { at, ms: utcMillis(at, what) };
}

function byTime<T extends Stamped>(a: T, b: T): number {
  return a.ms - b.ms;
}

/**
 * Read every page of a GitHub list. Pages are read until one is short; the
 * result is marked truncated when the page limit is reached first.
 */
async function listAll(
  gh: GhJson,
  base: string,
  pageLimit: number,
): Promise<{ items: unknown[]; truncated: boolean }> {
  const items: unknown[] = [];
  const joiner = base.includes("?") ? "&" : "?";
  for (let page = 1; page <= pageLimit; page++) {
    const batch = asList(
      await gh(`${base}${joiner}per_page=${PER_PAGE}&page=${page}`),
      base,
    );
    items.push(...batch);
    if (batch.length < PER_PAGE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

/**
 * Derive each milestone PR's `rollupRoot` from refs alone, never from text. A
 * milestone PR (base `milestone/…`) is rolled up by the single cohort PR whose
 * head is that base branch and whose base is the repository's default branch.
 * Zero such PRs, or more than one, leave the root unset; a PR is never its own
 * root.
 */
function deriveRollupRoots(observed: ObservedPr[]): void {
  const records = observed.map((o) => o.record);
  for (const milestone of records) {
    if (!milestone.baseRef.startsWith("milestone/")) continue;
    const roots = records.filter((candidate) =>
      candidate.number !== milestone.number &&
      candidate.repo === milestone.repo &&
      candidate.headRef === milestone.baseRef &&
      candidate.baseRef === candidate.defaultBranch
    );
    if (roots.length === 1) {
      milestone.rollupRoot = keyOf(milestone.repo, roots[0]!.number);
    }
  }
}

function observedPr(
  raw: Json,
  repo: string,
  defaultBranch: string,
  observedAt: string,
): ObservedPr {
  const number = raw.number;
  if (
    typeof number !== "number" || !Number.isSafeInteger(number) || number < 1
  ) {
    throw new Error(`${repo} pull request number is invalid`);
  }
  const label = keyOf(repo, number);
  const createdAt = asText(raw.created_at);
  if (createdAt === null) throw new Error(`${label} is missing created_at`);
  const base = asObject(raw.base, `${label}.base`);
  const head = asObject(raw.head, `${label}.head`);
  const baseRef = asText(base.ref);
  const headRef = asText(head.ref);
  const headSha = asText(head.sha);
  if (baseRef === null || headRef === null || headSha === null) {
    throw new Error(`${label} is missing its refs or head sha`);
  }
  // Each key below is always present in the REST list. Only its explicit empty
  // value (null, or [] for labels) means "none"; an omitted key is malformed.
  const rawState = requiredKey(raw, "state", label);
  const mergedAt = asText(requiredKey(raw, "merged_at", label));
  const closedAt = asText(requiredKey(raw, "closed_at", label));
  const rawLabels = asList(
    requiredKey(raw, "labels", label),
    `${label}.labels`,
  );
  const rawBody = requiredKey(raw, "body", label);
  const state: PrState = mergedAt !== null
    ? "merged"
    : rawState === "open"
    ? "open"
    : "closed";
  const labels = rawLabels.map((item) =>
    asText(asObject(item, `${label}.label`).name)
  );
  return {
    record: {
      repo,
      number,
      createdAt,
      baseRef,
      defaultBranch,
      headRef,
      headSha,
      state,
      mergedAt,
      closedAt,
      observedAt,
      milestone: baseRef.startsWith("milestone/"),
      ownerGated: labels.includes("needs-human"),
      ownerGateVerified: false,
      actionsComplete: false,
    },
    title: asText(raw.title) ?? "",
    body: typeof rawBody === "string" ? rawBody : "",
    mergeCommitSha: asText(raw.merge_commit_sha),
  };
}

/**
 * Observe one repository's cohort PRs. Pages stop at the first page whose
 * last PR predates the cohort, at a short page, or at the page bound; a bound
 * reached while the cohort may continue marks the repository truncated.
 */
async function observeRepo(
  gh: GhJson,
  repo: string,
  cohort: CollectOptions["cohort"],
  maxPrs: number,
  truncatedRepos: string[],
): Promise<{ observed: ObservedPr[]; openBeforeCohort: number }> {
  const repoInfo = asObject(await gh(`repos/${repo}`), `repos/${repo}`);
  const defaultBranch = asText(repoInfo.default_branch);
  if (defaultBranch === null) {
    throw new Error(`repos/${repo} has no default_branch`);
  }
  const startMs = utcMillis(cohort.start, "cohort.start");
  const endMs = utcMillis(cohort.end, "cohort.end");
  const pageBound = Math.ceil(maxPrs / PER_PAGE);
  const kept: Json[] = [];
  let truncated = false;
  for (let page = 1;; page++) {
    const batch = asList(
      await gh(
        `repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=${PER_PAGE}&page=${page}`,
      ),
      `repos/${repo}/pulls`,
    ).map((item) => asObject(item, `${repo} pull request`));
    if (batch.length === 0) break;
    for (const pr of batch) {
      const createdMs = utcMillis(
        asText(pr.created_at) ?? "",
        `${repo} pull request created_at`,
      );
      if (createdMs >= startMs && createdMs < endMs) kept.push(pr);
    }
    const oldest = utcMillis(
      asText(batch[batch.length - 1]!.created_at) ?? "",
      `${repo} pull request created_at`,
    );
    if (oldest < startMs || batch.length < PER_PAGE) break;
    if (page >= pageBound) {
      truncated = true;
      break;
    }
  }
  if (kept.length > maxPrs) {
    kept.length = maxPrs;
    truncated = true;
  }
  if (truncated) truncatedRepos.push(repo);
  const observed = kept.map((pr) =>
    observedPr(pr, repo, defaultBranch, cohort.observedAt)
  );
  deriveRollupRoots(observed);
  const openBeforeCohort = await countOpenBeforeCohort(
    gh,
    repo,
    startMs,
    pageBound,
    truncatedRepos,
  );
  return { observed, openBeforeCohort };
}

/**
 * Count the PRs still open that were created before the cohort began. They
 * are outside the creation-dated cohort, but a stalled PR must not vanish
 * from the report as it ages out of the window, so they are published as a
 * coverage count. PRs are read oldest first and the scan ends at the first PR
 * inside the cohort. It is bounded like the cohort scan; reaching the bound
 * on a full page of older PRs marks the repository truncated.
 */
async function countOpenBeforeCohort(
  gh: GhJson,
  repo: string,
  startMs: number,
  pageBound: number,
  truncatedRepos: string[],
): Promise<number> {
  let count = 0;
  for (let page = 1;; page++) {
    const batch = asList(
      await gh(
        `repos/${repo}/pulls?state=open&sort=created&direction=asc&per_page=${PER_PAGE}&page=${page}`,
      ),
      `repos/${repo}/pulls`,
    ).map((item) => asObject(item, `${repo} open pull request`));
    for (const pr of batch) {
      const createdMs = utcMillis(
        asText(pr.created_at) ?? "",
        `${repo} pull request created_at`,
      );
      // Oldest first: the first PR inside the cohort ends the scan.
      if (createdMs >= startMs) return count;
      if (asText(pr.state) === "open") count++;
    }
    if (batch.length < PER_PAGE) break;
    if (page >= pageBound) {
      if (!truncatedRepos.includes(repo)) truncatedRepos.push(repo);
      break;
    }
  }
  return count;
}

function parseReview(raw: unknown, what: string): Review | null {
  const o = asObject(raw, what);
  const state = asText(requiredKey(o, "state", what));
  if (state === null) throw new Error(`${what} has no state`);
  // A PENDING review carries an explicit null submitted_at and is not counted.
  const submitted = asText(requiredKey(o, "submitted_at", what));
  if (submitted === null) return null;
  return {
    id: asId(o.id, what),
    state,
    ...(asText(o.commit_id) ? { headSha: asText(o.commit_id)! } : {}),
    at: submitted,
    ms: utcMillis(submitted, `${what} submitted_at`),
  };
}

function parseIssueEvent(raw: unknown, what: string): IssueEvent {
  const o = asObject(raw, what);
  const label = typeof o.label === "object" && o.label !== null
    ? asText((o.label as Json).name)
    : null;
  return {
    id: asId(o.id, what),
    event: asText(o.event) ?? "",
    label,
    ...stamped(o.created_at, `${what} created_at`),
  };
}

function parseCommit(raw: unknown, what: string): Commit {
  const o = asObject(raw, what);
  const commit = asObject(o.commit, `${what}.commit`);
  const committer = asObject(commit.committer, `${what}.committer`);
  const sha = asText(o.sha);
  if (sha === null) throw new Error(`${what} has no sha`);
  return { sha, ...stamped(committer.date, `${what} committer date`) };
}

/** The GitHub evidence for one PR; truncated lists are noted, never silent. */
async function fetchEvidence(
  gh: GhJson,
  repo: string,
  number: number,
  notes: string[],
): Promise<PrEvidence> {
  const label = keyOf(repo, number);
  const reviews = await listAll(
    gh,
    `repos/${repo}/pulls/${number}/reviews`,
    EVENT_PAGE_LIMIT,
  );
  const events = await listAll(
    gh,
    `repos/${repo}/issues/${number}/events`,
    EVENT_PAGE_LIMIT,
  );
  const commits = await listAll(
    gh,
    `repos/${repo}/pulls/${number}/commits`,
    EVENT_PAGE_LIMIT,
  );
  for (
    const [name, page] of [
      ["reviews", reviews],
      ["issue events", events],
      ["commits", commits],
    ] as const
  ) {
    if (page.truncated) {
      notes.push(
        `${label}: ${name} truncated after ${EVENT_PAGE_LIMIT} pages`,
      );
    }
  }
  return {
    reviews: reviews.items.flatMap((item) => {
      const parsed = parseReview(item, `${label} review`);
      return parsed ? [parsed] : [];
    }),
    issueEvents: events.items.map((item) =>
      parseIssueEvent(item, `${label} event`)
    ),
    commits: commits.items.map((item) => parseCommit(item, `${label} commit`)),
  };
}

/**
 * Blocker intervals for one PR. `needs-human` is open from a label until its
 * removal. `changes-requested` is open from a CHANGES_REQUESTED review until
 * the next approval, dismissal or commit. An interval that never closes has
 * `endedAt: null`. CI failures are added by {@link ciBlockersFor}; other
 * blocker sources remain unrecorded.
 */
function blockersFor(
  record: PrCompletionRecord,
  evidence: PrEvidence,
): Blocker[] {
  const out: Blocker[] = [];
  const base = { repo: record.repo, prNumber: record.number };
  const humanEvents = evidence.issueEvents
    .filter((e) =>
      e.label === "needs-human" &&
      (e.event === "labeled" || e.event === "unlabeled")
    )
    .sort(byTime);
  let humanSince: string | null = null;
  for (const event of humanEvents) {
    if (event.event === "labeled") {
      humanSince ??= event.at;
    } else if (humanSince !== null) {
      out.push({
        ...base,
        blocker: "needs-human",
        startedAt: humanSince,
        endedAt: event.at,
      });
      humanSince = null;
    }
  }
  if (humanSince !== null) {
    out.push({
      ...base,
      blocker: "needs-human",
      startedAt: humanSince,
      endedAt: null,
    });
  }

  const marks: Array<Stamped & { opens: boolean }> = [];
  for (const review of evidence.reviews) {
    if (review.state === "CHANGES_REQUESTED") {
      marks.push({ ...review, opens: true });
    } else if (review.state === "APPROVED") {
      marks.push({ ...review, opens: false });
    }
  }
  for (const event of evidence.issueEvents) {
    if (event.event === "review_dismissed") {
      marks.push({ at: event.at, ms: event.ms, opens: false });
    }
  }
  for (const commit of evidence.commits) {
    marks.push({ at: commit.at, ms: commit.ms, opens: false });
  }
  let requestedSince: string | null = null;
  for (const mark of marks.sort(byTime)) {
    if (mark.opens) {
      requestedSince ??= mark.at;
    } else if (requestedSince !== null) {
      out.push({
        ...base,
        blocker: "changes-requested",
        startedAt: requestedSince,
        endedAt: mark.at,
      });
      requestedSince = null;
    }
  }
  if (requestedSince !== null) {
    out.push({
      ...base,
      blocker: "changes-requested",
      startedAt: requestedSince,
      endedAt: null,
    });
  }
  return out;
}

/** Failed workflow runs remain blockers until a later successful rerun. */
function ciBlockersFor(
  record: PrCompletionRecord,
  runs: readonly CiRun[],
  observedAt: string,
): Blocker[] {
  const workflows = runs.filter((run) =>
    run.kind === "workflow_run" && run.workflowId && run.completedAt &&
    run.outcome
  ).sort((a, b) =>
    utcMillis(a.completedAt!, "workflow completedAt") -
    utcMillis(b.completedAt!, "workflow completedAt")
  );
  const out: Blocker[] = [];
  for (const failed of workflows) {
    if (
      !new Set(["failure", "cancelled", "timed_out", "action_required"])
        .has(failed.outcome!)
    ) continue;
    const startedAt = failed.completedAt!;
    if (
      utcMillis(startedAt, "workflow completedAt") >
        utcMillis(observedAt, "observedAt")
    ) continue;
    const recovered = workflows.find((candidate) =>
      candidate.workflowId === failed.workflowId &&
      candidate.headSha === failed.headSha &&
      candidate.outcome === "success" && candidate.attempt! > failed.attempt! &&
      utcMillis(candidate.completedAt!, "workflow completedAt") >=
        utcMillis(startedAt, "workflow completedAt")
    );
    out.push({
      repo: record.repo,
      prNumber: record.number,
      blocker: "ci-failure",
      startedAt,
      endedAt: recovered?.completedAt ?? null,
    });
  }
  return out;
}

/**
 * The GitHub-observed events for one PR: submitted reviews, dismissals, the
 * merge, and each commit. Commit delivery requires a verified push's recorded range.
 */
function gitHubEvents(
  observed: ObservedPr,
  evidence: PrEvidence,
): GitHubEvent[] {
  const out: GitHubEvent[] = [];
  for (const review of evidence.reviews) {
    out.push({
      kind: "review",
      id: review.id,
      at: review.at,
      ms: review.ms,
      ...(review.headSha ? { headSha: review.headSha } : {}),
    });
  }
  for (const event of evidence.issueEvents) {
    if (event.event === "review_dismissed") {
      out.push({
        kind: "dismissal",
        id: event.id,
        at: event.at,
        ms: event.ms,
      });
    }
  }
  const { record } = observed;
  if (record.mergedAt !== null) {
    out.push({
      kind: "merge",
      id: observed.mergeCommitSha ?? "none",
      at: record.mergedAt,
      ms: utcMillis(record.mergedAt, "PR mergedAt"),
      headSha: record.headSha,
    });
  }
  evidence.commits.forEach((commit, index) => {
    out.push({
      kind: index === 0 ? "implementation" : "repair",
      id: commit.sha,
      at: commit.at,
      ms: commit.ms,
    });
  });
  return out;
}

/**
 * Match reviews, dismissals and merges one-to-one; commits can share the first
 * confirmed implementation or repair push whose delivered range contains them.
 * Branch updates match one commit within MATCH_WINDOW_MS either side of the call.
 * Matched event identifiers are attached to the audit action. Unmatched events
 * become `unknown` actions, never attributed to a human or the fleet.
 *
 * A review or dismissal matches within {@link MATCH_WINDOW_MS} of it. A merge
 * matches only a synchronous merge action on the same head shortly before the
 * GitHub merge event; an auto-merge arm cannot verify a later merge.
 */
function unmatchedActions(
  observed: ObservedPr,
  events: GitHubEvent[],
  verifiedFleet: TrustedPrAction[],
  used: Set<TrustedPrAction>,
): TrustedPrAction[] {
  const { record } = observed;
  const out: TrustedPrAction[] = [];
  for (const event of events) {
    let best: TrustedPrAction | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const action of verifiedFleet) {
      const isCommit = event.kind === "implementation" ||
        event.kind === "repair";
      if (action.outcome !== "confirmed") continue;
      if (
        event.headSha !== undefined && action.headSha !== undefined &&
        event.headSha !== action.headSha
      ) continue;
      if (
        event.kind === "review" && event.headSha !== undefined &&
        action.headSha !== event.headSha
      ) continue;
      if (
        isCommit && action.kind !== "branch-update" &&
        !action.deliveredCommits?.includes(event.id)
      ) continue;
      const isPush = action.kind === "implementation" ||
        action.kind === "repair" || action.kind === "milestone" ||
        action.kind === "branch-update";
      if (event.kind === "merge" && action.headSha !== record.headSha) {
        continue;
      }
      if (
        isCommit
          ? !isPush || (action.kind === "branch-update" && used.has(action))
          : used.has(action) || action.kind !== event.kind
      ) {
        continue;
      }
      const actionMs = utcMillis(action.timestamp, "action timestamp");
      const gap = Math.abs(actionMs - event.ms);
      const inWindow = event.kind === "merge"
        ? gap <= MATCH_WINDOW_MS
        : isCommit && action.kind === "branch-update"
        ? gap <= MATCH_WINDOW_MS
        : isCommit
        ? actionMs >= event.ms &&
          actionMs <=
            Date.parse(
                record.mergedAt ?? record.closedAt ?? record.observedAt!,
              ) + LIFETIME_SLACK_MS
        : gap <= MATCH_WINDOW_MS;
      if (inWindow && gap < bestGap) {
        best = action;
        bestGap = gap;
      }
    }
    if (best) {
      used.add(best);
      best.githubEvents ??= [];
      best.githubEvents.push({
        kind: event.kind,
        id: event.id,
        ...(event.headSha ? { headSha: event.headSha } : {}),
      });
      continue;
    }
    out.push({
      actionId: `gh:${record.repo}#${record.number}:${event.kind}:${event.id}`,
      runId: GITHUB_OBSERVATION_RUN,
      component: "unknown",
      repo: record.repo,
      prNumber: record.number,
      kind: event.kind,
      timestamp: event.at,
      outcome: "unknown",
      actor: "unknown",
      verified: false,
    });
  }
  return out;
}

/** CI duration per check run; `null` when the run is not completed or lacks a time. */
async function ciRunsFor(
  gh: GhJson,
  record: PrCompletionRecord,
  headShas: string[],
  notes: string[],
): Promise<CiRun[]> {
  const label = keyOf(record.repo, record.number);
  const rows: CiRun[] = [];
  const fetchPages = async (
    base: string,
    field: "check_runs" | "workflow_runs" | "jobs",
    source: string,
    headSha?: string,
  ): Promise<Json[]> => {
    const items: Json[] = [];
    let complete = false;
    let totalCount: number | null = null;
    for (let page = 1; page <= EVENT_PAGE_LIMIT; page++) {
      const path = `${base}${
        base.includes("?") ? "&" : "?"
      }per_page=${PER_PAGE}&page=${page}`;
      const body = asObject(await gh(path), path);
      if (typeof body.total_count === "number") totalCount = body.total_count;
      const batch = asList(requiredKey(body, field, path), path).map((item) =>
        asObject(item, `${path} ${source}`)
      );
      items.push(...batch);
      if (batch.length < PER_PAGE) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      notes.push(
        `${label}: ${source} history truncated for ${headSha ?? base}`,
      );
    }
    if (totalCount !== null && totalCount > items.length) {
      notes.push(
        `${label}: ${items.length} of ${totalCount} ${source} listed for ${
          headSha ?? base
        }`,
      );
    }
    return items;
  };
  const elapsedSeconds = (
    start: unknown,
    end: unknown,
    sourceName: string,
  ): number | null => {
    if (typeof start !== "string" || typeof end !== "string") return null;
    const seconds = (utcMillis(end, `${label} ${sourceName} completed_at`) -
      utcMillis(start, `${label} ${sourceName} started_at`)) / 1000;
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  };
  const heads = [...new Set([record.headSha, ...headShas].filter(Boolean))];
  const workflowRuns = new Map<string, { run: Json; headSha: string }>();
  for (const headSha of heads) {
    const checks = await fetchPages(
      `repos/${record.repo}/commits/${headSha}/check-runs`,
      "check_runs",
      "check runs",
      headSha,
    );
    for (const check of checks) {
      const durationSeconds = check.status === "completed"
        ? elapsedSeconds(check.started_at, check.completed_at, "check run")
        : null;
      rows.push({
        repo: record.repo,
        prNumber: record.number,
        runId: String(asId(check.id, `${label} check run`)),
        durationMinutes: durationSeconds === null ? null : durationSeconds / 60,
        kind: "check_run",
        headSha,
        durationSeconds,
        outcome: asText(check.conclusion),
        startedAt: asText(check.started_at),
        completedAt: asText(check.completed_at),
      });
    }
    const workflows = await fetchPages(
      `repos/${record.repo}/actions/runs?head_sha=${
        encodeURIComponent(headSha)
      }`,
      "workflow_runs",
      "workflow-run",
      headSha,
    );
    for (const run of workflows) {
      const runId = asId(run.id, `${label} workflow run`);
      workflowRuns.set(runId, { run, headSha });
    }
  }
  for (const { run: listedRun, headSha } of workflowRuns.values()) {
    const runId = asId(listedRun.id, `${label} workflow run`);
    const latestAttempt = typeof listedRun.run_attempt === "number" &&
        Number.isSafeInteger(listedRun.run_attempt) && listedRun.run_attempt > 0
      ? listedRun.run_attempt
      : 1;
    const attemptLimit = 100;
    if (latestAttempt > attemptLimit) {
      notes.push(
        `${label}: workflow run ${runId} has ${latestAttempt} attempts; history truncated at ${attemptLimit}`,
      );
    }
    for (
      let attempt = 1;
      attempt <= Math.min(latestAttempt, attemptLimit);
      attempt++
    ) {
      const attemptPath =
        `repos/${record.repo}/actions/runs/${runId}/attempts/${attempt}`;
      const run = asObject(await gh(attemptPath), attemptPath);
      const started = asText(run.run_started_at) ?? asText(run.created_at);
      const durationSeconds = run.status === "completed"
        ? elapsedSeconds(started, run.updated_at, "workflow run")
        : null;
      rows.push({
        repo: record.repo,
        prNumber: record.number,
        runId,
        attempt,
        durationMinutes: durationSeconds === null ? null : durationSeconds / 60,
        durationSeconds,
        kind: "workflow_run",
        workflowRunId: runId,
        ...(typeof run.workflow_id === "number" ||
            typeof run.workflow_id === "string"
          ? { workflowId: String(run.workflow_id) }
          : {}),
        headSha,
        outcome: asText(run.conclusion),
        startedAt: started,
        completedAt: asText(run.updated_at),
      });
      const jobs = await fetchPages(
        `repos/${record.repo}/actions/runs/${runId}/attempts/${attempt}/jobs`,
        "jobs",
        "job",
        headSha,
      );
      for (const job of jobs) {
        const jobDuration = job.status === "completed"
          ? elapsedSeconds(job.started_at, job.completed_at, "CI job")
          : null;
        rows.push({
          repo: record.repo,
          prNumber: record.number,
          runId: String(asId(job.id, `${label} CI job`)),
          attempt,
          durationMinutes: jobDuration === null ? null : jobDuration / 60,
          durationSeconds: jobDuration,
          kind: "job",
          workflowRunId: runId,
          ...(typeof run.workflow_id === "number" ||
              typeof run.workflow_id === "string"
            ? { workflowId: String(run.workflow_id) }
            : {}),
          headSha,
          outcome: asText(job.conclusion),
          startedAt: asText(job.started_at),
          completedAt: asText(job.completed_at),
        });
      }
    }
  }
  return rows;
}

/** Revert targets named by a PR's title or body, each read over its bounded slice. */
function revertedNumbers(title: string, body: string): number[] {
  const head = title.slice(0, TITLE_BOUND);
  const found = new Set<number>();
  if (REVERT_TITLE.test(head)) {
    for (const match of head.matchAll(QUOTED_PR_REFERENCE)) {
      found.add(Number(match[1]));
    }
  }
  const text = `${head}\n${body.slice(0, TEXT_BOUND)}`;
  for (const match of text.matchAll(REVERT_REFERENCE)) {
    found.add(Number(match[1]));
  }
  return [...found];
}

/**
 * A regression is a cohort PR that reverts a merged cohort PR. It is recorded
 * once per reverted PR, at the earliest revert, and resolved when the revert
 * merged. Reverts of PRs outside the cohort are not observed.
 */
function regressionsFor(
  observed: ObservedPr[],
  ciRunsByPr: ReadonlyMap<string, readonly CiRun[]> = new Map(),
): Regression[] {
  const byKey = new Map(
    observed.map((o) => [keyOf(o.record.repo, o.record.number), o.record]),
  );
  const earliest = new Map<string, Regression & { createdAt: string }>();
  for (const o of observed) {
    const revert = o.record;
    for (const reverted of revertedNumbers(o.title, o.body)) {
      if (reverted === revert.number) continue;
      const key = keyOf(revert.repo, reverted);
      const target = byKey.get(key);
      if (!target || target.state !== "merged") continue;
      const existing = earliest.get(key);
      if (
        !existing ||
        utcMillis(revert.createdAt, "revert createdAt") <
          utcMillis(existing.createdAt, "revert createdAt")
      ) {
        earliest.set(key, {
          repo: revert.repo,
          prNumber: reverted,
          detectedAt: revert.createdAt,
          resolved: revert.state === "merged",
          createdAt: revert.createdAt,
        });
      }
    }
  }
  const rows: Regression[] = [...earliest.values()].map(
    ({ createdAt: _createdAt, ...row }) => ({ ...row, source: "revert" }),
  );
  for (const { record } of observed) {
    if (!record.mergedAt) continue;
    const mergeMs = utcMillis(record.mergedAt, "PR mergedAt");
    const runs = ciRunsByPr.get(keyOf(record.repo, record.number)) ?? [];
    const workflows = runs.filter((run) => run.kind === "workflow_run");
    for (const failed of workflows) {
      if (
        !failed.completedAt || !failed.workflowId || !failed.headSha ||
        failed.headSha !== record.headSha ||
        !["failure", "cancelled", "timed_out", "action_required"].includes(
          failed.outcome ?? "",
        ) || utcMillis(failed.completedAt!, "workflow completedAt") < mergeMs
      ) continue;
      const recovered = workflows.some((candidate) =>
        candidate.workflowId === failed.workflowId &&
        candidate.headSha === failed.headSha &&
        candidate.outcome === "success" &&
        candidate.attempt! > failed.attempt! &&
        candidate.completedAt !== null &&
        utcMillis(candidate.completedAt!, "workflow completedAt") >=
          utcMillis(failed.completedAt!, "workflow completedAt")
      );
      rows.push({
        repo: record.repo,
        prNumber: record.number,
        detectedAt: failed.completedAt,
        resolved: recovered,
        source: "post_merge_ci",
      });
    }
  }
  return rows;
}

/** One deployment row, or the reason the record is unusable. */
function deploymentRow(
  component: unknown,
  revision: unknown,
  fingerprint: unknown,
  observedAt: unknown,
  hostId?: unknown,
): DeploymentRow | string {
  if (typeof component !== "string" || !COMPONENT_PATTERN.test(component)) {
    return "component is not a component identifier";
  }
  if (typeof revision !== "string" || revision.length === 0) {
    return "revision is missing";
  }
  if (
    typeof fingerprint !== "string" || !FINGERPRINT_PATTERN.test(fingerprint)
  ) {
    return "policy fingerprint is not a SHA-256 fingerprint";
  }
  if (typeof observedAt !== "string") return "observedAt is missing";
  if (
    hostId !== undefined &&
    (typeof hostId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(hostId))
  ) return "hostId is not a host identifier";
  try {
    utcMillis(observedAt, "observedAt");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return {
    component,
    ...(typeof hostId === "string" ? { hostId } : {}),
    revision,
    policyFingerprint: fingerprint,
    observedAt,
  };
}

type JsonRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

async function readJsonFile(path: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { ok: false, reason: "is missing" };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `is unreadable (${reason})` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "is malformed JSON" };
  }
}

/**
 * Deployment rows from the three sources. A babysitter heartbeat is the
 * current state and is kept whatever its age, so the report can call it
 * stale. Review-run and ledger records older than the heartbeat window are
 * counted in one note instead of being mixed into the current deployment.
 */
async function collectDeployments(
  options: CollectOptions,
  observedMs: number,
  notes: string[],
): Promise<DeploymentRow[]> {
  const rows: DeploymentRow[] = [];
  const cutoff = observedMs -
    options.expected.maxHeartbeatAgeHours * HOUR_MS;
  let outsideWindow = 0;
  const keepIfFresh = (row: DeploymentRow) => {
    if (utcMillis(row.observedAt, "deployment observedAt") >= cutoff) {
      rows.push(row);
    } else {
      outsideWindow++;
    }
  };

  for (const dir of options.babysitterStateDirs ?? []) {
    const path = `${dir}/deployment-health.json`;
    const loaded = await readJsonFile(path);
    if (!loaded.ok) {
      notes.push(`babysitter heartbeat ${path} ${loaded.reason}; skipped`);
      continue;
    }
    if (typeof loaded.value !== "object" || loaded.value === null) {
      notes.push(`babysitter heartbeat ${path} is not a JSON object; skipped`);
      continue;
    }
    const o = loaded.value as Json;
    const row = deploymentRow(
      o.component,
      o.codeRevision,
      o.policyFingerprint,
      o.observedAt,
      o.hostId,
    );
    if (typeof row === "string") {
      notes.push(`babysitter heartbeat ${path}: ${row}; skipped`);
    } else {
      rows.push(row);
    }
  }

  for (const dir of options.reviewRunDirs ?? []) {
    const rounds: string[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isDirectory) rounds.push(entry.name);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notes.push(`review-run dir ${dir} is unreadable (${reason}); skipped`);
      continue;
    }
    let absent = 0;
    let legacy = 0;
    for (const round of rounds.sort()) {
      const path = `${dir}/${round}/${REVIEW_RUN_FILE}`;
      const loaded = await readJsonFile(path);
      if (!loaded.ok) {
        if (loaded.reason === "is missing") absent++;
        else notes.push(`review-run record ${path} ${loaded.reason}; skipped`);
        continue;
      }
      if (typeof loaded.value !== "object" || loaded.value === null) {
        notes.push(`review-run record ${path} is not a JSON object; skipped`);
        continue;
      }
      const deployment = (loaded.value as Json).deployment;
      if (typeof deployment !== "object" || deployment === null) {
        // Written before the deployment field existed: no evidence, not an error.
        legacy++;
        continue;
      }
      const d = deployment as Json;
      const row = deploymentRow(
        d.component,
        d.codeRevision,
        d.policyFingerprint,
        d.observedAt,
        d.hostId,
      );
      if (typeof row === "string") {
        notes.push(`review-run record ${path}: ${row}; skipped`);
      } else {
        keepIfFresh(row);
      }
    }
    if (absent > 0) {
      notes.push(
        `review-run dir ${dir}: ${absent} round(s) have no ${REVIEW_RUN_FILE}`,
      );
    }
    if (legacy > 0) {
      notes.push(
        `review-run dir ${dir}: ${legacy} record(s) have no deployment field (written before it existed); not counted`,
      );
    }
  }

  for (const path of options.lifecycleLedgers ?? []) {
    try {
      await Deno.stat(path);
    } catch (error) {
      const reason = error instanceof Deno.errors.NotFound
        ? "is missing"
        : `is unreadable (${
          error instanceof Error ? error.message : String(error)
        })`;
      notes.push(`lifecycle ledger ${path} ${reason}; skipped`);
      continue;
    }
    let events;
    try {
      events = await readLifecycleLedger(path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notes.push(`lifecycle ledger ${path} is malformed (${reason}); skipped`);
      continue;
    }
    for (const event of events) {
      if (event.kind !== "assignment") continue;
      const { treatment } = event as AssignmentEvent;
      if (!treatment.workerCommit || !treatment.reviewPolicyFingerprint) {
        continue;
      }
      const row = deploymentRow(
        "worker",
        treatment.workerCommit,
        treatment.reviewPolicyFingerprint,
        event.recordedAt,
        event.host,
      );
      if (typeof row === "string") {
        notes.push(`lifecycle ledger ${path}: ${row}; row skipped`);
      } else {
        keepIfFresh(row);
      }
    }
  }

  if (outsideWindow > 0) {
    notes.push(
      `${outsideWindow} review-run or lifecycle deployment record(s) older than the ` +
        `${options.expected.maxHeartbeatAgeHours}h heartbeat window were not counted`,
    );
  }
  return rows;
}

async function collectDiscoveryEvents(
  directories: string[],
  verifiedMs: number,
  notes: string[],
): Promise<{
  events: Array<{ repo: string; prNumber: number; event: string }>;
  hosts: Set<string>;
  complete: boolean;
}> {
  const events: Array<{ repo: string; prNumber: number; event: string }> = [];
  const hosts = new Set<string>();
  let complete = directories.length > 0;
  for (const directory of directories) {
    const path = `${directory}/pr-discovery-events.jsonl`;
    try {
      const rows = await readPrDiscoveryEvents(path);
      for (const row of rows) {
        hosts.add(row.hostId);
        if (Date.parse(row.recordedAt) < verifiedMs) continue;
        events.push({
          repo: row.repo,
          prNumber: row.prNumber,
          event: row.event,
        });
      }
    } catch (error) {
      complete = false;
      const reason = error instanceof Deno.errors.NotFound
        ? "is missing"
        : `is invalid (${
          error instanceof Error ? error.message : String(error)
        })`;
      notes.push(
        `PR discovery events ${path} ${reason}; rollout remains unknown`,
      );
    }
  }
  return { events, hosts, complete };
}

/**
 * Whether a parsed review-log line is a posted review the matcher can use: a
 * repository, a PR number, a UTC time and an outcome the skill posts.
 */
function isPostedReview(value: unknown): value is LogRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const r = value as Partial<LogRecord>;
  if (
    typeof r.repo !== "string" || !PR_REPO_PATTERN.test(r.repo) ||
    typeof r.number !== "number" || !Number.isSafeInteger(r.number) ||
    r.number < 1 || typeof r.at !== "string" ||
    typeof r.outcome !== "string" || !POSTED_OUTCOMES.has(r.outcome)
  ) {
    return false;
  }
  try {
    utcMillis(r.at, "review log at");
  } catch {
    return false;
  }
  return true;
}

/**
 * Review actions from the review-fleet-prs skill's own logs. A posted review
 * may support matching the GitHub review event within {@link MATCH_WINDOW_MS},
 * but remains unverified because the log is not hash-chained
 * (docs/INTERNALS.md). Records for
 * PRs outside the cohort are ignored. A missing or unreadable file, and a
 * malformed line, is noted and skipped, never silently. The same record across
 * two logs is one action. Its head SHA helps correlate the event, but does not
 * verify it; review-log records remain supporting evidence only.
 */
async function reviewLogActions(
  paths: string[],
  cohort: ReadonlySet<string>,
  notes: string[],
): Promise<TrustedPrAction[]> {
  const byId = new Map<string, TrustedPrAction>();
  for (const path of paths) {
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        notes.push(`review log ${path} is missing; skipped`);
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        notes.push(`review log ${path} is unreadable (${reason}); skipped`);
      }
      continue;
    }
    const records = parseLog(text).filter(isPostedReview);
    const lines = text.split("\n").filter((line) => line.trim() !== "").length;
    if (records.length < lines) {
      notes.push(
        `review log ${path}: ${
          lines - records.length
        } malformed line(s) skipped`,
      );
    }
    for (const record of records) {
      if (!cohort.has(keyOf(record.repo, record.number))) continue;
      const actionId =
        `review-log:${record.repo}#${record.number}:${record.at}`;
      byId.set(actionId, {
        actionId,
        runId: REVIEW_LOG_RUN,
        component: "reviewer",
        repo: record.repo,
        prNumber: record.number,
        ...(record.headSha ? { headSha: record.headSha } : {}),
        kind: "review",
        timestamp: record.at,
        outcome: "confirmed",
        actor: "unknown",
        verified: false,
      });
    }
  }
  return [...byId.values()];
}

/** One audit entry, with whether its journal's directory chain verified. */
interface JournalEntry {
  entry: AuditEntry;
  verified: boolean;
}

/** Journal files directly under an audit directory. */
async function listJournals(
  dir: string,
): Promise<Array<{ path: string; checked: boolean }>> {
  const names: Array<{ path: string; checked: boolean }> = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".jsonl")) {
      names.push({
        path: `${dir}/${entry.name}`,
        checked: isAuditJournalName(entry.name),
      });
    }
  }
  return names.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Read every audit directory. A directory whose chains do not all verify
 * still contributes its entries, marked unverified; a directory with no
 * journals, or any unreadable one, leaves the evidence incomplete. Actions
 * repeated across hosts are kept once, preferring a verified copy.
 */
async function readAuditEntries(
  dirs: string[],
  notes: string[],
): Promise<{ entries: JournalEntry[]; complete: boolean }> {
  let complete = dirs.length > 0;
  if (dirs.length === 0) notes.push("no audit directory supplied");
  const byId = new Map<string, JournalEntry>();
  for (const dir of dirs) {
    try {
      const swept = await verifyAllChains(dir, {
        recoverInterruptedAppends: false,
      });
      let verified = false;
      if (!swept.ok) {
        complete = false;
        notes.push(
          `audit dir ${dir}: chain sweep failed (${swept.error.message})`,
        );
      } else if (swept.value.broken.length > 0) {
        complete = false;
        const paths = swept.value.broken.map((b) => b.path).join(", ");
        notes.push(
          `audit dir ${dir}: ${swept.value.broken.length} chain(s) failed verification (${paths})`,
        );
      } else {
        verified = true;
      }
      const journals = await listJournals(dir);
      if (journals.length === 0) {
        complete = false;
        notes.push(`audit dir ${dir}: no audit journals found`);
      }
      for (const { path, checked } of journals) {
        const fileVerified = verified && checked;
        if (!checked) {
          complete = false;
          notes.push(
            `audit journal ${path}: name not covered by chain sweep; unverified`,
          );
        }
        const loaded = await loadEntries(path);
        if (!loaded.ok) {
          complete = false;
          notes.push(
            `audit journal ${path} is unreadable (${loaded.error.message}); skipped`,
          );
          continue;
        }
        for (const entry of loaded.value) {
          const id = entry.actionId;
          if (!id) continue;
          const previous = byId.get(id);
          if (!previous || (!previous.verified && fileVerified)) {
            byId.set(id, { entry, verified: fileVerified });
          }
        }
      }
    } catch (error) {
      complete = false;
      const reason = error instanceof Error ? error.message : String(error);
      notes.push(`audit dir ${dir} is unreadable (${reason}); skipped`);
    }
  }
  return { entries: [...byId.values()], complete };
}

/**
 * The branch a `git push` target names, or `null` when it names none. The part
 * after a refspec's `:` is used, with `refs/heads/` stripped. `HEAD` names the
 * checked-out branch, which the journal does not record, so a `HEAD` target
 * cannot be linked; neither can an empty or `-`-prefixed target.
 */
function pushedBranch(target: string): string | null {
  const colon = target.lastIndexOf(":");
  const destination = colon === -1 ? target : target.slice(colon + 1);
  const name = destination.startsWith("refs/heads/")
    ? destination.slice("refs/heads/".length)
    : destination;
  if (name === "" || name === "HEAD" || name.startsWith("-")) return null;
  return name;
}

/**
 * Whether a push at `pushedMs` falls inside the PR's lifetime, widened by
 * {@link LIFETIME_SLACK_MS} either side: from creation to the merge, close or
 * observation, whichever the record carries.
 */
function pushWithinLifetime(
  record: PrCompletionRecord,
  pushedMs: number,
): boolean {
  const endText = record.mergedAt ?? record.closedAt ?? record.observedAt;
  if (endText === undefined || endText === null) return false;
  const createdMs = Date.parse(record.createdAt);
  const endMs = Date.parse(endText);
  return pushedMs >= createdMs - LIFETIME_SLACK_MS &&
    pushedMs <= endMs + LIFETIME_SLACK_MS;
}

/**
 * Link a `git-push` entry to a cohort PR and set its repo and PR number. A push
 * that carries a repo links within that repo. A push without one, which is
 * what production writes, links across every supplied repo by branch name, and
 * only when that branch name belongs to PRs in a single repo. Either way the
 * push must fall between the branch's first commit and the PR's end, and the latest PR created on the
 * branch wins. Anything ambiguous or unresolvable stays unlinked, which leaves
 * the PR's commits as honest `unknown` actions.
 */
function linkBranchPush(
  entry: AuditEntry,
  observed: ObservedPr[],
  evidenceByPr: Map<string, PrEvidence>,
): AuditEntry {
  if (entry.verb !== "git-push" || entry.prNumber || !entry.target) {
    return entry;
  }
  const branch = pushedBranch(entry.target);
  const pushedMs = Date.parse(entry.timestamp);
  if (branch === null || !Number.isFinite(pushedMs)) return entry;
  const named = observed.map(({ record }) => record).filter((record) =>
    record.headRef === branch
  );
  if (!entry.repo && new Set(named.map((record) => record.repo)).size > 1) {
    return entry;
  }
  let best: PrCompletionRecord | undefined;
  for (const record of named) {
    if (entry.repo && record.repo !== entry.repo) continue;
    const commits =
      evidenceByPr.get(keyOf(record.repo, record.number))!.commits;
    const firstCommitMs = Math.min(...commits.map((commit) => commit.ms));
    const lifetimeRecord = {
      ...record,
      createdAt: new Date(Math.min(Date.parse(record.createdAt), firstCommitMs))
        .toISOString(),
    };
    if (!pushWithinLifetime(lifetimeRecord, pushedMs)) continue;
    if (!best || Date.parse(record.createdAt) > Date.parse(best.createdAt)) {
      best = record;
    }
  }
  return best ? { ...entry, repo: best.repo, prNumber: best.number } : entry;
}

/**
 * Whether a cohort PR is stranded at the rollout verification instant: created
 * before it, still open at it (no merge or close at or before it), at least
 * {@link STRANDED_AGE_MS} old at it, and not owner-gated. A PR that merged after
 * the instant is stranded. PRs created before the cohort start never reach
 * this check.
 */
function strandedAt(pr: PrCompletionRecord, verifiedMs: number): boolean {
  const createdMs = utcMillis(pr.createdAt, "PR createdAt");
  const endText = pr.mergedAt ?? pr.closedAt ?? null;
  const openAtVerification = endText === null ||
    utcMillis(endText, "PR end") > verifiedMs;
  return createdMs < verifiedMs &&
    verifiedMs - createdMs >= STRANDED_AGE_MS &&
    openAtVerification &&
    pr.ownerGated !== true;
}

/**
 * Collect the PR completion snapshot. Throws on GitHub or input failures so
 * a partial read is never reported as complete; local-file problems are
 * noted and skipped.
 */
export async function collectPrCompletionSnapshot(
  options: CollectOptions,
): Promise<CollectedSnapshot> {
  const repos = [...new Set(options.repos)];
  if (repos.length === 0) {
    throw new Error("at least one repository is required");
  }
  for (const repo of repos) {
    if (!PR_REPO_PATTERN.test(repo)) {
      throw new Error(`repository ${repo} must be owner/name`);
    }
  }
  const startMs = utcMillis(options.cohort.start, "cohort.start");
  const endMs = utcMillis(options.cohort.end, "cohort.end");
  const observedMs = utcMillis(options.cohort.observedAt, "cohort.observedAt");
  if (startMs >= endMs || observedMs < startMs) {
    throw new Error(
      "cohort timestamps must satisfy start < end and observedAt >= start",
    );
  }
  if (options.rolloutVerifiedAt !== undefined) {
    utcMillis(options.rolloutVerifiedAt, "rolloutVerifiedAt");
  }
  const maxPrs = options.maxPrsPerRepo ?? DEFAULT_MAX_PRS_PER_REPO;
  if (!Number.isSafeInteger(maxPrs) || maxPrs < 1) {
    throw new Error("maxPrsPerRepo must be a positive integer");
  }

  const notes: string[] = [];
  if (options.expected.inventory === undefined) {
    notes.push(
      "no expected host/component deployment inventory supplied; per-host rollout status is unavailable",
    );
  }
  const truncatedRepos: string[] = [];
  const audit = await readAuditEntries(options.auditDirs, notes);

  const observed: ObservedPr[] = [];
  let openPrsBeforeCohort = 0;
  for (const repo of repos) {
    const repoObservation = await observeRepo(
      options.gh,
      repo,
      options.cohort,
      maxPrs,
      truncatedRepos,
    );
    observed.push(...repoObservation.observed);
    openPrsBeforeCohort += repoObservation.openBeforeCohort;
  }
  for (const o of observed) o.record.actionsComplete = audit.complete;
  if (observed.some((o) => o.record.state === "merged")) {
    notes.push(CI_SCOPE_NOTE);
  }

  const evidenceByPr = new Map<string, PrEvidence>();
  for (const { record } of observed) {
    evidenceByPr.set(
      keyOf(record.repo, record.number),
      await fetchEvidence(options.gh, record.repo, record.number, notes),
    );
  }
  const linked = audit.entries.map(({ entry, verified }) => ({
    entry: linkBranchPush(entry, observed, evidenceByPr),
    verified,
  }));
  const verifiedActions = prActionsFromAuditJournal(
    linked.filter((item) => item.verified).map((item) => item.entry),
    true,
  );
  const unverifiedActions = prActionsFromAuditJournal(
    linked.filter((item) => !item.verified).map((item) => item.entry),
    false,
  );
  const logActions = await reviewLogActions(
    options.reviewLogs ?? [],
    new Set(observed.map(({ record }) => keyOf(record.repo, record.number))),
    notes,
  );
  const verifiedFleet = [
    ...verifiedActions.filter((action) =>
      action.verified && action.actor === "fleet"
    ),
  ];
  const fleetByPr = new Map<string, TrustedPrAction[]>();
  for (const action of verifiedFleet) {
    // A recorded withdrawal invalidates earlier merge arms, but remains in
    // the output history. Failed withdrawals and later re-arms do not cancel.
    if (
      action.kind === "merge" &&
      linked.some(({ entry, verified }) =>
        verified && entry.verb === "pr-merge" &&
        entry.actionKind === "unknown" &&
        entry.outcome === "success" && entry.repo === action.repo &&
        entry.prNumber === action.prNumber &&
        Date.parse(entry.timestamp) >= Date.parse(action.timestamp) &&
        Date.parse(entry.timestamp) <=
          Date.parse(
            observed.find((o) =>
              o.record.repo === action.repo &&
              o.record.number === action.prNumber
            )?.record.mergedAt ?? options.cohort.observedAt,
          )
      )
    ) continue;
    const key = keyOf(action.repo, action.prNumber);
    const list = fleetByPr.get(key) ?? [];
    list.push(action);
    fleetByPr.set(key, list);
  }
  const matchingByPr = new Map(
    [...fleetByPr].map(([key, actions]) => [key, [...actions]]),
  );
  for (const action of logActions) {
    const key = keyOf(action.repo, action.prNumber);
    const list = matchingByPr.get(key) ?? [];
    list.push(action);
    matchingByPr.set(key, list);
  }

  const used = new Set<TrustedPrAction>();
  const githubActions: TrustedPrAction[] = [];
  const blockers: Blocker[] = [];
  const ciRuns: CiRun[] = [];
  const ciRunsByPr = new Map<string, CiRun[]>();
  let reviewEvents = 0;
  let prsWithReviewEvents = 0;
  for (const o of observed) {
    const { record } = o;
    const evidence = evidenceByPr.get(keyOf(record.repo, record.number))!;
    if (evidence.reviews.length > 0) {
      reviewEvents += evidence.reviews.length;
      prsWithReviewEvents++;
    }
    blockers.push(...blockersFor(record, evidence));
    githubActions.push(
      ...unmatchedActions(
        o,
        gitHubEvents(o, evidence),
        matchingByPr.get(keyOf(record.repo, record.number)) ?? [],
        used,
      ),
    );
    const prCiRuns = await ciRunsFor(
      options.gh,
      record,
      evidence.commits.map((commit) => commit.sha),
      notes,
    );
    ciRuns.push(...prCiRuns);
    ciRunsByPr.set(keyOf(record.repo, record.number), prCiRuns);
    blockers.push(
      ...ciBlockersFor(record, prCiRuns, options.cohort.observedAt),
    );
  }
  if ((options.reviewLogs ?? []).length === 0 && reviewEvents > 0) {
    const events = reviewEvents === 1 ? "review event" : "review events";
    const prs = prsWithReviewEvents === 1 ? "PR" : "PRs";
    notes.push(
      `${reviewEvents} ${events} on ${prsWithReviewEvents} ${prs} had no review-log source; ` +
        "the review-fleet-prs skill journals no audit records, so those reviews stay unknown unless an audit action matches them",
    );
  }

  const deployments = await collectDeployments(options, observedMs, notes);
  const records = observed.map((o) => o.record);
  let rollout: PrCompletionInput["rollout"];
  if (options.rolloutVerifiedAt !== undefined) {
    const verifiedMs = utcMillis(
      options.rolloutVerifiedAt,
      "rolloutVerifiedAt",
    );
    const discovery = await collectDiscoveryEvents(
      options.babysitterStateDirs ?? [],
      verifiedMs,
      notes,
    );
    const expectedBabysitterHosts = options.expected.inventory
      ?.filter((item) => item.component === "babysitter")
      .map((item) => item.hostId) ?? [];
    if (options.expected.inventory === undefined) {
      discovery.complete = false;
    }
    if (
      expectedBabysitterHosts.some((hostId) => !discovery.hosts.has(hostId))
    ) {
      discovery.complete = false;
      notes.push(
        "PR discovery events do not cover every expected babysitter host; rollout remains unknown",
      );
    }
    rollout = {
      verifiedAt: options.rolloutVerifiedAt,
      discoveryEvidenceComplete: discovery.complete,
      strandedPrs: records.filter((pr) => strandedAt(pr, verifiedMs)).map(
        (pr) => {
          const events = discovery.events.filter((event) =>
            event.repo === pr.repo && event.prNumber === pr.number
          );
          return {
            repo: pr.repo,
            prNumber: pr.number,
            eligible: true,
            discovered: events.some((event) => event.event === "discovered"),
            eligibilityConfirmed: events.some((event) =>
              event.event === "eligible"
            ),
            processed: events.some((event) => event.event === "processed"),
          };
        },
      ),
    };
    if (!discovery.complete && rollout.strandedPrs.length > 0) {
      notes.push(
        "rollout discovery evidence is unavailable; later audit actions do not prove ordinary discovery, eligibility or processing",
      );
    }
  }

  const input: PrCompletionInput = {
    cohort: { ...options.cohort },
    prs: records,
    actions: [
      ...verifiedActions,
      ...unverifiedActions,
      ...logActions,
      ...githubActions,
    ],
    blockers,
    ciRuns,
    regressions: regressionsFor(observed, ciRunsByPr),
    deployments,
    expectedDeployment: {
      components: [...options.expected.components],
      ...(options.expected.inventory !== undefined
        ? {
          inventory: options.expected.inventory.map((entry) => ({ ...entry })),
        }
        : {}),
      inventoryComplete: options.expected.inventory !== undefined,
      revision: options.expected.revision,
      policyFingerprint: options.expected.policyFingerprint,
      maxHeartbeatAgeHours: options.expected.maxHeartbeatAgeHours,
    },
    ...(rollout ? { rollout } : {}),
    truncatedRepos: [...truncatedRepos],
    openPrsBeforeCohort,
  };
  return { input, coverageNotes: notes, truncatedRepos };
}
