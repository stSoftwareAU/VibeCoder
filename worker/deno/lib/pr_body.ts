/**
 * PR body generation utilities for the Vibe Coder worker (Issue #915).
 *
 * Handles PR body construction including issue-closing keywords,
 * milestone sections, and idempotency markers.
 *
 * Replaces the body-related functions from worker/shared/pr_manager.sh.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { IssueSubAgentTier, Result } from "../types.ts";
import { isIssueSubAgentTier } from "./issue_sub_agent_tier.ts";

/** Prefix used in all worker PR body markers. */
export const WORKER_PR_MARKER_PREFIX = "<!-- vibe-worker-issue-";

/**
 * Every conjugation GitHub accepts as an issue-closing keyword, matched as a
 * literal so no issue number is ever interpolated into a regular expression
 * (`detect-non-literal-regexp`). Same-repository `#N` references only — a
 * cross-repository `owner/repo#N` names an issue this repository cannot read.
 */
const CLOSING_KEYWORD_PATTERN =
  /(?:^|[^\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

/** Every `#N` a closing keyword names, as written — duplicates included. */
function closingIssueReferences(prBody: string): number[] {
  const numbers: number[] = [];
  for (const match of prBody.matchAll(CLOSING_KEYWORD_PATTERN)) {
    const issueNumber = Number(match[1]);
    if (Number.isSafeInteger(issueNumber)) numbers.push(issueNumber);
  }
  return numbers;
}

/**
 * Check whether a PR body already contains an issue-closing keyword
 * (Closes, Fixes, or Resolves — in any conjugation GitHub honours) for the
 * given issue number.
 *
 * @param prBody - The full PR body content
 * @param issueNumber - The issue number to check for
 * @returns true if a closing keyword is already present
 */
export function hasClosingKeyword(
  prBody: string,
  issueNumber: number,
): boolean {
  return closingIssueReferences(prBody).includes(issueNumber);
}

/**
 * Extract the issue numbers a PR body closes, in the order written
 * (Issue #1113).
 *
 * The read half of {@link hasClosingKeyword}: that answers "does this body
 * close issue N?", this answers "which issues does this body close?" — the
 * question asked when the issue number is what you are looking for. `#0` is
 * not a GitHub issue, so it is dropped here.
 *
 * @param prBody - The full PR body content
 * @returns De-duplicated issue numbers, in first-mention order
 */
export function extractClosingIssueNumbers(prBody: string): number[] {
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const issueNumber of closingIssueReferences(prBody)) {
    if (issueNumber <= 0 || seen.has(issueNumber)) continue;
    seen.add(issueNumber);
    numbers.push(issueNumber);
  }
  return numbers;
}

/**
 * Ensure the PR body contains an issue-closing keyword (Issue #242).
 *
 * GitHub auto-closes issues when a PR body contains keywords like
 * "Closes #N", "Fixes #N", or "Resolves #N". If missing, appends
 * "Closes #N".
 *
 * Issue #520: Always uses closing keywords — "Addresses" does NOT
 * trigger GitHub auto-close and causes infinite loops.
 *
 * @param prBody - The full PR body content
 * @param issueNumber - The issue number to reference
 * @returns Updated PR body (unchanged if keyword already present)
 */
export function ensurePrReferencesIssue(
  prBody: string,
  issueNumber: number,
): string {
  if (hasClosingKeyword(prBody, issueNumber)) {
    return prBody;
  }
  return `${prBody}\n\nCloses #${issueNumber}`;
}

/**
 * Inputs for the milestone PR body section (Issue #3911).
 *
 * The resolved base branch travels with the milestone so a caller cannot
 * supply the *intended* branch by accident — the section is always rendered
 * from the branch the PR is actually based on.
 */
export interface MilestonePrSectionContext {
  /** The milestone title (e.g., "OIDC Authentication"). */
  milestoneTitle: string;
  /** The branch name derived for this milestone. */
  milestoneBranch: string;
  /** The branch the PR is actually based on (the `gh pr create --base` value). */
  baseBranch: string;
}

/**
 * Generate a milestone context section for PR body (Issue #423).
 *
 * Creates a markdown section describing the milestone the PR belongs to and
 * the branch it is actually based on.
 *
 * Issue #3911: the section previously named the *computed* milestone branch,
 * so when the base-branch fallback fired the footer asserted a targeting fact
 * that was false (PR #3904 claimed a `milestone/...` base while its base was
 * `Develop`). The base branch is now an input, and a mismatch is stated
 * plainly rather than hidden — the footer never names a branch that is not the
 * PR's base.
 *
 * @param ctx - Milestone title, derived milestone branch, and resolved base
 * @returns Markdown section string, or empty string if no milestone
 */
export function buildMilestonePrSection(
  ctx: MilestonePrSectionContext,
): string {
  const { milestoneTitle, milestoneBranch } = ctx;
  if (!milestoneTitle || !milestoneBranch) {
    return "";
  }

  const baseBranch = ctx.baseBranch.trim();
  if (baseBranch === milestoneBranch) {
    return `\n## Milestone\nThis PR is part of the **${milestoneTitle}** milestone and targets the \`${milestoneBranch}\` feature branch.\n`;
  }

  // Mismatch: say what is true. Naming the milestone branch here would repeat
  // the #3904 falsehood, so it is deliberately left out.
  if (!baseBranch) {
    return `\n## Milestone\n⚠️ This PR is part of the **${milestoneTitle}** milestone, but its base branch could not be determined — it is **not** confirmed to target the milestone feature branch.\n`;
  }
  return `\n## Milestone\n⚠️ This PR is part of the **${milestoneTitle}** milestone, but it is based on \`${baseBranch}\` rather than the milestone feature branch.\n`;
}

/**
 * Generate an HTML comment idempotency marker for the PR body (Issue #623).
 *
 * Embeds a unique marker so duplicate PRs can be detected and
 * consolidated. The marker is an HTML comment, invisible in rendered markdown.
 *
 * @param issueNumber - The issue number to embed
 * @returns HTML comment marker string
 */
export function buildIdempotencyMarker(issueNumber: number): string {
  return `${WORKER_PR_MARKER_PREFIX}${issueNumber} -->`;
}

/**
 * Prefix of the hidden marker recording the sub-agent tier the issue run
 * that opened this PR resolved (Issue #3403).
 *
 * A later PR outcome — merged, closed unmerged, reverted — is attributed back
 * to the tier of the run that raised the PR by reading this marker, without
 * needing to correlate the PR against a fleet-telemetry record from the
 * original run.
 */
export const SUB_AGENT_TIER_MARKER_PREFIX = '<!-- vibe-sub-agent-tier tier="';

/** Pattern matching every occurrence of the canonical tier marker. */
const SUB_AGENT_TIER_MARKER_PATTERN =
  /<!-- vibe-sub-agent-tier tier="([a-z]+)" -->/g;

/**
 * Build the hidden HTML-comment marker recording `tier` on a PR body (Issue
 * #3403), e.g. `<!-- vibe-sub-agent-tier tier="haiku" -->`.
 *
 * @param tier - The sub-agent tier the issue run resolved
 * @returns The marker, ready to append to the body
 */
export function buildSubAgentTierMarker(tier: IssueSubAgentTier): string {
  return `${SUB_AGENT_TIER_MARKER_PREFIX}${tier}" -->`;
}

/**
 * The sub-agent tier a PR body's marker names, or undefined when the body
 * carries none (Issue #3403).
 *
 * Reads the LAST occurrence, mirroring {@link summaryDigestFromBody} in
 * `pr_body_sync.ts`: the summary content opening the body may quote an
 * earlier marker verbatim, and the real marker for this body always follows
 * the footer. An occurrence naming an unrecognised tier is skipped rather
 * than returned, so a quoted or corrupted marker can never be read as a real
 * one.
 *
 * @param body - The PR body to search
 * @returns The last recognised tier, or undefined
 */
export function subAgentTierFromBody(
  body: string,
): IssueSubAgentTier | undefined {
  let last: IssueSubAgentTier | undefined;
  for (const match of body.matchAll(SUB_AGENT_TIER_MARKER_PATTERN)) {
    const tier = match[1];
    if (isIssueSubAgentTier(tier)) last = tier;
  }
  return last;
}

/**
 * Strip the comment delimiters off every occurrence of the canonical tier
 * marker, leaving the bare text `vibe-sub-agent-tier tier="<tier>"` behind (Issue
 * #3403).
 *
 * Run over summary content before it is assembled into a PR body: a summary
 * that happens to quote the marker verbatim (e.g. documenting this feature)
 * must not be read back as a second, real marker by {@link
 * subAgentTierFromBody} once it is embedded.
 *
 * @param text - Text that may quote the canonical marker
 * @returns `text` with every marker occurrence neutralised
 */
export function neutraliseSubAgentTierMarkers(text: string): string {
  return text.replace(
    SUB_AGENT_TIER_MARKER_PATTERN,
    (_match, tier) => `vibe-sub-agent-tier tier="${tier}"`,
  );
}

/**
 * Extract issue number from a PR title (Issue #546).
 *
 * PR titles follow the format "Fix: Description (#NNN)" or
 * "Fix: Description (Issue #NNN)". Extracts the issue number.
 *
 * @param title - The PR title string
 * @returns Result containing the issue number, or an error if not found
 */
export function extractIssueNumberFromPrTitle(
  title: string,
): Result<number, Error> {
  const trailingHash = title.match(/\(#(\d+)\)$/);
  if (trailingHash?.[1]) {
    return { ok: true, value: parseInt(trailingHash[1], 10) };
  }

  const issueHash = title.match(/\(Issue #(\d+)\)$/);
  if (issueHash?.[1]) {
    return { ok: true, value: parseInt(issueHash[1], 10) };
  }

  return {
    ok: false,
    error: new Error(`No issue number found in title: ${title}`),
  };
}
