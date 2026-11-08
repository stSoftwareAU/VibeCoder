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
import { splitMarkdownCode } from "./markdown_code_spans.ts";

/** Longest criterion text quoted back in a comment or PR note. */
const MAX_QUOTED_LENGTH = 300;

/**
 * Every closing keyword GitHub honours, with the text before it kept so the
 * rewrite leaves the surrounding markdown alone. Same shape as the matcher in
 * `pr_body.ts`; the issue number is compared after the match, never
 * interpolated into the pattern.
 */
export const CLOSING_KEYWORD_RE =
  /(^|[^\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#(\d+)\b/gi;

/**
 * A colon closing phrase such as `Closes: #N` or `resolved : owner/repo#N`.
 * GitHub honours it, and {@link CLOSING_KEYWORD_RE} does not match it.
 * Groups: the lead character, the keyword with its separator, the optional
 * repository qualifier, and the issue number.
 *
 * No two quantifiers overlap: the keyword is a fixed word set, the two runs of
 * whitespace sit either side of a literal `:`, and the qualifier's two runs are
 * split by a literal `/`, so a hostile run is read in linear time.
 */
export const COLON_CLOSE_RE =
  /(^|[^\w/])((?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:\s*)(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#(\d+)\b/gi;

/**
 * A full-URL closing phrase such as `Fixes https://github.com/owner/repo/issues/N`.
 * GitHub honours it, and {@link CLOSING_KEYWORD_RE} does not match it.
 * Groups: the lead character, the keyword with its whitespace, the owner, the
 * repository, and the issue number.
 *
 * No two quantifiers overlap: the owner and repository runs are split by a
 * literal `/`, and the keyword's whitespace run is followed by a literal `h`.
 */
export const URL_CLOSE_RE =
  /(^|[^\w/])((?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+)https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/issues\/(\d+)\b/gi;

/** `Part of #N` (or `owner/repo#N`): the explicit non-closing reference. */
export const PART_OF_RE =
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

/**
 * Same-repository issues a PR body names as `Part of #N` (Issue #3177): the
 * explicit non-closing reference this module writes when a criterion is
 * unmet. A qualified `owner/repo#N` is another repository's issue and is not
 * returned.
 */
export function extractPartOfIssueNumbers(prBody: string): number[] {
  const numbers = new Set<number>();
  for (const match of prBody.matchAll(PART_OF_RE)) {
    if (match[2]) continue;
    const issueNumber = Number(match[3]);
    if (Number.isSafeInteger(issueNumber) && issueNumber > 0) {
      numbers.add(issueNumber);
    }
  }
  return [...numbers];
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

/**
 * Neutralise every closing keyword in `text` that names an issue other than
 * `issueNumber` (Issue #4783).
 *
 * A PR summary is embedded in the PR body as written, so a sentence such as
 * "... closing references do not close #4674" makes GitHub close #4674 when the
 * PR merges. The plain (`close #N`), colon (`close: #N`) and full-URL
 * (`Fixes https://github.com/o/r/issues/N`) forms are all handled. Each such keyword is rewritten so that the keyword word alone is
 * an inline code span: `close` #4674. Only the keyword is wrapped, not the
 * reference, so the sentence still reads naturally. A backtick between the
 * keyword and `#N` means neither GitHub nor a raw-regex reader (such as
 * `extractClosingIssueNumbers` in `pr_body.ts`, which does not mask code) sees
 * a closing reference. The governing issue is left alone: #3177 and #4126 keep
 * its own closing keyword in line with the closure block (see
 * {@link withholdIssueClose} and {@link restoreIssueClose}), and this function
 * complements them for every other issue.
 *
 * Code is inert to GitHub, so only prose segments (`inCode === false`) are
 * rewritten. A reference is governing, and returned untouched, when its number
 * is `issueNumber` and either no identity is supplied or its repository
 * (`owner/repo` when qualified, otherwise the PR's repository) is the issue's
 * repository. A qualified reference to `issueNumber` with no identity is also
 * left untouched: {@link withholdIssueClose} handles it, or throws.
 *
 * @param text - Markdown to neutralise (a PR summary or assembled body).
 * @param issueNumber - The governing issue, whose closing keywords are kept.
 * @param identity - Trusted repositories for the PR and its governing issue.
 * @returns The text with every other-issue closing keyword code-wrapped.
 */
export function neutraliseOtherIssueClosingKeywords(
  text: string,
  issueNumber: number,
  identity?: IssueIdentity,
): string {
  const isGoverning = (num: string, repo: string | undefined): boolean =>
    Number(num) === issueNumber &&
    (identity === undefined ||
      (repo ?? identity.prRepo).toLowerCase() ===
        identity.issueRepo.toLowerCase());
  // Wrap the keyword word alone, keeping the lead and whatever follows it.
  const wrap = (match: string, lead: string): string => {
    const rest = match.slice(lead.length);
    const keyword = /^\w+/.exec(rest)?.[0] ?? rest;
    return `${lead}\`${keyword}\`${rest.slice(keyword.length)}`;
  };
  return splitMarkdownCode(text)
    .map((segment) =>
      segment.inCode ? segment.value : segment.value
        .replace(
          CLOSING_KEYWORD_RE,
          (
            match: string,
            lead: string,
            repo: string | undefined,
            num: string,
          ) => isGoverning(num, repo) ? match : wrap(match, lead),
        )
        .replace(
          COLON_CLOSE_RE,
          (
            match: string,
            lead: string,
            _kw: string,
            repo: string | undefined,
            num: string,
          ) => isGoverning(num, repo) ? match : wrap(match, lead),
        )
        .replace(
          URL_CLOSE_RE,
          (
            match: string,
            lead: string,
            _kw: string,
            owner: string,
            name: string,
            num: string,
          ) => isGoverning(num, `${owner}/${name}`) ? match : wrap(match, lead),
        )
    )
    .join("");
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
 * The PR-body section that says why the PR does not close its issue. The
 * note names the target issue only; it carries no VibeCoder issue number
 * (Issue #4641), because GitHub resolves a bare `#N` against the PR's repo.
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
    "labels so it remains queued to finish the unmet criteria.",
    "",
  ].join("\n");
}
