/**
 * PR body generation utilities for the Vibe Coder worker (Issue #915).
 *
 * Handles PR body construction including issue-closing keywords,
 * milestone sections, and idempotency markers.
 *
 * Replaces the body-related functions from worker/shared/pr_manager.sh.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { isIssueSubAgentTier } from "./issue_sub_agent_tier.ts";
import { splitMarkdownCode } from "./markdown_code_spans.ts";
/** Prefix used in all worker PR body markers. */ export const WORKER_PR_MARKER_PREFIX = "<!-- vibe-worker-issue-";
/**
 * Every conjugation GitHub accepts as an issue-closing keyword, matched as a
 * literal so no issue number is ever interpolated into a regular expression
 * (`detect-non-literal-regexp`). Same-repository `#N` references only — a
 * cross-repository `owner/repo#N` names an issue this repository cannot read.
 */ const CLOSING_KEYWORD_PATTERN = /(?:^|[^\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
/**
 * {@link CLOSING_KEYWORD_PATTERN} with the keyword and `#N` required on the
 * same line (`[ \t]+`, not `\s+`): GitHub does not honour a keyword whose `#N`
 * sits on the next line, so `Closes\n#42` closes nothing. Used only by
 * {@link ensurePrReferencesIssue}, which must not treat such a split as a
 * reference; the other callers keep the looser pattern they rely on.
 */ const GITHUB_CLOSING_KEYWORD_PATTERN = /(?:^|[^\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[ \t]+#(\d+)\b/gi;
/** Every `#N` a closing keyword names, as written — duplicates included. */ function closingIssueReferences(prBody) {
  const numbers = [];
  for (const match of prBody.matchAll(CLOSING_KEYWORD_PATTERN)){
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
 */ export function hasClosingKeyword(prBody, issueNumber) {
  return closingIssueReferences(prBody).includes(issueNumber);
}
/**
 * The prose around the closing keyword that names `issueNumber`, with
 * whitespace collapsed, or null when the body does not close it.
 *
 * Callers that must ignore Markdown code pass text that has already had code
 * masked. The match uses the same closing-keyword pattern as
 * {@link hasClosingKeyword}.
 */ export function closingKeywordLine(prBody, issueNumber) {
  for (const match of prBody.matchAll(CLOSING_KEYWORD_PATTERN)){
    if (Number(match[1]) !== issueNumber) continue;
    const at = match.index ?? 0;
    // The line the keyword starts on, through the line it ends on, so a
    // hard-wrapped "close\n#N" stays one phrase and the previous paragraph
    // does not leak in.
    const lineStart = prBody.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
    const matchEnd = at + match[0].length;
    const lineBreak = prBody.indexOf("\n", matchEnd);
    const lineEnd = lineBreak === -1 ? prBody.length : lineBreak;
    const phrase = prBody.slice(lineStart, lineEnd).replace(/\s+/g, " ").trim();
    if (phrase.length === 0) return match[0].trim();
    return phrase.length > 200 ? phrase.slice(0, 200).trim() : phrase;
  }
  return null;
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
 */ export function extractClosingIssueNumbers(prBody) {
  const seen = new Set();
  const numbers = [];
  for (const issueNumber of closingIssueReferences(prBody)){
    if (issueNumber <= 0 || seen.has(issueNumber)) continue;
    seen.add(issueNumber);
    numbers.push(issueNumber);
  }
  return numbers;
}
/**
 * Replace every in-code character (but not line breaks) with a non-space
 * placeholder, so code can never read as prose and a code span between a
 * keyword and its `#N` ("Closes `x` #42") cannot collapse into a same-line
 * reference the way blanking it to spaces would.
 */ function maskCodeWithPlaceholder(text) {
  return splitMarkdownCode(text).map((segment)=>segment.inCode ? segment.value.replace(/[^\n]/g, "\u0001") : segment.value).join("");
}
/**
 * Whether the PR body carries a same-line closing keyword for `issueNumber`
 * in prose that GitHub would act on (Issue #4808): keywords inside code spans
 * or fences are masked out first.
 */ function hasGithubClosingReference(prBody, issueNumber) {
  const masked = maskCodeWithPlaceholder(prBody);
  for (const match of masked.matchAll(GITHUB_CLOSING_KEYWORD_PATTERN)){
    if (Number(match[1]) === issueNumber) return true;
  }
  return false;
}
/**
 * Ensure the PR body contains an issue-closing keyword (Issue #242).
 *
 * GitHub auto-closes issues when a PR body contains keywords like
 * "Closes #N", "Fixes #N", or "Resolves #N". If missing, appends
 * "Closes #N".
 *
 * Issue #4808: a keyword only counts when GitHub would act on it. A keyword
 * inside Markdown code (a code span or a fenced block) is masked out first,
 * and a keyword whose `#N` sits on the next line ("Closes\n#42") does not
 * count — so such a body gets "Closes #N" appended (prepended when the body
 * ends inside an unclosed fence, which would swallow an appended line). A
 * same-line, non-code keyword for the issue leaves the body unchanged.
 *
 * Issue #520: Always uses closing keywords — "Addresses" does NOT
 * trigger GitHub auto-close and causes infinite loops.
 *
 * @param prBody - The full PR body content
 * @param issueNumber - The issue number to reference
 * @returns Updated PR body (unchanged if a same-line, non-code closing keyword
 *   for the issue is already present)
 */ export function ensurePrReferencesIssue(prBody, issueNumber) {
  if (hasGithubClosingReference(prBody, issueNumber)) return prBody;
  const appended = `${prBody}\n\nCloses #${issueNumber}`;
  if (hasGithubClosingReference(appended, issueNumber)) return appended;
  // The body ends inside an unclosed fence, which swallows the appended
  // keyword too; lead with it so it is prose.
  return `Closes #${issueNumber}\n\n${prBody}`;
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
 */ export function buildMilestonePrSection(ctx) {
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
 */ export function buildIdempotencyMarker(issueNumber) {
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
 */ export const SUB_AGENT_TIER_MARKER_PREFIX = '<!-- vibe-sub-agent-tier tier="';
/** Pattern matching every occurrence of the canonical tier marker. */ const SUB_AGENT_TIER_MARKER_PATTERN = /<!-- vibe-sub-agent-tier tier="([a-z]+)" -->/g;
/**
 * Build the hidden HTML-comment marker recording `tier` on a PR body (Issue
 * #3403), e.g. `<!-- vibe-sub-agent-tier tier="haiku" -->`.
 *
 * @param tier - The sub-agent tier the issue run resolved
 * @returns The marker, ready to append to the body
 */ export function buildSubAgentTierMarker(tier) {
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
 */ export function subAgentTierFromBody(body) {
  let last;
  for (const match of body.matchAll(SUB_AGENT_TIER_MARKER_PATTERN)){
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
 */ export function neutraliseSubAgentTierMarkers(text) {
  return text.replace(SUB_AGENT_TIER_MARKER_PATTERN, (_match, tier)=>`vibe-sub-agent-tier tier="${tier}"`);
}
/**
 * Extract issue number from a PR title (Issue #546).
 *
 * PR titles follow the format "Fix: Description (#NNN)" or
 * "Fix: Description (Issue #NNN)". Extracts the issue number.
 *
 * @param title - The PR title string
 * @returns Result containing the issue number, or an error if not found
 */ export function extractIssueNumberFromPrTitle(title) {
  const trailingHash = title.match(/\(#(\d+)\)$/);
  if (trailingHash?.[1]) {
    return {
      ok: true,
      value: parseInt(trailingHash[1], 10)
    };
  }
  const issueHash = title.match(/\(Issue #(\d+)\)$/);
  if (issueHash?.[1]) {
    return {
      ok: true,
      value: parseInt(issueHash[1], 10)
    };
  }
  return {
    ok: false,
    error: new Error(`No issue number found in title: ${title}`)
  };
}
/** The one unambiguous assignment marker on a worker-built PR (Issue #3720). */ export function assignmentIdFromBody(body) {
  const ids = new Set(Array.from(body.matchAll(/<!-- vibe-assignment-id id="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})" -->/g), (match)=>match[1]));
  return ids.size === 1 ? [
    ...ids
  ][0] : undefined;
}
/** Embed only the worker-owned ID, refusing malformed identifiers. */ export function buildAssignmentIdMarker(assignmentId) {
  const marker = `<!-- vibe-assignment-id id="${assignmentId}" -->`;
  if (assignmentIdFromBody(marker) !== assignmentId) {
    throw new Error("Invalid lifecycle assignment ID");
  }
  return marker;
}
/** Quoted documentation is not an attribution marker. */ export function neutraliseAssignmentIdMarkers(text) {
  return text.replaceAll("<!-- vibe-assignment-id ", "vibe-assignment-id ");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcl9ib2R5LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUFIgYm9keSBnZW5lcmF0aW9uIHV0aWxpdGllcyBmb3IgdGhlIFZpYmUgQ29kZXIgd29ya2VyIChJc3N1ZSAjOTE1KS5cbiAqXG4gKiBIYW5kbGVzIFBSIGJvZHkgY29uc3RydWN0aW9uIGluY2x1ZGluZyBpc3N1ZS1jbG9zaW5nIGtleXdvcmRzLFxuICogbWlsZXN0b25lIHNlY3Rpb25zLCBhbmQgaWRlbXBvdGVuY3kgbWFya2Vycy5cbiAqXG4gKiBSZXBsYWNlcyB0aGUgYm9keS1yZWxhdGVkIGZ1bmN0aW9ucyBmcm9tIHdvcmtlci9zaGFyZWQvcHJfbWFuYWdlci5zaC5cbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgSXNzdWVTdWJBZ2VudFRpZXIsIFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgaXNJc3N1ZVN1YkFnZW50VGllciB9IGZyb20gXCIuL2lzc3VlX3N1Yl9hZ2VudF90aWVyLnRzXCI7XG5pbXBvcnQgeyBzcGxpdE1hcmtkb3duQ29kZSB9IGZyb20gXCIuL21hcmtkb3duX2NvZGVfc3BhbnMudHNcIjtcblxuLyoqIFByZWZpeCB1c2VkIGluIGFsbCB3b3JrZXIgUFIgYm9keSBtYXJrZXJzLiAqL1xuZXhwb3J0IGNvbnN0IFdPUktFUl9QUl9NQVJLRVJfUFJFRklYID0gXCI8IS0tIHZpYmUtd29ya2VyLWlzc3VlLVwiO1xuXG4vKipcbiAqIEV2ZXJ5IGNvbmp1Z2F0aW9uIEdpdEh1YiBhY2NlcHRzIGFzIGFuIGlzc3VlLWNsb3Npbmcga2V5d29yZCwgbWF0Y2hlZCBhcyBhXG4gKiBsaXRlcmFsIHNvIG5vIGlzc3VlIG51bWJlciBpcyBldmVyIGludGVycG9sYXRlZCBpbnRvIGEgcmVndWxhciBleHByZXNzaW9uXG4gKiAoYGRldGVjdC1ub24tbGl0ZXJhbC1yZWdleHBgKS4gU2FtZS1yZXBvc2l0b3J5IGAjTmAgcmVmZXJlbmNlcyBvbmx5IOKAlCBhXG4gKiBjcm9zcy1yZXBvc2l0b3J5IGBvd25lci9yZXBvI05gIG5hbWVzIGFuIGlzc3VlIHRoaXMgcmVwb3NpdG9yeSBjYW5ub3QgcmVhZC5cbiAqL1xuY29uc3QgQ0xPU0lOR19LRVlXT1JEX1BBVFRFUk4gPVxuICAvKD86XnxbXlxcdy9dKSg/OmNsb3NlW3NkXT98Zml4KD86ZVtzZF0pP3xyZXNvbHZlW3NkXT8pXFxzKyMoXFxkKylcXGIvZ2k7XG5cbi8qKlxuICoge0BsaW5rIENMT1NJTkdfS0VZV09SRF9QQVRURVJOfSB3aXRoIHRoZSBrZXl3b3JkIGFuZCBgI05gIHJlcXVpcmVkIG9uIHRoZVxuICogc2FtZSBsaW5lIChgWyBcXHRdK2AsIG5vdCBgXFxzK2ApOiBHaXRIdWIgZG9lcyBub3QgaG9ub3VyIGEga2V5d29yZCB3aG9zZSBgI05gXG4gKiBzaXRzIG9uIHRoZSBuZXh0IGxpbmUsIHNvIGBDbG9zZXNcXG4jNDJgIGNsb3NlcyBub3RoaW5nLiBVc2VkIG9ubHkgYnlcbiAqIHtAbGluayBlbnN1cmVQclJlZmVyZW5jZXNJc3N1ZX0sIHdoaWNoIG11c3Qgbm90IHRyZWF0IHN1Y2ggYSBzcGxpdCBhcyBhXG4gKiByZWZlcmVuY2U7IHRoZSBvdGhlciBjYWxsZXJzIGtlZXAgdGhlIGxvb3NlciBwYXR0ZXJuIHRoZXkgcmVseSBvbi5cbiAqL1xuY29uc3QgR0lUSFVCX0NMT1NJTkdfS0VZV09SRF9QQVRURVJOID1cbiAgLyg/Ol58W15cXHcvXSkoPzpjbG9zZVtzZF0/fGZpeCg/OmVbc2RdKT98cmVzb2x2ZVtzZF0/KVsgXFx0XSsjKFxcZCspXFxiL2dpO1xuXG4vKiogRXZlcnkgYCNOYCBhIGNsb3Npbmcga2V5d29yZCBuYW1lcywgYXMgd3JpdHRlbiDigJQgZHVwbGljYXRlcyBpbmNsdWRlZC4gKi9cbmZ1bmN0aW9uIGNsb3NpbmdJc3N1ZVJlZmVyZW5jZXMocHJCb2R5OiBzdHJpbmcpOiBudW1iZXJbXSB7XG4gIGNvbnN0IG51bWJlcnM6IG51bWJlcltdID0gW107XG4gIGZvciAoY29uc3QgbWF0Y2ggb2YgcHJCb2R5Lm1hdGNoQWxsKENMT1NJTkdfS0VZV09SRF9QQVRURVJOKSkge1xuICAgIGNvbnN0IGlzc3VlTnVtYmVyID0gTnVtYmVyKG1hdGNoWzFdKTtcbiAgICBpZiAoTnVtYmVyLmlzU2FmZUludGVnZXIoaXNzdWVOdW1iZXIpKSBudW1iZXJzLnB1c2goaXNzdWVOdW1iZXIpO1xuICB9XG4gIHJldHVybiBudW1iZXJzO1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSBQUiBib2R5IGFscmVhZHkgY29udGFpbnMgYW4gaXNzdWUtY2xvc2luZyBrZXl3b3JkXG4gKiAoQ2xvc2VzLCBGaXhlcywgb3IgUmVzb2x2ZXMg4oCUIGluIGFueSBjb25qdWdhdGlvbiBHaXRIdWIgaG9ub3VycykgZm9yIHRoZVxuICogZ2l2ZW4gaXNzdWUgbnVtYmVyLlxuICpcbiAqIEBwYXJhbSBwckJvZHkgLSBUaGUgZnVsbCBQUiBib2R5IGNvbnRlbnRcbiAqIEBwYXJhbSBpc3N1ZU51bWJlciAtIFRoZSBpc3N1ZSBudW1iZXIgdG8gY2hlY2sgZm9yXG4gKiBAcmV0dXJucyB0cnVlIGlmIGEgY2xvc2luZyBrZXl3b3JkIGlzIGFscmVhZHkgcHJlc2VudFxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFzQ2xvc2luZ0tleXdvcmQoXG4gIHByQm9keTogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiBjbG9zaW5nSXNzdWVSZWZlcmVuY2VzKHByQm9keSkuaW5jbHVkZXMoaXNzdWVOdW1iZXIpO1xufVxuXG4vKipcbiAqIFRoZSBwcm9zZSBhcm91bmQgdGhlIGNsb3Npbmcga2V5d29yZCB0aGF0IG5hbWVzIGBpc3N1ZU51bWJlcmAsIHdpdGhcbiAqIHdoaXRlc3BhY2UgY29sbGFwc2VkLCBvciBudWxsIHdoZW4gdGhlIGJvZHkgZG9lcyBub3QgY2xvc2UgaXQuXG4gKlxuICogQ2FsbGVycyB0aGF0IG11c3QgaWdub3JlIE1hcmtkb3duIGNvZGUgcGFzcyB0ZXh0IHRoYXQgaGFzIGFscmVhZHkgaGFkIGNvZGVcbiAqIG1hc2tlZC4gVGhlIG1hdGNoIHVzZXMgdGhlIHNhbWUgY2xvc2luZy1rZXl3b3JkIHBhdHRlcm4gYXNcbiAqIHtAbGluayBoYXNDbG9zaW5nS2V5d29yZH0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbG9zaW5nS2V5d29yZExpbmUoXG4gIHByQm9keTogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGZvciAoY29uc3QgbWF0Y2ggb2YgcHJCb2R5Lm1hdGNoQWxsKENMT1NJTkdfS0VZV09SRF9QQVRURVJOKSkge1xuICAgIGlmIChOdW1iZXIobWF0Y2hbMV0pICE9PSBpc3N1ZU51bWJlcikgY29udGludWU7XG4gICAgY29uc3QgYXQgPSBtYXRjaC5pbmRleCA/PyAwO1xuICAgIC8vIFRoZSBsaW5lIHRoZSBrZXl3b3JkIHN0YXJ0cyBvbiwgdGhyb3VnaCB0aGUgbGluZSBpdCBlbmRzIG9uLCBzbyBhXG4gICAgLy8gaGFyZC13cmFwcGVkIFwiY2xvc2VcXG4jTlwiIHN0YXlzIG9uZSBwaHJhc2UgYW5kIHRoZSBwcmV2aW91cyBwYXJhZ3JhcGhcbiAgICAvLyBkb2VzIG5vdCBsZWFrIGluLlxuICAgIGNvbnN0IGxpbmVTdGFydCA9IHByQm9keS5sYXN0SW5kZXhPZihcIlxcblwiLCBNYXRoLm1heCgwLCBhdCAtIDEpKSArIDE7XG4gICAgY29uc3QgbWF0Y2hFbmQgPSBhdCArIG1hdGNoWzBdLmxlbmd0aDtcbiAgICBjb25zdCBsaW5lQnJlYWsgPSBwckJvZHkuaW5kZXhPZihcIlxcblwiLCBtYXRjaEVuZCk7XG4gICAgY29uc3QgbGluZUVuZCA9IGxpbmVCcmVhayA9PT0gLTEgPyBwckJvZHkubGVuZ3RoIDogbGluZUJyZWFrO1xuICAgIGNvbnN0IHBocmFzZSA9IHByQm9keS5zbGljZShsaW5lU3RhcnQsIGxpbmVFbmQpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbiAgICBpZiAocGhyYXNlLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG1hdGNoWzBdLnRyaW0oKTtcbiAgICByZXR1cm4gcGhyYXNlLmxlbmd0aCA+IDIwMCA/IHBocmFzZS5zbGljZSgwLCAyMDApLnRyaW0oKSA6IHBocmFzZTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IHRoZSBpc3N1ZSBudW1iZXJzIGEgUFIgYm9keSBjbG9zZXMsIGluIHRoZSBvcmRlciB3cml0dGVuXG4gKiAoSXNzdWUgIzExMTMpLlxuICpcbiAqIFRoZSByZWFkIGhhbGYgb2Yge0BsaW5rIGhhc0Nsb3NpbmdLZXl3b3JkfTogdGhhdCBhbnN3ZXJzIFwiZG9lcyB0aGlzIGJvZHlcbiAqIGNsb3NlIGlzc3VlIE4/XCIsIHRoaXMgYW5zd2VycyBcIndoaWNoIGlzc3VlcyBkb2VzIHRoaXMgYm9keSBjbG9zZT9cIiDigJQgdGhlXG4gKiBxdWVzdGlvbiBhc2tlZCB3aGVuIHRoZSBpc3N1ZSBudW1iZXIgaXMgd2hhdCB5b3UgYXJlIGxvb2tpbmcgZm9yLiBgIzBgIGlzXG4gKiBub3QgYSBHaXRIdWIgaXNzdWUsIHNvIGl0IGlzIGRyb3BwZWQgaGVyZS5cbiAqXG4gKiBAcGFyYW0gcHJCb2R5IC0gVGhlIGZ1bGwgUFIgYm9keSBjb250ZW50XG4gKiBAcmV0dXJucyBEZS1kdXBsaWNhdGVkIGlzc3VlIG51bWJlcnMsIGluIGZpcnN0LW1lbnRpb24gb3JkZXJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RDbG9zaW5nSXNzdWVOdW1iZXJzKHByQm9keTogc3RyaW5nKTogbnVtYmVyW10ge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxudW1iZXI+KCk7XG4gIGNvbnN0IG51bWJlcnM6IG51bWJlcltdID0gW107XG4gIGZvciAoY29uc3QgaXNzdWVOdW1iZXIgb2YgY2xvc2luZ0lzc3VlUmVmZXJlbmNlcyhwckJvZHkpKSB7XG4gICAgaWYgKGlzc3VlTnVtYmVyIDw9IDAgfHwgc2Vlbi5oYXMoaXNzdWVOdW1iZXIpKSBjb250aW51ZTtcbiAgICBzZWVuLmFkZChpc3N1ZU51bWJlcik7XG4gICAgbnVtYmVycy5wdXNoKGlzc3VlTnVtYmVyKTtcbiAgfVxuICByZXR1cm4gbnVtYmVycztcbn1cblxuLyoqXG4gKiBSZXBsYWNlIGV2ZXJ5IGluLWNvZGUgY2hhcmFjdGVyIChidXQgbm90IGxpbmUgYnJlYWtzKSB3aXRoIGEgbm9uLXNwYWNlXG4gKiBwbGFjZWhvbGRlciwgc28gY29kZSBjYW4gbmV2ZXIgcmVhZCBhcyBwcm9zZSBhbmQgYSBjb2RlIHNwYW4gYmV0d2VlbiBhXG4gKiBrZXl3b3JkIGFuZCBpdHMgYCNOYCAoXCJDbG9zZXMgYHhgICM0MlwiKSBjYW5ub3QgY29sbGFwc2UgaW50byBhIHNhbWUtbGluZVxuICogcmVmZXJlbmNlIHRoZSB3YXkgYmxhbmtpbmcgaXQgdG8gc3BhY2VzIHdvdWxkLlxuICovXG5mdW5jdGlvbiBtYXNrQ29kZVdpdGhQbGFjZWhvbGRlcih0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gc3BsaXRNYXJrZG93bkNvZGUodGV4dClcbiAgICAubWFwKChzZWdtZW50KSA9PlxuICAgICAgc2VnbWVudC5pbkNvZGUgPyBzZWdtZW50LnZhbHVlLnJlcGxhY2UoL1teXFxuXS9nLCBcIlxcdTAwMDFcIikgOiBzZWdtZW50LnZhbHVlXG4gICAgKVxuICAgIC5qb2luKFwiXCIpO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgdGhlIFBSIGJvZHkgY2FycmllcyBhIHNhbWUtbGluZSBjbG9zaW5nIGtleXdvcmQgZm9yIGBpc3N1ZU51bWJlcmBcbiAqIGluIHByb3NlIHRoYXQgR2l0SHViIHdvdWxkIGFjdCBvbiAoSXNzdWUgIzQ4MDgpOiBrZXl3b3JkcyBpbnNpZGUgY29kZSBzcGFuc1xuICogb3IgZmVuY2VzIGFyZSBtYXNrZWQgb3V0IGZpcnN0LlxuICovXG5mdW5jdGlvbiBoYXNHaXRodWJDbG9zaW5nUmVmZXJlbmNlKFxuICBwckJvZHk6IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbik6IGJvb2xlYW4ge1xuICBjb25zdCBtYXNrZWQgPSBtYXNrQ29kZVdpdGhQbGFjZWhvbGRlcihwckJvZHkpO1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIG1hc2tlZC5tYXRjaEFsbChHSVRIVUJfQ0xPU0lOR19LRVlXT1JEX1BBVFRFUk4pKSB7XG4gICAgaWYgKE51bWJlcihtYXRjaFsxXSkgPT09IGlzc3VlTnVtYmVyKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogRW5zdXJlIHRoZSBQUiBib2R5IGNvbnRhaW5zIGFuIGlzc3VlLWNsb3Npbmcga2V5d29yZCAoSXNzdWUgIzI0MikuXG4gKlxuICogR2l0SHViIGF1dG8tY2xvc2VzIGlzc3VlcyB3aGVuIGEgUFIgYm9keSBjb250YWlucyBrZXl3b3JkcyBsaWtlXG4gKiBcIkNsb3NlcyAjTlwiLCBcIkZpeGVzICNOXCIsIG9yIFwiUmVzb2x2ZXMgI05cIi4gSWYgbWlzc2luZywgYXBwZW5kc1xuICogXCJDbG9zZXMgI05cIi5cbiAqXG4gKiBJc3N1ZSAjNDgwODogYSBrZXl3b3JkIG9ubHkgY291bnRzIHdoZW4gR2l0SHViIHdvdWxkIGFjdCBvbiBpdC4gQSBrZXl3b3JkXG4gKiBpbnNpZGUgTWFya2Rvd24gY29kZSAoYSBjb2RlIHNwYW4gb3IgYSBmZW5jZWQgYmxvY2spIGlzIG1hc2tlZCBvdXQgZmlyc3QsXG4gKiBhbmQgYSBrZXl3b3JkIHdob3NlIGAjTmAgc2l0cyBvbiB0aGUgbmV4dCBsaW5lIChcIkNsb3Nlc1xcbiM0MlwiKSBkb2VzIG5vdFxuICogY291bnQg4oCUIHNvIHN1Y2ggYSBib2R5IGdldHMgXCJDbG9zZXMgI05cIiBhcHBlbmRlZCAocHJlcGVuZGVkIHdoZW4gdGhlIGJvZHlcbiAqIGVuZHMgaW5zaWRlIGFuIHVuY2xvc2VkIGZlbmNlLCB3aGljaCB3b3VsZCBzd2FsbG93IGFuIGFwcGVuZGVkIGxpbmUpLiBBXG4gKiBzYW1lLWxpbmUsIG5vbi1jb2RlIGtleXdvcmQgZm9yIHRoZSBpc3N1ZSBsZWF2ZXMgdGhlIGJvZHkgdW5jaGFuZ2VkLlxuICpcbiAqIElzc3VlICM1MjA6IEFsd2F5cyB1c2VzIGNsb3Npbmcga2V5d29yZHMg4oCUIFwiQWRkcmVzc2VzXCIgZG9lcyBOT1RcbiAqIHRyaWdnZXIgR2l0SHViIGF1dG8tY2xvc2UgYW5kIGNhdXNlcyBpbmZpbml0ZSBsb29wcy5cbiAqXG4gKiBAcGFyYW0gcHJCb2R5IC0gVGhlIGZ1bGwgUFIgYm9keSBjb250ZW50XG4gKiBAcGFyYW0gaXNzdWVOdW1iZXIgLSBUaGUgaXNzdWUgbnVtYmVyIHRvIHJlZmVyZW5jZVxuICogQHJldHVybnMgVXBkYXRlZCBQUiBib2R5ICh1bmNoYW5nZWQgaWYgYSBzYW1lLWxpbmUsIG5vbi1jb2RlIGNsb3Npbmcga2V5d29yZFxuICogICBmb3IgdGhlIGlzc3VlIGlzIGFscmVhZHkgcHJlc2VudClcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuc3VyZVByUmVmZXJlbmNlc0lzc3VlKFxuICBwckJvZHk6IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbik6IHN0cmluZyB7XG4gIGlmIChoYXNHaXRodWJDbG9zaW5nUmVmZXJlbmNlKHByQm9keSwgaXNzdWVOdW1iZXIpKSByZXR1cm4gcHJCb2R5O1xuICBjb25zdCBhcHBlbmRlZCA9IGAke3ByQm9keX1cXG5cXG5DbG9zZXMgIyR7aXNzdWVOdW1iZXJ9YDtcbiAgaWYgKGhhc0dpdGh1YkNsb3NpbmdSZWZlcmVuY2UoYXBwZW5kZWQsIGlzc3VlTnVtYmVyKSkgcmV0dXJuIGFwcGVuZGVkO1xuICAvLyBUaGUgYm9keSBlbmRzIGluc2lkZSBhbiB1bmNsb3NlZCBmZW5jZSwgd2hpY2ggc3dhbGxvd3MgdGhlIGFwcGVuZGVkXG4gIC8vIGtleXdvcmQgdG9vOyBsZWFkIHdpdGggaXQgc28gaXQgaXMgcHJvc2UuXG4gIHJldHVybiBgQ2xvc2VzICMke2lzc3VlTnVtYmVyfVxcblxcbiR7cHJCb2R5fWA7XG59XG5cbi8qKlxuICogSW5wdXRzIGZvciB0aGUgbWlsZXN0b25lIFBSIGJvZHkgc2VjdGlvbiAoSXNzdWUgIzM5MTEpLlxuICpcbiAqIFRoZSByZXNvbHZlZCBiYXNlIGJyYW5jaCB0cmF2ZWxzIHdpdGggdGhlIG1pbGVzdG9uZSBzbyBhIGNhbGxlciBjYW5ub3RcbiAqIHN1cHBseSB0aGUgKmludGVuZGVkKiBicmFuY2ggYnkgYWNjaWRlbnQg4oCUIHRoZSBzZWN0aW9uIGlzIGFsd2F5cyByZW5kZXJlZFxuICogZnJvbSB0aGUgYnJhbmNoIHRoZSBQUiBpcyBhY3R1YWxseSBiYXNlZCBvbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBNaWxlc3RvbmVQclNlY3Rpb25Db250ZXh0IHtcbiAgLyoqIFRoZSBtaWxlc3RvbmUgdGl0bGUgKGUuZy4sIFwiT0lEQyBBdXRoZW50aWNhdGlvblwiKS4gKi9cbiAgbWlsZXN0b25lVGl0bGU6IHN0cmluZztcbiAgLyoqIFRoZSBicmFuY2ggbmFtZSBkZXJpdmVkIGZvciB0aGlzIG1pbGVzdG9uZS4gKi9cbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmc7XG4gIC8qKiBUaGUgYnJhbmNoIHRoZSBQUiBpcyBhY3R1YWxseSBiYXNlZCBvbiAodGhlIGBnaCBwciBjcmVhdGUgLS1iYXNlYCB2YWx1ZSkuICovXG4gIGJhc2VCcmFuY2g6IHN0cmluZztcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBhIG1pbGVzdG9uZSBjb250ZXh0IHNlY3Rpb24gZm9yIFBSIGJvZHkgKElzc3VlICM0MjMpLlxuICpcbiAqIENyZWF0ZXMgYSBtYXJrZG93biBzZWN0aW9uIGRlc2NyaWJpbmcgdGhlIG1pbGVzdG9uZSB0aGUgUFIgYmVsb25ncyB0byBhbmRcbiAqIHRoZSBicmFuY2ggaXQgaXMgYWN0dWFsbHkgYmFzZWQgb24uXG4gKlxuICogSXNzdWUgIzM5MTE6IHRoZSBzZWN0aW9uIHByZXZpb3VzbHkgbmFtZWQgdGhlICpjb21wdXRlZCogbWlsZXN0b25lIGJyYW5jaCxcbiAqIHNvIHdoZW4gdGhlIGJhc2UtYnJhbmNoIGZhbGxiYWNrIGZpcmVkIHRoZSBmb290ZXIgYXNzZXJ0ZWQgYSB0YXJnZXRpbmcgZmFjdFxuICogdGhhdCB3YXMgZmFsc2UgKFBSICMzOTA0IGNsYWltZWQgYSBgbWlsZXN0b25lLy4uLmAgYmFzZSB3aGlsZSBpdHMgYmFzZSB3YXNcbiAqIGBEZXZlbG9wYCkuIFRoZSBiYXNlIGJyYW5jaCBpcyBub3cgYW4gaW5wdXQsIGFuZCBhIG1pc21hdGNoIGlzIHN0YXRlZFxuICogcGxhaW5seSByYXRoZXIgdGhhbiBoaWRkZW4g4oCUIHRoZSBmb290ZXIgbmV2ZXIgbmFtZXMgYSBicmFuY2ggdGhhdCBpcyBub3QgdGhlXG4gKiBQUidzIGJhc2UuXG4gKlxuICogQHBhcmFtIGN0eCAtIE1pbGVzdG9uZSB0aXRsZSwgZGVyaXZlZCBtaWxlc3RvbmUgYnJhbmNoLCBhbmQgcmVzb2x2ZWQgYmFzZVxuICogQHJldHVybnMgTWFya2Rvd24gc2VjdGlvbiBzdHJpbmcsIG9yIGVtcHR5IHN0cmluZyBpZiBubyBtaWxlc3RvbmVcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkTWlsZXN0b25lUHJTZWN0aW9uKFxuICBjdHg6IE1pbGVzdG9uZVByU2VjdGlvbkNvbnRleHQsXG4pOiBzdHJpbmcge1xuICBjb25zdCB7IG1pbGVzdG9uZVRpdGxlLCBtaWxlc3RvbmVCcmFuY2ggfSA9IGN0eDtcbiAgaWYgKCFtaWxlc3RvbmVUaXRsZSB8fCAhbWlsZXN0b25lQnJhbmNoKSB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH1cblxuICBjb25zdCBiYXNlQnJhbmNoID0gY3R4LmJhc2VCcmFuY2gudHJpbSgpO1xuICBpZiAoYmFzZUJyYW5jaCA9PT0gbWlsZXN0b25lQnJhbmNoKSB7XG4gICAgcmV0dXJuIGBcXG4jIyBNaWxlc3RvbmVcXG5UaGlzIFBSIGlzIHBhcnQgb2YgdGhlICoqJHttaWxlc3RvbmVUaXRsZX0qKiBtaWxlc3RvbmUgYW5kIHRhcmdldHMgdGhlIFxcYCR7bWlsZXN0b25lQnJhbmNofVxcYCBmZWF0dXJlIGJyYW5jaC5cXG5gO1xuICB9XG5cbiAgLy8gTWlzbWF0Y2g6IHNheSB3aGF0IGlzIHRydWUuIE5hbWluZyB0aGUgbWlsZXN0b25lIGJyYW5jaCBoZXJlIHdvdWxkIHJlcGVhdFxuICAvLyB0aGUgIzM5MDQgZmFsc2Vob29kLCBzbyBpdCBpcyBkZWxpYmVyYXRlbHkgbGVmdCBvdXQuXG4gIGlmICghYmFzZUJyYW5jaCkge1xuICAgIHJldHVybiBgXFxuIyMgTWlsZXN0b25lXFxu4pqg77iPIFRoaXMgUFIgaXMgcGFydCBvZiB0aGUgKioke21pbGVzdG9uZVRpdGxlfSoqIG1pbGVzdG9uZSwgYnV0IGl0cyBiYXNlIGJyYW5jaCBjb3VsZCBub3QgYmUgZGV0ZXJtaW5lZCDigJQgaXQgaXMgKipub3QqKiBjb25maXJtZWQgdG8gdGFyZ2V0IHRoZSBtaWxlc3RvbmUgZmVhdHVyZSBicmFuY2guXFxuYDtcbiAgfVxuICByZXR1cm4gYFxcbiMjIE1pbGVzdG9uZVxcbuKaoO+4jyBUaGlzIFBSIGlzIHBhcnQgb2YgdGhlICoqJHttaWxlc3RvbmVUaXRsZX0qKiBtaWxlc3RvbmUsIGJ1dCBpdCBpcyBiYXNlZCBvbiBcXGAke2Jhc2VCcmFuY2h9XFxgIHJhdGhlciB0aGFuIHRoZSBtaWxlc3RvbmUgZmVhdHVyZSBicmFuY2guXFxuYDtcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBhbiBIVE1MIGNvbW1lbnQgaWRlbXBvdGVuY3kgbWFya2VyIGZvciB0aGUgUFIgYm9keSAoSXNzdWUgIzYyMykuXG4gKlxuICogRW1iZWRzIGEgdW5pcXVlIG1hcmtlciBzbyBkdXBsaWNhdGUgUFJzIGNhbiBiZSBkZXRlY3RlZCBhbmRcbiAqIGNvbnNvbGlkYXRlZC4gVGhlIG1hcmtlciBpcyBhbiBIVE1MIGNvbW1lbnQsIGludmlzaWJsZSBpbiByZW5kZXJlZCBtYXJrZG93bi5cbiAqXG4gKiBAcGFyYW0gaXNzdWVOdW1iZXIgLSBUaGUgaXNzdWUgbnVtYmVyIHRvIGVtYmVkXG4gKiBAcmV0dXJucyBIVE1MIGNvbW1lbnQgbWFya2VyIHN0cmluZ1xuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRJZGVtcG90ZW5jeU1hcmtlcihpc3N1ZU51bWJlcjogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke1dPUktFUl9QUl9NQVJLRVJfUFJFRklYfSR7aXNzdWVOdW1iZXJ9IC0tPmA7XG59XG5cbi8qKlxuICogUHJlZml4IG9mIHRoZSBoaWRkZW4gbWFya2VyIHJlY29yZGluZyB0aGUgc3ViLWFnZW50IHRpZXIgdGhlIGlzc3VlIHJ1blxuICogdGhhdCBvcGVuZWQgdGhpcyBQUiByZXNvbHZlZCAoSXNzdWUgIzM0MDMpLlxuICpcbiAqIEEgbGF0ZXIgUFIgb3V0Y29tZSDigJQgbWVyZ2VkLCBjbG9zZWQgdW5tZXJnZWQsIHJldmVydGVkIOKAlCBpcyBhdHRyaWJ1dGVkIGJhY2tcbiAqIHRvIHRoZSB0aWVyIG9mIHRoZSBydW4gdGhhdCByYWlzZWQgdGhlIFBSIGJ5IHJlYWRpbmcgdGhpcyBtYXJrZXIsIHdpdGhvdXRcbiAqIG5lZWRpbmcgdG8gY29ycmVsYXRlIHRoZSBQUiBhZ2FpbnN0IGEgZmxlZXQtdGVsZW1ldHJ5IHJlY29yZCBmcm9tIHRoZVxuICogb3JpZ2luYWwgcnVuLlxuICovXG5leHBvcnQgY29uc3QgU1VCX0FHRU5UX1RJRVJfTUFSS0VSX1BSRUZJWCA9ICc8IS0tIHZpYmUtc3ViLWFnZW50LXRpZXIgdGllcj1cIic7XG5cbi8qKiBQYXR0ZXJuIG1hdGNoaW5nIGV2ZXJ5IG9jY3VycmVuY2Ugb2YgdGhlIGNhbm9uaWNhbCB0aWVyIG1hcmtlci4gKi9cbmNvbnN0IFNVQl9BR0VOVF9USUVSX01BUktFUl9QQVRURVJOID1cbiAgLzwhLS0gdmliZS1zdWItYWdlbnQtdGllciB0aWVyPVwiKFthLXpdKylcIiAtLT4vZztcblxuLyoqXG4gKiBCdWlsZCB0aGUgaGlkZGVuIEhUTUwtY29tbWVudCBtYXJrZXIgcmVjb3JkaW5nIGB0aWVyYCBvbiBhIFBSIGJvZHkgKElzc3VlXG4gKiAjMzQwMyksIGUuZy4gYDwhLS0gdmliZS1zdWItYWdlbnQtdGllciB0aWVyPVwiaGFpa3VcIiAtLT5gLlxuICpcbiAqIEBwYXJhbSB0aWVyIC0gVGhlIHN1Yi1hZ2VudCB0aWVyIHRoZSBpc3N1ZSBydW4gcmVzb2x2ZWRcbiAqIEByZXR1cm5zIFRoZSBtYXJrZXIsIHJlYWR5IHRvIGFwcGVuZCB0byB0aGUgYm9keVxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTdWJBZ2VudFRpZXJNYXJrZXIodGllcjogSXNzdWVTdWJBZ2VudFRpZXIpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7U1VCX0FHRU5UX1RJRVJfTUFSS0VSX1BSRUZJWH0ke3RpZXJ9XCIgLS0+YDtcbn1cblxuLyoqXG4gKiBUaGUgc3ViLWFnZW50IHRpZXIgYSBQUiBib2R5J3MgbWFya2VyIG5hbWVzLCBvciB1bmRlZmluZWQgd2hlbiB0aGUgYm9keVxuICogY2FycmllcyBub25lIChJc3N1ZSAjMzQwMykuXG4gKlxuICogUmVhZHMgdGhlIExBU1Qgb2NjdXJyZW5jZSwgbWlycm9yaW5nIHtAbGluayBzdW1tYXJ5RGlnZXN0RnJvbUJvZHl9IGluXG4gKiBgcHJfYm9keV9zeW5jLnRzYDogdGhlIHN1bW1hcnkgY29udGVudCBvcGVuaW5nIHRoZSBib2R5IG1heSBxdW90ZSBhblxuICogZWFybGllciBtYXJrZXIgdmVyYmF0aW0sIGFuZCB0aGUgcmVhbCBtYXJrZXIgZm9yIHRoaXMgYm9keSBhbHdheXMgZm9sbG93c1xuICogdGhlIGZvb3Rlci4gQW4gb2NjdXJyZW5jZSBuYW1pbmcgYW4gdW5yZWNvZ25pc2VkIHRpZXIgaXMgc2tpcHBlZCByYXRoZXJcbiAqIHRoYW4gcmV0dXJuZWQsIHNvIGEgcXVvdGVkIG9yIGNvcnJ1cHRlZCBtYXJrZXIgY2FuIG5ldmVyIGJlIHJlYWQgYXMgYSByZWFsXG4gKiBvbmUuXG4gKlxuICogQHBhcmFtIGJvZHkgLSBUaGUgUFIgYm9keSB0byBzZWFyY2hcbiAqIEByZXR1cm5zIFRoZSBsYXN0IHJlY29nbmlzZWQgdGllciwgb3IgdW5kZWZpbmVkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdWJBZ2VudFRpZXJGcm9tQm9keShcbiAgYm9keTogc3RyaW5nLFxuKTogSXNzdWVTdWJBZ2VudFRpZXIgfCB1bmRlZmluZWQge1xuICBsZXQgbGFzdDogSXNzdWVTdWJBZ2VudFRpZXIgfCB1bmRlZmluZWQ7XG4gIGZvciAoY29uc3QgbWF0Y2ggb2YgYm9keS5tYXRjaEFsbChTVUJfQUdFTlRfVElFUl9NQVJLRVJfUEFUVEVSTikpIHtcbiAgICBjb25zdCB0aWVyID0gbWF0Y2hbMV07XG4gICAgaWYgKGlzSXNzdWVTdWJBZ2VudFRpZXIodGllcikpIGxhc3QgPSB0aWVyO1xuICB9XG4gIHJldHVybiBsYXN0O1xufVxuXG4vKipcbiAqIFN0cmlwIHRoZSBjb21tZW50IGRlbGltaXRlcnMgb2ZmIGV2ZXJ5IG9jY3VycmVuY2Ugb2YgdGhlIGNhbm9uaWNhbCB0aWVyXG4gKiBtYXJrZXIsIGxlYXZpbmcgdGhlIGJhcmUgdGV4dCBgdmliZS1zdWItYWdlbnQtdGllciB0aWVyPVwiPHRpZXI+XCJgIGJlaGluZCAoSXNzdWVcbiAqICMzNDAzKS5cbiAqXG4gKiBSdW4gb3ZlciBzdW1tYXJ5IGNvbnRlbnQgYmVmb3JlIGl0IGlzIGFzc2VtYmxlZCBpbnRvIGEgUFIgYm9keTogYSBzdW1tYXJ5XG4gKiB0aGF0IGhhcHBlbnMgdG8gcXVvdGUgdGhlIG1hcmtlciB2ZXJiYXRpbSAoZS5nLiBkb2N1bWVudGluZyB0aGlzIGZlYXR1cmUpXG4gKiBtdXN0IG5vdCBiZSByZWFkIGJhY2sgYXMgYSBzZWNvbmQsIHJlYWwgbWFya2VyIGJ5IHtAbGlua1xuICogc3ViQWdlbnRUaWVyRnJvbUJvZHl9IG9uY2UgaXQgaXMgZW1iZWRkZWQuXG4gKlxuICogQHBhcmFtIHRleHQgLSBUZXh0IHRoYXQgbWF5IHF1b3RlIHRoZSBjYW5vbmljYWwgbWFya2VyXG4gKiBAcmV0dXJucyBgdGV4dGAgd2l0aCBldmVyeSBtYXJrZXIgb2NjdXJyZW5jZSBuZXV0cmFsaXNlZFxuICovXG5leHBvcnQgZnVuY3Rpb24gbmV1dHJhbGlzZVN1YkFnZW50VGllck1hcmtlcnModGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZShcbiAgICBTVUJfQUdFTlRfVElFUl9NQVJLRVJfUEFUVEVSTixcbiAgICAoX21hdGNoLCB0aWVyKSA9PiBgdmliZS1zdWItYWdlbnQtdGllciB0aWVyPVwiJHt0aWVyfVwiYCxcbiAgKTtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IGlzc3VlIG51bWJlciBmcm9tIGEgUFIgdGl0bGUgKElzc3VlICM1NDYpLlxuICpcbiAqIFBSIHRpdGxlcyBmb2xsb3cgdGhlIGZvcm1hdCBcIkZpeDogRGVzY3JpcHRpb24gKCNOTk4pXCIgb3JcbiAqIFwiRml4OiBEZXNjcmlwdGlvbiAoSXNzdWUgI05OTilcIi4gRXh0cmFjdHMgdGhlIGlzc3VlIG51bWJlci5cbiAqXG4gKiBAcGFyYW0gdGl0bGUgLSBUaGUgUFIgdGl0bGUgc3RyaW5nXG4gKiBAcmV0dXJucyBSZXN1bHQgY29udGFpbmluZyB0aGUgaXNzdWUgbnVtYmVyLCBvciBhbiBlcnJvciBpZiBub3QgZm91bmRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RJc3N1ZU51bWJlckZyb21QclRpdGxlKFxuICB0aXRsZTogc3RyaW5nLFxuKTogUmVzdWx0PG51bWJlciwgRXJyb3I+IHtcbiAgY29uc3QgdHJhaWxpbmdIYXNoID0gdGl0bGUubWF0Y2goL1xcKCMoXFxkKylcXCkkLyk7XG4gIGlmICh0cmFpbGluZ0hhc2g/LlsxXSkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcGFyc2VJbnQodHJhaWxpbmdIYXNoWzFdLCAxMCkgfTtcbiAgfVxuXG4gIGNvbnN0IGlzc3VlSGFzaCA9IHRpdGxlLm1hdGNoKC9cXChJc3N1ZSAjKFxcZCspXFwpJC8pO1xuICBpZiAoaXNzdWVIYXNoPy5bMV0pIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHBhcnNlSW50KGlzc3VlSGFzaFsxXSwgMTApIH07XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjogbmV3IEVycm9yKGBObyBpc3N1ZSBudW1iZXIgZm91bmQgaW4gdGl0bGU6ICR7dGl0bGV9YCksXG4gIH07XG59XG5cbi8qKiBUaGUgb25lIHVuYW1iaWd1b3VzIGFzc2lnbm1lbnQgbWFya2VyIG9uIGEgd29ya2VyLWJ1aWx0IFBSIChJc3N1ZSAjMzcyMCkuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzaWdubWVudElkRnJvbUJvZHkoYm9keTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgaWRzID0gbmV3IFNldChcbiAgICBBcnJheS5mcm9tKFxuICAgICAgYm9keS5tYXRjaEFsbChcbiAgICAgICAgLzwhLS0gdmliZS1hc3NpZ25tZW50LWlkIGlkPVwiKFswLTlhLWZdezh9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezEyfSlcIiAtLT4vZyxcbiAgICAgICksXG4gICAgICAobWF0Y2gpID0+IG1hdGNoWzFdLFxuICAgICksXG4gICk7XG4gIHJldHVybiBpZHMuc2l6ZSA9PT0gMSA/IFsuLi5pZHNdWzBdIDogdW5kZWZpbmVkO1xufVxuXG4vKiogRW1iZWQgb25seSB0aGUgd29ya2VyLW93bmVkIElELCByZWZ1c2luZyBtYWxmb3JtZWQgaWRlbnRpZmllcnMuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRBc3NpZ25tZW50SWRNYXJrZXIoYXNzaWdubWVudElkOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBtYXJrZXIgPSBgPCEtLSB2aWJlLWFzc2lnbm1lbnQtaWQgaWQ9XCIke2Fzc2lnbm1lbnRJZH1cIiAtLT5gO1xuICBpZiAoYXNzaWdubWVudElkRnJvbUJvZHkobWFya2VyKSAhPT0gYXNzaWdubWVudElkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBsaWZlY3ljbGUgYXNzaWdubWVudCBJRFwiKTtcbiAgfVxuICByZXR1cm4gbWFya2VyO1xufVxuXG4vKiogUXVvdGVkIGRvY3VtZW50YXRpb24gaXMgbm90IGFuIGF0dHJpYnV0aW9uIG1hcmtlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuZXV0cmFsaXNlQXNzaWdubWVudElkTWFya2Vycyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlQWxsKFwiPCEtLSB2aWJlLWFzc2lnbm1lbnQtaWQgXCIsIFwidmliZS1hc3NpZ25tZW50LWlkIFwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Q0FRQyxHQUdELFNBQVMsbUJBQW1CLFFBQVEsNEJBQTRCO0FBQ2hFLFNBQVMsaUJBQWlCLFFBQVEsMkJBQTJCO0FBRTdELCtDQUErQyxHQUMvQyxPQUFPLE1BQU0sMEJBQTBCLDBCQUEwQjtBQUVqRTs7Ozs7Q0FLQyxHQUNELE1BQU0sMEJBQ0o7QUFFRjs7Ozs7O0NBTUMsR0FDRCxNQUFNLGlDQUNKO0FBRUYsMEVBQTBFLEdBQzFFLFNBQVMsdUJBQXVCLE1BQWM7RUFDNUMsTUFBTSxVQUFvQixFQUFFO0VBQzVCLEtBQUssTUFBTSxTQUFTLE9BQU8sUUFBUSxDQUFDLHlCQUEwQjtJQUM1RCxNQUFNLGNBQWMsT0FBTyxLQUFLLENBQUMsRUFBRTtJQUNuQyxJQUFJLE9BQU8sYUFBYSxDQUFDLGNBQWMsUUFBUSxJQUFJLENBQUM7RUFDdEQ7RUFDQSxPQUFPO0FBQ1Q7QUFFQTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUyxrQkFDZCxNQUFjLEVBQ2QsV0FBbUI7RUFFbkIsT0FBTyx1QkFBdUIsUUFBUSxRQUFRLENBQUM7QUFDakQ7QUFFQTs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxT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
// denoCacheMetadata=740195454203235708,5761123664670368415