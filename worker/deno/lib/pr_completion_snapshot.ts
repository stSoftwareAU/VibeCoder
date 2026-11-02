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
 * audit action of the same kind sits within {@link MATCH_WINDOW_MS} of it.
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

import type { AuditEntry } from "./audit_entry.ts";
import { loadEntries, verifyAllChains } from "./audit_journal.ts";
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
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** A GitHub event matches a verified fleet action within this window. */
const MATCH_WINDOW_MS = 10 * MINUTE_MS;
/** Commits closer than this together form one push group. */
const PUSH_GROUP_MS = 2 * MINUTE_MS;
const STRANDED_AGE_MS = DAY_MS;
const PER_PAGE = 100;
/** Pages read for reviews, issue events and commits of one PR. */
const EVENT_PAGE_LIMIT = 10;
const DEFAULT_MAX_PRS_PER_REPO = 500;
const COMPONENT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
/** Bounds applied to free text before any pattern runs over it. */
const TEXT_BOUND = 20_000;
/** Anchored and bounded: a title that opens `Revert "…"`. */
const REVERT_TITLE = /^Revert "[^"\n]{1,300}"/;
const REVERT_REFERENCE = /\bReverts?\s+#(\d{1,7})\b/gi;
const QUOTED_PR_REFERENCE = /\(#(\d{1,7})\)/g;
const ROLLUP_LINE = /\brollup of\b|^\s*includes\b/i;
const PR_REFERENCE = /#(\d{1,7})\b/g;

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

/** Pull requests cited as the subject of a rollup line in `text`. */
function rollupTargets(text: string): number[] {
  const found: number[] = [];
  for (const line of text.slice(0, TEXT_BOUND).split("\n")) {
    if (!ROLLUP_LINE.test(line)) continue;
    for (const match of line.matchAll(PR_REFERENCE)) {
      found.push(Number(match[1]));
    }
  }
  return found;
}

/**
 * Milestone PRs named by a default-branch rollup. A milestone PR gets a
 * `rollupRoot` only when exactly one default-branch PR in the cohort claims
 * it with "Rollup of" or "Includes" wording; anything ambiguous stays unset.
 */
function deriveRollupRoots(observed: ObservedPr[]): void {
  const byNumber = new Map(observed.map((o) => [o.record.number, o.record]));
  const claimants = new Map<number, Set<number>>();
  for (const o of observed) {
    const pr = o.record;
    if (pr.baseRef !== pr.defaultBranch || pr.milestone) continue;
    for (const target of rollupTargets(`${o.title}\n${o.body}`)) {
      const milestonePr = byNumber.get(target);
      if (!milestonePr?.milestone || target === pr.number) continue;
      const set = claimants.get(target) ?? new Set<number>();
      set.add(pr.number);
      claimants.set(target, set);
    }
  }
  for (const [target, roots] of claimants) {
    if (roots.size !== 1) continue;
    const [root] = roots;
    const milestonePr = byNumber.get(target)!;
    milestonePr.rollupRoot = keyOf(milestonePr.repo, root!);
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
  const mergedAt = asText(raw.merged_at);
  const state: PrState = mergedAt !== null
    ? "merged"
    : raw.state === "open"
    ? "open"
    : "closed";
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((item) => asText(asObject(item, `${label}.label`).name))
    : [];
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
      closedAt: asText(raw.closed_at),
      observedAt,
      milestone: baseRef.startsWith("milestone/"),
      ownerGated: labels.includes("needs-human"),
      ownerGateVerified: false,
      actionsComplete: false,
    },
    title: asText(raw.title) ?? "",
    body: typeof raw.body === "string" ? raw.body : "",
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
): Promise<ObservedPr[]> {
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
  return observed;
}

function parseReview(raw: unknown, what: string): Review | null {
  const o = asObject(raw, what);
  const submitted = asText(o.submitted_at);
  if (submitted === null) return null;
  return {
    id: asId(o.id, what),
    state: asText(o.state) ?? "",
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
 * `endedAt: null`. CI-failing and hold blockers are not produced yet.
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
 * The GitHub-observed events for one PR: submitted reviews, dismissals, the
 * merge, and one implementation (first) or repair (later) event per push
 * group. Commits within {@link PUSH_GROUP_MS} of the previous one share a group.
 */
function gitHubEvents(
  observed: ObservedPr,
  evidence: PrEvidence,
): GitHubEvent[] {
  const out: GitHubEvent[] = [];
  for (const review of evidence.reviews) {
    out.push({ kind: "review", id: review.id, at: review.at, ms: review.ms });
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
    });
  }
  const groups: Commit[][] = [];
  for (const commit of [...evidence.commits].sort(byTime)) {
    const current = groups[groups.length - 1];
    if (
      current && commit.ms - current[current.length - 1]!.ms <= PUSH_GROUP_MS
    ) {
      current.push(commit);
    } else {
      groups.push([commit]);
    }
  }
  groups.forEach((group, index) => {
    const last = group[group.length - 1]!;
    out.push({
      kind: index === 0 ? "implementation" : "repair",
      id: last.sha,
      at: last.at,
      ms: last.ms,
    });
  });
  return out;
}

/**
 * Match each GitHub event to at most one verified fleet action of the same
 * kind on the same PR within {@link MATCH_WINDOW_MS}. Matched events add
 * nothing: the audit action already stands for them. Unmatched events become
 * `unknown` actions, never attributed to a human or the fleet.
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
      if (used.has(action) || action.kind !== event.kind) continue;
      const gap = Math.abs(
        utcMillis(action.timestamp, "action timestamp") -
          event.ms,
      );
      if (gap <= MATCH_WINDOW_MS && gap < bestGap) {
        best = action;
        bestGap = gap;
      }
    }
    if (best) {
      used.add(best);
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
  notes: string[],
): Promise<CiRun[]> {
  const path =
    `repos/${record.repo}/commits/${record.headSha}/check-runs?per_page=${PER_PAGE}`;
  const body = asObject(await gh(path), path);
  const runs = asList(body.check_runs, path).map((run) =>
    asObject(run, `${path} check run`)
  );
  const total = body.total_count;
  const label = keyOf(record.repo, record.number);
  if (typeof total === "number" && total > runs.length) {
    notes.push(`${label}: ${runs.length} of ${total} check runs listed`);
  }
  return runs.map((run) => {
    const started = asText(run.started_at);
    const completed = asText(run.completed_at);
    const duration = run.status === "completed" && started !== null &&
        completed !== null
      ? (utcMillis(completed, `${label} check completed_at`) -
        utcMillis(started, `${label} check started_at`)) / MINUTE_MS
      : null;
    return {
      repo: record.repo,
      prNumber: record.number,
      runId: String(asId(run.id, `${label} check run`)),
      durationMinutes: duration !== null && duration >= 0 ? duration : null,
    };
  });
}

/** Revert targets named by a PR's title or body. Every pattern is anchored or bounded. */
function revertedNumbers(title: string, body: string): number[] {
  const head = title.slice(0, 1_000);
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
function regressionsFor(observed: ObservedPr[]): Regression[] {
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
  return [...earliest.values()].map(({ createdAt: _createdAt, ...row }) => row);
}

/** One deployment row, or the reason the record is unusable. */
function deploymentRow(
  component: unknown,
  revision: unknown,
  fingerprint: unknown,
  observedAt: unknown,
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
  try {
    utcMillis(observedAt, "observedAt");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return {
    component,
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
      if (typeof deployment !== "object" || deployment === null) continue;
      const d = deployment as Json;
      const row = deploymentRow(
        d.component,
        d.codeRevision,
        d.policyFingerprint,
        d.observedAt,
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

/** One audit entry, with whether its journal's directory chain verified. */
interface JournalEntry {
  entry: AuditEntry;
  verified: boolean;
}

/** Journal files directly under an audit directory. */
async function listJournals(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".jsonl")) {
      names.push(`${dir}/${entry.name}`);
    }
  }
  return names.sort();
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
      const swept = await verifyAllChains(dir);
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
      for (const path of journals) {
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
          if (!previous || (!previous.verified && verified)) {
            byId.set(id, { entry, verified });
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
 * Link a branch push to a cohort PR by repo and branch: the latest PR on
 * that head ref created at or before the push. Journals carry no PR number
 * for pushes.
 */
function linkBranchPush(
  entry: AuditEntry,
  observed: ObservedPr[],
): AuditEntry {
  if (
    entry.verb !== "git-push" || entry.prNumber || !entry.repo || !entry.target
  ) {
    return entry;
  }
  const pushedMs = Date.parse(entry.timestamp);
  let best: PrCompletionRecord | undefined;
  for (const { record } of observed) {
    if (
      record.repo !== entry.repo || record.headRef !== entry.target ||
      Date.parse(record.createdAt) > pushedMs
    ) continue;
    if (!best || Date.parse(record.createdAt) > Date.parse(best.createdAt)) {
      best = record;
    }
  }
  return best ? { ...entry, prNumber: best.number } : entry;
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
  const truncatedRepos: string[] = [];
  const audit = await readAuditEntries(options.auditDirs, notes);

  const observed: ObservedPr[] = [];
  for (const repo of repos) {
    observed.push(
      ...await observeRepo(
        options.gh,
        repo,
        options.cohort,
        maxPrs,
        truncatedRepos,
      ),
    );
  }
  for (const o of observed) o.record.actionsComplete = audit.complete;

  const linked = audit.entries.map(({ entry, verified }) => ({
    entry: linkBranchPush(entry, observed),
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
  const verifiedFleet = verifiedActions.filter((action) =>
    action.verified && action.actor === "fleet"
  );
  const fleetByPr = new Map<string, TrustedPrAction[]>();
  for (const action of verifiedFleet) {
    const key = keyOf(action.repo, action.prNumber);
    const list = fleetByPr.get(key) ?? [];
    list.push(action);
    fleetByPr.set(key, list);
  }

  const used = new Set<TrustedPrAction>();
  const githubActions: TrustedPrAction[] = [];
  const blockers: Blocker[] = [];
  const ciRuns: CiRun[] = [];
  for (const o of observed) {
    const { record } = o;
    const evidence = await fetchEvidence(
      options.gh,
      record.repo,
      record.number,
      notes,
    );
    blockers.push(...blockersFor(record, evidence));
    githubActions.push(
      ...unmatchedActions(
        o,
        gitHubEvents(o, evidence),
        fleetByPr.get(keyOf(record.repo, record.number)) ?? [],
        used,
      ),
    );
    if (record.state === "merged") {
      ciRuns.push(...await ciRunsFor(options.gh, record, notes));
    }
  }

  const deployments = await collectDeployments(options, observedMs, notes);
  const records = observed.map((o) => o.record);
  let rollout: PrCompletionInput["rollout"];
  if (options.rolloutVerifiedAt !== undefined) {
    const verifiedMs = utcMillis(
      options.rolloutVerifiedAt,
      "rolloutVerifiedAt",
    );
    rollout = {
      verifiedAt: options.rolloutVerifiedAt,
      strandedPrs: records.filter((pr) =>
        pr.state === "open" &&
        observedMs - utcMillis(pr.createdAt, "PR createdAt") >
          STRANDED_AGE_MS &&
        utcMillis(pr.createdAt, "PR createdAt") < verifiedMs &&
        pr.ownerGated !== true
      ).map((pr) => {
        const fleet = verifiedFleet.filter((action) =>
          action.repo === pr.repo && action.prNumber === pr.number &&
          utcMillis(action.timestamp, "action timestamp") >= verifiedMs
        );
        return {
          repo: pr.repo,
          prNumber: pr.number,
          eligible: true,
          rediscovered: fleet.length > 0,
          processed: fleet.some((action) =>
            action.outcome === "confirmed" && action.kind !== "unknown"
          ),
        };
      }),
    };
  }

  const input: PrCompletionInput = {
    cohort: { ...options.cohort },
    prs: records,
    actions: [...verifiedActions, ...unverifiedActions, ...githubActions],
    blockers,
    ciRuns,
    regressions: regressionsFor(observed),
    deployments,
    expectedDeployment: {
      components: [...options.expected.components],
      revision: options.expected.revision,
      policyFingerprint: options.expected.policyFingerprint,
      maxHeartbeatAgeHours: options.expected.maxHeartbeatAgeHours,
    },
    ...(rollout ? { rollout } : {}),
  };
  return { input, coverageNotes: notes, truncatedRepos };
}
