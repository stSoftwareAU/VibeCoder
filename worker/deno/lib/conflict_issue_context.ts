/**
 * Originating-issue context for both sides of a conflicting PR
 * (Issue #1113, parent #1076).
 *
 * The merge-conflict agent sees the conflicted working tree and nothing else,
 * so it reads "the same constant set to two different values" as a genuine
 * contradiction and stops. Often it is not one: one issue superseded the
 * other, and the answer is written down in an issue neither side of the merge
 * can see. This module answers the question the resolver cannot currently ask
 * — **what were the two sides trying to do?** — by resolving:
 *
 * - the **PR side**: the issue the conflicting PR itself came from, and
 * - the **base side**: for each conflicted path, the issues behind the
 *   base-branch commits that changed that path since the merge base.
 *
 * It reports; it does not decide. Nothing here judges whether one issue
 * supersedes the other, and nothing here is wired into the resolution path —
 * that is #1114.
 *
 * **Absence is a first-class result.** "No originating issue found" is
 * returned as a stated reason, never as an empty list: the resolver's
 * behaviour when it has no intent to consult differs materially from its
 * behaviour when both intents are known, and it cannot tell those apart from
 * `[]`.
 *
 * **Everything is bounded.** This runs inside a pass with a ten-minute
 * per-attempt budget and a shared rate limit, so an unbounded `git log` over a
 * long-lived base branch mapped commit-by-commit through the GitHub API is not
 * viable. Commits per path, issues returned, characters of issue text and
 * total `gh` calls all have documented defaults
 * ({@link DEFAULT_CONFLICT_ISSUE_CONTEXT_BOUNDS}), and every bound that bites
 * is declared in {@link ConflictIssueContext.truncation}.
 *
 * The base walk is `--first-parent`, so it sees the base branch's own merge
 * and squash commits rather than every commit each merged PR brought with it.
 * A base commit whose subject carries no PR reference is reported as
 * `"no-pr"` rather than mapped through a per-commit API lookup — one bounded
 * git call per path is the whole cost.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { type GitRunner, resolveComparableBaseRef } from "./git_base_ref.ts";
import { issueNumberFromBranch } from "./issue_branch_candidates.ts";
import {
  extractClosingIssueNumbers,
  extractIssueNumberFromPrTitle,
} from "./pr_body.ts";

/** Which signal produced the PR-side originating issue. */
export type PrOriginSignal = "branch" | "body" | "linkage";

/** Why the PR side could not be resolved. */
export type PrUnresolvedReason =
  /** No branch shape, closing keyword or GitHub linkage named an issue. */
  | "no-signal"
  /** An issue was named but `gh` could not read it. */
  | "lookup-failed"
  /** A bound was reached before the issue could be read. */
  | "budget-exhausted";

/** Why a conflicted path's base side could not be resolved. */
export type BaseUnresolvedReason =
  /** The merge base of the PR branch and the base branch is unusable. */
  | "merge-base-unavailable"
  /** `git log` failed for this path. */
  | "git-error"
  /** No base commit touched this path since the merge base. */
  | "no-commits"
  /** Base commits exist, but none names a PR. */
  | "no-pr"
  /** PRs were identified, but none names an issue. */
  | "no-issue"
  /** A `gh` call failed while mapping PRs to issues. */
  | "lookup-failed"
  /** A bound was reached before this path could be resolved. */
  | "budget-exhausted";

/** An originating issue, with its text bounded for prompt use. */
export interface OriginatingIssue {
  number: number;
  title: string;
  /** GitHub issue state, e.g. `OPEN` / `CLOSED`. */
  state: string;
  /** Issue body, cut to fit the character budget. */
  body: string;
  /** True when {@link body} was cut. */
  bodyTruncated: boolean;
}

/** The issue the conflicting PR itself came from — or why there is none. */
export type PrSideOrigin =
  | { resolved: true; signal: PrOriginSignal; issue: OriginatingIssue }
  | { resolved: false; reason: PrUnresolvedReason };

/** What the base branch was trying to do to one conflicted path. */
export interface BasePathOrigin {
  /** The conflicted path this entry is keyed to. */
  path: string;
  /** Base commits actually inspected (bounded per path). */
  commitsInspected: number;
  /** PRs identified from those commits' subjects, in newest-first order. */
  prNumbers: number[];
  /** Issues those PRs name. Empty whenever {@link unresolved} is set. */
  issues: OriginatingIssue[];
  /** `null` when at least one issue was resolved; otherwise why not. */
  unresolved: BaseUnresolvedReason | null;
}

/** Which bounds bit, so a caller never mistakes a cut result for a whole one. */
export interface ConflictContextTruncation {
  /** Paths where the per-path commit cap stopped the walk. */
  commitCapPaths: string[];
  /** True when the total-issue cap dropped an identified issue. */
  issueCapHit: boolean;
  /** Issues whose body text was cut to fit the character budget. */
  textTruncatedIssues: number[];
  /** True when the `gh` call budget ran out before the walk finished. */
  ghCallCapHit: boolean;
}

/** The gathered context for one conflicting PR. */
export interface ConflictIssueContext {
  repo: string;
  prNumber: number;
  /** The PR side's origin, resolved or explicitly not. */
  prSide: PrSideOrigin;
  /** One entry per conflicted path, in the order given. */
  baseSide: BasePathOrigin[];
  /** Which bounds bit. */
  truncation: ConflictContextTruncation;
  /** `gh` calls actually spent. */
  ghCallsUsed: number;
  /** Failures encountered, stated rather than swallowed. */
  warnings: string[];
}

/** Bounds on the work this module will do. */
export interface ConflictIssueContextBounds {
  /** Base commits inspected per conflicted path. */
  maxCommitsPerPath: number;
  /** Distinct issues fetched across the whole result. */
  maxIssues: number;
  /** Total characters of issue body text across the whole result. */
  maxIssueTextChars: number;
  /** Total `gh` invocations. */
  maxGhCalls: number;
}

/**
 * Documented defaults.
 *
 * Sized for one attempt inside the merge-conflict pass: 20 first-parent
 * commits is several months of a busy path's history, 8 issues at 4000
 * characters of body text is roughly a page of prompt, and 30 `gh` calls
 * keeps the shared rate limit intact even when every path resolves.
 */
export const DEFAULT_CONFLICT_ISSUE_CONTEXT_BOUNDS: ConflictIssueContextBounds =
  {
    maxCommitsPerPath: 20,
    maxIssues: 8,
    maxIssueTextChars: 4000,
    maxGhCalls: 30,
  };

/** What to gather context for. */
export interface ConflictIssueContextRequest {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The conflicting PR's number. */
  prNumber: number;
  /** The PR's head branch. */
  prBranch: string;
  /** The PR's base branch. */
  baseBranch: string;
  /** Conflicted paths, as `git diff --name-only --diff-filter=U` reports them. */
  conflictedPaths: readonly string[];
  /** The PR body, when the caller already has it — saves a `gh` call. */
  prBody?: string;
  /** Working directory of the clone. */
  cwd?: string;
}

/** Injected seams. */
export interface ConflictIssueContextDeps {
  /** Git runner, matching `deps.git.runGitCommand`. */
  git: GitRunner;
  /** `gh` runner returning stdout; throws on failure. */
  gh: (args: string[]) => Promise<string>;
  /** Bound overrides; anything omitted takes its documented default. */
  bounds?: Partial<ConflictIssueContextBounds>;
}

/** Field separator in the `git log` format — never appears in a subject. */
const LOG_FIELD_SEPARATOR = "\x1f";

/** `Merge pull request #99 from …` — GitHub's merge-commit subject. */
const MERGE_COMMIT_SUBJECT = /^Merge pull request #(\d+)\b/;

/** `Some title (#99)` — GitHub's squash-merge subject. */
const SQUASH_COMMIT_SUBJECT = /\(#(\d+)\)\s*$/;

/** A commit SHA as git prints it. */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

/**
 * The PR number a base-branch commit subject names, or `null`.
 *
 * Recognises GitHub's two merge shapes and nothing else — `Fix issue #99`
 * names an issue, not a PR, and must not be read as one.
 */
export function prNumberFromCommitSubject(subject: string): number | null {
  const merge = MERGE_COMMIT_SUBJECT.exec(subject);
  const squash = merge ? null : SQUASH_COMMIT_SUBJECT.exec(subject);
  const digits = merge?.[1] ?? squash?.[1];
  if (digits === undefined) return null;
  const prNumber = Number(digits);
  return Number.isSafeInteger(prNumber) && prNumber > 0 ? prNumber : null;
}

/** A PR as `gh pr view` reports it. */
interface PrView {
  number: number;
  title: string;
  body: string;
  /** Issues GitHub itself considers this PR to close. */
  closingIssues: number[];
}

/** Outcome of a bounded lookup: the value, or why there is none. */
type Lookup<T> =
  | { ok: true; value: T }
  | { ok: false; budgetExhausted: boolean };

/** Mutable state threaded through one gather. */
interface GatherState {
  repo: string;
  gh: (args: string[]) => Promise<string>;
  bounds: ConflictIssueContextBounds;
  ghCallsUsed: number;
  textCharsUsed: number;
  warnings: string[];
  truncation: ConflictContextTruncation;
  issueCache: Map<number, OriginatingIssue>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one `gh` call against the budget.
 *
 * A failure is recorded as a warning and returned as `ok: false` — never
 * swallowed into an empty result that reads as "nothing to find".
 */
async function runGh(
  state: GatherState,
  args: string[],
  what: string,
): Promise<Lookup<string>> {
  if (state.ghCallsUsed >= state.bounds.maxGhCalls) {
    state.truncation.ghCallCapHit = true;
    return { ok: false, budgetExhausted: true };
  }
  state.ghCallsUsed++;
  try {
    return { ok: true, value: await state.gh(args) };
  } catch (error) {
    state.warnings.push(`${what} failed: ${errorMessage(error)}`);
    return { ok: false, budgetExhausted: false };
  }
}

/** Take issue text from the shared character budget, cutting if needed. */
function takeIssueText(
  state: GatherState,
  issueNumber: number,
  text: string,
): { body: string; truncated: boolean } {
  const remaining = Math.max(
    0,
    state.bounds.maxIssueTextChars - state.textCharsUsed,
  );
  if (text.length <= remaining) {
    state.textCharsUsed += text.length;
    return { body: text, truncated: false };
  }
  state.textCharsUsed += remaining;
  state.truncation.textTruncatedIssues.push(issueNumber);
  return { body: text.slice(0, remaining), truncated: true };
}

/** Fetch an issue's number, title, state and bounded body. */
async function fetchIssue(
  state: GatherState,
  issueNumber: number,
): Promise<Lookup<OriginatingIssue>> {
  const cached = state.issueCache.get(issueNumber);
  if (cached) return { ok: true, value: cached };

  if (state.issueCache.size >= state.bounds.maxIssues) {
    state.truncation.issueCapHit = true;
    return { ok: false, budgetExhausted: true };
  }

  const what = `gh issue view #${issueNumber}`;
  const output = await runGh(state, [
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    state.repo,
    "--json",
    "number,title,state,body",
  ], what);
  if (!output.ok) return output;

  let parsed: { title?: string; state?: string; body?: string };
  try {
    parsed = JSON.parse(output.value);
  } catch (error) {
    state.warnings.push(
      `${what} returned unparseable JSON: ${errorMessage(error)}`,
    );
    return { ok: false, budgetExhausted: false };
  }

  const text = takeIssueText(state, issueNumber, String(parsed.body ?? ""));
  const issue: OriginatingIssue = {
    number: issueNumber,
    title: String(parsed.title ?? ""),
    state: String(parsed.state ?? ""),
    body: text.body,
    bodyTruncated: text.truncated,
  };
  state.issueCache.set(issueNumber, issue);
  return { ok: true, value: issue };
}

/** Fetch a PR's title, body and closing-issue references in one call. */
async function fetchPrView(
  state: GatherState,
  prNumber: number,
): Promise<Lookup<PrView>> {
  const what = `gh pr view #${prNumber}`;
  const output = await runGh(state, [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    state.repo,
    "--json",
    "number,title,body,closingIssuesReferences",
  ], what);
  if (!output.ok) return output;

  let parsed: {
    title?: string;
    body?: string;
    closingIssuesReferences?: Array<{ number?: number }>;
  };
  try {
    parsed = JSON.parse(output.value);
  } catch (error) {
    state.warnings.push(
      `${what} returned unparseable JSON: ${errorMessage(error)}`,
    );
    return { ok: false, budgetExhausted: false };
  }

  const closingIssues: number[] = [];
  for (const reference of parsed.closingIssuesReferences ?? []) {
    const number = reference?.number;
    if (
      typeof number === "number" && Number.isSafeInteger(number) &&
      number > 0 && !closingIssues.includes(number)
    ) {
      closingIssues.push(number);
    }
  }

  return {
    ok: true,
    value: {
      number: prNumber,
      title: String(parsed.title ?? ""),
      body: String(parsed.body ?? ""),
      closingIssues,
    },
  };
}

/** Turn a bounded-lookup failure into the matching PR-side reason. */
function prReasonFor(budgetExhausted: boolean): PrUnresolvedReason {
  return budgetExhausted ? "budget-exhausted" : "lookup-failed";
}

/**
 * Resolve the PR side, in precedence order: the `issue-<n>-…` branch shape,
 * then the body's closing keywords, then GitHub's own linkage. First hit
 * wins, and the winning signal is recorded.
 */
async function resolvePrSide(
  state: GatherState,
  request: ConflictIssueContextRequest,
): Promise<PrSideOrigin> {
  const finish = async (
    issueNumber: number,
    signal: PrOriginSignal,
  ): Promise<PrSideOrigin> => {
    const issue = await fetchIssue(state, issueNumber);
    return issue.ok
      ? { resolved: true, signal, issue: issue.value }
      : { resolved: false, reason: prReasonFor(issue.budgetExhausted) };
  };

  // 1. The branch shape — free, and the worker's own convention.
  const branchIssue = issueNumberFromBranch(request.prBranch);
  if (branchIssue !== null) return await finish(branchIssue, "branch");

  // The body and the linkage both come from one PR view.
  let view: PrView | null = null;
  if (request.prBody === undefined) {
    const fetched = await fetchPrView(state, request.prNumber);
    if (!fetched.ok) {
      return { resolved: false, reason: prReasonFor(fetched.budgetExhausted) };
    }
    view = fetched.value;
  }

  // 2. The body's closing keywords.
  const bodyIssue = extractClosingIssueNumbers(request.prBody ?? view!.body)[0];
  if (bodyIssue !== undefined) return await finish(bodyIssue, "body");

  // 3. GitHub's own linkage.
  if (view === null) {
    const fetched = await fetchPrView(state, request.prNumber);
    if (!fetched.ok) {
      return { resolved: false, reason: prReasonFor(fetched.budgetExhausted) };
    }
    view = fetched.value;
  }
  const linkedIssue = view.closingIssues[0];
  if (linkedIssue !== undefined) return await finish(linkedIssue, "linkage");

  return { resolved: false, reason: "no-signal" };
}

/** The merge base to walk the base branch from. */
interface BaseWalkAnchor {
  mergeBase: string;
  baseRef: string;
}

/**
 * Resolve the merge base of the PR branch and the base branch.
 *
 * Returns `null` — with a warning naming the cause — when the walk cannot
 * start. Every caller turns that into an explicit per-path
 * `"merge-base-unavailable"` rather than an empty base side.
 */
async function resolveBaseWalkAnchor(
  state: GatherState,
  request: ConflictIssueContextRequest,
  git: GitRunner,
): Promise<BaseWalkAnchor | null> {
  const cwd = request.cwd;
  const resolveRef = async (branch: string): Promise<string | null> => {
    try {
      const resolved = await resolveComparableBaseRef(git, branch, { cwd });
      if (resolved.ok) return resolved.value;
      state.warnings.push(
        `merge base walk skipped: ${resolved.error.message}`,
      );
    } catch (error) {
      state.warnings.push(
        `merge base walk skipped: '${branch}' is not a usable ref (${
          errorMessage(error)
        })`,
      );
    }
    return null;
  };

  const baseRef = await resolveRef(request.baseBranch);
  if (baseRef === null) return null;
  const headRef = await resolveRef(request.prBranch);
  if (headRef === null) return null;

  const result = await git(["merge-base", baseRef, headRef], { cwd });
  const sha = result.ok ? result.value.stdout.trim() : "";
  if (!result.ok || result.value.code !== 0 || !COMMIT_SHA.test(sha)) {
    const detail = result.ok
      ? `exit ${result.value.code}: ${result.value.stderr.trim()}`
      : result.error.message;
    state.warnings.push(
      `no merge base between '${baseRef}' and '${headRef}' (${detail})`,
    );
    return null;
  }
  return { mergeBase: sha, baseRef };
}

/** An unresolved base-side entry — absence stated, never silence. */
function unresolvedPath(
  path: string,
  reason: BaseUnresolvedReason,
  commitsInspected = 0,
  prNumbers: number[] = [],
): BasePathOrigin {
  return { path, commitsInspected, prNumbers, issues: [], unresolved: reason };
}

/** Base commits touching one path since the merge base, bounded. */
async function inspectPathCommits(
  state: GatherState,
  request: ConflictIssueContextRequest,
  git: GitRunner,
  anchor: BaseWalkAnchor,
  path: string,
): Promise<Lookup<{ subjects: string[] }>> {
  const cap = state.bounds.maxCommitsPerPath;
  // One more than the cap, so "capped" is a fact rather than a guess.
  const result = await git([
    "log",
    "--first-parent",
    `--max-count=${cap + 1}`,
    `--format=%H%x1f%s`,
    `${anchor.mergeBase}..${anchor.baseRef}`,
    "--",
    path,
  ], { cwd: request.cwd });

  if (!result.ok || result.value.code !== 0) {
    const detail = result.ok
      ? `exit ${result.value.code}: ${result.value.stderr.trim()}`
      : result.error.message;
    state.warnings.push(`git log failed for '${path}' (${detail})`);
    return { ok: false, budgetExhausted: false };
  }

  const lines = result.value.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length > cap) state.truncation.commitCapPaths.push(path);

  const subjects = lines.slice(0, cap).map((line) => {
    const separator = line.indexOf(LOG_FIELD_SEPARATOR);
    return separator < 0 ? line : line.slice(separator + 1);
  });
  return { ok: true, value: { subjects } };
}

/** Resolve the base side for one conflicted path. */
async function gatherPathOrigin(
  state: GatherState,
  request: ConflictIssueContextRequest,
  git: GitRunner,
  anchor: BaseWalkAnchor,
  path: string,
): Promise<BasePathOrigin> {
  const commits = await inspectPathCommits(state, request, git, anchor, path);
  if (!commits.ok) return unresolvedPath(path, "git-error");

  const subjects = commits.value.subjects;
  if (subjects.length === 0) return unresolvedPath(path, "no-commits");

  const prNumbers: number[] = [];
  for (const subject of subjects) {
    const prNumber = prNumberFromCommitSubject(subject);
    if (prNumber !== null && !prNumbers.includes(prNumber)) {
      prNumbers.push(prNumber);
    }
  }
  if (prNumbers.length === 0) {
    return unresolvedPath(path, "no-pr", subjects.length);
  }

  const issues: OriginatingIssue[] = [];
  let budgetExhausted = false;
  let lookupFailed = false;

  for (const prNumber of prNumbers) {
    const view = await fetchPrView(state, prNumber);
    if (!view.ok) {
      if (view.budgetExhausted) {
        budgetExhausted = true;
        break;
      }
      lookupFailed = true;
      continue;
    }

    // GitHub's linkage first; the worker's `(#N)` title convention is the
    // fallback for PRs whose linkage was never recorded.
    let issueNumbers = view.value.closingIssues;
    if (issueNumbers.length === 0) {
      const fromTitle = extractIssueNumberFromPrTitle(view.value.title);
      issueNumbers = fromTitle.ok ? [fromTitle.value] : [];
    }

    for (const issueNumber of issueNumbers) {
      const issue = await fetchIssue(state, issueNumber);
      if (!issue.ok) {
        if (issue.budgetExhausted) {
          budgetExhausted = true;
          break;
        }
        lookupFailed = true;
        continue;
      }
      if (!issues.some((known) => known.number === issueNumber)) {
        issues.push(issue.value);
      }
    }
    if (budgetExhausted) break;
  }

  if (issues.length > 0) {
    return {
      path,
      commitsInspected: subjects.length,
      prNumbers,
      issues,
      unresolved: null,
    };
  }

  const reason: BaseUnresolvedReason = budgetExhausted
    ? "budget-exhausted"
    : lookupFailed
    ? "lookup-failed"
    : "no-issue";
  return unresolvedPath(path, reason, subjects.length, prNumbers);
}

/**
 * Gather the originating-issue context for both sides of a conflicting PR.
 *
 * Never throws and never returns a bare empty result: every side either names
 * its issues or states why it has none, and every bound that bit is declared
 * in {@link ConflictIssueContext.truncation}.
 */
export async function gatherConflictIssueContext(
  request: ConflictIssueContextRequest,
  deps: ConflictIssueContextDeps,
): Promise<ConflictIssueContext> {
  const state: GatherState = {
    repo: request.repo,
    gh: deps.gh,
    bounds: { ...DEFAULT_CONFLICT_ISSUE_CONTEXT_BOUNDS, ...deps.bounds },
    ghCallsUsed: 0,
    textCharsUsed: 0,
    warnings: [],
    truncation: {
      commitCapPaths: [],
      issueCapHit: false,
      textTruncatedIssues: [],
      ghCallCapHit: false,
    },
    issueCache: new Map(),
  };

  const prSide = await resolvePrSide(state, request);

  const paths: string[] = [];
  for (const path of request.conflictedPaths) {
    if (path.length > 0 && !paths.includes(path)) paths.push(path);
  }

  const baseSide: BasePathOrigin[] = [];
  if (paths.length > 0) {
    const anchor = await resolveBaseWalkAnchor(state, request, deps.git);
    for (const path of paths) {
      baseSide.push(
        anchor === null
          ? unresolvedPath(path, "merge-base-unavailable")
          : await gatherPathOrigin(state, request, deps.git, anchor, path),
      );
    }
  }

  return {
    repo: request.repo,
    prNumber: request.prNumber,
    prSide,
    baseSide,
    truncation: state.truncation,
    ghCallsUsed: state.ghCallsUsed,
    warnings: state.warnings,
  };
}
