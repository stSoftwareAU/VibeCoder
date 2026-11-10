/**
 * A timed-out run keeps a draft PR so the issue continues (Issue #4146).
 *
 * The owner's clarification: when a run times out with its criteria unmet,
 * "it's ok to create a draft PR and then automatically continue. Do not raise
 * another issue." The work is already preserved on the issue branch (Issues
 * #47, #218); this makes it visible as a DRAFT that says `Part of #N` — never
 * a closing keyword, never auto-merge (the sweep skips drafts, Issue #1800).
 * The fleet's own draft never holds its issue (`getBlockingPRForIssue`), so
 * the next run re-claims the issue and resumes the branch (Issue #220). When
 * that run completes, completion marks the draft ready and it takes the
 * normal review and auto-merge path, even with a criterion still unmet
 * (Issue #4234); the body says `Closes #N` unless an entry is `missing`.
 * When marking a known draft ready fails, the run is not released as having
 * raised it ready: completion fails the run so the next run retries (Issue
 * #4952). A draft whose state could not be read is treated as a known draft
 * only when the ready step's own head read says `isDraft` is true; otherwise a
 * failed ready only warns.
 *
 * Best-effort: the branch is the deliverable that matters, so a `gh` failure
 * is reported, never thrown.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { withholdIssueClose } from "./missing_criterion_close_guard.ts";
import { mdSafe } from "./mutation_gate.ts";
import { buildPrTitle } from "./pr_title_build.ts";

/** Marks a PR body as a draft continuation (timed out, or criteria unmet). */
export const DRAFT_CONTINUATION_MARKER = "<!-- vibe-draft-continuation -->";

/** What {@link ensureDraftContinuationPr} did. */
export type DraftContinuationResult =
  | { kind: "created"; prNumber: number }
  | { kind: "existing"; prNumber: number }
  | { kind: "failed"; error: string };

/**
 * Make sure the issue branch has an open PR: a draft `Part of #N` when it has
 * none, the existing one (draft or not) left as it is otherwise.
 */
export async function ensureDraftContinuationPr(args: {
  repo: string;
  issueNumber: number;
  issueTitle: string;
  branchName: string;
  baseBranch: string;
  gh: (args: string[]) => Promise<string>;
}): Promise<DraftContinuationResult> {
  const { repo, issueNumber, issueTitle, branchName, baseBranch, gh } = args;
  try {
    const listed = JSON.parse(
      await gh([
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        branchName,
        "--state",
        "open",
        "--json",
        "number,isDraft",
      ]),
    ) as { number?: unknown }[];
    const existing = listed.find((p) => typeof p.number === "number");
    if (existing) {
      return { kind: "existing", prNumber: existing.number as number };
    }
    const url = await gh([
      "pr",
      "create",
      "--draft",
      "--repo",
      repo,
      "--base",
      baseBranch,
      "--head",
      branchName,
      "--title",
      // Issue #4679: scrubbed, so an issue-title `[#999]` is no reference.
      buildPrTitle(issueTitle, issueNumber),
      "--body",
      buildDraftContinuationBody(issueNumber),
    ]);
    const prNumber = Number(url.trim().match(/\/pull\/(\d+)/)?.[1] ?? 0);
    return prNumber > 0
      ? { kind: "created", prNumber }
      : { kind: "failed", error: `unexpected gh output: ${url.trim()}` };
  } catch (err) {
    return {
      kind: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Turn an open PR whose acceptance criteria are not all met back into a
 * draft (owner, Issue #4146): "make sure that incomplete PRs are draft so the
 * CI and code reviews aren't done." Marks it a draft, disarms auto-merge when
 * armed, and rewrites the body to `Part of #N` with no closing keyword. The
 * branch is left alone and the issue stays under `work-on`, so the next run
 * continues it; when that run completes, completion marks it ready and arms
 * auto-merge even with a criterion still unmet, and the body says `Closes #N`
 * unless an entry is `missing` (Issue #4234).
 *
 * Each step is best-effort and reported through `log`, never thrown: the
 * draft state is what keeps the sweep away, so a failed body edit must not
 * stop the conversion.
 *
 * @param body - The PR body the run assembled; its closing keyword for the
 *   issue is withheld.
 * @param draftBody - The body to write instead of the unmet-criteria draft
 *   body (Issue #4617: the mutation hold body). Omitted, the unmet-criteria
 *   body is written.
 */
export async function convertToDraftContinuation(args: {
  repo: string;
  issueNumber: number;
  prNumber: number;
  body: string;
  draftBody?: string;
  gh: (args: string[]) => Promise<string>;
  log: (message: string) => void;
}): Promise<void> {
  const { repo, issueNumber, prNumber, body, draftBody, gh, log } = args;
  const pr = String(prNumber);
  let isDraft = false;
  let armed = true;
  try {
    const view = JSON.parse(
      await gh([
        "pr",
        "view",
        pr,
        "--repo",
        repo,
        "--json",
        "isDraft,autoMergeRequest",
      ]),
    ) as { isDraft?: unknown; autoMergeRequest?: unknown };
    isDraft = view.isDraft === true;
    armed = view.autoMergeRequest !== null &&
      view.autoMergeRequest !== undefined;
  } catch (err) {
    log(`could not read PR #${prNumber} before converting it: ${errText(err)}`);
  }
  if (armed) {
    try {
      await gh(["pr", "merge", pr, "--repo", repo, "--disable-auto"]);
    } catch (err) {
      log(`could not disarm auto-merge on PR #${prNumber}: ${errText(err)}`);
    }
  }
  if (!isDraft) {
    try {
      await gh(["pr", "ready", pr, "--repo", repo, "--undo"]);
    } catch (err) {
      log(`could not convert PR #${prNumber} to a draft: ${errText(err)}`);
    }
  }
  try {
    await gh([
      "pr",
      "edit",
      pr,
      "--repo",
      repo,
      "--body",
      draftBody ?? buildUnmetDraftBody(issueNumber, body),
    ]);
  } catch (err) {
    log(`could not rewrite PR #${prNumber}'s body: ${errText(err)}`);
  }
}

/** A draft for unmet criteria: the run's body, closing keyword withheld. */
export function buildUnmetDraftBody(issueNumber: number, body: string): string {
  return [
    DRAFT_CONTINUATION_MARKER,
    "",
    `> **Draft — not every acceptance criterion is met yet.** Part of #${issueNumber}. ` +
    "The next run continues this branch; when it completes, the PR is " +
    "marked ready and auto-merge armed, even with a criterion still unmet, " +
    "and it says `Closes #N` unless an entry is `missing`.",
    "",
    withholdIssueClose(body, issueNumber),
  ].join("\n");
}

/**
 * A draft for surviving mutants the repository's CI blocks on (Issue #4617).
 * Unlike the unmet-criteria draft it says validation is incomplete, carries
 * the mutation gate's comment, and is still `Part of #N` with no closing
 * keyword. The job and workflow names come from repository files, so any
 * backtick or line break is stripped again here.
 */
export function buildMutationHoldDraftBody(
  issueNumber: number,
  body: string,
  hold: {
    job: string;
    workflow: string;
    comment: string;
  },
): string {
  const job = mdSafe(hold.job);
  const workflow = mdSafe(hold.workflow);
  return [
    DRAFT_CONTINUATION_MARKER,
    "",
    "> **Draft — validation incomplete.** The worker's mutation check still " +
    "reports surviving mutants on the changed lines, and this repository's " +
    `CI job \`${job}\` (${workflow}) blocks on them. Part of #${issueNumber}. ` +
    "The next run continues this branch; the pull request is marked ready " +
    "once the mutation check reports no survivor.",
    "",
    hold.comment,
    "",
    withholdIssueClose(body, issueNumber),
  ].join("\n");
}

/** What {@link markDraftReadyAndAwaitCi} reports (Issues #4160, #4952). */
export interface MarkReadyResult {
  /** False only when `gh pr ready` threw: the PR is still a draft. */
  ready: boolean;
  /** True once ready-for-review CI has started, so auto-merge may be armed. */
  ciStarted: boolean;
  /**
   * The head read's `isDraft`: true, false, or null when the read failed or
   * left it out (Issue #4952).
   */
  draft: boolean | null;
}

/** The arguments of {@link markDraftReadyAndAwaitCi}. */
interface MarkReadyArgs {
  repo: string;
  prNumber: number;
  gh: (args: string[]) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Mark a draft continuation ready and wait for its CI to start (Issues #4160,
 * #4952). Draft PRs skip CI (Issue #4152) and GitHub counts a skipped required
 * check as passing, so arming auto-merge straight after `gh pr ready` could
 * merge on the draft's skipped checks before the ready-for-review run
 * registers.
 *
 * One `gh pr view` reads the head commit and `isDraft`. When `isDraft` is
 * exactly `false` the PR is already ready: `gh pr ready` and the CI wait are
 * skipped and the result is `{ ready: true, ciStarted: true, draft: false }`.
 * When `isDraft` is missing, the draft is marked ready as before.
 *
 * `ready` is `false` only when `gh pr ready` throws, so the PR is still a
 * draft; the caller decides whether that fails the run (Issue #4952).
 * `ciStarted` is `true` once the head commit carries a check run that was not
 * there before the PR was marked ready and was not skipped. It is `false` when
 * the check runs cannot be read, or when no such run appears within
 * `timeoutMs`. A caller that treats the PR as a draft must not arm auto-merge
 * when `ciStarted` is `false`; the sweep arms it once CI has run. `draft` is
 * what the head read said, so a caller whose draft state is unknown can apply
 * the same rule when `draft` is `true` (Issue #4952). Never throws.
 */
export async function markDraftReadyAndAwaitCi(
  args: MarkReadyArgs,
): Promise<MarkReadyResult> {
  const { repo, prNumber, gh, sleep, log } = args;
  const timeoutMs = args.timeoutMs ?? 120_000;
  const pollMs = args.pollMs ?? 10_000;
  const pr = String(prNumber);
  let headRefOid = "";
  let draft: boolean | null = null;
  let before: Set<number> | undefined;
  const checkRuns = async () =>
    JSON.parse(
      await gh([
        "api",
        `repos/${repo}/commits/${headRefOid}/check-runs?per_page=100`,
        "--jq",
        "[.check_runs[] | {id, conclusion}]",
      ]),
    ) as { id: number; conclusion: string | null }[];
  try {
    const view = JSON.parse(
      await gh([
        "pr",
        "view",
        pr,
        "--repo",
        repo,
        "--json",
        "headRefOid,isDraft",
      ]),
    ) as { headRefOid: string; isDraft?: unknown };
    headRefOid = view.headRefOid;
    draft = typeof view.isDraft === "boolean" ? view.isDraft : null;
    // Issue #4952: already ready, so there is nothing to mark and no CI wait.
    if (draft === false) return { ready: true, ciStarted: true, draft };
    before = new Set((await checkRuns()).map((run) => run.id));
  } catch (err) {
    log(
      `could not read PR #${prNumber}'s check runs, so auto-merge is not ` +
        `armed this run (Issue #4160): ${errText(err)}`,
    );
  }
  try {
    await gh(["pr", "ready", pr, "--repo", repo]);
  } catch (err) {
    log(`could not mark PR #${prNumber} ready: ${errText(err)}`);
    return { ready: false, ciStarted: false, draft };
  }
  if (!before) return { ready: true, ciStarted: false, draft };
  try {
    // Checked at once, then every `pollMs` up to and including `timeoutMs`.
    for (let waited = 0;; waited += pollMs) {
      const started = (await checkRuns()).some((run) =>
        !before.has(run.id) && run.conclusion !== "skipped"
      );
      if (started) return { ready: true, ciStarted: true, draft };
      if (waited >= timeoutMs) break;
      await sleep(pollMs);
    }
    log(
      `PR #${prNumber}'s ready-for-review CI had not started after ` +
        `${timeoutMs / 1000}s; auto-merge not armed, the sweep arms it once ` +
        "CI has run (Issue #4160)",
    );
  } catch (err) {
    log(`could not read PR #${prNumber}'s check runs: ${errText(err)}`);
  }
  return { ready: true, ciStarted: false, draft };
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The draft's body: work in progress, `Part of #N`, no closing keyword. */
export function buildDraftContinuationBody(issueNumber: number): string {
  return [
    DRAFT_CONTINUATION_MARKER,
    "",
    `Part of #${issueNumber}`,
    "",
    "**Work in progress.** The run timed out before every acceptance " +
    "criterion was met, so this PR is a draft and does not close the issue. " +
    "The issue stays under `work-on`: the next run resumes this branch; " +
    "when it completes, this PR is marked ready and auto-merge armed, even " +
    "with a criterion still unmet, and it says `Closes #N` unless an entry " +
    "is `missing`.",
  ].join("\n");
}
