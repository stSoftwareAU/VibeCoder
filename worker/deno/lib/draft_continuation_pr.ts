/**
 * A timed-out run keeps a draft PR so the issue continues (Issue #4146).
 *
 * The owner's clarification: when a run times out with its criteria unmet,
 * "it's ok to create a draft PR and then automatically continue. Do not raise
 * another issue." The work is already preserved on the issue branch (Issues
 * #47, #218); this makes it visible as a DRAFT that says `Part of #N` — never
 * a closing keyword, never auto-merge (the sweep skips drafts, Issue #1800).
 * The fleet's own draft never holds its issue (`getBlockingPRForIssue`), so
 * the next run re-claims the issue, resumes the branch (Issue #220) and
 * finishes; once every criterion is met, completion marks the draft ready
 * with `Closes #N` and it takes the normal review and auto-merge path.
 *
 * Best-effort: the branch is the deliverable that matters, so a `gh` failure
 * is reported, never thrown.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { withholdIssueClose } from "./missing_criterion_close_guard.ts";

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
      `WIP: ${issueTitle} (#${issueNumber})`,
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
 * continues it; completion marks it ready and arms auto-merge once every
 * criterion is met.
 *
 * Each step is best-effort and reported through `log`, never thrown: the
 * draft state is what keeps the sweep away, so a failed body edit must not
 * stop the conversion.
 *
 * @param body - The PR body the run assembled; its closing keyword for the
 *   issue is withheld.
 */
export async function convertToDraftContinuation(args: {
  repo: string;
  issueNumber: number;
  prNumber: number;
  body: string;
  gh: (args: string[]) => Promise<string>;
  log: (message: string) => void;
}): Promise<void> {
  const { repo, issueNumber, prNumber, body, gh, log } = args;
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
      buildUnmetDraftBody(issueNumber, body),
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
    "The next run continues this branch; the PR is marked ready, with " +
    "auto-merge armed, once every criterion is met (Issue #4146).",
    "",
    withholdIssueClose(body, issueNumber),
  ].join("\n");
}

/**
 * Mark a draft continuation ready and wait for its CI to start (Issue
 * #4160). Draft PRs skip CI (Issue #4152) and GitHub counts a skipped
 * required check as passing, so arming auto-merge straight after `gh pr
 * ready` could merge on the draft's skipped checks before the
 * ready-for-review run registers.
 *
 * Returns `true` once the head commit carries a check run that was not there
 * before the PR was marked ready and was not skipped — the caller arms
 * auto-merge only then. Returns `false` when marking it ready fails or no
 * such run appears within `timeoutMs`; auto-merge is then left for the
 * sweep, which arms it once CI has run. Never throws.
 */
export async function markReadyAndAwaitCi(args: {
  repo: string;
  prNumber: number;
  gh: (args: string[]) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const { repo, prNumber, gh, sleep, log } = args;
  const timeoutMs = args.timeoutMs ?? 120_000;
  const pollMs = args.pollMs ?? 10_000;
  const pr = String(prNumber);
  let headRefOid = "";
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
    ({ headRefOid } = JSON.parse(
      await gh(["pr", "view", pr, "--repo", repo, "--json", "headRefOid"]),
    ) as { headRefOid: string });
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
    return false;
  }
  if (!before) return false;
  try {
    // Checked at once, then every `pollMs` up to and including `timeoutMs`.
    for (let waited = 0;; waited += pollMs) {
      const started = (await checkRuns()).some((run) =>
        !before.has(run.id) && run.conclusion !== "skipped"
      );
      if (started) return true;
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
  return false;
}

function errText(err: unknown): string {
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
    "The issue stays under `work-on`: the next run resumes this branch and " +
    "finishes the job, then marks this PR ready with `Closes` (Issue #4146).",
  ].join("\n");
}
