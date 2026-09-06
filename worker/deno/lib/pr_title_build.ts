/**
 * Building the PR title from an issue title (Issue #1248).
 *
 * A leaf module with no imports: the completion phase is its only caller, and
 * the matchers in `pr_title_issue_ref.ts` are the code this exists to protect,
 * so keeping the two apart avoids a dependency in either direction.
 *
 * The defect this closes: the issue title came from
 * `gh issue view --json title` and was interpolated verbatim into
 * `gh pr create --title`. An issue titled `Add caching [#999]` therefore
 * produced the fleet-authored PR title *"Add caching [#999] (Issue #5)"*,
 * which `prTitleReferencesIssue()` — and through it the duplicate-PR guard and
 * `isBlockedByRecentlyClosedPR()` — reads as a reference to issue #999. A
 * merged PR blocks permanently (Issue #3151), so #999 was stranded for good
 * under a skip reason that reads like a passing cooldown. The matching side
 * was hardened in Issue #319; this is the injection side.
 *
 * The rule: the worker's own `(Issue #<n>)` suffix is the single authoritative
 * reference in a PR title, so every issue-reference token in the issue title
 * is removed or neutralised before the suffix is appended.
 *
 * The patterns below are fixed literals — nothing interpolates the issue
 * number or any other external value into a `RegExp` — and none nests a
 * quantifier inside a quantifier, so there is no ReDoS surface.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** GitHub rejects a pull request title longer than this. */
export const MAX_PR_TITLE_CHARS = 256;

/**
 * Longest scrubbed issue title carried into a PR title. Leaves ample room for
 * the ` (Issue #<n>)` suffix inside {@link MAX_PR_TITLE_CHARS}, and keeps a
 * pathological 4 kB title out of the PR list.
 */
const MAX_ISSUE_TITLE_CHARS = 180;

/** Used when the issue title scrubs away to nothing. */
const FALLBACK_TITLE = "Untitled issue";

/**
 * Delimited issue references — `(#5)`, `(Issue #5)`, `[issue #5]` — in the
 * exact shapes {@link prTitleMatchesIssue} treats as canonical. Removed whole,
 * delimiters included, because the surrounding brackets carry no meaning once
 * the reference is gone.
 */
const DELIMITED_REFERENCE = /[([] ?(?:issue ?)?#\d+ ?[)\]]/gi;

/** A `#` introducing a number, wherever it survived the pass above. */
const BARE_HASH_REFERENCE = /#(?=\d)/g;

/** Control characters, which must never reach a `gh pr create --title`. */
// deno-lint-ignore no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

/**
 * Strip issue-reference syntax from an issue title, and flatten it to one
 * bounded line.
 *
 * Delimited references are removed entirely; a bare `#999` keeps its digits
 * and loses the `#`, so the title still reads sensibly while no longer
 * matching any of the fleet's title matchers. Cross-repository forms
 * (`owner/repo#999`) are neutralised the same way — the matchers skip them
 * today, but nothing in a PR title should depend on that.
 *
 * Exported for tests and for any future caller that needs the scrubbed title
 * without the suffix.
 */
export function scrubIssueReferences(issueTitle: string): string {
  const scrubbed = issueTitle
    .replace(CONTROL_CHARACTERS, " ")
    .replace(DELIMITED_REFERENCE, " ")
    .replace(BARE_HASH_REFERENCE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (scrubbed.length === 0) return "";
  return scrubbed.length > MAX_ISSUE_TITLE_CHARS
    ? `${scrubbed.slice(0, MAX_ISSUE_TITLE_CHARS - 1)}…`
    : scrubbed;
}

/**
 * Build the pull request title for an issue: the scrubbed issue title, then
 * the worker's own `(Issue #<n>)` suffix as the one reference the title
 * carries.
 *
 * A title that scrubs away to nothing falls back to {@link FALLBACK_TITLE}
 * rather than leading with the suffix, so the PR list stays readable.
 */
export function buildPrTitle(issueTitle: string, issueNumber: number): string {
  const scrubbed = scrubIssueReferences(issueTitle) || FALLBACK_TITLE;
  return `${scrubbed} (Issue #${String(Math.trunc(issueNumber))})`;
}
