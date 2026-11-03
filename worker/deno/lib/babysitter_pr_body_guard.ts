/**
 * What a babysitter repair publishes as the PR description (Issue #4637).
 *
 * The agent's proposal (`.babysitter-pr-body`) replaces the body the summary
 * sync built, and GitHub closes every issue the body names with a closing
 * keyword when the PR merges. A proposal that said `close #4674` over a
 * committed summary with an unmet criterion re-opened exactly the close that
 * the summary withholds (the #4716 regression).
 *
 * The guard decides, from evidence committed at the pushed head, whether the
 * governing issue may be closed, and rewrites the proposal to match:
 *
 * ```mermaid
 * flowchart TD
 *     S["Summary committed at the pushed head"] --> M{"Unmet criterion, no committed<br/>summary, or no closing phrase?"}
 *     M -- yes --> W["Withhold: negated phrases become complete,<br/>closing keywords become Part of"]
 *     M -- no --> C["Keep the closing keyword, or add Closes #N<br/>when the proposal dropped the issue"]
 * ```
 *
 * The proposal is agent text, so any hidden `<!-- vibe-... -->` marker in it is
 * stripped. The live body's markers are appended in their place, so the
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
  withholdIssueClose,
} from "./missing_criterion_close_guard.ts";
import { maskMarkdownCode } from "./markdown_code_spans.ts";
import { closingKeywordLine } from "./pr_body.ts";
import { issueNumberFromMarker } from "./pr_body_sync.ts";

/** GitHub's pull request body limit, in characters (Issue #4359). */
export const PR_BODY_LIMIT = 65_536;

/** A complete hidden worker marker, `<!-- vibe-... -->`. */
const VIBE_MARKER_RE = /<!--\s*vibe-[\s\S]*?-->/gi;

/** The opener of a hidden marker, whether or not the marker is closed. */
const VIBE_MARKER_OPENER_RE = /<!--\s*vibe-/gi;

/**
 * A negated closing phrase such as "does not close #N". GitHub still reads it
 * as a closing reference, so its keyword is replaced by `complete`. Groups:
 * the negation, the rest of the reference from its whitespace onward, the
 * optional repository qualifier, and the issue number.
 */
const NEGATED_CLOSE_RE =
  /((?:\bnot|\bnever|\bcannot|n['’]t|\bno\s+longer)\s+)(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s+(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#(\d+)\b)/gi;

/** Any `#N` reference, whether same-repository or qualified. */
const ISSUE_MENTION_RE = /#(\d+)\b/g;

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
 * the committed summary must exist, must have no unmet criterion, and must
 * carry a closing keyword for the issue. A proposal with its own unmet
 * criterion withholds the close too.
 *
 * @param input.summary - The summary committed at the pushed head.
 * @param input.issueNumber - The governing issue.
 * @param input.proposal - The agent's proposed description, if any.
 */
export function isIssueCloseAllowed(input: {
  summary: string | undefined;
  issueNumber: number;
  proposal: string | undefined;
}): boolean {
  const { summary, issueNumber, proposal } = input;
  if (summary === undefined) return false;
  if (findMissingCriteria(summary).length > 0) return false;
  if (closingKeywordLine(maskMarkdownCode(summary), issueNumber) === null) {
    return false;
  }
  return proposal === undefined || findMissingCriteria(proposal).length === 0;
}

/**
 * Whether GitHub reports the issue as closed by the PR. A reference whose
 * repository is not given is taken to be this repository's.
 *
 * @param refs - `closingIssuesReferences` from `gh pr view`.
 * @param issueNumber - The issue to look for.
 * @param repo - The pull request's repository, `owner/name`.
 */
export function githubClosesIssue(
  refs: readonly ClosingIssueReference[] | undefined,
  issueNumber: number,
  repo: string,
): boolean {
  return (refs ?? []).some((ref) => {
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
 * An unrelated PR, with no worker marker in its live body, gets only the
 * restored closing references.
 *
 * @throws When the governing issue would still close, or the body is over the
 *   GitHub limit. The caller then leaves the reviews open.
 */
export function guardPrBodyProposal(input: PrBodyGuardInput): string {
  const { proposal, liveBody, summary, repo } = input;
  const identity: IssueIdentity = { prRepo: repo, issueRepo: repo };
  const issueNumber = issueNumberFromMarker(liveBody);
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
    closeAllowed = isIssueCloseAllowed({ summary, issueNumber, proposal });
    if (closeAllowed) {
      if (!mentionsIssue(maskMarkdownCode(text), issueNumber)) {
        appended.unshift(`Closes #${issueNumber}`);
      }
    } else {
      text = withholdIssueClose(
        withholdNegatedClose(text, issueNumber, repo),
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

/** Remove every hidden vibe marker from agent text, and defuse a stray opener. */
function stripVibeMarkers(text: string): string {
  return text
    .replace(VIBE_MARKER_RE, "")
    .replace(VIBE_MARKER_OPENER_RE, "<!- - vibe-")
    .trimEnd();
}

/**
 * The hidden vibe markers the live body carries, each once, in the order of
 * their final occurrence. The footer follows any quoted summary text, so the
 * footer's marker stays the last of its kind (the reader takes the last).
 */
function liveVibeMarkers(body: string): string[] {
  const all = [...body.matchAll(VIBE_MARKER_RE)].map((match) => match[0]);
  const kept: string[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    if (!kept.includes(all[i]!)) kept.unshift(all[i]!);
  }
  return kept;
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

/** Fail loud if a closing keyword for the withheld issue survives the rewrite. */
function assertWithheld(body: string, issueNumber: number, repo: string): void {
  const masked = maskMarkdownCode(body);
  const survives = closingKeywordLine(masked, issueNumber) !== null ||
    closingRefs(masked, repo).some((ref) =>
      ref.sameRepo && ref.issueNumber === issueNumber
    );
  if (survives) {
    throw new Error(
      `proposed PR description still closes #${issueNumber} after the withhold; refusing to publish`,
    );
  }
}
