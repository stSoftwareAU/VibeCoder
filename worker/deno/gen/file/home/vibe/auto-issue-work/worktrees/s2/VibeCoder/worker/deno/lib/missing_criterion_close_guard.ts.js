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
 */ import { parseClosureEntries } from "./acceptance_criteria_gate.ts";
import { splitMarkdownCode } from "./markdown_code_spans.ts";
/** Longest criterion text quoted back in a comment or PR note. */ const MAX_QUOTED_LENGTH = 300;
/**
 * Every closing keyword GitHub honours, with the text before it kept so the
 * rewrite leaves the surrounding markdown alone. Same shape as the matcher in
 * `pr_body.ts`; the issue number is compared after the match, never
 * interpolated into the pattern.
 */ export const CLOSING_KEYWORD_RE = /(^|[^\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#(\d+)\b/gi;
/**
 * A colon closing phrase such as `Closes: #N` or `resolved : owner/repo#N`.
 * GitHub honours it, and {@link CLOSING_KEYWORD_RE} does not match it.
 * Groups: the lead character, the keyword with its separator, the optional
 * repository qualifier, and the issue number.
 *
 * No two quantifiers overlap: the keyword is a fixed word set, the two runs of
 * whitespace sit either side of a literal `:`, and the qualifier's two runs are
 * split by a literal `/`, so a hostile run is read in linear time.
 */ export const COLON_CLOSE_RE = /(^|[^\w/])((?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:\s*)(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#(\d+)\b/gi;
/**
 * A full-URL closing phrase such as `Fixes https://github.com/owner/repo/issues/N`.
 * GitHub honours it, and {@link CLOSING_KEYWORD_RE} does not match it.
 * Groups: the lead character, the keyword with its whitespace, the owner, the
 * repository, and the issue number.
 *
 * No two quantifiers overlap: the owner and repository runs are split by a
 * literal `/`, and the keyword's whitespace run is followed by a literal `h`.
 */ export const URL_CLOSE_RE = /(^|[^\w/])((?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+)https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/issues\/(\d+)\b/gi;
/** `Part of #N` (or `owner/repo#N`): the explicit non-closing reference. */ export const PART_OF_RE = /(^|[^\w/])part\s+of\s+(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#(\d+)\b/gi;
/** A caller can defer publication and retry once the governing repository is known. */ export class MissingIssueIdentityError extends Error {
  constructor(){
    super("Cannot reconcile qualified issue reference without trusted repository identity");
    this.name = "MissingIssueIdentityError";
  }
}
function rewriteReference(body, pattern, replacement, issueNumber, identity) {
  return body.replace(pattern, (match, lead, repo, num)=>{
    if (Number(num) !== issueNumber) return match;
    if (repo && !identity) {
      throw new MissingIssueIdentityError();
    }
    const targetRepo = repo ?? identity?.prRepo;
    if (identity && targetRepo?.toLowerCase() !== identity.issueRepo.toLowerCase()) return match;
    return `${lead}${replacement} ${repo ? `${repo}#${num}` : `#${num}`}`;
  });
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
 */ export function findMissingCriteria(prBody) {
  return parseClosureEntries(prBody).filter((entry)=>entry.status === "missing" || entry.status === "partial").map((entry)=>entry.text);
}
/**
 * Same-repository issues a PR body names as `Part of #N` (Issue #3177): the
 * explicit non-closing reference this module writes when a criterion is
 * unmet. A qualified `owner/repo#N` is another repository's issue and is not
 * returned.
 */ export function extractPartOfIssueNumbers(prBody) {
  const numbers = new Set();
  for (const match of prBody.matchAll(PART_OF_RE)){
    if (match[2]) continue;
    const issueNumber = Number(match[3]);
    if (Number.isSafeInteger(issueNumber) && issueNumber > 0) {
      numbers.add(issueNumber);
    }
  }
  return [
    ...numbers
  ];
}
/** Whether the closure block requires withholding the issue close. */ export function withholdsIssueClose(summary) {
  return findMissingCriteria(summary).length > 0;
}
/**
 * Rewrite every closing keyword that names `issueNumber` as `Part of #N`,
 * leaving keywords for other issues untouched.
 *
 * @param body - The PR body.
 * @param issueNumber - The issue the PR must not close.
 */ export function withholdIssueClose(body, issueNumber, identity) {
  return rewriteReference(body, CLOSING_KEYWORD_RE, "Part of", issueNumber, identity);
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
 */ export function neutraliseOtherIssueClosingKeywords(text, issueNumber, identity) {
  const isGoverning = (num, repo)=>Number(num) === issueNumber && (identity === undefined || (repo ?? identity.prRepo).toLowerCase() === identity.issueRepo.toLowerCase());
  // Wrap the keyword word alone, keeping the lead and whatever follows it.
  const wrap = (match, lead)=>{
    const rest = match.slice(lead.length);
    const keyword = /^\w+/.exec(rest)?.[0] ?? rest;
    return `${lead}\`${keyword}\`${rest.slice(keyword.length)}`;
  };
  return splitMarkdownCode(text).map((segment)=>segment.inCode ? segment.value : segment.value.replace(CLOSING_KEYWORD_RE, (match, lead, repo, num)=>isGoverning(num, repo) ? match : wrap(match, lead)).replace(COLON_CLOSE_RE, (match, lead, _kw, repo, num)=>isGoverning(num, repo) ? match : wrap(match, lead)).replace(URL_CLOSE_RE, (match, lead, _kw, owner, name, num)=>isGoverning(num, `${owner}/${name}`) ? match : wrap(match, lead))).join("");
}
/** Restore a governing issue's Part of reference when all criteria are met. */ export function restoreIssueClose(body, issueNumber, identity) {
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
 */ export function alignIssueCloseWithClosure(summary, issueNumber, identity) {
  return withholdsIssueClose(summary) ? withholdIssueClose(summary, issueNumber, identity) : restoreIssueClose(summary, issueNumber, identity);
}
/** One criterion as a bullet, trimmed to a readable length. */ function quote(criterion) {
  const text = criterion.replace(/\s+/g, " ").trim();
  return text.length > MAX_QUOTED_LENGTH ? `- ${text.slice(0, MAX_QUOTED_LENGTH - 1)}…` : `- ${text}`;
}
/**
 * The PR-body section that says why the PR does not close its issue. The
 * note names the target issue only; it carries no VibeCoder issue number
 * (Issue #4641), because GitHub resolves a bare `#N` against the PR's repo.
 *
 * @param issueNumber - The issue the PR is part of.
 * @param missing - The unmet entries, from {@link findMissingCriteria}.
 */ export function buildMissingCriteriaPrNote(issueNumber, missing, issueRepo) {
  const ref = issueRepo ? `${issueRepo}#${issueNumber}` : `#${issueNumber}`;
  return [
    `## Not closing ${ref}`,
    "",
    `This PR leaves ${ref} open: its own \`## Acceptance ` + `Criteria\` block marks ${missing.length} criteri${missing.length === 1 ? "on" : "a"} \`partial\` or \`missing\`:`,
    "",
    ...missing.map(quote),
    "",
    `When it merges, the worker leaves ${ref} open with its existing ` + "labels so it remains queued to finish the unmet criteria.",
    ""
  ].join("\n");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taXNzaW5nX2NyaXRlcmlvbl9jbG9zZV9ndWFyZC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEEgUFIgd2hvc2Ugb3duIGNsb3N1cmUgYmxvY2sgbWFya3MgYSBjcml0ZXJpb24gYHBhcnRpYWxgIG9yIGBtaXNzaW5nYCBkb2VzIG5vdCBjbG9zZSBpdHNcbiAqIGlzc3VlIChJc3N1ZSAjMzE3NykuXG4gKlxuICogXCJBIG1pc3NpbmcgY29yZSBkZWxpdmVyYWJsZSBpcyBub3QgYSBQUlwiIHdhcyBhIHByb3NlIHJ1bGUgdGhhdCBvbmx5IGFcbiAqIHJldmlld2VyIGVuZm9yY2VkLCBhbmQgYSBQUiBpbnRvIGEgbWlsZXN0b25lIGJyYW5jaCBoYXMgbm8gcmV2aWV3ZXI6IGl0XG4gKiBtZXJnZXMgb24gZ3JlZW4gQ0kuIEdSUS1BdXRvVHJhZGVyIzI0NTkgbWFya2VkIHRocmVlIG9mIGl0cyBmb3VyIGNyaXRlcmlhXG4gKiBgbWlzc2luZ2AsIG1lcmdlZCBpbnRvIGl0cyBtaWxlc3RvbmUgYW5kIGNsb3NlZCAjMjMwMSBhcyBjb21wbGV0ZWQ7ICMyMzA3XG4gKiBhbmQgIzIzNzAgZGlkIHRoZSBzYW1lIGZvciAjMjI1NCBhbmQgIzIyNTMuIFRoZSBydW4gaGFkIGFscmVhZHkgc2FpZCwgaW4gYVxuICogZm9ybSB0aGUgd29ya2VyIHBhcnNlcyAoYGFjY2VwdGFuY2VfY3JpdGVyaWFfZ2F0ZS50c2ApLCB0aGF0IHRoZVxuICogZGVsaXZlcmFibGUgd2FzIGFic2VudC5cbiAqXG4gKiBUd28gZGV0ZXJtaW5pc3RpYyBjaGVja3MgcmVhZCB0aGF0IHNpZ25hbDpcbiAqXG4gKiBgYGBtZXJtYWlkXG4gKiBmbG93Y2hhcnQgVERcbiAqICAgICBTW1wiUFIgc3VtbWFyeSBjbG9zdXJlIGJsb2NrXCJdIC0tPiBNe1wiQW55IGVudHJ5PGJyLz5tYXJrZWQgcGFydGlhbCBvciBtaXNzaW5nP1wifVxuICogICAgIE0gLS0gbm8gLS0+IENbXCJQUiBib2R5IGNsb3NlcyB0aGUgaXNzdWU8YnIvPihDbG9zZXMgI04pXCJdXG4gKiAgICAgTSAtLSB5ZXMgLS0+IFBbXCJQUiBib2R5IHNheXMgUGFydCBvZiAjTjxici8+YW5kIG5hbWVzIHRoZSB1bm1ldCBjcml0ZXJpYVwiXVxuICogICAgIEMgLS0+IFhbXCJNZXJnZTogY2xvc2VyIGNsb3NlcyB0aGUgaXNzdWVcIl1cbiAqICAgICBQIC0tPiBIe1wiTWVyZ2U6IGNsb3NlciByZWFkczxici8+dGhlIG1lcmdlZCBQUiBib2R5XCJ9XG4gKiAgICAgSCAtLT4gT1tcIklzc3VlIGxlZnQgb3BlbiBhbmQgcXVldWVkPGJyLz50byBmaW5pc2ggdGhlIHVubWV0IGNyaXRlcmlhXCJdXG4gKiBgYGBcbiAqXG4gKiBUaGUgY2xvc2VyIGNoZWNrIGlzIHRoZSBiZWx0IGFuZCBicmFjZXM6IGEgZmxlZXQgUFIgdGl0bGUgbmFtZXMgaXRzIGlzc3VlXG4gKiAoYChJc3N1ZSAjTilgKSwgc28gYSBjbG9zZXIgdGhhdCByZWFkcyB0aXRsZXMgd291bGQgY2xvc2UgdGhlIGlzc3VlIGV2ZW5cbiAqIHdpdGggbm8gY2xvc2luZyBrZXl3b3JkIGluIHRoZSBib2R5LlxuICpcbiAqIEV2ZXJ5IGZ1bmN0aW9uIGhlcmUgaXMgcHVyZS4gVGhlIGNsb3NlcnMgcHJlc2VydmUgdGhlIGV4aXN0aW5nIGxhYmVscy5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgeyBwYXJzZUNsb3N1cmVFbnRyaWVzIH0gZnJvbSBcIi4vYWNjZXB0YW5jZV9jcml0ZXJpYV9nYXRlLnRzXCI7XG5pbXBvcnQgeyBzcGxpdE1hcmtkb3duQ29kZSB9IGZyb20gXCIuL21hcmtkb3duX2NvZGVfc3BhbnMudHNcIjtcblxuLyoqIExvbmdlc3QgY3JpdGVyaW9uIHRleHQgcXVvdGVkIGJhY2sgaW4gYSBjb21tZW50IG9yIFBSIG5vdGUuICovXG5jb25zdCBNQVhfUVVPVEVEX0xFTkdUSCA9IDMwMDtcblxuLyoqXG4gKiBFdmVyeSBjbG9zaW5nIGtleXdvcmQgR2l0SHViIGhvbm91cnMsIHdpdGggdGhlIHRleHQgYmVmb3JlIGl0IGtlcHQgc28gdGhlXG4gKiByZXdyaXRlIGxlYXZlcyB0aGUgc3Vycm91bmRpbmcgbWFya2Rvd24gYWxvbmUuIFNhbWUgc2hhcGUgYXMgdGhlIG1hdGNoZXIgaW5cbiAqIGBwcl9ib2R5LnRzYDsgdGhlIGlzc3VlIG51bWJlciBpcyBjb21wYXJlZCBhZnRlciB0aGUgbWF0Y2gsIG5ldmVyXG4gKiBpbnRlcnBvbGF0ZWQgaW50byB0aGUgcGF0dGVybi5cbiAqL1xuZXhwb3J0IGNvbnN0IENMT1NJTkdfS0VZV09SRF9SRSA9XG4gIC8oXnxbXlxcdy9dKSg/OmNsb3NlW3NkXT98Zml4KD86ZVtzZF0pP3xyZXNvbHZlW3NkXT8pXFxzKyg/OihbYS16MC05Xy4tXStcXC9bYS16MC05Xy4tXSspKT8jKFxcZCspXFxiL2dpO1xuXG4vKipcbiAqIEEgY29sb24gY2xvc2luZyBwaHJhc2Ugc3VjaCBhcyBgQ2xvc2VzOiAjTmAgb3IgYHJlc29sdmVkIDogb3duZXIvcmVwbyNOYC5cbiAqIEdpdEh1YiBob25vdXJzIGl0LCBhbmQge0BsaW5rIENMT1NJTkdfS0VZV09SRF9SRX0gZG9lcyBub3QgbWF0Y2ggaXQuXG4gKiBHcm91cHM6IHRoZSBsZWFkIGNoYXJhY3RlciwgdGhlIGtleXdvcmQgd2l0aCBpdHMgc2VwYXJhdG9yLCB0aGUgb3B0aW9uYWxcbiAqIHJlcG9zaXRvcnkgcXVhbGlmaWVyLCBhbmQgdGhlIGlzc3VlIG51bWJlci5cbiAqXG4gKiBObyB0d28gcXVhbnRpZmllcnMgb3ZlcmxhcDogdGhlIGtleXdvcmQgaXMgYSBmaXhlZCB3b3JkIHNldCwgdGhlIHR3byBydW5zIG9mXG4gKiB3aGl0ZXNwYWNlIHNpdCBlaXRoZXIgc2lkZSBvZiBhIGxpdGVyYWwgYDpgLCBhbmQgdGhlIHF1YWxpZmllcidzIHR3byBydW5zIGFyZVxuICogc3BsaXQgYnkgYSBsaXRlcmFsIGAvYCwgc28gYSBob3N0aWxlIHJ1biBpcyByZWFkIGluIGxpbmVhciB0aW1lLlxuICovXG5leHBvcnQgY29uc3QgQ09MT05fQ0xPU0VfUkUgPVxuICAvKF58W15cXHcvXSkoKD86Y2xvc2Vbc2RdP3xmaXgoPzplW3NkXSk/fHJlc29sdmVbc2RdPylcXHMqOlxccyopKD86KFthLXowLTlfLi1dK1xcL1thLXowLTlfLi1dKykpPyMoXFxkKylcXGIvZ2k7XG5cbi8qKlxuICogQSBmdWxsLVVSTCBjbG9zaW5nIHBocmFzZSBzdWNoIGFzIGBGaXhlcyBodHRwczovL2dpdGh1Yi5jb20vb3duZXIvcmVwby9pc3N1ZXMvTmAuXG4gKiBHaXRIdWIgaG9ub3VycyBpdCwgYW5kIHtAbGluayBDTE9TSU5HX0tFWVdPUkRfUkV9IGRvZXMgbm90IG1hdGNoIGl0LlxuICogR3JvdXBzOiB0aGUgbGVhZCBjaGFyYWN0ZXIsIHRoZSBrZXl3b3JkIHdpdGggaXRzIHdoaXRlc3BhY2UsIHRoZSBvd25lciwgdGhlXG4gKiByZXBvc2l0b3J5LCBhbmQgdGhlIGlzc3VlIG51bWJlci5cbiAqXG4gKiBObyB0d28gcXVhbnRpZmllcnMgb3ZlcmxhcDogdGhlIG93bmVyIGFuZCByZXBvc2l0b3J5IHJ1bnMgYXJlIHNwbGl0IGJ5IGFcbiAqIGxpdGVyYWwgYC9gLCBhbmQgdGhlIGtleXdvcmQncyB3aGl0ZXNwYWNlIHJ1biBpcyBmb2xsb3dlZCBieSBhIGxpdGVyYWwgYGhgLlxuICovXG5leHBvcnQgY29uc3QgVVJMX0NMT1NFX1JFID1cbiAgLyhefFteXFx3L10pKCg/OmNsb3NlW3NkXT98Zml4KD86ZVtzZF0pP3xyZXNvbHZlW3NkXT8pXFxzKylodHRwczpcXC9cXC9naXRodWJcXC5jb21cXC8oW2EtejAtOV8uLV0rKVxcLyhbYS16MC05Xy4tXSspXFwvaXNzdWVzXFwvKFxcZCspXFxiL2dpO1xuXG4vKiogYFBhcnQgb2YgI05gIChvciBgb3duZXIvcmVwbyNOYCk6IHRoZSBleHBsaWNpdCBub24tY2xvc2luZyByZWZlcmVuY2UuICovXG5leHBvcnQgY29uc3QgUEFSVF9PRl9SRSA9XG4gIC8oXnxbXlxcdy9dKXBhcnRcXHMrb2ZcXHMrKD86KFthLXowLTlfLi1dK1xcL1thLXowLTlfLi1dKykpPyMoXFxkKylcXGIvZ2k7XG5cbi8qKiBBIGNhbGxlciBjYW4gZGVmZXIgcHVibGljYXRpb24gYW5kIHJldHJ5IG9uY2UgdGhlIGdvdmVybmluZyByZXBvc2l0b3J5IGlzIGtub3duLiAqL1xuZXhwb3J0IGNsYXNzIE1pc3NpbmdJc3N1ZUlkZW50aXR5RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIHN1cGVyKFxuICAgICAgXCJDYW5ub3QgcmVjb25jaWxlIHF1YWxpZmllZCBpc3N1ZSByZWZlcmVuY2Ugd2l0aG91dCB0cnVzdGVkIHJlcG9zaXRvcnkgaWRlbnRpdHlcIixcbiAgICApO1xuICAgIHRoaXMubmFtZSA9IFwiTWlzc2luZ0lzc3VlSWRlbnRpdHlFcnJvclwiO1xuICB9XG59XG5cbi8qKiBUcnVzdGVkIHJlcG9zaXRvcmllcyBmb3IgYSBQUiBhbmQgaXRzIGdvdmVybmluZyBpc3N1ZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSXNzdWVJZGVudGl0eSB7XG4gIHByUmVwbzogc3RyaW5nO1xuICBpc3N1ZVJlcG86IHN0cmluZztcbn1cblxuZnVuY3Rpb24gcmV3cml0ZVJlZmVyZW5jZShcbiAgYm9keTogc3RyaW5nLFxuICBwYXR0ZXJuOiBSZWdFeHAsXG4gIHJlcGxhY2VtZW50OiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIGlkZW50aXR5PzogSXNzdWVJZGVudGl0eSxcbik6IHN0cmluZyB7XG4gIHJldHVybiBib2R5LnJlcGxhY2UoXG4gICAgcGF0dGVybixcbiAgICAobWF0Y2g6IHN0cmluZywgbGVhZDogc3RyaW5nLCByZXBvOiBzdHJpbmcgfCB1bmRlZmluZWQsIG51bTogc3RyaW5nKSA9PiB7XG4gICAgICBpZiAoTnVtYmVyKG51bSkgIT09IGlzc3VlTnVtYmVyKSByZXR1cm4gbWF0Y2g7XG4gICAgICBpZiAocmVwbyAmJiAhaWRlbnRpdHkpIHtcbiAgICAgICAgdGhyb3cgbmV3IE1pc3NpbmdJc3N1ZUlkZW50aXR5RXJyb3IoKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHRhcmdldFJlcG8gPSByZXBvID8/IGlkZW50aXR5Py5wclJlcG87XG4gICAgICBpZiAoXG4gICAgICAgIGlkZW50aXR5ICYmXG4gICAgICAgIHRhcmdldFJlcG8/LnRvTG93ZXJDYXNlKCkgIT09IGlkZW50aXR5Lmlzc3VlUmVwby50b0xvd2VyQ2FzZSgpXG4gICAgICApIHJldHVybiBtYXRjaDtcbiAgICAgIHJldHVybiBgJHtsZWFkfSR7cmVwbGFjZW1lbnR9ICR7cmVwbyA/IGAke3JlcG99IyR7bnVtfWAgOiBgIyR7bnVtfWB9YDtcbiAgICB9LFxuICApO1xufVxuXG4vKipcbiAqIFRoZSBjbG9zdXJlIGVudHJpZXMgYSBQUiBzdW1tYXJ5IChvciBQUiBib2R5KSBtYXJrcyBgcGFydGlhbGAgb3IgYG1pc3NpbmdgLCBhcyB3cml0dGVuLlxuICpcbiAqIFJlYWRzIHRoZSBzYW1lIGAjIyBBY2NlcHRhbmNlIENyaXRlcmlhYCBibG9jayB0aGUgY2xvc3VyZSBnYXRlIHBhcnNlcywgc29cbiAqIHRoZSB0d28gY2Fubm90IGRpc2FncmVlIGFib3V0IHdoYXQgdGhlIHJ1biBzYWlkLiBBIGJvZHkgd2l0aCBubyBibG9jayBoYXNcbiAqIG5vIHVubWV0IGVudHJpZXMuXG4gKlxuICogQHBhcmFtIHByQm9keSAtIFRoZSBQUiBzdW1tYXJ5IG9yIGFzc2VtYmxlZCBQUiBib2R5LlxuICogQHJldHVybnMgVGhlIHRleHQgb2YgZWFjaCB1bm1ldCBlbnRyeSwgaW4gc3VtbWFyeSBvcmRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRNaXNzaW5nQ3JpdGVyaWEocHJCb2R5OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBwYXJzZUNsb3N1cmVFbnRyaWVzKHByQm9keSlcbiAgICAuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkuc3RhdHVzID09PSBcIm1pc3NpbmdcIiB8fCBlbnRyeS5zdGF0dXMgPT09IFwicGFydGlhbFwiKVxuICAgIC5tYXAoKGVudHJ5KSA9PiBlbnRyeS50ZXh0KTtcbn1cblxuLyoqXG4gKiBTYW1lLXJlcG9zaXRvcnkgaXNzdWVzIGEgUFIgYm9keSBuYW1lcyBhcyBgUGFydCBvZiAjTmAgKElzc3VlICMzMTc3KTogdGhlXG4gKiBleHBsaWNpdCBub24tY2xvc2luZyByZWZlcmVuY2UgdGhpcyBtb2R1bGUgd3JpdGVzIHdoZW4gYSBjcml0ZXJpb24gaXNcbiAqIHVubWV0LiBBIHF1YWxpZmllZCBgb3duZXIvcmVwbyNOYCBpcyBhbm90aGVyIHJlcG9zaXRvcnkncyBpc3N1ZSBhbmQgaXMgbm90XG4gKiByZXR1cm5lZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RQYXJ0T2ZJc3N1ZU51bWJlcnMocHJCb2R5OiBzdHJpbmcpOiBudW1iZXJbXSB7XG4gIGNvbnN0IG51bWJlcnMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiBwckJvZHkubWF0Y2hBbGwoUEFSVF9PRl9SRSkpIHtcbiAgICBpZiAobWF0Y2hbMl0pIGNvbnRpbnVlO1xuICAgIGNvbnN0IGlzc3VlTnVtYmVyID0gTnVtYmVyKG1hdGNoWzNdKTtcbiAgICBpZiAoTnVtYmVyLmlzU2FmZUludGVnZXIoaXNzdWVOdW1iZXIpICYmIGlzc3VlTnVtYmVyID4gMCkge1xuICAgICAgbnVtYmVycy5hZGQoaXNzdWVOdW1iZXIpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gWy4uLm51bWJlcnNdO1xufVxuXG4vKiogV2hldGhlciB0aGUgY2xvc3VyZSBibG9jayByZXF1aXJlcyB3aXRoaG9sZGluZyB0aGUgaXNzdWUgY2xvc2UuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aGhvbGRzSXNzdWVDbG9zZShzdW1tYXJ5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGZpbmRNaXNzaW5nQ3JpdGVyaWEoc3VtbWFyeSkubGVuZ3RoID4gMDtcbn1cblxuLyoqXG4gKiBSZXdyaXRlIGV2ZXJ5IGNsb3Npbmcga2V5d29yZCB0aGF0IG5hbWVzIGBpc3N1ZU51bWJlcmAgYXMgYFBhcnQgb2YgI05gLFxuICogbGVhdmluZyBrZXl3b3JkcyBmb3Igb3RoZXIgaXNzdWVzIHVudG91Y2hlZC5cbiAqXG4gKiBAcGFyYW0gYm9keSAtIFRoZSBQUiBib2R5LlxuICogQHBhcmFtIGlzc3VlTnVtYmVyIC0gVGhlIGlzc3VlIHRoZSBQUiBtdXN0IG5vdCBjbG9zZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpdGhob2xkSXNzdWVDbG9zZShcbiAgYm9keTogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBpZGVudGl0eT86IElzc3VlSWRlbnRpdHksXG4pOiBzdHJpbmcge1xuICByZXR1cm4gcmV3cml0ZVJlZmVyZW5jZShcbiAgICBib2R5LFxuICAgIENMT1NJTkdfS0VZV09SRF9SRSxcbiAgICBcIlBhcnQgb2ZcIixcbiAgICBpc3N1ZU51bWJlcixcbiAgICBpZGVudGl0eSxcbiAgKTtcbn1cblxuLyoqXG4gKiBOZXV0cmFsaXNlIGV2ZXJ5IGNsb3Npbmcga2V5d29yZCBpbiBgdGV4dGAgdGhhdCBuYW1lcyBhbiBpc3N1ZSBvdGhlciB0aGFuXG4gKiBgaXNzdWVOdW1iZXJgIChJc3N1ZSAjNDc4MykuXG4gKlxuICogQSBQUiBzdW1tYXJ5IGlzIGVtYmVkZGVkIGluIHRoZSBQUiBib2R5IGFzIHdyaXR0ZW4sIHNvIGEgc2VudGVuY2Ugc3VjaCBhc1xuICogXCIuLi4gY2xvc2luZyByZWZlcmVuY2VzIGRvIG5vdCBjbG9zZSAjNDY3NFwiIG1ha2VzIEdpdEh1YiBjbG9zZSAjNDY3NCB3aGVuIHRoZVxuICogUFIgbWVyZ2VzLiBUaGUgcGxhaW4gKGBjbG9zZSAjTmApLCBjb2xvbiAoYGNsb3NlOiAjTmApIGFuZCBmdWxsLVVSTFxuICogKGBGaXhlcyBodHRwczovL2dpdGh1Yi5jb20vby9yL2lzc3Vlcy9OYCkgZm9ybXMgYXJlIGFsbCBoYW5kbGVkLiBFYWNoIHN1Y2gga2V5d29yZCBpcyByZXdyaXR0ZW4gc28gdGhhdCB0aGUga2V5d29yZCB3b3JkIGFsb25lIGlzXG4gKiBhbiBpbmxpbmUgY29kZSBzcGFuOiBgY2xvc2VgICM0Njc0LiBPbmx5IHRoZSBrZXl3b3JkIGlzIHdyYXBwZWQsIG5vdCB0aGVcbiAqIHJlZmVyZW5jZSwgc28gdGhlIHNlbnRlbmNlIHN0aWxsIHJlYWRzIG5hdHVyYWxseS4gQSBiYWNrdGljayBiZXR3ZWVuIHRoZVxuICoga2V5d29yZCBhbmQgYCNOYCBtZWFucyBuZWl0aGVyIEdpdEh1YiBub3IgYSByYXctcmVnZXggcmVhZGVyIChzdWNoIGFzXG4gKiBgZXh0cmFjdENsb3NpbmdJc3N1ZU51bWJlcnNgIGluIGBwcl9ib2R5LnRzYCwgd2hpY2ggZG9lcyBub3QgbWFzayBjb2RlKSBzZWVzXG4gKiBhIGNsb3NpbmcgcmVmZXJlbmNlLiBUaGUgZ292ZXJuaW5nIGlzc3VlIGlzIGxlZnQgYWxvbmU6ICMzMTc3IGFuZCAjNDEyNiBrZWVwXG4gKiBpdHMgb3duIGNsb3Npbmcga2V5d29yZCBpbiBsaW5lIHdpdGggdGhlIGNsb3N1cmUgYmxvY2sgKHNlZVxuICoge0BsaW5rIHdpdGhob2xkSXNzdWVDbG9zZX0gYW5kIHtAbGluayByZXN0b3JlSXNzdWVDbG9zZX0pLCBhbmQgdGhpcyBmdW5jdGlvblxuICogY29tcGxlbWVudHMgdGhlbSBmb3IgZXZlcnkgb3RoZXIgaXNzdWUuXG4gKlxuICogQ29kZSBpcyBpbmVydCB0byBHaXRIdWIsIHNvIG9ubHkgcHJvc2Ugc2VnbWVudHMgKGBpbkNvZGUgPT09IGZhbHNlYCkgYXJlXG4gKiByZXdyaXR0ZW4uIEEgcmVmZXJlbmNlIGlzIGdvdmVybmluZywgYW5kIHJldHVybmVkIHVudG91Y2hlZCwgd2hlbiBpdHMgbnVtYmVyXG4gKiBpcyBgaXNzdWVOdW1iZXJgIGFuZCBlaXRoZXIgbm8gaWRlbnRpdHkgaXMgc3VwcGxpZWQgb3IgaXRzIHJlcG9zaXRvcnlcbiAqIChgb3duZXIvcmVwb2Agd2hlbiBxdWFsaWZpZWQsIG90aGVyd2lzZSB0aGUgUFIncyByZXBvc2l0b3J5KSBpcyB0aGUgaXNzdWUnc1xuICogcmVwb3NpdG9yeS4gQSBxdWFsaWZpZWQgcmVmZXJlbmNlIHRvIGBpc3N1ZU51bWJlcmAgd2l0aCBubyBpZGVudGl0eSBpcyBhbHNvXG4gKiBsZWZ0IHVudG91Y2hlZDoge0BsaW5rIHdpdGhob2xkSXNzdWVDbG9zZX0gaGFuZGxlcyBpdCwgb3IgdGhyb3dzLlxuICpcbiAqIEBwYXJhbSB0ZXh0IC0gTWFya2Rvd24gdG8gbmV1dHJhbGlzZSAoYSBQUiBzdW1tYXJ5IG9yIGFzc2VtYmxlZCBib2R5KS5cbiAqIEBwYXJhbSBpc3N1ZU51bWJlciAtIFRoZSBnb3Zlcm5pbmcgaXNzdWUsIHdob3NlIGNsb3Npbmcga2V5d29yZHMgYXJlIGtlcHQuXG4gKiBAcGFyYW0gaWRlbnRpdHkgLSBUcnVzdGVkIHJlcG9zaXRvcmllcyBmb3IgdGhlIFBSIGFuZCBpdHMgZ292ZXJuaW5nIGlzc3VlLlxuICogQHJldHVybnMgVGhlIHRleHQgd2l0aCBldmVyeSBvdGhlci1pc3N1ZSBjbG9zaW5nIGtleXdvcmQgY29kZS13cmFwcGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmV1dHJhbGlzZU90aGVySXNzdWVDbG9zaW5nS2V5d29yZHMoXG4gIHRleHQ6IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgaWRlbnRpdHk/OiBJc3N1ZUlkZW50aXR5LFxuKTogc3RyaW5nIHtcbiAgY29uc3QgaXNHb3Zlcm5pbmcgPSAobnVtOiBzdHJpbmcsIHJlcG86IHN0cmluZyB8IHVuZGVmaW5lZCk6IGJvb2xlYW4gPT5cbiAgICBOdW1iZXIobnVtKSA9PT0gaXNzdWVOdW1iZXIgJiZcbiAgICAoaWRlbnRpdHkgPT09IHVuZGVmaW5lZCB8fFxuICAgICAgKHJlcG8gPz8gaWRlbnRpdHkucHJSZXBvKS50b0xvd2VyQ2FzZSgpID09PVxuICAgICAgICBpZGVudGl0eS5pc3N1ZVJlcG8udG9Mb3dlckNhc2UoKSk7XG4gIC8vIFdyYXAgdGhlIGtleXdvcmQgd29yZCBhbG9uZSwga2VlcGluZyB0aGUgbGVhZCBhbmQgd2hhdGV2ZXIgZm9sbG93cyBpdC5cbiAgY29uc3Qgd3JhcCA9IChtYXRjaDogc3RyaW5nLCBsZWFkOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IHJlc3QgPSBtYXRjaC5zbGljZShsZWFkLmxlbmd0aCk7XG4gICAgY29uc3Qga2V5d29yZCA9IC9eXFx3Ky8uZXhlYyhyZXN0KT8uWzBdID8/IHJlc3Q7XG4gICAgcmV0dXJuIGAke2xlYWR9XFxgJHtrZXl3b3JkfVxcYCR7cmVzdC5zbGljZShrZXl3b3JkLmxlbmd0aCl9YDtcbiAgfTtcbiAgcmV0dXJuIHNwbGl0TWFya2Rvd25Db2RlKHRleHQpXG4gICAgLm1hcCgoc2VnbWVudCkgPT5cbiAgICAgIHNlZ21lbnQuaW5Db2RlID8gc2VnbWVudC52YWx1ZSA6IHNlZ21lbnQudmFsdWVcbiAgICAgICAgLnJlcGxhY2UoXG4gICAgICAgICAgQ0xPU0lOR19LRVlXT1JEX1JFLFxuICAgICAgICAgIChcbiAgICAgICAgICAgIG1hdGNoOiBzdHJpbmcsXG4gICAgICAgICAgICBsZWFkOiBzdHJpbmcsXG4gICAgICAgICAgICByZXBvOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICAgICAgICBudW06IHN0cmluZyxcbiAgICAgICAgICApID0+IGlzR292ZXJuaW5nKG51bSwgcmVwbykgPyBtYXRjaCA6IHdyYXAobWF0Y2gsIGxlYWQpLFxuICAgICAgICApXG4gICAgICAgIC5yZXBsYWNlKFxuICAgICAgICAgIENPTE9OX0NMT1NFX1JFLFxuICAgICAgICAgIChcbiAgICAgICAgICAgIG1hdGNoOiBzdHJpbmcsXG4gICAgICAgICAgICBsZWFkOiBzdHJpbmcsXG4gICAgICAgICAgICBfa3c6IHN0cmluZyxcbiAgICAgICAgICAgIHJlcG86IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIG51bTogc3RyaW5nLFxuICAgICAgICAgICkgPT4gaXNHb3Zlcm5pbmcobnVtLCByZXBvKSA/IG1hdGNoIDogd3JhcChtYXRjaCwgbGVhZCksXG4gICAgICAgIClcbiAgICAgICAgLnJlcGxhY2UoXG4gICAgICAgICAgVVJMX0NMT1NFX1JFLFxuICAgICAgICAgIChcbiAgICAgICAgICAgIG1hdGNoOiBzdHJpbmcsXG4gICAgICAgICAgICBsZWFkOiBzdHJpbmcsXG4gICAgICAgICAgICBfa3c6IHN0cmluZyxcbiAgICAgICAgICAgIG93bmVyOiBzdHJpbmcsXG4gICAgICAgICAgICBuYW1lOiBzdHJpbmcsXG4gICAgICAgICAgICBudW06IHN0cmluZyxcbiAgICAgICAgICApID0+IGlzR292ZXJuaW5nKG51bSwgYCR7b3duZXJ9LyR7bmFtZX1gKSA/IG1hdGNoIDogd3JhcChtYXRjaCwgbGVhZCksXG4gICAgICAgIClcbiAgICApXG4gICAgLmpvaW4oXCJcIik7XG59XG5cbi8qKiBSZXN0b3JlIGEgZ292ZXJuaW5nIGlzc3VlJ3MgUGFydCBvZiByZWZlcmVuY2Ugd2hlbiBhbGwgY3JpdGVyaWEgYXJlIG1ldC4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXN0b3JlSXNzdWVDbG9zZShcbiAgYm9keTogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBpZGVudGl0eT86IElzc3VlSWRlbnRpdHksXG4pOiBzdHJpbmcge1xuICByZXR1cm4gcmV3cml0ZVJlZmVyZW5jZShib2R5LCBQQVJUX09GX1JFLCBcIkNsb3Nlc1wiLCBpc3N1ZU51bWJlciwgaWRlbnRpdHkpO1xufVxuXG4vKipcbiAqIEFsaWduIHRoZSBpc3N1ZSdzIGNsb3Npbmcga2V5d29yZCB3aXRoIHRoZSBzdW1tYXJ5J3Mgb3duIGNsb3N1cmUgYmxvY2s6IGFcbiAqIGBwYXJ0aWFsYCBvciBgbWlzc2luZ2AgZW50cnkgd2l0aGhvbGRzIHRoZSBjbG9zZSAoYFBhcnQgb2YgI05gKSwgYW5kIG5vIHVubWV0IGVudHJ5XG4gKiByZXN0b3JlcyBpdCAoYENsb3NlcyAjTmApLiBTYW1lIHJ1bGUgYXNzZW1ibGVQckJvZHkgYXBwbGllcyB0byB0aGUgUFIgYm9keVxuICogKElzc3VlICMzMTc3KSwgc28gdGhlIGNvbW1pdHRlZCBzdW1tYXJ5IGFuZCBQUiBib2R5IGFncmVlIChJc3N1ZSAjNDQ3MikuXG4gKlxuICogQHBhcmFtIHN1bW1hcnkgLSBUaGUgUFIgc3VtbWFyeSwgd2l0aCBpdHMgY2xvc3VyZSBibG9jayBhbHJlYWR5IHJlbmRlcmVkLlxuICogQHBhcmFtIGlzc3VlTnVtYmVyIC0gVGhlIGlzc3VlIHRoZSBQUiBpcyBwYXJ0IG9mLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYWxpZ25Jc3N1ZUNsb3NlV2l0aENsb3N1cmUoXG4gIHN1bW1hcnk6IHN0cmluZyxcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgaWRlbnRpdHk/OiBJc3N1ZUlkZW50aXR5LFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIHdpdGhob2xkc0lzc3VlQ2xvc2Uoc3VtbWFyeSlcbiAgICA/IHdpdGhob2xkSXNzdWVDbG9zZShzdW1tYXJ5LCBpc3N1ZU51bWJlciwgaWRlbnRpdHkpXG4gICAgOiByZXN0b3JlSXNzdWVDbG9zZShzdW1tYXJ5LCBpc3N1ZU51bWJlciwgaWRlbnRpdHkpO1xufVxuXG4vKiogT25lIGNyaXRlcmlvbiBhcyBhIGJ1bGxldCwgdHJpbW1lZCB0byBhIHJlYWRhYmxlIGxlbmd0aC4gKi9cbmZ1bmN0aW9uIHF1b3RlKGNyaXRlcmlvbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdGV4dCA9IGNyaXRlcmlvbi5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XG4gIHJldHVybiB0ZXh0Lmxlbmd0aCA+IE1BWF9RVU9URURfTEVOR1RIXG4gICAgPyBgLSAke3RleHQuc2xpY2UoMCwgTUFYX1FVT1RFRF9MRU5HVEggLSAxKX3igKZgXG4gICAgOiBgLSAke3RleHR9YDtcbn1cblxuLyoqXG4gKiBUaGUgUFItYm9keSBzZWN0aW9uIHRoYXQgc2F5cyB3aHkgdGhlIFBSIGRvZXMgbm90IGNsb3NlIGl0cyBpc3N1ZS4gVGhlXG4gKiBub3RlIG5hbWVzIHRoZSB0YXJnZXQgaXNzdWUgb25seTsgaXQgY2FycmllcyBubyBWaWJlQ29kZXIgaXNzdWUgbnVtYmVyXG4gKiAoSXNzdWUgIzQ2NDEpLCBiZWNhdXNlIEdpdEh1YiByZXNvbHZlcyBhIGJhcmUgYCNOYCBhZ2FpbnN0IHRoZSBQUidzIHJlcG8uXG4gKlxuICogQHBhcmFtIGlzc3VlTnVtYmVyIC0gVGhlIGlzc3VlIHRoZSBQUiBpcyBwYXJ0IG9mLlxuICogQHBhcmFtIG1pc3NpbmcgLSBUaGUgdW5tZXQgZW50cmllcywgZnJvbSB7QGxpbmsgZmluZE1pc3NpbmdDcml0ZXJpYX0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZE1pc3NpbmdDcml0ZXJpYVByTm90ZShcbiAgaXNzdWVOdW1iZXI6IG51bWJlcixcbiAgbWlzc2luZzogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGlzc3VlUmVwbz86IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHJlZiA9IGlzc3VlUmVwbyA/IGAke2lzc3VlUmVwb30jJHtpc3N1ZU51bWJlcn1gIDogYCMke2lzc3VlTnVtYmVyfWA7XG4gIHJldHVybiBbXG4gICAgYCMjIE5vdCBjbG9zaW5nICR7cmVmfWAsXG4gICAgXCJcIixcbiAgICBgVGhpcyBQUiBsZWF2ZXMgJHtyZWZ9IG9wZW46IGl0cyBvd24gXFxgIyMgQWNjZXB0YW5jZSBgICtcbiAgICBgQ3JpdGVyaWFcXGAgYmxvY2sgbWFya3MgJHttaXNzaW5nLmxlbmd0aH0gY3JpdGVyaSR7XG4gICAgICBtaXNzaW5nLmxlbmd0aCA9PT0gMSA/IFwib25cIiA6IFwiYVwiXG4gICAgfSBcXGBwYXJ0aWFsXFxgIG9yIFxcYG1pc3NpbmdcXGA6YCxcbiAgICBcIlwiLFxuICAgIC4uLm1pc3NpbmcubWFwKHF1b3RlKSxcbiAgICBcIlwiLFxuICAgIGBXaGVuIGl0IG1lcmdlcywgdGhlIHdvcmtlciBsZWF2ZXMgJHtyZWZ9IG9wZW4gd2l0aCBpdHMgZXhpc3RpbmcgYCArXG4gICAgXCJsYWJlbHMgc28gaXQgcmVtYWlucyBxdWV1ZWQgdG8gZmluaXNoIHRoZSB1bm1ldCBjcml0ZXJpYS5cIixcbiAgICBcIlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0ErQkMsR0FFRCxTQUFTLG1CQUFtQixRQUFRLGdDQUFnQztBQUNwRSxTQUFTLGlCQUFpQixRQUFRLDJCQUEyQjtBQUU3RCxnRUFBZ0UsR0FDaEUsTUFBTSxvQkFBb0I7QUFFMUI7Ozs7O0NBS0MsR0FDRCxPQUFPLE1BQU0scUJBQ1gsb0dBQW9HO0FBRXRHOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sTUFBTSxpQkFDWCwwR0FBMEc7QUFFNUc7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLE1BQU0sZUFDWCxtSUFBbUk7QUFFckksMEVBQTBFLEdBQzFFLE9BQU8sTUFBTSxhQUNYLG9FQUFvRTtBQUV0RSxxRkFBcUYsR0FDckYsT0FBTyxNQUFNLGtDQUFrQztFQUM3QyxhQUFjO0lBQ1osS0FBSyxDQUNIO0lBRUYsSUFBSSxDQUFDLElBQUksR0FBRztFQUNkO0FBQ0Y7QUFRQSxTQUFTLGlCQUNQLElBQVksRUFDWixPQUFlLEVBQ2YsV0FBbUIsRUFDbkIsV0FBbUIsRUFDbkIsUUFBd0I7RUFFeEIsT0FBTyxLQUFLLE9BQU8sQ0FDakIsU0FDQSxDQUFDLE9BQWUsTUFBYyxNQUEwQjtJQUN0RCxJQUFJLE9BQU8sU0FBUyxhQUFhLE9BQU87SUFDeEMsSUFBSSxRQUFRLENBQUMsVUFBVTtNQUNyQixNQUFNLElBQUk7SUFDWjtJQUNBLE1BQU0sYUFBYSxRQUFRLFVBQVU7SUFD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
// denoCacheMetadata=293040001596433455,17888543202295670160