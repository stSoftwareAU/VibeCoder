/**
 * What a babysitter repair publishes as the PR description (Issue #4637).
 *
 * The agent's proposal (`.babysitter-pr-body`) replaces the body the summary
 * sync built, and GitHub closes every issue the body names with a closing
 * keyword when the PR merges. A proposal that said `close #4674` over a
 * committed summary with an unmet criterion re-opened exactly the close that
 * the summary withholds (the #4716 regression).
 *
 * The guard decides whether the governing issue may be closed, from evidence
 * committed at the pushed head and from the proposal's own closure block, and
 * rewrites the proposal to match:
 *
 * ```mermaid
 * flowchart TD
 *     S["Summary committed at the pushed head"] --> M{"Unmet criterion or<br/>no committed summary?"}
 *     P["Proposal's own closure block<br/>(a missing or partial entry)"] --> M
 *     M -- yes --> W["Withhold: negated phrases become complete,<br/>closing keywords become Part of"]
 *     M -- no --> C["Keep the closing keyword, or add Closes #N<br/>unless the text has one or an explicit Part of #N"]
 * ```
 *
 * The proposal is agent text. Its complete hidden `<!-- vibe-... -->` markers
 * are stripped, and every other HTML-comment delimiter in it is made inert by
 * the shared neutralisation, so an unclosed `<!--` cannot hide the lines the
 * guard appends. The live body's markers are appended in their place, so the
 * summary digest and the worker-issue marker keep reconciling.
 *
 * Every function here is pure. The caller reads the live body and the summary
 * as committed at HEAD, never the working tree.
 *
 * Uses Australian English throughout (behaviour, organisation, etc.).
 */

import {
  CLOSING_KEYWORD_RE,
  findMissingCriteria,
  type IssueIdentity,
  PART_OF_RE,
  withholdIssueClose,
} from "./missing_criterion_close_guard.ts";
import { maskMarkdownCode } from "./markdown_code_spans.ts";
import { neutraliseAgentMarkers } from "./agent_marker_neutralisation.ts";
import { closingKeywordLine } from "./pr_body.ts";
import { issueNumberFromMarker } from "./pr_body_sync.ts";
import { issueNumberFromBranch } from "./issue_branch_candidates.ts";

/** GitHub's pull request body limit, in characters (Issue #4359). */
export const PR_BODY_LIMIT = 65_536;

/** Opens every HTML comment, a hidden marker included. */
const COMMENT_OPENER = "<!--";

/** Closes every HTML comment, a hidden marker included. */
const COMMENT_CLOSER = "-->";

/** The name a worker marker opens with, after `<!--` and optional whitespace. */
const MARKER_NAME_PREFIX = "vibe-";

/** One whitespace character, as `\s` matches it. */
const WHITESPACE_RE = /\s/;

/**
 * A negated closing phrase such as "does not close #N". GitHub still reads it
 * as a closing reference, so its keyword is replaced by `complete`. Groups:
 * the negation, the rest of the reference from its whitespace onward, the
 * optional repository qualifier, and the issue number.
 *
 * No two quantifiers overlap: the negation and the keyword are fixed words,
 * and the qualifier's two runs are split by a literal `/`, so a hostile run
 * is read in linear time.
 */
const NEGATED_CLOSE_RE =
  /((?:\bnot|\bnever|\bcannot|n['’]t|\bno\s+longer)\s+)(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s+(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#(\d+)\b)/gi;

/** Any `#N` reference, whether same-repository or qualified. */
const ISSUE_MENTION_RE = /#(\d+)\b/g;

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
const COLON_CLOSE_RE =
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
const URL_CLOSE_RE =
  /(^|[^\w/])((?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+)https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/issues\/(\d+)\b/gi;

/** Inputs to {@link guardPrBodyProposal}. */
export interface PrBodyGuardInput {
  /** The agent's proposed description, or undefined when it proposed none. */
  proposal: string | undefined;
  /** The body after the summary sync: the source of the markers and of the closing references. */
  liveBody: string;
  /** The summary committed at the pushed head, or undefined when none is committed. */
  summary: string | undefined;
  /** The pull request's repository, `owner/name`. */
  repo: string;
  /**
   * The pull request's head branch. A worker branch (`issue-N-...`) names the
   * governing issue when the live body has lost its worker marker.
   */
  headRefName: string;
}

/**
 * The issue a repair's description is governed by: the worker marker in the
 * live body, else the issue a worker branch (`issue-N-...`) names (Issue #4637).
 * A body with neither is an unrelated pull request.
 */
export function governingIssueNumber(
  liveBody: string,
  headRefName: string,
): number | undefined {
  return issueNumberFromMarker(liveBody) ??
    issueNumberFromBranch(headRefName) ?? undefined;
}

/** A closing reference as `gh pr view --json closingIssuesReferences` reports it. */
export interface ClosingIssueReference {
  number: number;
  repository?: { name: string; owner?: { login: string } };
}

/** A closing reference the body names, read from a masked body. */
interface ClosingRef {
  /** `#N` for this repository, `owner/name#N` for another. */
  key: string;
  issueNumber: number;
  /** Whether the reference names an issue in this repository. */
  sameRepo: boolean;
  /** The reference as written, without the lead character. */
  text: string;
}

/**
 * Whether the governing issue may be closed. Unknown evidence is not enough:
 * the committed summary must exist and must have no unmet criterion. The close
 * is also withheld when the proposal carries its own unmet criterion: a
 * `missing` or `partial` entry in its closure block, even when the committed
 * summary is fully met. The summary's own wording does not decide it: a fully
 * met summary whose text names no closing keyword for the issue and no explicit
 * `Part of #N` gets `Closes #N` appended, as `assemblePrBody` does. A bare
 * mention of the issue is not a closing claim.
 *
 * @param input.summary - The summary committed at the pushed head.
 * @param input.proposal - The agent's proposed description, if any.
 */
export function isIssueCloseAllowed(input: {
  summary: string | undefined;
  proposal: string | undefined;
}): boolean {
  const { summary, proposal } = input;
  if (summary === undefined) return false;
  if (findMissingCriteria(summary).length > 0) return false;
  return proposal === undefined || findMissingCriteria(proposal).length === 0;
}

/**
 * Whether GitHub reports the issue as closed by the PR. A reference whose
 * repository is not given is taken to be this repository's.
 *
 * @param refs - `closingIssuesReferences` from `gh pr view`. The caller has
 *   checked that GitHub returned the field.
 * @param issueNumber - The issue to look for.
 * @param repo - The pull request's repository, `owner/name`.
 */
export function githubClosesIssue(
  refs: readonly ClosingIssueReference[],
  issueNumber: number,
  repo: string,
): boolean {
  return refs.some((ref) => {
    if (ref.number !== issueNumber) return false;
    const repository = ref.repository;
    if (repository === undefined) return true;
    const owner = repository.owner?.login;
    return owner === undefined ||
      `${owner}/${repository.name}`.toLowerCase() === repo.toLowerCase();
  });
}

/**
 * The description to publish for a repair's head (Issue #4637).
 *
 * With a proposal, the result is the proposal with its hidden markers
 * stripped, the live body's markers appended, closing references to other
 * issues that the proposal dropped restored, and the governing issue either
 * kept (its close is allowed) or withheld (its close is not). Without a
 * proposal, the live body is the base and only the withholding applies.
 *
 * The governing issue is the worker marker in the live body, else the issue the
 * worker branch names ({@link governingIssueNumber}). An unrelated PR, with
 * neither, gets only the restored closing references.
 *
 * @throws When the governing issue would still close, or the body is over the
 *   GitHub limit. The caller then leaves the reviews open.
 */
export function guardPrBodyProposal(input: PrBodyGuardInput): string {
  const { proposal, liveBody, summary, repo, headRefName } = input;
  const identity: IssueIdentity = { prRepo: repo, issueRepo: repo };
  const issueNumber = governingIssueNumber(liveBody, headRefName);
  let text = proposal === undefined ? liveBody : stripVibeMarkers(proposal);
  const appended: string[] = [];

  if (proposal !== undefined) {
    const kept = new Set(
      closingRefs(maskMarkdownCode(text), repo).map((ref) => ref.key),
    );
    for (const ref of closingRefs(maskMarkdownCode(liveBody), repo)) {
      const governed = issueNumber !== undefined && ref.sameRepo &&
        ref.issueNumber === issueNumber;
      if (governed || kept.has(ref.key)) continue;
      if (!appended.includes(ref.text)) appended.push(ref.text);
    }
  }

  let closeAllowed: boolean | undefined;
  if (issueNumber !== undefined) {
    closeAllowed = isIssueCloseAllowed({ summary, proposal });
    if (closeAllowed) {
      // A bare mention is not a closing claim: only a closing keyword, or an
      // explicit `Part of #N` the proposal chose, stops the close being added.
      if (!namesClosingOrPartOf(text, issueNumber, repo)) {
        appended.unshift(`Closes #${issueNumber}`);
      }
    } else {
      text = withholdIssueClose(
        withholdNegatedClose(
          withholdColonAndUrlClose(text, issueNumber, repo),
          issueNumber,
          repo,
        ),
        issueNumber,
        identity,
      );
      if (!mentionsIssue(maskMarkdownCode(text), issueNumber)) {
        appended.unshift(`Part of #${issueNumber}`);
      }
    }
  }

  let body = appended.length > 0 ? `${text}\n\n${appended.join("\n")}` : text;
  if (proposal !== undefined) {
    const markers = liveVibeMarkers(liveBody);
    if (markers.length > 0) body = `${body}\n\n${markers.join("\n")}`;
  }

  if (issueNumber !== undefined && closeAllowed === false) {
    assertWithheld(body, issueNumber, repo);
  }
  if (body.length > PR_BODY_LIMIT) {
    throw new Error(
      `proposed PR description is ${body.length} characters; GitHub allows ${PR_BODY_LIMIT}`,
    );
  }
  return body;
}

/**
 * Remove every complete hidden vibe marker from agent text, then make every
 * other HTML-comment delimiter inert through the shared neutralisation, so an
 * unclosed `<!--` cannot hide what the guard appends (Issue #4637).
 *
 * Exported so the hostile-input tests can reach the scan directly: a body of
 * 30,000 openers cannot be published, so it cannot go through the guard.
 */
export function stripVibeMarkers(text: string): string {
  const kept: string[] = [];
  let at = 0;
  for (const [start, end] of completeVibeMarkerSpans(text)) {
    kept.push(text.slice(at, start));
    at = end;
  }
  kept.push(text.slice(at));
  return neutraliseAgentMarkers(kept.join("")).text.trimEnd();
}

/**
 * The hidden vibe markers the live body carries, each once, in the order of
 * their final occurrence. The footer follows any quoted summary text, so the
 * footer's marker stays the last of its kind (the reader takes the last).
 *
 * A marker quoted in a Markdown code span or block is not the worker's: the
 * scan runs over the masked body, which keeps every offset, and the marker
 * text is sliced from the original (Issue #4637).
 */
function liveVibeMarkers(body: string): string[] {
  const masked = maskMarkdownCode(body);
  const all = completeVibeMarkerSpans(masked).map(([start, end]) =>
    body.slice(start, end)
  );
  const seen = new Set<string>();
  const kept: string[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    if (seen.has(all[i]!)) continue;
    seen.add(all[i]!);
    kept.push(all[i]!);
  }
  return kept.reverse();
}

/**
 * The `[start, end)` offsets of every complete hidden vibe marker in `text`,
 * found in one left-to-right pass (Issue #4637).
 *
 * An opener is `<!--`, optional whitespace, then `vibe-` (case-insensitive).
 * Its marker runs to the first `-->` after the `vibe-`, as the regex this
 * replaced did. An opener with no `-->` after it has no marker, and no later
 * opener can have one either, so the scan stops there and the caller defuses
 * the rest. Each character is read a bounded number of times, so a hostile
 * run of openers cannot make the scan quadratic.
 */
function completeVibeMarkerSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const opener = text.indexOf(COMMENT_OPENER, from);
    if (opener === -1) break;
    const name = skipWhitespace(text, opener + COMMENT_OPENER.length);
    const isVibe =
      text.slice(name, name + MARKER_NAME_PREFIX.length).toLowerCase() ===
        MARKER_NAME_PREFIX;
    if (!isVibe) {
      from = opener + 1;
      continue;
    }
    const close = text.indexOf(
      COMMENT_CLOSER,
      name + MARKER_NAME_PREFIX.length,
    );
    if (close === -1) break;
    const end = close + COMMENT_CLOSER.length;
    spans.push([opener, end]);
    from = end;
  }
  return spans;
}

/** The first index at or after `from` that is not whitespace. */
function skipWhitespace(text: string, from: number): number {
  let at = from;
  while (at < text.length && WHITESPACE_RE.test(text[at]!)) at++;
  return at;
}

/** Every closing reference GitHub would honour, read from a masked body. */
function closingRefs(masked: string, repo: string): ClosingRef[] {
  const refs: ClosingRef[] = [];
  for (const match of masked.matchAll(CLOSING_KEYWORD_RE)) {
    const issueNumber = Number(match[3]);
    if (!Number.isSafeInteger(issueNumber)) continue;
    const qualifier = match[2]?.toLowerCase();
    const sameRepo = qualifier === undefined ||
      qualifier === repo.toLowerCase();
    refs.push({
      key: `${sameRepo ? "" : qualifier}#${issueNumber}`,
      issueNumber,
      sameRepo,
      text: match[0].slice((match[1] ?? "").length),
    });
  }
  return refs;
}

/**
 * Whether the text already settles the governing issue's close: a closing
 * keyword for it (plain, colon or full-URL form), or an explicit `Part of #N`.
 * A bare `#N`, or another repository's `owner/repo#N`, settles nothing.
 */
function namesClosingOrPartOf(
  text: string,
  issueNumber: number,
  repo: string,
): boolean {
  const masked = maskMarkdownCode(text);
  const repoKey = repo.toLowerCase();
  return closingRefs(masked, repo).some((ref) =>
    ref.sameRepo && ref.issueNumber === issueNumber
  ) || governingColonAndUrlCloses(text, issueNumber, repo).length > 0 ||
    [...masked.matchAll(PART_OF_RE)].some((match) => {
      const qualifier = match[2]?.toLowerCase();
      return Number(match[3]) === issueNumber &&
        (qualifier === undefined || qualifier === repoKey);
    });
}

/** Whether a masked body mentions `#N` in any form. */
function mentionsIssue(masked: string, issueNumber: number): boolean {
  return [...masked.matchAll(ISSUE_MENTION_RE)].some((match) =>
    Number(match[1]) === issueNumber
  );
}

/**
 * Replace the keyword of each negated phrase that names the issue, so GitHub
 * no longer reads it as a closing reference. A phrase naming another
 * repository's issue is left alone.
 */
function withholdNegatedClose(
  text: string,
  issueNumber: number,
  repo: string,
): string {
  return text.replace(
    NEGATED_CLOSE_RE,
    (
      match: string,
      negation: string,
      rest: string,
      qualifier: string | undefined,
      num: string,
    ) => {
      if (Number(num) !== issueNumber) return match;
      if (
        qualifier !== undefined &&
        qualifier.toLowerCase() !== repo.toLowerCase()
      ) {
        return match;
      }
      return `${negation}complete${rest}`;
    },
  );
}

/**
 * The `[start, end)` offsets of each colon or full-URL closing phrase that
 * names `issueNumber` in `repo`, covering only the keyword and its separator
 * (Issue #4637). Phrases are found in the masked body, and a match that
 * reaches into code is skipped, so a phrase inside a code span or block is
 * never rewritten.
 */
function governingColonAndUrlCloses(
  text: string,
  issueNumber: number,
  repo: string,
): Array<[number, number]> {
  const masked = maskMarkdownCode(text);
  const repoKey = repo.toLowerCase();
  const spans: Array<[number, number]> = [];
  for (const match of masked.matchAll(COLON_CLOSE_RE)) {
    if (Number(match[4]) !== issueNumber) continue;
    const qualifier = match[3]?.toLowerCase();
    if (qualifier !== undefined && qualifier !== repoKey) continue;
    const span = proseSpan(text, masked, match, match[2]!.length);
    if (span) spans.push(span);
  }
  for (const match of masked.matchAll(URL_CLOSE_RE)) {
    if (Number(match[5]) !== issueNumber) continue;
    if (`${match[3]}/${match[4]}`.toLowerCase() !== repoKey) continue;
    const span = proseSpan(text, masked, match, match[2]!.length);
    if (span) spans.push(span);
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/**
 * The keyword span of a match, when every character from the keyword to the
 * end of the match is prose. The masked and original texts have the same
 * length, so a match that touched code differs between them.
 */
function proseSpan(
  text: string,
  masked: string,
  match: RegExpMatchArray,
  partLength: number,
): [number, number] | undefined {
  const start = (match.index ?? 0) + match[1]!.length;
  const end = (match.index ?? 0) + match[0].length;
  if (text.slice(start, end) !== masked.slice(start, end)) return undefined;
  return [start, start + partLength];
}

/**
 * Replace the keyword and separator of each colon or full-URL closing phrase
 * that names the withheld issue with `Part of `, so GitHub no longer reads it
 * as a closing reference (Issue #4637). A phrase naming another issue or
 * another repository is left alone, and so is one inside code.
 */
function withholdColonAndUrlClose(
  text: string,
  issueNumber: number,
  repo: string,
): string {
  let out = "";
  let at = 0;
  for (
    const [start, end] of governingColonAndUrlCloses(text, issueNumber, repo)
  ) {
    out += `${text.slice(at, start)}Part of `;
    at = end;
  }
  return out + text.slice(at);
}

/** Fail loud if a closing keyword for the withheld issue survives the rewrite. */
function assertWithheld(body: string, issueNumber: number, repo: string): void {
  const masked = maskMarkdownCode(body);
  const survives = closingKeywordLine(masked, issueNumber) !== null ||
    closingRefs(masked, repo).some((ref) =>
      ref.sameRepo && ref.issueNumber === issueNumber
    ) ||
    governingColonAndUrlCloses(body, issueNumber, repo).length > 0;
  if (survives) {
    throw new Error(
      `proposed PR description still closes #${issueNumber} after the withhold; refusing to publish`,
    );
  }
}
