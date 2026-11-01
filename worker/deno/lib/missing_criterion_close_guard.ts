/**
 * A PR whose own closure block marks a criterion `partial` or `missing` does not close its
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
 *     S["PR summary closure block"] --> M{"Any entry<br/>marked partial or missing?"}
 *     M -- no --> C["PR body closes the issue<br/>(Closes #N)"]
 *     M -- yes --> P["PR body says Part of #N<br/>and names the unmet criteria"]
 *     C --> X["Merge: closer closes the issue"]
 *     P --> H{"Merge: closer reads<br/>the merged PR body"}
 *     H --> O["Issue left open and queued<br/>to finish the unmet criteria"]
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
  /(^|[^\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#(\d+)\b/gi;

const PART_OF_RE =
  /(^|[^\w/])part\s+of\s+(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#(\d+)\b/gi;

/** A caller can defer publication and retry once the governing repository is known. */
export class MissingIssueIdentityError extends Error {
  constructor() {
    super(
      "Cannot reconcile qualified issue reference without trusted repository identity",
    );
    this.name = "MissingIssueIdentityError";
  }
}

/** Trusted repositories for a PR and its governing issue. */
export interface IssueIdentity {
  prRepo: string;
  issueRepo: string;
}

function rewriteReference(
  body: string,
  pattern: RegExp,
  replacement: string,
  issueNumber: number,
  identity?: IssueIdentity,
): string {
  return body.replace(
    pattern,
    (match: string, lead: string, repo: string | undefined, num: string) => {
      if (Number(num) !== issueNumber) return match;
      if (repo && !identity) {
        throw new MissingIssueIdentityError();
      }
      const targetRepo = repo ?? identity?.prRepo;
      if (
        identity &&
        targetRepo?.toLowerCase() !== identity.issueRepo.toLowerCase()
      ) return match;
      return `${lead}${replacement} ${repo ? `${repo}#${num}` : `#${num}`}`;
    },
  );
}

/**
 * The closure entries a PR summary (or PR body) marks `partial` or `missing`, as written.
 *
 * Reads the same `## Acceptance Criteria` block the closure gate parses, so
 * the two cannot disagree about what the run said. A body with no block has
 * no unmet entries.
 *
 * @param prBody - The PR summary or assembled PR body.
 * @returns The text of each unmet entry, in summary order.
 */
export function findMissingCriteria(prBody: string): string[] {
  return parseClosureEntries(prBody)
    .filter((entry) => entry.status === "missing" || entry.status === "partial")
    .map((entry) => entry.text);
}

/** Whether the closure block requires withholding the issue close. */
export function withholdsIssueClose(summary: string): boolean {
  return findMissingCriteria(summary).length > 0;
}

/**
 * Rewrite every closing keyword that names `issueNumber` as `Part of #N`,
 * leaving keywords for other issues untouched.
 *
 * @param body - The PR body.
 * @param issueNumber - The issue the PR must not close.
 */
export function withholdIssueClose(
  body: string,
  issueNumber: number,
  identity?: IssueIdentity,
): string {
  return rewriteReference(
    body,
    CLOSING_KEYWORD_RE,
    "Part of",
    issueNumber,
    identity,
  );
}

/** Restore a governing issue's Part of reference when all criteria are met. */
export function restoreIssueClose(
  body: string,
  issueNumber: number,
  identity?: IssueIdentity,
): string {
  return rewriteReference(body, PART_OF_RE, "Closes", issueNumber, identity);
}

/**
 * Align the issue's closing keyword with the summary's own closure block: a
 * `partial` or `missing` entry withholds the close (`Part of #N`), and no unmet entry
 * restores it (`Closes #N`). Same rule assemblePrBody applies to the PR body
 * (Issue #3177), so the committed summary and PR body agree (Issue #4472).
 *
 * @param summary - The PR summary, with its closure block already rendered.
 * @param issueNumber - The issue the PR is part of.
 */
export function alignIssueCloseWithClosure(
  summary: string,
  issueNumber: number,
  identity?: IssueIdentity,
): string {
  return withholdsIssueClose(summary)
    ? withholdIssueClose(summary, issueNumber, identity)
    : restoreIssueClose(summary, issueNumber, identity);
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
 * @param missing - The unmet entries, from {@link findMissingCriteria}.
 */
export function buildMissingCriteriaPrNote(
  issueNumber: number,
  missing: readonly string[],
  issueRepo?: string,
): string {
  const ref = issueRepo ? `${issueRepo}#${issueNumber}` : `#${issueNumber}`;
  return [
    `## Not closing ${ref}`,
    "",
    `This PR leaves ${ref} open: its own \`## Acceptance ` +
    `Criteria\` block marks ${missing.length} criteri${
      missing.length === 1 ? "on" : "a"
    } \`partial\` or \`missing\`:`,
    "",
    ...missing.map(quote),
    "",
    `When it merges, the worker leaves ${ref} open with its existing ` +
    "labels so it remains queued to finish the unmet criteria (Issue #3177).",
    "",
  ].join("\n");
}
