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
 * A GitHub event is never attributed from its login. A matching verified fleet
 * action takes precedence; otherwise reviews, dismissals and merges require a
 * numeric actor id in the explicit human allowlist. Commit authorship alone
 * stays unknown. Review-fleet-prs logs
 * can support a review match but are not hash-chained or sufficient to verify
 * completion.
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

import type { AuditEntry } from "./audit_entry.ts";
import { ownerHoldFromBody } from "./fleet_review_hold.ts";
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
  ACTOR_ID_PATTERN,
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
  /** Numeric GitHub ids whose unmatched reviews, dismissals or merges affirm human intervention. */
  humanActorIds?: readonly string[];
  /** Cap on PRs kept per repository in the cohort (default 500). */
  maxPrsPerRepo?: number;
  /** Maximum GitHub calls devoted to CI per collection (default 5000). */
  ciCallBudget?: number;
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
  "CI history reads check runs on every observed PR head and workflow attempts/jobs on heads with workflow runs; truncated API history is called out per PR";

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
  body: string;
  id: string;
  state: string;
  actorId: string | null;
  headSha?: string;
}

interface IssueEvent extends Stamped {
  id: string;
  event: string;
  label: string | null;
  actorId: string | null;
}

interface Commit extends Stamped {
  sha: string;
}

interface PrEvidence {
  reviews: Review[];
  reviewsComplete: boolean;
  issueEvents: IssueEvent[];
  commits: Commit[];
}

/** A GitHub-observed event that a fleet action may or may not account for. */
interface GitHubEvent extends Stamped {
  kind: PrActionKind;
  id: string;
  headSha?: string;
  actorId: string | null;
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

/** A numeric GitHub actor id, or null when the API names no account. */
function actorIdOf(raw: Json, key: string, what: string): string | null {
  const rawActor = requiredKey(raw, key, what);
  if (rawActor === null) return null;
  const actor = asObject(rawActor, `${what}.${key}`);
  const id = asId(requiredKey(actor, "id", `${what}.${key}`), `${what}.${key}`);
  const value = String(id);
  if (!ACTOR_ID_PATTERN.test(value)) {
    throw new Error(`${what}.${key}.id must be a numeric GitHub user id`);
  }
  return value;
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
 * Observe cohort PRs and, during rollout verification, outside-cohort candidates.
 * Rollout discovery scans to exhaustion or the page bound: an age cutoff
 * cannot rule out stranded PRs on later pages. Bound exhaustion is incomplete.
 */
async function observeRepo(
  gh: GhJson,
  repo: string,
  cohort: CollectOptions["cohort"],
  maxPrs: number,
  truncatedRepos: string[],
  rolloutVerifiedAt?: string,
): Promise<{
  observed: ObservedPr[];
  rolloutCandidates: ObservedPr[];
  rolloutComplete: boolean;
  openBeforeCohort: number;
}> {
  const repoInfo = asObject(await gh(`repos/${repo}`), `repos/${repo}`);
  const defaultBranch = asText(repoInfo.default_branch);
  if (defaultBranch === null) {
    throw new Error(`repos/${repo} has no default_branch`);
  }
  const startMs = utcMillis(cohort.start, "cohort.start");
  const endMs = utcMillis(cohort.end, "cohort.end");
  const verifiedMs = rolloutVerifiedAt === undefined
    ? undefined
    : utcMillis(rolloutVerifiedAt, "rolloutVerifiedAt");
  const pageBound = Math.ceil(maxPrs / PER_PAGE);
  const kept: Json[] = [];
  const rolloutKept: Json[] = [];
  let truncated = false;
  let rolloutIncomplete = false;
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
      else if (
        verifiedMs !== undefined && createdMs < verifiedMs
      ) rolloutKept.push(pr);
    }
    const oldest = utcMillis(
      asText(batch[batch.length - 1]!.created_at) ?? "",
      `${repo} pull request created_at`,
    );
    if (batch.length < PER_PAGE) break;
    if (rolloutVerifiedAt === undefined && oldest < startMs) break;
    if (page >= pageBound) {
      truncated = oldest >= startMs;
      rolloutIncomplete = rolloutVerifiedAt !== undefined;
      break;
    }
  }
  if (kept.length > maxPrs) {
    kept.length = maxPrs;
    truncated = true;
  }
  if (rolloutKept.length > maxPrs) {
    rolloutKept.length = maxPrs;
    rolloutIncomplete = true;
  }
  if (truncated) truncatedRepos.push(repo);
  const observed = kept.map((pr) =>
    observedPr(pr, repo, defaultBranch, cohort.observedAt)
  );
  const rolloutCandidates = rolloutKept.map((pr) =>
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
  return {
    observed,
    rolloutCandidates,
    rolloutComplete: !rolloutIncomplete,
    openBeforeCohort,
  };
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
    body: asText(requiredKey(o, "body", what))?.slice(0, TEXT_BOUND) ?? "",
    actorId: actorIdOf(o, "user", what),
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
    actorId: actorIdOf(o, "actor", what),
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
    reviewsComplete: !reviews.truncated,
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
 * `endedAt: null`. CI failures, failed-repair recovery and reviewer branch
 * refresh waits are added from their recorded evidence.
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

/**
 * Failed workflow runs remain blockers until a later successful run of the same
 * workflow: a later attempt of the failed run, or a different run on any head
 * of the PR, including a ready_for_review or reopened run on the same head. A blocker never extends past the PR's merge or
 * close: it ends there when no recovery came first, and a failure completed
 * after that moment is not a blocker at all.
 */
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
  const endCap = record.mergedAt ?? record.closedAt ?? null;
  const endCapMs = endCap === null
    ? null
    : utcMillis(endCap, "PR merged or closed at");
  const out: Blocker[] = [];
  for (const failed of workflows) {
    if (
      !new Set(["failure", "timed_out", "action_required"])
        .has(failed.outcome!)
    ) continue;
    const startedAt = failed.completedAt!;
    const startedMs = utcMillis(startedAt, "workflow completedAt");
    if (startedMs > utcMillis(observedAt, "observedAt")) continue;
    if (endCapMs !== null && startedMs > endCapMs) continue;
    const recovered = workflows.find((candidate) =>
      candidate.workflowId === failed.workflowId &&
      candidate.outcome === "success" &&
      (candidate.runId !== failed.runId ||
        candidate.attempt! > failed.attempt!) &&
      utcMillis(candidate.completedAt!, "workflow completedAt") >= startedMs
    );
    let endedAt: string | null = recovered?.completedAt ?? null;
    if (
      endCap !== null && endCapMs !== null &&
      (endedAt === null ||
        utcMillis(endedAt, "workflow completedAt") > endCapMs)
    ) {
      endedAt = endCap;
    }
    const previous = out.at(-1);
    if (
      previous && (previous.endedAt === null ||
        utcMillis(previous.endedAt, "blocker endedAt") >= startedMs)
    ) {
      if (
        previous.endedAt !== null && (endedAt === null ||
          utcMillis(endedAt, "blocker endedAt") >
            utcMillis(previous.endedAt, "blocker endedAt"))
      ) {
        previous.endedAt = endedAt;
      }
      continue;
    }
    out.push({
      repo: record.repo,
      prNumber: record.number,
      blocker: "ci-failure",
      startedAt,
      endedAt,
    });
  }
  return out;
}

/** Time spent between a recorded failed repair and its next confirmed repair. */
export function recoveryBlockersFor(
  record: PrCompletionRecord,
  actions: readonly TrustedPrAction[],
): Blocker[] {
  const endCap = record.mergedAt ?? record.closedAt ?? null;
  const repairs = actions.filter((action) =>
    action.verified && (action.kind === "repair" ||
      (action.kind === "dismissal" && action.actor === "fleet" &&
        action.outcome === "confirmed"))
  ).sort((a, b) =>
    utcMillis(a.timestamp, "repair action timestamp") -
    utcMillis(b.timestamp, "repair action timestamp")
  );
  const out: Blocker[] = [];
  let pending: string | null = null;
  for (const action of repairs) {
    if (
      endCap !== null &&
      utcMillis(action.timestamp, "repair timestamp") >
        utcMillis(endCap, "PR end")
    ) break;
    if (action.kind === "repair" && action.outcome === "failed") {
      pending ??= action.timestamp;
    }
    if (action.outcome === "confirmed" && pending !== null) {
      out.push({
        repo: record.repo,
        prNumber: record.number,
        blocker: "repair-recovery",
        startedAt: pending,
        endedAt: action.timestamp,
      });
      pending = null;
    }
  }
  if (pending !== null) {
    out.push({
      repo: record.repo,
      prNumber: record.number,
      blocker: "repair-recovery",
      startedAt: pending,
      endedAt: endCap,
    });
  }
  return out;
}

/** Time spent waiting for checks after a trusted reviewer branch refresh. */
export function branchRefreshBlockersFor(
  record: PrCompletionRecord,
  actions: readonly TrustedPrAction[],
  runs: readonly CiRun[],
): Blocker[] {
  const endCap = record.mergedAt ?? record.closedAt ?? null;
  const endCapMs = endCap === null ? null : utcMillis(endCap, "PR end");
  return actions.flatMap((action) => {
    if (
      !action.verified || action.actor !== "fleet" ||
      action.kind !== "branch-update" ||
      action.outcome !== "confirmed"
    ) return [];
    const commitShas = action.githubEvents?.filter((event) =>
      event.kind === "implementation" || event.kind === "repair"
    ).map((event) =>
      event.id
    ) ?? [];
    if (commitShas.length === 0) return [];
    const startedMs = utcMillis(action.timestamp, "branch update timestamp");
    if (endCapMs !== null && startedMs > endCapMs) return [];
    const completed = runs.flatMap((run) =>
      (run.kind === "workflow_run" || run.kind === "check_run") &&
        run.outcome && run.headSha &&
        commitShas.includes(run.headSha) && run.completedAt &&
        utcMillis(run.completedAt, "workflow completedAt") >= startedMs
        ? [run.completedAt]
        : []
    ).sort((a, b) =>
      utcMillis(a, "workflow completedAt") -
      utcMillis(b, "workflow completedAt")
    )[0] ?? null;
    const endedAt = endCap !== null && (completed === null ||
        utcMillis(completed, "workflow completedAt") >
          utcMillis(endCap, "PR end"))
      ? endCap
      : completed;
    return [{
      repo: record.repo,
      prNumber: record.number,
      blocker: "branch-refresh",
      startedAt: action.timestamp,
      endedAt,
    }];
  });
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
      actorId: review.actorId,
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
        actorId: event.actorId,
      });
    }
  }
  const { record } = observed;
  if (record.mergedAt !== null) {
    const mergeEvents = evidence.issueEvents.filter((event) =>
      event.event === "merged"
    );
    out.push({
      kind: "merge",
      id: mergeEvents.length === 1
        ? mergeEvents[0]!.id
        : observed.mergeCommitSha ?? "none",
      at: record.mergedAt,
      ms: utcMillis(record.mergedAt, "PR mergedAt"),
      actorId: mergeEvents.length === 1 ? mergeEvents[0]!.actorId : null,
      headSha: record.headSha,
    });
  }
  evidence.commits.forEach((commit, index) => {
    out.push({
      kind: index === 0 ? "implementation" : "repair",
      id: commit.sha,
      at: commit.at,
      ms: commit.ms,
      // Git authorship is self-set metadata, not the authenticated push actor.
      actorId: null,
    });
  });
  return out;
}

/** The GitHub event kinds that are commits, matched to a push by its delivered range. */
const COMMIT_EVENT_KINDS: ReadonlySet<PrActionKind> = new Set<PrActionKind>([
  "implementation",
  "repair",
]);

/**
 * Match reviews, dismissals and merges one-to-one. A commit matches a confirmed
 * implementation, repair or milestone push whose `deliveredCommits` contains it,
 * stamped at or after the commit and within the PR's lifetime; several commits
 * may share one such push. A branch update accounts for one commit within
 * MATCH_WINDOW_MS either side of its call. Matched event identifiers are
 * attached to the audit action. Unmatched events remain unknown unless their
 * numeric GitHub actor id is explicitly configured as human evidence.
 *
 * A review or dismissal matches a verified fleet action of its kind within
 * {@link MATCH_WINDOW_MS} either side of it. Reviews, dismissals and merges are
 * paired one-to-one by nearest gap, not event order, so an earlier nearby review
 * cannot take the action a later one recorded. A review's head is compared only
 * when both sides carry one, so a journalled review without a head still
 * matches a GitHub review that has a `commit_id`. A merge matches only a
 * confirmed merge action on the PR's head, within MATCH_WINDOW_MS either side
 * of the GitHub merge event. An auto-merge arm (`merge-arm`) never verifies a
 * later merge.
 */
function unmatchedActions(
  observed: ObservedPr,
  events: GitHubEvent[],
  verifiedFleet: TrustedPrAction[],
  used: Set<TrustedPrAction>,
  humanActorIds: ReadonlySet<string | null>,
): TrustedPrAction[] {
  const { record } = observed;
  const out: TrustedPrAction[] = [];
  /** The gap of an in-window pairing of one event with one action, or null. */
  const pairing = (
    event: GitHubEvent,
    action: TrustedPrAction,
  ): number | null => {
    const isCommit = COMMIT_EVENT_KINDS.has(event.kind);
    if (action.outcome !== "confirmed") return null;
    if (
      event.headSha !== undefined && action.headSha !== undefined &&
      event.headSha !== action.headSha
    ) return null;
    if (
      isCommit && action.kind !== "branch-update" &&
      !action.deliveredCommits?.includes(event.id)
    ) return null;
    const isPush = action.kind === "implementation" ||
      action.kind === "repair" || action.kind === "milestone" ||
      action.kind === "branch-update";
    if (event.kind === "merge" && action.headSha !== record.headSha) {
      return null;
    }
    if (
      isCommit
        ? !isPush || (action.kind === "branch-update" && used.has(action))
        : action.kind !== event.kind
    ) {
      return null;
    }
    const actionMs = utcMillis(action.timestamp, "action timestamp");
    const gap = Math.abs(actionMs - event.ms);
    const inWindow = event.kind === "merge"
      ? gap <= MATCH_WINDOW_MS
      : action.kind === "branch-update"
      ? gap <= MATCH_WINDOW_MS
      : isCommit
      ? actionMs >= event.ms &&
        actionMs <=
          Date.parse(
              record.mergedAt ?? record.closedAt ?? record.observedAt!,
            ) + LIFETIME_SLACK_MS
      : gap <= MATCH_WINDOW_MS;
    if (!inWindow) return null;
    return gap;
  };
  const assigned = new Map<GitHubEvent, TrustedPrAction>();
  // Reviews, dismissals and merges pair one-to-one by nearest gap, not event
  // order, so an earlier nearby review cannot take the action another review
  // actually recorded.
  const pairs: {
    event: GitHubEvent;
    action: TrustedPrAction;
    gap: number;
    order: number;
  }[] = [];
  events.forEach((event, order) => {
    if (COMMIT_EVENT_KINDS.has(event.kind)) return;
    for (const action of verifiedFleet) {
      const found = pairing(event, action);
      if (found !== null) pairs.push({ event, action, order, gap: found });
    }
  });
  pairs.sort((a, b) => a.gap - b.gap || a.order - b.order);
  for (const pair of pairs) {
    if (assigned.has(pair.event) || used.has(pair.action)) continue;
    assigned.set(pair.event, pair.action);
    used.add(pair.action);
  }
  for (const event of events) {
    let best: TrustedPrAction | undefined = assigned.get(event);
    // Commit events pick their nearest action here; none is in `assigned`.
    if (COMMIT_EVENT_KINDS.has(event.kind)) {
      let bestGap = Number.POSITIVE_INFINITY;
      for (const action of verifiedFleet) {
        const found = pairing(event, action);
        if (found !== null && found < bestGap) {
          best = action;
          bestGap = found;
        }
      }
    }
    if (best) {
      used.add(best);
      if (
        best.runId === REVIEW_LOG_RUN && !best.verified &&
        humanActorIds.has(event.actorId)
      ) {
        best.actor = "human";
        best.verified = true;
      }
      best.githubEvents ??= [];
      best.githubEvents.push({
        kind: event.kind,
        id: event.id,
        ...(event.headSha ? { headSha: event.headSha } : {}),
      });
      continue;
    }
    const human = humanActorIds.has(event.actorId);
    out.push({
      actionId: `gh:${record.repo}#${record.number}:${event.kind}:${event.id}`,
      runId: GITHUB_OBSERVATION_RUN,
      component: "unknown",
      repo: record.repo,
      prNumber: record.number,
      kind: event.kind,
      timestamp: event.at,
      outcome: human ? "confirmed" : "unknown",
      actor: human ? "human" : "unknown",
      verified: human,
    });
  }
  return out;
}

/** A current hold requires both the reviewer contract and verified action evidence. */
function verifyOwnerGate(
  record: PrCompletionRecord,
  evidence: PrEvidence,
  actions: TrustedPrAction[],
): void {
  if (
    record.state !== "open" || record.ownerGated !== true ||
    !evidence.reviewsComplete
  ) return;
  const latest = evidence.reviews.filter((review) =>
    review.headSha === record.headSha
  ).sort(byTime).at(-1);
  if (latest?.state !== "COMMENTED") return;
  const hold = ownerHoldFromBody(latest.body);
  if (hold === null) return;
  const action = actions.find((action) =>
    action.kind === "review" && action.component === "reviewer" &&
    action.verified && action.actor === "fleet" &&
    action.outcome === "confirmed" && action.githubEvents?.some((event) =>
      event.kind === "review" && event.id === latest.id
    )
  );
  if (action === undefined) return;
  record.ownerGateVerified = true;
  record.ownerGateEvidence = {
    ...hold,
    reviewId: latest.id,
    actionId: action.actionId,
    headSha: record.headSha,
    timestamp: latest.at,
  };
}

/** CI duration per check run; `null` when the run is not completed or lacks a time. */
async function ciRunsFor(
  gh: GhJson,
  record: PrCompletionRecord,
  headShas: string[],
  notes: string[],
  mergeCommit = false,
  markIncomplete: () => void = () => {},
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
      markIncomplete();
      notes.push(
        `${label}: ${source} history truncated for ${headSha ?? base}`,
      );
    }
    if (totalCount !== null && totalCount > items.length) {
      markIncomplete();
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
  const workflowPath = mergeCommit
    ? `repos/${record.repo}/actions/runs?head_sha=${
      encodeURIComponent(record.headSha)
    }`
    : `repos/${record.repo}/actions/runs?branch=${
      encodeURIComponent(record.headRef)
    }`;
  const workflows = await fetchPages(
    workflowPath,
    "workflow_runs",
    "workflow-run",
  );
  for (const run of workflows) {
    const headSha = asText(requiredKey(run, "head_sha", "workflow run"));
    if (headSha === null || !heads.includes(headSha)) continue;
    workflowRuns.set(asId(run.id, `${label} workflow run`), { run, headSha });
  }
  for (const headSha of mergeCommit ? [] : heads) {
    // filter=all: otherwise GitHub lists only the latest run per check name.
    const checks = await fetchPages(
      `repos/${record.repo}/commits/${headSha}/check-runs?filter=all`,
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
        completedAt: check.status === "completed"
          ? asText(check.completed_at)
          : null,
      });
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
      markIncomplete();
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
        completedAt: run.status === "completed" ? asText(run.updated_at) : null,
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
 *
 * A post-merge CI regression is a failed workflow run on a merged PR's merge
 * commit, completed at or after the merge. `failure`, `timed_out` and
 * `action_required` count; `cancelled` does not, since a concurrency
 * cancellation is not a failure. Only the merge commit's runs are read: a run
 * on the PR head is not a post-merge regression, and later default-branch
 * commits are not observed. It is resolved by a later successful attempt of the
 * same workflow on that commit.
 */
function regressionsFor(
  observed: ObservedPr[],
  postMergeRunsByPr: ReadonlyMap<string, readonly CiRun[]> = new Map(),
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
  for (const { record, mergeCommitSha } of observed) {
    if (!record.mergedAt || mergeCommitSha === null) continue;
    const mergeMs = utcMillis(record.mergedAt, "PR mergedAt");
    const runs = postMergeRunsByPr.get(keyOf(record.repo, record.number)) ?? [];
    const workflows = runs.filter((run) => run.kind === "workflow_run");
    const failedRuns = new Map<string, CiRun>();
    for (const failed of workflows) {
      if (
        !failed.completedAt || !failed.workflowId ||
        failed.headSha !== mergeCommitSha ||
        !["failure", "timed_out", "action_required"].includes(
          failed.outcome ?? "",
        ) || utcMillis(failed.completedAt!, "workflow completedAt") < mergeMs
      ) continue;
      const previous = failedRuns.get(failed.runId);
      if (!previous || failed.completedAt < previous.completedAt!) {
        failedRuns.set(failed.runId, failed);
      }
    }
    for (const failed of failedRuns.values()) {
      const recovered = workflows.some((candidate) =>
        candidate.workflowId === failed.workflowId &&
        candidate.headSha === failed.headSha &&
        candidate.outcome === "success" &&
        (candidate.runId !== failed.runId ||
          candidate.attempt! > failed.attempt!) &&
        candidate.completedAt !== null &&
        utcMillis(candidate.completedAt!, "workflow completedAt") >=
          utcMillis(failed.completedAt!, "workflow completedAt")
      );
      rows.push({
        repo: record.repo,
        prNumber: record.number,
        detectedAt: failed.completedAt!,
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
  endMs: number,
  expectedFingerprint: string,
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
      const rows = await readPrDiscoveryEvents(path, verifiedMs, endMs);
      for (const row of rows) {
        if (Date.parse(row.recordedAt) > endMs) continue;
        hosts.add(row.hostId);
        // Same-day dedup keeps the first row per key, so a row already carrying
        // the expected policy fingerprint stands for later scans too.
        if (
          Date.parse(row.recordedAt) < verifiedMs &&
          row.policyFingerprint !== expectedFingerprint
        ) continue;
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
 * the instant is stranded. Older rollout candidates are checked separately
 * from cohort PRs.
 */
function strandedAt(pr: PrCompletionRecord, verifiedMs: number): boolean {
  const createdMs = utcMillis(pr.createdAt, "PR createdAt");
  const endText = pr.mergedAt ?? pr.closedAt ?? null;
  const openAtVerification = endText === null ||
    utcMillis(endText, "PR end") > verifiedMs;
  return createdMs < verifiedMs &&
    verifiedMs - createdMs >= STRANDED_AGE_MS &&
    openAtVerification &&
    !(pr.ownerGated === true && pr.ownerGateVerified === true &&
      pr.ownerGateEvidence !== undefined &&
      utcMillis(pr.ownerGateEvidence.timestamp, "owner gate timestamp") <=
        verifiedMs);
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
  for (const id of options.humanActorIds ?? []) {
    if (!ACTOR_ID_PATTERN.test(id)) {
      throw new Error(
        `humanActorIds entry ${id} is not a numeric GitHub user id`,
      );
    }
  }
  const humanActorIds = new Set(options.humanActorIds ?? []);

  const notes: string[] = [];
  if (options.expected.inventory === undefined) {
    notes.push(
      "no expected host/component deployment inventory supplied; per-host rollout status is unavailable",
    );
  }
  const truncatedRepos: string[] = [];
  const audit = await readAuditEntries(options.auditDirs, notes);

  const observed: ObservedPr[] = [];
  const rolloutCandidates: ObservedPr[] = [];
  let rolloutPrsComplete = true;
  let openPrsBeforeCohort = 0;
  for (const repo of repos) {
    const repoObservation = await observeRepo(
      options.gh,
      repo,
      options.cohort,
      maxPrs,
      truncatedRepos,
      options.rolloutVerifiedAt,
    );
    observed.push(...repoObservation.observed);
    rolloutCandidates.push(...repoObservation.rolloutCandidates);
    rolloutPrsComplete &&= repoObservation.rolloutComplete;
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
  const rolloutCandidatesByKey = new Map<string, ObservedPr>();
  for (const candidate of rolloutCandidates) {
    if (
      strandedAt(
        candidate.record,
        utcMillis(
          options.rolloutVerifiedAt!,
          "rolloutVerifiedAt",
        ),
      )
    ) {
      const evidence = await fetchEvidence(
        options.gh,
        candidate.record.repo,
        candidate.record.number,
        notes,
      );
      const actions = verifiedActions.filter((action) =>
        action.repo === candidate.record.repo &&
        action.prNumber === candidate.record.number
      );
      unmatchedActions(
        candidate,
        gitHubEvents(candidate, evidence),
        actions.filter((action) => action.actor === "fleet"),
        new Set<TrustedPrAction>(),
        humanActorIds,
      );
      verifyOwnerGate(candidate.record, evidence, actions);
      rolloutCandidatesByKey.set(
        keyOf(candidate.record.repo, candidate.record.number),
        candidate,
      );
    }
  }
  const verifiedFleet = [
    ...verifiedActions.filter((action) =>
      action.verified && action.actor === "fleet"
    ),
  ];
  const fleetByPr = new Map<string, TrustedPrAction[]>();
  for (const action of verifiedFleet) {
    // A successful withdrawal before the GitHub merge invalidates an earlier
    // direct merge action; the withdrawal remains in the output history.
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
  const used = new Set<TrustedPrAction>();
  const supersededLogs = new Set<TrustedPrAction>();
  const githubActions: TrustedPrAction[] = [];
  const blockers: Blocker[] = [];
  const ciRuns: CiRun[] = [];
  const postMergeRunsByPr = new Map<string, CiRun[]>();
  const ciIncompletePrs = new Map<string, { repo: string; prNumber: number }>();
  let ciCallsRemaining = options.ciCallBudget ?? 5000;
  if (!Number.isSafeInteger(ciCallsRemaining) || ciCallsRemaining < 0) {
    throw new Error("ciCallBudget must be a non-negative safe integer");
  }
  class CiBudgetExhausted extends Error {}
  const ciGh: GhJson = (path) => {
    if (ciCallsRemaining === 0) throw new CiBudgetExhausted();
    ciCallsRemaining--;
    return options.gh(path);
  };
  const boundedCi = async (
    record: PrCompletionRecord,
    heads: string[],
    mergeCommit = false,
  ): Promise<CiRun[]> => {
    const markIncomplete = () =>
      ciIncompletePrs.set(
        keyOf(record.repo, record.number),
        { repo: record.repo, prNumber: record.number },
      );
    try {
      return await ciRunsFor(
        ciGh,
        record,
        heads,
        notes,
        mergeCommit,
        markIncomplete,
      );
    } catch (error) {
      if (!(error instanceof CiBudgetExhausted)) throw error;
      markIncomplete();
      notes.push(
        `${
          keyOf(record.repo, record.number)
        }: CI history truncated; collection call budget exhausted`,
      );
      return [];
    }
  };
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
    const events = gitHubEvents(o, evidence);
    const fleet = fleetByPr.get(keyOf(record.repo, record.number)) ?? [];
    blockers.push(...recoveryBlockersFor(record, fleet));
    const unmatched = unmatchedActions(o, events, fleet, used, humanActorIds);
    // Reserve the log row for a matched reviewer post before another GitHub
    // review can claim it. Unmatched journal actions cannot supersede logs.
    for (
      const action of fleet.filter((item) =>
        item.component === "reviewer" && item.kind === "review" &&
        item.githubEvents?.some((event) => event.kind === "review")
      )
    ) {
      const candidates = logActions.filter((log) =>
        !supersededLogs.has(log) && log.repo === action.repo &&
        log.prNumber === action.prNumber &&
        (!log.headSha || !action.headSha || log.headSha === action.headSha) &&
        Math.abs(Date.parse(log.timestamp) - Date.parse(action.timestamp)) <=
          MATCH_WINDOW_MS
      );
      candidates.sort((a, b) =>
        Math.abs(Date.parse(a.timestamp) - Date.parse(action.timestamp)) -
        Math.abs(Date.parse(b.timestamp) - Date.parse(action.timestamp))
      );
      if (candidates[0]) supersededLogs.add(candidates[0]);
    }
    const unmatchedIds = new Set(unmatched.map((action) => action.actionId));
    githubActions.push(...unmatchedActions(
      o,
      events.filter((event) =>
        unmatchedIds.has(
          `gh:${record.repo}#${record.number}:${event.kind}:${event.id}`,
        )
      ),
      logActions.filter((action) =>
        action.repo === record.repo && action.prNumber === record.number &&
        !supersededLogs.has(action)
      ),
      used,
      humanActorIds,
    ));
    verifyOwnerGate(
      record,
      evidence,
      fleetByPr.get(keyOf(record.repo, record.number)) ?? [],
    );
    const prCiRuns = await boundedCi(
      record,
      evidence.commits.map((commit) => commit.sha),
    );
    ciRuns.push(...prCiRuns);
    blockers.push(
      ...ciBlockersFor(record, prCiRuns, options.cohort.observedAt),
      ...branchRefreshBlockersFor(record, fleet, prCiRuns),
    );
    // Merge-commit runs feed only the post-merge regressions, not CI cost
    // totals, so they are read separately and kept out of `ciRuns`.
    if (record.mergedAt !== null) {
      if (o.mergeCommitSha === null) {
        notes.push(
          `${
            keyOf(record.repo, record.number)
          }: merge commit SHA is null or absent; post-merge CI is not observed`,
        );
      } else {
        postMergeRunsByPr.set(
          keyOf(record.repo, record.number),
          await boundedCi(
            { ...record, headSha: o.mergeCommitSha },
            [],
            true,
          ),
        );
      }
    }
  }
  if ((options.reviewLogs ?? []).length === 0 && reviewEvents > 0) {
    const events = reviewEvents === 1 ? "review event" : "review events";
    const prs = prsWithReviewEvents === 1 ? "PR" : "PRs";
    notes.push(
      `${reviewEvents} ${events} on ${prsWithReviewEvents} ${prs} had no review-log source; ` +
        "reviews without a matching verified audit action or an explicitly allowlisted human actor stay unknown",
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
      Math.min(observedMs, verifiedMs + 14 * 86_400_000),
      options.expected.policyFingerprint,
      notes,
    );
    discovery.complete &&= rolloutPrsComplete;
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
      strandedPrs: [
        ...records,
        ...[...rolloutCandidatesByKey.values()].map((candidate) =>
          candidate.record
        ),
      ].filter((pr) => strandedAt(pr, verifiedMs)).map(
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
      ...logActions.filter((action) => !supersededLogs.has(action)),
      ...githubActions,
    ],
    blockers,
    ciRuns,
    ciIncompletePrs: [...ciIncompletePrs.values()],
    regressions: regressionsFor(observed, postMergeRunsByPr),
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
