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
 *     H --> O["Issue left open, labelled needs-human,<br/>comment names the missing criteria"]
 * ```
 *
 * The closer check is the belt and braces: a fleet PR title names its issue
 * (`(Issue #N)`), so a closer that reads titles would close the issue even
 * with no closing keyword in the body.
 *
 * Every function here is pure except {@link holdIssueOpenForMissingCriteria},
 * which takes `gh` injected.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { parseClosureEntries } from "./acceptance_criteria_gate.ts";
import { LABEL_DEFAULTS } from "./config_defaults.ts";

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
    `When it merges, the worker leaves #${issueNumber} open, labels it ` +
    `\`${LABEL_DEFAULTS.needsHumanLabel}\` and names the missing criteria ` +
    "on the issue (Issue #3177).",
    "",
  ].join("\n");
}

/**
 * The issue comment posted when a merged PR is not allowed to close its
 * issue.
 *
 * @param args.prNumber - The merged PR.
 * @param args.baseRefName - The branch it merged into, when known.
 * @param args.missing - The `missing` entries from the merged PR's body.
 */
export function buildMissingCriteriaHoldComment(args: {
  prNumber: number;
  baseRefName?: string;
  missing: readonly string[];
}): string {
  const where = args.baseRefName ? ` into \`${args.baseRefName}\`` : "";
  return [
    `⚠️ **Left open — PR #${args.prNumber} merged${where}, but its own ` +
    `\`## Acceptance Criteria\` block marks ${args.missing.length} ` +
    `criteri${args.missing.length === 1 ? "on" : "a"} \`missing\`:**`,
    "",
    ...args.missing.map(quote),
    "",
    "A PR that says the deliverable is absent does not complete the issue, " +
    "so the worker has not closed it and has labelled it " +
    `\`${LABEL_DEFAULTS.needsHumanLabel}\` (Issue #3177). Finish the ` +
    "missing criteria in a follow-up PR, or close this issue by hand if the " +
    "gap is acceptable.",
  ].join("\n");
}

/**
 * Leave an issue open after its PR merged with `missing` criteria: label it
 * `needs-human`, then comment naming the criteria.
 *
 * The label goes on first. A failed label throws before the comment is
 * posted, so the caller retries next cycle without having commented twice;
 * an issue that already carries the label is left alone, which is what keeps
 * a closer that runs every cycle from repeating itself.
 *
 * @returns `"held"` when the label and comment were applied, or
 *   `"already-held"` when the issue already carried the label.
 * @throws when `gh` fails.
 */
export async function holdIssueOpenForMissingCriteria(args: {
  repo: string;
  issueNumber: number;
  prNumber: number;
  baseRefName?: string;
  missing: readonly string[];
  issueLabels: readonly string[];
  ghCommandFn: (args: string[]) => Promise<string>;
}): Promise<"held" | "already-held"> {
  const label = LABEL_DEFAULTS.needsHumanLabel;
  if (args.issueLabels.includes(label)) return "already-held";
  await args.ghCommandFn([
    "issue",
    "edit",
    String(args.issueNumber),
    "--repo",
    args.repo,
    "--add-label",
    label,
  ]);
  await args.ghCommandFn([
    "issue",
    "comment",
    String(args.issueNumber),
    "--repo",
    args.repo,
    "--body",
    buildMissingCriteriaHoldComment({
      prNumber: args.prNumber,
      ...(args.baseRefName ? { baseRefName: args.baseRefName } : {}),
      missing: args.missing,
    }),
  ]);
  return "held";
}
