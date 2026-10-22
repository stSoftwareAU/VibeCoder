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

/** Marks a PR body as a timed-out run's draft continuation. */
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
