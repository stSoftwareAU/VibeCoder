/**
 * Which PR belongs to *this run* (Issue #174).
 *
 * Issue→PR linking matches "any PR whose title or body references #N".
 * That cannot tell *the PR for the branch this run just pushed* from
 * *some PR for this issue*, and in a fleet those differ routinely: humans
 * and sibling hosts land partial PRs against an issue that is still being
 * worked.
 *
 * On VibeCoder#42 the cost was three commits. The worker pushed
 * `issue-42-primary-graphql-quota-exhaustion-is-swallowed-by-t`, then
 * completion matched PR #173 — a human's partial PR on
 * `issue-42-relabel-reopens-merged-pr-gate`, merged mid-run — logged
 * `IDEMPOTENT: PR already exists`, closed the issue, and released with
 * `outcome pr:#173`. No PR was ever opened for the worker's branch and
 * nothing was logged above INFO.
 *
 * **The branch name shape is not a discriminator.** Both PRs on #42 had an
 * `issue-42-*` head and the same author; only the exact branch separates
 * them. Every decision here compares the full branch name.
 *
 * Two decisions live here, deliberately apart:
 *
 *  - {@link decideCompletionPr} — which PR completion should use, or
 *    whether to open a new one;
 *  - {@link mergedPrCompletesThisRun} — whether a merged PR is grounds for
 *    *this run* to close the issue.
 *
 * Pure and side-effect free, so the rules are testable without a network.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** PR states the linker can hand back. */
export type LinkedPrState = "OPEN" | "MERGED" | "CLOSED";

/** A PR found by issue-number linking, with the state that decides its use. */
export interface LinkedPr {
  url: string;
  state: LinkedPrState;
}

/** Inputs to {@link decideCompletionPr}. */
export interface CompletionPrInput {
  /** Open PR whose head is exactly this run's branch, or null. */
  openPrForBranch: string | null;
  /**
   * Commits this run's branch has ahead of its base, or `null` when the
   * count could not be taken (a git failure — never silently zero).
   */
  branchCommitsAhead: number | null;
  /** PR found by issue-number linking, which may be anyone's. */
  prForIssue: LinkedPr | null;
}

/** What completion should do. */
export type CompletionPrDecision =
  | { kind: "recover"; prUrl: string; why: string }
  | { kind: "create"; why: string };

/**
 * Decide whether completion recovers an existing PR or opens a new one.
 *
 * The rule that matters, and the one Issue #174 exists for: **a merged or
 * closed PR is never the PR for commits this run just pushed.** When the
 * branch is ahead of its base, the run opens a PR for it whatever else
 * references the issue.
 *
 * Order:
 *
 *  1. An open PR whose head is this branch — unambiguously ours.
 *  2. An open PR for the issue — someone's work is in flight; recovering it
 *     is the pre-#174 behaviour and loses nothing.
 *  3. The branch is ahead of base — open a PR for it, ignoring any
 *     merged/closed PR that merely mentions the issue.
 *  4. The branch is level with base and a PR exists — nothing to raise, so
 *     that PR does represent the work (the Issue #1559 case).
 *  5. Nothing found — attempt creation and let it report its own error.
 *
 * An unknown commit count (`null`) deliberately does **not** force creation:
 * without the count we do not know work exists, and changing behaviour on an
 * unknown is the riskier half of the trade. The protection in that case is
 * {@link mergedPrCompletesThisRun}, which still refuses to *close* the issue
 * on someone else's PR.
 */
export function decideCompletionPr(
  input: CompletionPrInput,
): CompletionPrDecision {
  const { openPrForBranch, branchCommitsAhead, prForIssue } = input;

  if (openPrForBranch) {
    return {
      kind: "recover",
      prUrl: openPrForBranch,
      why: "an open PR already has this branch as its head",
    };
  }

  if (prForIssue?.state === "OPEN") {
    return {
      kind: "recover",
      prUrl: prForIssue.url,
      why: "an open PR references this issue",
    };
  }

  if (branchCommitsAhead !== null && branchCommitsAhead > 0) {
    const other = prForIssue
      ? ` — ${prForIssue.url} is ${prForIssue.state.toLowerCase()} and is not ` +
        `the PR for this branch`
      : "";
    return {
      kind: "create",
      why: `the branch is ${branchCommitsAhead} commit(s) ahead of base` +
        other,
    };
  }

  if (prForIssue) {
    const ahead = branchCommitsAhead === null
      ? "the commit count could not be taken"
      : "the branch is level with base";
    return {
      kind: "recover",
      prUrl: prForIssue.url,
      why: `${ahead}, so ${prForIssue.url} represents the work`,
    };
  }

  return { kind: "create", why: "no PR references this issue or branch" };
}

/**
 * Whether a merged PR is grounds for *this run* to close the issue.
 *
 * True only when the merged PR's head is exactly the branch this run worked.
 * A merged PR from a human or a sibling host completes the issue only in its
 * author's judgement, not the worker's — Issue #174's second rule.
 *
 * Both names are trimmed; comparison is exact and case-sensitive, because git
 * refs are. A missing head ref (the lookup failed) returns false: unproven
 * provenance must never authorise a close.
 *
 * @param prHeadRef - `headRefName` of the merged PR, or null when unknown.
 * @param runBranch - The branch this run pushed.
 */
export function mergedPrCompletesThisRun(
  prHeadRef: string | null | undefined,
  runBranch: string | null | undefined,
): boolean {
  const head = (prHeadRef ?? "").trim();
  const ours = (runBranch ?? "").trim();
  if (head === "" || ours === "") return false;
  return head === ours;
}

/**
 * The comment left when a merged PR is someone else's.
 *
 * Says what the worker has and what it did not do, so the issue's author can
 * make the call. Names the branch, because that is the thing a human needs in
 * order to find the work.
 */
export function foreignMergedPrComment(
  prNumber: number,
  runBranch: string,
): string {
  return [
    `PR #${prNumber} is merged and references this issue, but its head is ` +
    `not this run's branch \`${runBranch}\`, so the worker has not closed ` +
    `this issue (Issue #174).`,
    "",
    `Whether that PR completes this issue is your call. The worker's work is ` +
    `on \`${runBranch}\` — if it is still wanted, re-label the issue and the ` +
    `next claim resumes that branch; if it is not, close this issue and the ` +
    `branch can be deleted.`,
  ].join("\n");
}
