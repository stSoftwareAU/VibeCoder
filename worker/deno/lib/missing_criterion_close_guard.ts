/**
 * A PR whose own closure block marks a criterion `missing` does not close its
 * issue (Issue #3177).
 *
 * "A missing core deliverable is not a PR" was a prose rule that only a
 * reviewer enforced, and a PR into a milestone branch has no reviewer: it
 * merges on green CI. GRQ-AutoTrader#2459 marked three of its four criteria
 * `missing`, merged into its milestone and closed #2301 as completed; #2307
 * and #2370 did the same for #2254 and #2253. The run had already said, in a
 * form the worker parses (`acceptance_criteria_gate.ts`), that the
 * deliverable was absent.
 *
 * Two deterministic checks read that signal:
 *
 * ```mermaid
 * flowchart TD
 *     S["PR summary closure block"] --> M{"Any entry<br/>marked missing?"}
 *     M -- no --> C["PR body closes the issue<br/>(Closes #N)"]
 *     M -- yes --> P["PR body says Part of #N<br/>and names the missing criteria"]
 *     C --> X["Merge: closer closes the issue"]
 *     P --> H{"Merge: closer reads<br/>the merged PR body"}
 *     H --> O["Issue left open and queued<br/>to finish the missing criteria"]
 * ```
 *
 * The closer check is the belt and braces: a fleet PR title names its issue
 * (`(Issue #N)`), so a closer that reads titles would close the issue even
 * with no closing keyword in the body.
 *
 * Every function here is pure. The closers preserve the existing labels.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { parseClosureEntries } from "./acceptance_criteria_gate.ts";

/** Longest criterion text quoted back in a comment or PR note. */
const MAX_QUOTED_LENGTH = 300;

/**
 * Every closing keyword GitHub honours, with the text before it kept so the
 * rewrite leaves the surrounding markdown alone. Same shape as the matcher in
 * `pr_body.ts`; the issue number is compared after the match, never
 * interpolated into the pattern.
 */
const CLOSING_KEYWORD_RE =
  /(^|[^\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

/**
 * The closure entries a PR summary (or PR body) marks `missing`, as written.
 *
 * Reads the same `## Acceptance Criteria` block the closure gate parses, so
 * the two cannot disagree about what the run said. A body with no block has
 * no missing entries.
 *
 * @param prBody - The PR summary or assembled PR body.
 * @returns The text of each `missing` entry, in summary order.
 */
export function findMissingCriteria(prBody: string): string[] {
  return parseClosureEntries(prBody)
    .filter((entry) => entry.status === "missing")
    .map((entry) => entry.text);
}

/**
 * Rewrite every closing keyword that names `issueNumber` as `Part of #N`,
 * leaving keywords for other issues untouched.
 *
 * @param body - The PR body.
 * @param issueNumber - The issue the PR must not close.
 */
export function withholdIssueClose(body: string, issueNumber: number): string {
  return body.replace(
    CLOSING_KEYWORD_RE,
    (match: string, lead: string, num: string) =>
      Number(num) === issueNumber ? `${lead}Part of #${num}` : match,
  );
}

/** One criterion as a bullet, trimmed to a readable length. */
function quote(criterion: string): string {
  const text = criterion.replace(/\s+/g, " ").trim();
  return text.length > MAX_QUOTED_LENGTH
    ? `- ${text.slice(0, MAX_QUOTED_LENGTH - 1)}…`
    : `- ${text}`;
}

/**
 * The PR-body section that says why the PR does not close its issue.
 *
 * @param issueNumber - The issue the PR is part of.
 * @param missing - The `missing` entries, from {@link findMissingCriteria}.
 */
export function buildMissingCriteriaPrNote(
  issueNumber: number,
  missing: readonly string[],
): string {
  return [
    `## Not closing #${issueNumber}`,
    "",
    `This PR leaves #${issueNumber} open: its own \`## Acceptance ` +
    `Criteria\` block marks ${missing.length} criteri${
      missing.length === 1 ? "on" : "a"
    } \`missing\`:`,
    "",
    ...missing.map(quote),
    "",
    `When it merges, the worker leaves #${issueNumber} open with its existing ` +
    "labels so it remains queued to finish the missing criteria (Issue #3177).",
    "",
  ].join("\n");
}
