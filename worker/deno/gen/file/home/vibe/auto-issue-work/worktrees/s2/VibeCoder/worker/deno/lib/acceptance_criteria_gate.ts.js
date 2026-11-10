/**
 * Deterministic acceptance-criteria closure gate for PR summaries (Issue #518).
 *
 * The planner writes a `## Acceptance Criteria` checklist into every published
 * sub-issue (`prompts/planning/prompt.md`), and until now nothing downstream ever
 * read it back: the implementing run never saw the criteria as a target and the
 * PR summary never said which were met, so a reviewer had to re-derive them by
 * hand. The artefact was written and orphaned.
 *
 * `prompts/issue/prompt.md` closes the loop on the agent side — when the issue body
 * carries criteria, the PR summary must carry a `## Acceptance Criteria` block
 * assessing each one as `met` / `partial` / `missing`, with the file or test that
 * evidences it, a one-line reason for every gap, and an `unrequested` entry for
 * any change in the diff not traceable to the issue. A prose rule alone is a
 * quality escape (the same escape `failure_detection_gate.ts` closes on the
 * planner side), so this module is the deterministic check behind it: an
 * unexplained gap is a failure to surface, not a pass.
 *
 * Both exported functions are pure — the caller
 * (`phases/completion_phase.ts`) supplies the issue body and the assembled PR
 * body, so the whole path is unit-tested without a network.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { reviewBlockTemplateLines } from "./review_block_template.ts";
/** Statuses that must name the evidence observed. */ const EVIDENCE_REQUIRED = [
  "met",
  "partial"
];
/** Statuses that must carry a one-line reason for the gap. */ const REASON_REQUIRED = [
  "partial",
  "missing"
];
// A heading reading exactly "Acceptance Criteria". Used for the PR summary's
// closure block (`parseClosureEntries`), where a wider heading earlier in the
// summary must not shadow the real block (Issue #4107).
// Every heading tail here is `\s*(?::\s*)?$`, not `\s*:?\s*$`: two whitespace
// runs with only an optional `:` between them backtrack quadratically on a
// heading padded with spaces and then any other character (Issue #3164).
const ACCEPTANCE_HEADING_RE = /^\s{0,3}#{1,6}\s+acceptance\s+criteria\s*(?::\s*)?$/i;
// The same heading in an issue body, optionally preceded by up to five words
// (e.g. "Scope and acceptance criteria", Issue #4107). The prefix words
// (`[...]+\s+`) are non-whitespace runs separated by whitespace, so the pattern
// is bounded and has no overlapping quantifiers.
const ISSUE_ACCEPTANCE_HEADING_RE = /^\s{0,3}#{1,6}\s+(?:[a-z0-9&,/'.-]+\s+){0,5}acceptance\s+criteria\s*(?::\s*)?$/i;
// A grill-me "Accepted scope so far" heading (Issue #2562). Grill-me states the
// scope it settled under this heading rather than "Acceptance Criteria", so an
// issue refined by grill-me carried no criteria as far as this gate could see.
const ACCEPTED_SCOPE_HEADING_RE = /^\s{0,3}#{1,6}\s+accepted\s+scope(?:\s+so\s+far)?\s*(?::\s*)?$/i;
// A "Done when" heading (Issue #3486). An issue whose criteria sit under
// `## Done when` — rather than "Acceptance Criteria" or grill-me's
// "Accepted scope so far" — still states its scope, so the degraded-run guard
// must read it rather than treating the issue as stating no criteria.
const DONE_WHEN_HEADING_RE = /^\s{0,3}#{1,6}\s+done\s+when\s*(?::\s*)?$/i;
// A "Definition of done" heading (Issue #3761). stSoftwareAU/NEAT-AI#4061 stated
// its criteria here rather than under "Acceptance Criteria", so every gate keyed
// on extractAcceptanceCriteria treated it as stating none. Same tail as above.
const DEFINITION_OF_DONE_HEADING_RE = /^\s{0,3}#{1,6}\s+definition\s+of\s+done\s*(?::\s*)?$/i;
// Any markdown heading — used as the section boundary.
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s+/;
// A top-level markdown list item: "- x", "* x", "1. x", optionally a checkbox.
// The text is `([^\n]*)` with no `$`, not `(.*)$`: `.` stops at a lone `\r`,
// and a failing tail split a padded item's spaces between `\s+` and `(.*)` in
// every possible way — quadratic in the run (Issue #3186).
const LIST_ITEM_RE = /^\s{0,1}(?:[-*+]|\d+[.)])\s+([^\n]*)/;
// The leading checkbox of a task-list item, stripped from the criterion text.
const CHECKBOX_RE = /^\[[ xX~]?\]\s*/;
/**
 * Extract a section body from a markdown document — by default the
 * `## Acceptance Criteria` section, matched strictly (no prefix words).
 *
 * @param heading - The heading that opens the section.
 * @returns the raw lines of the section, or `null` when no such heading exists.
 */ function extractSection(markdown, heading = ACCEPTANCE_HEADING_RE) {
  const lines = markdown.split(/\r?\n/);
  for(let i = 0; i < lines.length; i++){
    if (!heading.test(lines[i])) continue;
    const collected = [];
    for(let j = i + 1; j < lines.length; j++){
      if (ANY_HEADING_RE.test(lines[j])) break;
      collected.push(lines[j]);
    }
    return collected;
  }
  return null;
}
/**
 * Group a section's lines into top-level list items, each joined with its own
 * indented continuation lines.
 *
 * Continuations matter because an agent may put the evidence or the reason on a
 * nested bullet under the criterion rather than on the same line.
 */ function collectListItems(sectionLines) {
  const items = [];
  let current = null;
  for (const line of sectionLines){
    const match = line.match(LIST_ITEM_RE);
    if (match) {
      if (current) items.push(current.join(" "));
      current = [
        match[1].trim()
      ];
      continue;
    }
    if (current && line.trim() !== "") {
      current.push(line.trim());
      continue;
    }
    if (current && line.trim() === "") {
      // A blank line ends the item but not the section.
      items.push(current.join(" "));
      current = null;
    }
  }
  if (current) items.push(current.join(" "));
  return items.filter((item)=>item.trim() !== "");
}
/**
 * Extract the acceptance criteria stated in an issue body.
 *
 * Reads the list items under the `## Acceptance Criteria` heading, with any
 * task-list checkbox stripped. A heading ending in "acceptance criteria"
 * (e.g. `## Scope and acceptance criteria`) also counts (Issue #4107). When
 * that heading carries no list items, it falls back to the list under a
 * `## Definition of done` heading (Issue #3761).
 * An issue with neither — or with headings that carry no list items — has no
 * criteria, and the gate does not apply.
 *
 * @param issueBody - The raw issue body.
 * @returns The criterion texts, in body order (empty when there are none).
 */ export function extractAcceptanceCriteria(issueBody) {
  // The exact heading wins, as before; the wider heading is only a fallback,
  // and an earlier prose heading that merely ends in the phrase must not hide
  // a later list, so every wider match is tried (Issue #4107).
  const exact = listItemsUnder(issueBody, ACCEPTANCE_HEADING_RE);
  if (exact.length > 0) return exact;
  const wider = firstListUnderAny(issueBody, ISSUE_ACCEPTANCE_HEADING_RE);
  if (wider.length > 0) return wider;
  return listItemsUnder(issueBody, DEFINITION_OF_DONE_HEADING_RE);
}
/**
 * Extract the scope an issue settled on (Issue #2562): its acceptance criteria
 * when it states them (the `## Acceptance Criteria` list, or the
 * `## Definition of done` list when there is none — Issue #3761), otherwise
 * the list under a grill-me `### Accepted scope so far` heading, otherwise the
 * list under a `## Done when` heading (Issue #3486).
 *
 * Deliberately separate from {@link extractAcceptanceCriteria}: the closure
 * gate keeps reading only the criteria list, and this wider reading is used
 * where a run's delivery is judged against everything the issue accepted — a
 * degraded run (`degraded_delivery.ts`).
 *
 * @param issueBody - The raw issue body.
 * @returns The scope items, in body order (empty when the issue states none).
 */ export function extractAcceptedScope(issueBody) {
  const criteria = extractAcceptanceCriteria(issueBody);
  if (criteria.length > 0) return criteria;
  const acceptedScope = listItemsUnder(issueBody, ACCEPTED_SCOPE_HEADING_RE);
  if (acceptedScope.length > 0) return acceptedScope;
  return listItemsUnder(issueBody, DONE_WHEN_HEADING_RE);
}
/**
 * The checkbox-stripped list items under the first `heading` match that
 * carries any, or none. Unlike {@link listItemsUnder}, a matching heading with
 * no list items does not stop the search.
 */ function firstListUnderAny(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  for(let i = 0; i < lines.length; i++){
    if (!heading.test(lines[i])) continue;
    const section = [];
    for(let j = i + 1; j < lines.length; j++){
      if (ANY_HEADING_RE.test(lines[j])) break;
      section.push(lines[j]);
    }
    const items = stripCheckboxes(collectListItems(section));
    if (items.length > 0) return items;
  }
  return [];
}
function stripCheckboxes(items) {
  return items.map((item)=>item.replace(CHECKBOX_RE, "").trim()).filter((item)=>item !== "");
}
/** The checkbox-stripped list items under `heading`, or none. */ function listItemsUnder(markdown, heading) {
  const section = extractSection(markdown, heading);
  if (section === null) return [];
  return stripCheckboxes(collectListItems(section));
}
/**
 * Match the entry's leading status, allowing Markdown emphasis/code markers.
 * Status words inside criterion prose or nested test descriptions are not an
 * assessment (for example, "a missing or unreadable value" in a negative test).
 */ function statusOf(entry) {
  const match = entry.match(/^[\s*_`]*(unrequested|partial|missing|met)\b/i);
  return match ? match[1].toLowerCase() : null;
}
// Hardcoded per-label patterns — a `new RegExp(label…)` built from an argument
// is a ReDoS surface Semgrep blocks on, and only these two labels exist.
// The search is unanchored, so the value is `([^\n]*)` with no `$`: a `(.*)$`
// tail that a lone `\r` made fail restarted at every later occurrence of the
// label and rescanned to the end each time — quadratic (Issue #3186).
const LABEL_PATTERNS = {
  evidence: /evidence\s*[:\-—]\s*([^\n]*)/i,
  reason: /reason\s*[:\-—]\s*([^\n]*)/i
};
/** Whether a labelled field (`evidence:`, `reason:`) is present and filled. */ function hasFilledLabel(entry, label) {
  const match = entry.match(LABEL_PATTERNS[label]);
  if (!match) return false;
  return match[1].replace(/[`*_\s—-]/g, "") !== "";
}
/**
 * Parse the `## Acceptance Criteria` closure block out of a PR summary.
 *
 * Only list items starting with a recognised status are treated as assessment
 * entries, so a prose lead-in above the list is ignored rather than mis-counted.
 *
 * @param prSummaryContent - The PR summary (or assembled PR body).
 * @returns The parsed entries, in summary order (empty when the block is absent).
 */ export function parseClosureEntries(prSummaryContent) {
  const section = extractSection(prSummaryContent);
  if (section === null) return [];
  const entries = [];
  for (const item of collectListItems(section)){
    const text = item.replace(CHECKBOX_RE, "").trim();
    const status = statusOf(text);
    if (!status) continue;
    entries.push({
      status,
      hasEvidence: hasFilledLabel(text, "evidence"),
      hasReason: hasFilledLabel(text, "reason"),
      text
    });
  }
  return entries;
}
/**
 * Verify that a PR summary closes out the issue's acceptance criteria.
 *
 * Rules, all deterministic:
 *   1. The issue has no criteria → the gate does not apply and passes.
 *   2. The summary must carry a `## Acceptance Criteria` block with at least one
 *      assessment entry per stated criterion.
 *   3. A `met` or `partial` entry must name its evidence (`evidence: …`).
 *   4. A `partial`, `missing` or `unrequested` entry must carry a one-line
 *      reason (`reason: …`) — an unexplained gap is a failure to surface.
 *
 * @param opts.issueBody - The issue body the run implemented.
 * @param opts.prSummaryContent - The PR summary content (or assembled PR body).
 */ export function validateAcceptanceClosure(opts) {
  const criteria = extractAcceptanceCriteria(opts.issueBody);
  if (criteria.length === 0) {
    return {
      applicable: false,
      valid: true,
      criteria,
      entries: [],
      problems: []
    };
  }
  const entries = parseClosureEntries(opts.prSummaryContent);
  const problems = [];
  const assessments = entries.filter((e)=>e.status !== "unrequested");
  if (assessments.length === 0) {
    problems.push(`the PR summary carries no \`## Acceptance Criteria\` closure block, but the issue states ${criteria.length} criteri${criteria.length === 1 ? "on" : "a"}`);
  } else if (assessments.length < criteria.length) {
    problems.push(`only ${assessments.length} of ${criteria.length} acceptance criteria are assessed in the closure block`);
  }
  for (const entry of entries){
    const status = entry.status;
    if (status !== "unrequested" && EVIDENCE_REQUIRED.includes(status) && !entry.hasEvidence) {
      problems.push(`\`${status}\` entry names no evidence: "${entry.text}"`);
    }
    const needsReason = status === "unrequested" || REASON_REQUIRED.includes(status);
    if (needsReason && !entry.hasReason) {
      problems.push(`\`${status}\` entry carries no reason: "${entry.text}"`);
    }
  }
  return {
    applicable: true,
    valid: problems.length === 0,
    criteria,
    entries,
    problems
  };
}
/**
 * Build the issue comment reported when the closure block is missing or
 * malformed (Issue #4234): it is reported once in the session, whatever
 * remains is named in the PR's reviewer note, and the PR is raised anyway.
 *
 * Names every rule broken and restates the required shape, so the next attempt
 * can fix the summary without re-deriving the format.
 *
 * The shape printed is `REVIEW_BLOCK_TEMPLATE`, the same block the
 * independent-review gate prints, including its `## Standards Review` half:
 * that gate runs immediately after this one at the same chokepoint, so a
 * criteria block written from a template it rejects only trades one finding for
 * the next (Issue #751).
 */ export function buildClosureGateComment(result) {
  const problems = result.problems.map((p)=>`- ${p}`).join("\n");
  return [
    "⚠️ **Acceptance-criteria closure missing.** This issue states acceptance " + "criteria, so the PR summary should close each one out; any left unclosed " + "is named on the pull request, which is raised anyway:",
    "",
    problems,
    "",
    "Add a `## Acceptance Criteria` block to " + "`docs/archive/pr-summaries/pr-summary-<issue>.md` with one entry per " + "criterion, in this shape — the `## Standards Review` half is printed with " + "it because the independent-review check runs next and reports a criteria " + "block raised without it:",
    "",
    ...reviewBlockTemplateLines()
  ].join("\n");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hY2NlcHRhbmNlX2NyaXRlcmlhX2dhdGUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEZXRlcm1pbmlzdGljIGFjY2VwdGFuY2UtY3JpdGVyaWEgY2xvc3VyZSBnYXRlIGZvciBQUiBzdW1tYXJpZXMgKElzc3VlICM1MTgpLlxuICpcbiAqIFRoZSBwbGFubmVyIHdyaXRlcyBhIGAjIyBBY2NlcHRhbmNlIENyaXRlcmlhYCBjaGVja2xpc3QgaW50byBldmVyeSBwdWJsaXNoZWRcbiAqIHN1Yi1pc3N1ZSAoYHByb21wdHMvcGxhbm5pbmcvcHJvbXB0Lm1kYCksIGFuZCB1bnRpbCBub3cgbm90aGluZyBkb3duc3RyZWFtIGV2ZXJcbiAqIHJlYWQgaXQgYmFjazogdGhlIGltcGxlbWVudGluZyBydW4gbmV2ZXIgc2F3IHRoZSBjcml0ZXJpYSBhcyBhIHRhcmdldCBhbmQgdGhlXG4gKiBQUiBzdW1tYXJ5IG5ldmVyIHNhaWQgd2hpY2ggd2VyZSBtZXQsIHNvIGEgcmV2aWV3ZXIgaGFkIHRvIHJlLWRlcml2ZSB0aGVtIGJ5XG4gKiBoYW5kLiBUaGUgYXJ0ZWZhY3Qgd2FzIHdyaXR0ZW4gYW5kIG9ycGhhbmVkLlxuICpcbiAqIGBwcm9tcHRzL2lzc3VlL3Byb21wdC5tZGAgY2xvc2VzIHRoZSBsb29wIG9uIHRoZSBhZ2VudCBzaWRlIOKAlCB3aGVuIHRoZSBpc3N1ZSBib2R5XG4gKiBjYXJyaWVzIGNyaXRlcmlhLCB0aGUgUFIgc3VtbWFyeSBtdXN0IGNhcnJ5IGEgYCMjIEFjY2VwdGFuY2UgQ3JpdGVyaWFgIGJsb2NrXG4gKiBhc3Nlc3NpbmcgZWFjaCBvbmUgYXMgYG1ldGAgLyBgcGFydGlhbGAgLyBgbWlzc2luZ2AsIHdpdGggdGhlIGZpbGUgb3IgdGVzdCB0aGF0XG4gKiBldmlkZW5jZXMgaXQsIGEgb25lLWxpbmUgcmVhc29uIGZvciBldmVyeSBnYXAsIGFuZCBhbiBgdW5yZXF1ZXN0ZWRgIGVudHJ5IGZvclxuICogYW55IGNoYW5nZSBpbiB0aGUgZGlmZiBub3QgdHJhY2VhYmxlIHRvIHRoZSBpc3N1ZS4gQSBwcm9zZSBydWxlIGFsb25lIGlzIGFcbiAqIHF1YWxpdHkgZXNjYXBlICh0aGUgc2FtZSBlc2NhcGUgYGZhaWx1cmVfZGV0ZWN0aW9uX2dhdGUudHNgIGNsb3NlcyBvbiB0aGVcbiAqIHBsYW5uZXIgc2lkZSksIHNvIHRoaXMgbW9kdWxlIGlzIHRoZSBkZXRlcm1pbmlzdGljIGNoZWNrIGJlaGluZCBpdDogYW5cbiAqIHVuZXhwbGFpbmVkIGdhcCBpcyBhIGZhaWx1cmUgdG8gc3VyZmFjZSwgbm90IGEgcGFzcy5cbiAqXG4gKiBCb3RoIGV4cG9ydGVkIGZ1bmN0aW9ucyBhcmUgcHVyZSDigJQgdGhlIGNhbGxlclxuICogKGBwaGFzZXMvY29tcGxldGlvbl9waGFzZS50c2ApIHN1cHBsaWVzIHRoZSBpc3N1ZSBib2R5IGFuZCB0aGUgYXNzZW1ibGVkIFBSXG4gKiBib2R5LCBzbyB0aGUgd2hvbGUgcGF0aCBpcyB1bml0LXRlc3RlZCB3aXRob3V0IGEgbmV0d29yay5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgeyByZXZpZXdCbG9ja1RlbXBsYXRlTGluZXMgfSBmcm9tIFwiLi9yZXZpZXdfYmxvY2tfdGVtcGxhdGUudHNcIjtcblxuLyoqIFN0YXR1c2VzIGEgY3JpdGVyaW9uIG1heSBiZSBjbG9zZWQgb3V0IHdpdGguICovXG5leHBvcnQgdHlwZSBDcml0ZXJpb25TdGF0dXMgPSBcIm1ldFwiIHwgXCJwYXJ0aWFsXCIgfCBcIm1pc3NpbmdcIjtcblxuLyoqIFN0YXR1c2VzIHRoYXQgbXVzdCBuYW1lIHRoZSBldmlkZW5jZSBvYnNlcnZlZC4gKi9cbmNvbnN0IEVWSURFTkNFX1JFUVVJUkVEOiBDcml0ZXJpb25TdGF0dXNbXSA9IFtcIm1ldFwiLCBcInBhcnRpYWxcIl07XG5cbi8qKiBTdGF0dXNlcyB0aGF0IG11c3QgY2FycnkgYSBvbmUtbGluZSByZWFzb24gZm9yIHRoZSBnYXAuICovXG5jb25zdCBSRUFTT05fUkVRVUlSRUQ6IENyaXRlcmlvblN0YXR1c1tdID0gW1wicGFydGlhbFwiLCBcIm1pc3NpbmdcIl07XG5cbi8qKiBPbmUgYXNzZXNzbWVudCBlbnRyeSBwYXJzZWQgb3V0IG9mIHRoZSBQUiBzdW1tYXJ5J3MgY2xvc3VyZSBibG9jay4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2xvc3VyZUVudHJ5IHtcbiAgLyoqIGBtZXRgIC8gYHBhcnRpYWxgIC8gYG1pc3NpbmdgLCBvciBgdW5yZXF1ZXN0ZWRgIGZvciBhIHNjb3BlLWNyZWVwIGVudHJ5LiAqL1xuICBzdGF0dXM6IENyaXRlcmlvblN0YXR1cyB8IFwidW5yZXF1ZXN0ZWRcIjtcbiAgLyoqIFdoZXRoZXIgdGhlIGVudHJ5IG5hbWVzIHRoZSBldmlkZW5jZSBvYnNlcnZlZC4gKi9cbiAgaGFzRXZpZGVuY2U6IGJvb2xlYW47XG4gIC8qKiBXaGV0aGVyIHRoZSBlbnRyeSBjYXJyaWVzIGEgcmVhc29uLiAqL1xuICBoYXNSZWFzb246IGJvb2xlYW47XG4gIC8qKiBUaGUgZW50cnkgdGV4dCwgZm9yIGZhaWx1cmUgbWVzc2FnZXMuICovXG4gIHRleHQ6IHN0cmluZztcbn1cblxuLyoqIFZlcmRpY3Qgb2YgdGhlIGNsb3N1cmUgZ2F0ZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQWNjZXB0YW5jZUNsb3N1cmVSZXN1bHQge1xuICAvKiogVHJ1ZSB3aGVuIHRoZSBpc3N1ZSBib2R5IGNhcnJpZXMgY3JpdGVyaWEsIHNvIHRoZSBnYXRlIGFwcGxpZXMuICovXG4gIGFwcGxpY2FibGU6IGJvb2xlYW47XG4gIC8qKiBUcnVlIHdoZW4gdGhlIGdhdGUgcGFzc2VzIChhbHdheXMgdHJ1ZSB3aGVuIGl0IGRvZXMgbm90IGFwcGx5KS4gKi9cbiAgdmFsaWQ6IGJvb2xlYW47XG4gIC8qKiBDcml0ZXJpYSBmb3VuZCBpbiB0aGUgaXNzdWUgYm9keS4gKi9cbiAgY3JpdGVyaWE6IHN0cmluZ1tdO1xuICAvKiogQXNzZXNzbWVudCBlbnRyaWVzIGZvdW5kIGluIHRoZSBQUiBzdW1tYXJ5J3MgY2xvc3VyZSBibG9jay4gKi9cbiAgZW50cmllczogQ2xvc3VyZUVudHJ5W107XG4gIC8qKiBPbmUgbGluZSBwZXIgcnVsZSBicm9rZW4g4oCUIGVtcHR5IHdoZW4gdGhlIGdhdGUgcGFzc2VzLiAqL1xuICBwcm9ibGVtczogc3RyaW5nW107XG59XG5cbi8vIEEgaGVhZGluZyByZWFkaW5nIGV4YWN0bHkgXCJBY2NlcHRhbmNlIENyaXRlcmlhXCIuIFVzZWQgZm9yIHRoZSBQUiBzdW1tYXJ5J3Ncbi8vIGNsb3N1cmUgYmxvY2sgKGBwYXJzZUNsb3N1cmVFbnRyaWVzYCksIHdoZXJlIGEgd2lkZXIgaGVhZGluZyBlYXJsaWVyIGluIHRoZVxuLy8gc3VtbWFyeSBtdXN0IG5vdCBzaGFkb3cgdGhlIHJlYWwgYmxvY2sgKElzc3VlICM0MTA3KS5cbi8vIEV2ZXJ5IGhlYWRpbmcgdGFpbCBoZXJlIGlzIGBcXHMqKD86OlxccyopPyRgLCBub3QgYFxccyo6P1xccyokYDogdHdvIHdoaXRlc3BhY2Vcbi8vIHJ1bnMgd2l0aCBvbmx5IGFuIG9wdGlvbmFsIGA6YCBiZXR3ZWVuIHRoZW0gYmFja3RyYWNrIHF1YWRyYXRpY2FsbHkgb24gYVxuLy8gaGVhZGluZyBwYWRkZWQgd2l0aCBzcGFjZXMgYW5kIHRoZW4gYW55IG90aGVyIGNoYXJhY3RlciAoSXNzdWUgIzMxNjQpLlxuY29uc3QgQUNDRVBUQU5DRV9IRUFESU5HX1JFID1cbiAgL15cXHN7MCwzfSN7MSw2fVxccythY2NlcHRhbmNlXFxzK2NyaXRlcmlhXFxzKig/OjpcXHMqKT8kL2k7XG5cbi8vIFRoZSBzYW1lIGhlYWRpbmcgaW4gYW4gaXNzdWUgYm9keSwgb3B0aW9uYWxseSBwcmVjZWRlZCBieSB1cCB0byBmaXZlIHdvcmRzXG4vLyAoZS5nLiBcIlNjb3BlIGFuZCBhY2NlcHRhbmNlIGNyaXRlcmlhXCIsIElzc3VlICM0MTA3KS4gVGhlIHByZWZpeCB3b3Jkc1xuLy8gKGBbLi4uXStcXHMrYCkgYXJlIG5vbi13aGl0ZXNwYWNlIHJ1bnMgc2VwYXJhdGVkIGJ5IHdoaXRlc3BhY2UsIHNvIHRoZSBwYXR0ZXJuXG4vLyBpcyBib3VuZGVkIGFuZCBoYXMgbm8gb3ZlcmxhcHBpbmcgcXVhbnRpZmllcnMuXG5jb25zdCBJU1NVRV9BQ0NFUFRBTkNFX0hFQURJTkdfUkUgPVxuICAvXlxcc3swLDN9I3sxLDZ9XFxzKyg/OlthLXowLTkmLC8nLi1dK1xccyspezAsNX1hY2NlcHRhbmNlXFxzK2NyaXRlcmlhXFxzKig/OjpcXHMqKT8kL2k7XG5cbi8vIEEgZ3JpbGwtbWUgXCJBY2NlcHRlZCBzY29wZSBzbyBmYXJcIiBoZWFkaW5nIChJc3N1ZSAjMjU2MikuIEdyaWxsLW1lIHN0YXRlcyB0aGVcbi8vIHNjb3BlIGl0IHNldHRsZWQgdW5kZXIgdGhpcyBoZWFkaW5nIHJhdGhlciB0aGFuIFwiQWNjZXB0YW5jZSBDcml0ZXJpYVwiLCBzbyBhblxuLy8gaXNzdWUgcmVmaW5lZCBieSBncmlsbC1tZSBjYXJyaWVkIG5vIGNyaXRlcmlhIGFzIGZhciBhcyB0aGlzIGdhdGUgY291bGQgc2VlLlxuY29uc3QgQUNDRVBURURfU0NPUEVfSEVBRElOR19SRSA9XG4gIC9eXFxzezAsM30jezEsNn1cXHMrYWNjZXB0ZWRcXHMrc2NvcGUoPzpcXHMrc29cXHMrZmFyKT9cXHMqKD86OlxccyopPyQvaTtcblxuLy8gQSBcIkRvbmUgd2hlblwiIGhlYWRpbmcgKElzc3VlICMzNDg2KS4gQW4gaXNzdWUgd2hvc2UgY3JpdGVyaWEgc2l0IHVuZGVyXG4vLyBgIyMgRG9uZSB3aGVuYCDigJQgcmF0aGVyIHRoYW4gXCJBY2NlcHRhbmNlIENyaXRlcmlhXCIgb3IgZ3JpbGwtbWUnc1xuLy8gXCJBY2NlcHRlZCBzY29wZSBzbyBmYXJcIiDigJQgc3RpbGwgc3RhdGVzIGl0cyBzY29wZSwgc28gdGhlIGRlZ3JhZGVkLXJ1biBndWFyZFxuLy8gbXVzdCByZWFkIGl0IHJhdGhlciB0aGFuIHRyZWF0aW5nIHRoZSBpc3N1ZSBhcyBzdGF0aW5nIG5vIGNyaXRlcmlhLlxuY29uc3QgRE9ORV9XSEVOX0hFQURJTkdfUkUgPSAvXlxcc3swLDN9I3sxLDZ9XFxzK2RvbmVcXHMrd2hlblxccyooPzo6XFxzKik/JC9pO1xuXG4vLyBBIFwiRGVmaW5pdGlvbiBvZiBkb25lXCIgaGVhZGluZyAoSXNzdWUgIzM3NjEpLiBzdFNvZnR3YXJlQVUvTkVBVC1BSSM0MDYxIHN0YXRlZFxuLy8gaXRzIGNyaXRlcmlhIGhlcmUgcmF0aGVyIHRoYW4gdW5kZXIgXCJBY2NlcHRhbmNlIENyaXRlcmlhXCIsIHNvIGV2ZXJ5IGdhdGUga2V5ZWRcbi8vIG9uIGV4dHJhY3RBY2NlcHRhbmNlQ3JpdGVyaWEgdHJlYXRlZCBpdCBhcyBzdGF0aW5nIG5vbmUuIFNhbWUgdGFpbCBhcyBhYm92ZS5cbmNvbnN0IERFRklOSVRJT05fT0ZfRE9ORV9IRUFESU5HX1JFID1cbiAgL15cXHN7MCwzfSN7MSw2fVxccytkZWZpbml0aW9uXFxzK29mXFxzK2RvbmVcXHMqKD86OlxccyopPyQvaTtcblxuLy8gQW55IG1hcmtkb3duIGhlYWRpbmcg4oCUIHVzZWQgYXMgdGhlIHNlY3Rpb24gYm91bmRhcnkuXG5jb25zdCBBTllfSEVBRElOR19SRSA9IC9eXFxzezAsM30jezEsNn1cXHMrLztcblxuLy8gQSB0b3AtbGV2ZWwgbWFya2Rvd24gbGlzdCBpdGVtOiBcIi0geFwiLCBcIiogeFwiLCBcIjEuIHhcIiwgb3B0aW9uYWxseSBhIGNoZWNrYm94LlxuLy8gVGhlIHRleHQgaXMgYChbXlxcbl0qKWAgd2l0aCBubyBgJGAsIG5vdCBgKC4qKSRgOiBgLmAgc3RvcHMgYXQgYSBsb25lIGBcXHJgLFxuLy8gYW5kIGEgZmFpbGluZyB0YWlsIHNwbGl0IGEgcGFkZGVkIGl0ZW0ncyBzcGFjZXMgYmV0d2VlbiBgXFxzK2AgYW5kIGAoLiopYCBpblxuLy8gZXZlcnkgcG9zc2libGUgd2F5IOKAlCBxdWFkcmF0aWMgaW4gdGhlIHJ1biAoSXNzdWUgIzMxODYpLlxuY29uc3QgTElTVF9JVEVNX1JFID0gL15cXHN7MCwxfSg/OlstKitdfFxcZCtbLildKVxccysoW15cXG5dKikvO1xuXG4vLyBUaGUgbGVhZGluZyBjaGVja2JveCBvZiBhIHRhc2stbGlzdCBpdGVtLCBzdHJpcHBlZCBmcm9tIHRoZSBjcml0ZXJpb24gdGV4dC5cbmNvbnN0IENIRUNLQk9YX1JFID0gL15cXFtbIHhYfl0/XFxdXFxzKi87XG5cbi8qKlxuICogRXh0cmFjdCBhIHNlY3Rpb24gYm9keSBmcm9tIGEgbWFya2Rvd24gZG9jdW1lbnQg4oCUIGJ5IGRlZmF1bHQgdGhlXG4gKiBgIyMgQWNjZXB0YW5jZSBDcml0ZXJpYWAgc2VjdGlvbiwgbWF0Y2hlZCBzdHJpY3RseSAobm8gcHJlZml4IHdvcmRzKS5cbiAqXG4gKiBAcGFyYW0gaGVhZGluZyAtIFRoZSBoZWFkaW5nIHRoYXQgb3BlbnMgdGhlIHNlY3Rpb24uXG4gKiBAcmV0dXJucyB0aGUgcmF3IGxpbmVzIG9mIHRoZSBzZWN0aW9uLCBvciBgbnVsbGAgd2hlbiBubyBzdWNoIGhlYWRpbmcgZXhpc3RzLlxuICovXG5mdW5jdGlvbiBleHRyYWN0U2VjdGlvbihcbiAgbWFya2Rvd246IHN0cmluZyxcbiAgaGVhZGluZzogUmVnRXhwID0gQUNDRVBUQU5DRV9IRUFESU5HX1JFLFxuKTogc3RyaW5nW10gfCBudWxsIHtcbiAgY29uc3QgbGluZXMgPSBtYXJrZG93bi5zcGxpdCgvXFxyP1xcbi8pO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKCFoZWFkaW5nLnRlc3QobGluZXNbaV0hKSkgY29udGludWU7XG4gICAgY29uc3QgY29sbGVjdGVkOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAobGV0IGogPSBpICsgMTsgaiA8IGxpbmVzLmxlbmd0aDsgaisrKSB7XG4gICAgICBpZiAoQU5ZX0hFQURJTkdfUkUudGVzdChsaW5lc1tqXSEpKSBicmVhaztcbiAgICAgIGNvbGxlY3RlZC5wdXNoKGxpbmVzW2pdISk7XG4gICAgfVxuICAgIHJldHVybiBjb2xsZWN0ZWQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogR3JvdXAgYSBzZWN0aW9uJ3MgbGluZXMgaW50byB0b3AtbGV2ZWwgbGlzdCBpdGVtcywgZWFjaCBqb2luZWQgd2l0aCBpdHMgb3duXG4gKiBpbmRlbnRlZCBjb250aW51YXRpb24gbGluZXMuXG4gKlxuICogQ29udGludWF0aW9ucyBtYXR0ZXIgYmVjYXVzZSBhbiBhZ2VudCBtYXkgcHV0IHRoZSBldmlkZW5jZSBvciB0aGUgcmVhc29uIG9uIGFcbiAqIG5lc3RlZCBidWxsZXQgdW5kZXIgdGhlIGNyaXRlcmlvbiByYXRoZXIgdGhhbiBvbiB0aGUgc2FtZSBsaW5lLlxuICovXG5mdW5jdGlvbiBjb2xsZWN0TGlzdEl0ZW1zKHNlY3Rpb25MaW5lczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGl0ZW1zOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgY3VycmVudDogc3RyaW5nW10gfCBudWxsID0gbnVsbDtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2Ygc2VjdGlvbkxpbmVzKSB7XG4gICAgY29uc3QgbWF0Y2ggPSBsaW5lLm1hdGNoKExJU1RfSVRFTV9SRSk7XG4gICAgaWYgKG1hdGNoKSB7XG4gICAgICBpZiAoY3VycmVudCkgaXRlbXMucHVzaChjdXJyZW50LmpvaW4oXCIgXCIpKTtcbiAgICAgIGN1cnJlbnQgPSBbbWF0Y2hbMV0hLnRyaW0oKV07XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGN1cnJlbnQgJiYgbGluZS50cmltKCkgIT09IFwiXCIpIHtcbiAgICAgIGN1cnJlbnQucHVzaChsaW5lLnRyaW0oKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGN1cnJlbnQgJiYgbGluZS50cmltKCkgPT09IFwiXCIpIHtcbiAgICAgIC8vIEEgYmxhbmsgbGluZSBlbmRzIHRoZSBpdGVtIGJ1dCBub3QgdGhlIHNlY3Rpb24uXG4gICAgICBpdGVtcy5wdXNoKGN1cnJlbnQuam9pbihcIiBcIikpO1xuICAgICAgY3VycmVudCA9IG51bGw7XG4gICAgfVxuICB9XG4gIGlmIChjdXJyZW50KSBpdGVtcy5wdXNoKGN1cnJlbnQuam9pbihcIiBcIikpO1xuXG4gIHJldHVybiBpdGVtcy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0udHJpbSgpICE9PSBcIlwiKTtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IHRoZSBhY2NlcHRhbmNlIGNyaXRlcmlhIHN0YXRlZCBpbiBhbiBpc3N1ZSBib2R5LlxuICpcbiAqIFJlYWRzIHRoZSBsaXN0IGl0ZW1zIHVuZGVyIHRoZSBgIyMgQWNjZXB0YW5jZSBDcml0ZXJpYWAgaGVhZGluZywgd2l0aCBhbnlcbiAqIHRhc2stbGlzdCBjaGVja2JveCBzdHJpcHBlZC4gQSBoZWFkaW5nIGVuZGluZyBpbiBcImFjY2VwdGFuY2UgY3JpdGVyaWFcIlxuICogKGUuZy4gYCMjIFNjb3BlIGFuZCBhY2NlcHRhbmNlIGNyaXRlcmlhYCkgYWxzbyBjb3VudHMgKElzc3VlICM0MTA3KS4gV2hlblxuICogdGhhdCBoZWFkaW5nIGNhcnJpZXMgbm8gbGlzdCBpdGVtcywgaXQgZmFsbHMgYmFjayB0byB0aGUgbGlzdCB1bmRlciBhXG4gKiBgIyMgRGVmaW5pdGlvbiBvZiBkb25lYCBoZWFkaW5nIChJc3N1ZSAjMzc2MSkuXG4gKiBBbiBpc3N1ZSB3aXRoIG5laXRoZXIg4oCUIG9yIHdpdGggaGVhZGluZ3MgdGhhdCBjYXJyeSBubyBsaXN0IGl0ZW1zIOKAlCBoYXMgbm9cbiAqIGNyaXRlcmlhLCBhbmQgdGhlIGdhdGUgZG9lcyBub3QgYXBwbHkuXG4gKlxuICogQHBhcmFtIGlzc3VlQm9keSAtIFRoZSByYXcgaXNzdWUgYm9keS5cbiAqIEByZXR1cm5zIFRoZSBjcml0ZXJpb24gdGV4dHMsIGluIGJvZHkgb3JkZXIgKGVtcHR5IHdoZW4gdGhlcmUgYXJlIG5vbmUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdEFjY2VwdGFuY2VDcml0ZXJpYShpc3N1ZUJvZHk6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgLy8gVGhlIGV4YWN0IGhlYWRpbmcgd2lucywgYXMgYmVmb3JlOyB0aGUgd2lkZXIgaGVhZGluZyBpcyBvbmx5IGEgZmFsbGJhY2ssXG4gIC8vIGFuZCBhbiBlYXJsaWVyIHByb3NlIGhlYWRpbmcgdGhhdCBtZXJlbHkgZW5kcyBpbiB0aGUgcGhyYXNlIG11c3Qgbm90IGhpZGVcbiAgLy8gYSBsYXRlciBsaXN0LCBzbyBldmVyeSB3aWRlciBtYXRjaCBpcyB0cmllZCAoSXNzdWUgIzQxMDcpLlxuICBjb25zdCBleGFjdCA9IGxpc3RJdGVtc1VuZGVyKGlzc3VlQm9keSwgQUNDRVBUQU5DRV9IRUFESU5HX1JFKTtcbiAgaWYgKGV4YWN0Lmxlbmd0aCA+IDApIHJldHVybiBleGFjdDtcbiAgY29uc3Qgd2lkZXIgPSBmaXJzdExpc3RVbmRlckFueShpc3N1ZUJvZHksIElTU1VFX0FDQ0VQVEFOQ0VfSEVBRElOR19SRSk7XG4gIGlmICh3aWRlci5sZW5ndGggPiAwKSByZXR1cm4gd2lkZXI7XG4gIHJldHVybiBsaXN0SXRlbXNVbmRlcihpc3N1ZUJvZHksIERFRklOSVRJT05fT0ZfRE9ORV9IRUFESU5HX1JFKTtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IHRoZSBzY29wZSBhbiBpc3N1ZSBzZXR0bGVkIG9uIChJc3N1ZSAjMjU2Mik6IGl0cyBhY2NlcHRhbmNlIGNyaXRlcmlhXG4gKiB3aGVuIGl0IHN0YXRlcyB0aGVtICh0aGUgYCMjIEFjY2VwdGFuY2UgQ3JpdGVyaWFgIGxpc3QsIG9yIHRoZVxuICogYCMjIERlZmluaXRpb24gb2YgZG9uZWAgbGlzdCB3aGVuIHRoZXJlIGlzIG5vbmUg4oCUIElzc3VlICMzNzYxKSwgb3RoZXJ3aXNlXG4gKiB0aGUgbGlzdCB1bmRlciBhIGdyaWxsLW1lIGAjIyMgQWNjZXB0ZWQgc2NvcGUgc28gZmFyYCBoZWFkaW5nLCBvdGhlcndpc2UgdGhlXG4gKiBsaXN0IHVuZGVyIGEgYCMjIERvbmUgd2hlbmAgaGVhZGluZyAoSXNzdWUgIzM0ODYpLlxuICpcbiAqIERlbGliZXJhdGVseSBzZXBhcmF0ZSBmcm9tIHtAbGluayBleHRyYWN0QWNjZXB0YW5jZUNyaXRlcmlhfTogdGhlIGNsb3N1cmVcbiAqIGdhdGUga2VlcHMgcmVhZGluZyBvbmx5IHRoZSBjcml0ZXJpYSBsaXN0LCBhbmQgdGhpcyB3aWRlciByZWFkaW5nIGlzIHVzZWRcbiAqIHdoZXJlIGEgcnVuJ3MgZGVsaXZlcnkgaXMganVkZ2VkIGFnYWluc3QgZXZlcnl0aGluZyB0aGUgaXNzdWUgYWNjZXB0ZWQg4oCUIGFcbiAqIGRlZ3JhZGVkIHJ1biAoYGRlZ3JhZGVkX2RlbGl2ZXJ5LnRzYCkuXG4gKlxuICogQHBhcmFtIGlzc3VlQm9keSAtIFRoZSByYXcgaXNzdWUgYm9keS5cbiAqIEByZXR1cm5zIFRoZSBzY29wZSBpdGVtcywgaW4gYm9keSBvcmRlciAoZW1wdHkgd2hlbiB0aGUgaXNzdWUgc3RhdGVzIG5vbmUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdEFjY2VwdGVkU2NvcGUoaXNzdWVCb2R5OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGNyaXRlcmlhID0gZXh0cmFjdEFjY2VwdGFuY2VDcml0ZXJpYShpc3N1ZUJvZHkpO1xuICBpZiAoY3JpdGVyaWEubGVuZ3RoID4gMCkgcmV0dXJuIGNyaXRlcmlhO1xuICBjb25zdCBhY2NlcHRlZFNjb3BlID0gbGlzdEl0ZW1zVW5kZXIoaXNzdWVCb2R5LCBBQ0NFUFRFRF9TQ09QRV9IRUFESU5HX1JFKTtcbiAgaWYgKGFjY2VwdGVkU2NvcGUubGVuZ3RoID4gMCkgcmV0dXJuIGFjY2VwdGVkU2NvcGU7XG4gIHJldHVybiBsaXN0SXRlbXNVbmRlcihpc3N1ZUJvZHksIERPTkVfV0hFTl9IRUFESU5HX1JFKTtcbn1cblxuLyoqXG4gKiBUaGUgY2hlY2tib3gtc3RyaXBwZWQgbGlzdCBpdGVtcyB1bmRlciB0aGUgZmlyc3QgYGhlYWRpbmdgIG1hdGNoIHRoYXRcbiAqIGNhcnJpZXMgYW55LCBvciBub25lLiBVbmxpa2Uge0BsaW5rIGxpc3RJdGVtc1VuZGVyfSwgYSBtYXRjaGluZyBoZWFkaW5nIHdpdGhcbiAqIG5vIGxpc3QgaXRlbXMgZG9lcyBub3Qgc3RvcCB0aGUgc2VhcmNoLlxuICovXG5mdW5jdGlvbiBmaXJzdExpc3RVbmRlckFueShtYXJrZG93bjogc3RyaW5nLCBoZWFkaW5nOiBSZWdFeHApOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGxpbmVzID0gbWFya2Rvd24uc3BsaXQoL1xccj9cXG4vKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGlmICghaGVhZGluZy50ZXN0KGxpbmVzW2ldISkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHNlY3Rpb246IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChsZXQgaiA9IGkgKyAxOyBqIDwgbGluZXMubGVuZ3RoOyBqKyspIHtcbiAgICAgIGlmIChBTllfSEVBRElOR19SRS50ZXN0KGxpbmVzW2pdISkpIGJyZWFrO1xuICAgICAgc2VjdGlvbi5wdXNoKGxpbmVzW2pdISk7XG4gICAgfVxuICAgIGNvbnN0IGl0ZW1zID0gc3RyaXBDaGVja2JveGVzKGNvbGxlY3RMaXN0SXRlbXMoc2VjdGlvbikpO1xuICAgIGlmIChpdGVtcy5sZW5ndGggPiAwKSByZXR1cm4gaXRlbXM7XG4gIH1cbiAgcmV0dXJuIFtdO1xufVxuXG5mdW5jdGlvbiBzdHJpcENoZWNrYm94ZXMoaXRlbXM6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICByZXR1cm4gaXRlbXMubWFwKChpdGVtKSA9PiBpdGVtLnJlcGxhY2UoQ0hFQ0tCT1hfUkUsIFwiXCIpLnRyaW0oKSlcbiAgICAuZmlsdGVyKChpdGVtKSA9PiBpdGVtICE9PSBcIlwiKTtcbn1cblxuLyoqIFRoZSBjaGVja2JveC1zdHJpcHBlZCBsaXN0IGl0ZW1zIHVuZGVyIGBoZWFkaW5nYCwgb3Igbm9uZS4gKi9cbmZ1bmN0aW9uIGxpc3RJdGVtc1VuZGVyKG1hcmtkb3duOiBzdHJpbmcsIGhlYWRpbmc6IFJlZ0V4cCk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGV4dHJhY3RTZWN0aW9uKG1hcmtkb3duLCBoZWFkaW5nKTtcbiAgaWYgKHNlY3Rpb24gPT09IG51bGwpIHJldHVybiBbXTtcbiAgcmV0dXJuIHN0cmlwQ2hlY2tib3hlcyhjb2xsZWN0TGlzdEl0ZW1zKHNlY3Rpb24pKTtcbn1cblxuLyoqXG4gKiBNYXRjaCB0aGUgZW50cnkncyBsZWFkaW5nIHN0YXR1cywgYWxsb3dpbmcgTWFya2Rvd24gZW1waGFzaXMvY29kZSBtYXJrZXJzLlxuICogU3RhdHVzIHdvcmRzIGluc2lkZSBjcml0ZXJpb24gcHJvc2Ugb3IgbmVzdGVkIHRlc3QgZGVzY3JpcHRpb25zIGFyZSBub3QgYW5cbiAqIGFzc2Vzc21lbnQgKGZvciBleGFtcGxlLCBcImEgbWlzc2luZyBvciB1bnJlYWRhYmxlIHZhbHVlXCIgaW4gYSBuZWdhdGl2ZSB0ZXN0KS5cbiAqL1xuZnVuY3Rpb24gc3RhdHVzT2YoZW50cnk6IHN0cmluZyk6IENsb3N1cmVFbnRyeVtcInN0YXR1c1wiXSB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IGVudHJ5Lm1hdGNoKC9eW1xccypfYF0qKHVucmVxdWVzdGVkfHBhcnRpYWx8bWlzc2luZ3xtZXQpXFxiL2kpO1xuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFsxXSEudG9Mb3dlckNhc2UoKSBhcyBDbG9zdXJlRW50cnlbXCJzdGF0dXNcIl0gOiBudWxsO1xufVxuXG4vLyBIYXJkY29kZWQgcGVyLWxhYmVsIHBhdHRlcm5zIOKAlCBhIGBuZXcgUmVnRXhwKGxhYmVs4oCmKWAgYnVpbHQgZnJvbSBhbiBhcmd1bWVudFxuLy8gaXMgYSBSZURvUyBzdXJmYWNlIFNlbWdyZXAgYmxvY2tzIG9uLCBhbmQgb25seSB0aGVzZSB0d28gbGFiZWxzIGV4aXN0LlxuLy8gVGhlIHNlYXJjaCBpcyB1bmFuY2hvcmVkLCBzbyB0aGUgdmFsdWUgaXMgYChbXlxcbl0qKWAgd2l0aCBubyBgJGA6IGEgYCguKikkYFxuLy8gdGFpbCB0aGF0IGEgbG9uZSBgXFxyYCBtYWRlIGZhaWwgcmVzdGFydGVkIGF0IGV2ZXJ5IGxhdGVyIG9jY3VycmVuY2Ugb2YgdGhlXG4vLyBsYWJlbCBhbmQgcmVzY2FubmVkIHRvIHRoZSBlbmQgZWFjaCB0aW1lIOKAlCBxdWFkcmF0aWMgKElzc3VlICMzMTg2KS5cbmNvbnN0IExBQkVMX1BBVFRFUk5TID0ge1xuICBldmlkZW5jZTogL2V2aWRlbmNlXFxzKls6XFwt4oCUXVxccyooW15cXG5dKikvaSxcbiAgcmVhc29uOiAvcmVhc29uXFxzKls6XFwt4oCUXVxccyooW15cXG5dKikvaSxcbn0gYXMgY29uc3Q7XG5cbi8qKiBXaGV0aGVyIGEgbGFiZWxsZWQgZmllbGQgKGBldmlkZW5jZTpgLCBgcmVhc29uOmApIGlzIHByZXNlbnQgYW5kIGZpbGxlZC4gKi9cbmZ1bmN0aW9uIGhhc0ZpbGxlZExhYmVsKFxuICBlbnRyeTogc3RyaW5nLFxuICBsYWJlbDoga2V5b2YgdHlwZW9mIExBQkVMX1BBVFRFUk5TLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IG1hdGNoID0gZW50cnkubWF0Y2goTEFCRUxfUEFUVEVSTlNbbGFiZWxdKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gbWF0Y2hbMV0hLnJlcGxhY2UoL1tgKl9cXHPigJQtXS9nLCBcIlwiKSAhPT0gXCJcIjtcbn1cblxuLyoqXG4gKiBQYXJzZSB0aGUgYCMjIEFjY2VwdGFuY2UgQ3JpdGVyaWFgIGNsb3N1cmUgYmxvY2sgb3V0IG9mIGEgUFIgc3VtbWFyeS5cbiAqXG4gKiBPbmx5IGxpc3QgaXRlbXMgc3RhcnRpbmcgd2l0aCBhIHJlY29nbmlzZWQgc3RhdHVzIGFyZSB0cmVhdGVkIGFzIGFzc2Vzc21lbnRcbiAqIGVudHJpZXMsIHNvIGEgcHJvc2UgbGVhZC1pbiBhYm92ZSB0aGUgbGlzdCBpcyBpZ25vcmVkIHJhdGhlciB0aGFuIG1pcy1jb3VudGVkLlxuICpcbiAqIEBwYXJhbSBwclN1bW1hcnlDb250ZW50IC0gVGhlIFBSIHN1bW1hcnkgKG9yIGFzc2VtYmxlZCBQUiBib2R5KS5cbiAqIEByZXR1cm5zIFRoZSBwYXJzZWQgZW50cmllcywgaW4gc3VtbWFyeSBvcmRlciAoZW1wdHkgd2hlbiB0aGUgYmxvY2sgaXMgYWJzZW50KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ2xvc3VyZUVudHJpZXMocHJTdW1tYXJ5Q29udGVudDogc3RyaW5nKTogQ2xvc3VyZUVudHJ5W10ge1xuICBjb25zdCBzZWN0aW9uID0gZXh0cmFjdFNlY3Rpb24ocHJTdW1tYXJ5Q29udGVudCk7XG4gIGlmIChzZWN0aW9uID09PSBudWxsKSByZXR1cm4gW107XG5cbiAgY29uc3QgZW50cmllczogQ2xvc3VyZUVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBpdGVtIG9mIGNvbGxlY3RMaXN0SXRlbXMoc2VjdGlvbikpIHtcbiAgICBjb25zdCB0ZXh0ID0gaXRlbS5yZXBsYWNlKENIRUNLQk9YX1JFLCBcIlwiKS50cmltKCk7XG4gICAgY29uc3Qgc3RhdHVzID0gc3RhdHVzT2YodGV4dCk7XG4gICAgaWYgKCFzdGF0dXMpIGNvbnRpbnVlO1xuICAgIGVudHJpZXMucHVzaCh7XG4gICAgICBzdGF0dXMsXG4gICAgICBoYXNFdmlkZW5jZTogaGFzRmlsbGVkTGFiZWwodGV4dCwgXCJldmlkZW5jZVwiKSxcbiAgICAgIGhhc1JlYXNvbjogaGFzRmlsbGVkTGFiZWwodGV4dCwgXCJyZWFzb25cIiksXG4gICAgICB0ZXh0LFxuICAgIH0pO1xuICB9XG4gIHJldHVybiBlbnRyaWVzO1xufVxuXG4vKipcbiAqIFZlcmlmeSB0aGF0IGEgUFIgc3VtbWFyeSBjbG9zZXMgb3V0IHRoZSBpc3N1ZSdzIGFjY2VwdGFuY2UgY3JpdGVyaWEuXG4gKlxuICogUnVsZXMsIGFsbCBkZXRlcm1pbmlzdGljOlxuICogICAxLiBUaGUgaXNzdWUgaGFzIG5vIGNyaXRlcmlhIOKGkiB0aGUgZ2F0ZSBkb2VzIG5vdCBhcHBseSBhbmQgcGFzc2VzLlxuICogICAyLiBUaGUgc3VtbWFyeSBtdXN0IGNhcnJ5IGEgYCMjIEFjY2VwdGFuY2UgQ3JpdGVyaWFgIGJsb2NrIHdpdGggYXQgbGVhc3Qgb25lXG4gKiAgICAgIGFzc2Vzc21lbnQgZW50cnkgcGVyIHN0YXRlZCBjcml0ZXJpb24uXG4gKiAgIDMuIEEgYG1ldGAgb3IgYHBhcnRpYWxgIGVudHJ5IG11c3QgbmFtZSBpdHMgZXZpZGVuY2UgKGBldmlkZW5jZTog4oCmYCkuXG4gKiAgIDQuIEEgYHBhcnRpYWxgLCBgbWlzc2luZ2Agb3IgYHVucmVxdWVzdGVkYCBlbnRyeSBtdXN0IGNhcnJ5IGEgb25lLWxpbmVcbiAqICAgICAgcmVhc29uIChgcmVhc29uOiDigKZgKSDigJQgYW4gdW5leHBsYWluZWQgZ2FwIGlzIGEgZmFpbHVyZSB0byBzdXJmYWNlLlxuICpcbiAqIEBwYXJhbSBvcHRzLmlzc3VlQm9keSAtIFRoZSBpc3N1ZSBib2R5IHRoZSBydW4gaW1wbGVtZW50ZWQuXG4gKiBAcGFyYW0gb3B0cy5wclN1bW1hcnlDb250ZW50IC0gVGhlIFBSIHN1bW1hcnkgY29udGVudCAob3IgYXNzZW1ibGVkIFBSIGJvZHkpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVBY2NlcHRhbmNlQ2xvc3VyZShvcHRzOiB7XG4gIGlzc3VlQm9keTogc3RyaW5nO1xuICBwclN1bW1hcnlDb250ZW50OiBzdHJpbmc7XG59KTogQWNjZXB0YW5jZUNsb3N1cmVSZXN1bHQge1xuICBjb25zdCBjcml0ZXJpYSA9IGV4dHJhY3RBY2NlcHRhbmNlQ3JpdGVyaWEob3B0cy5pc3N1ZUJvZHkpO1xuICBpZiAoY3JpdGVyaWEubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFwcGxpY2FibGU6IGZhbHNlLFxuICAgICAgdmFsaWQ6IHRydWUsXG4gICAgICBjcml0ZXJpYSxcbiAgICAgIGVudHJpZXM6IFtdLFxuICAgICAgcHJvYmxlbXM6IFtdLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBlbnRyaWVzID0gcGFyc2VDbG9zdXJlRW50cmllcyhvcHRzLnByU3VtbWFyeUNvbnRlbnQpO1xuICBjb25zdCBwcm9ibGVtczogc3RyaW5nW10gPSBbXTtcblxuICBjb25zdCBhc3Nlc3NtZW50cyA9IGVudHJpZXMuZmlsdGVyKChlKSA9PiBlLnN0YXR1cyAhPT0gXCJ1bnJlcXVlc3RlZFwiKTtcbiAgaWYgKGFzc2Vzc21lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHByb2JsZW1zLnB1c2goXG4gICAgICBgdGhlIFBSIHN1bW1hcnkgY2FycmllcyBubyBcXGAjIyBBY2NlcHRhbmNlIENyaXRlcmlhXFxgIGNsb3N1cmUgYmxvY2ssIGJ1dCB0aGUgaXNzdWUgc3RhdGVzICR7Y3JpdGVyaWEubGVuZ3RofSBjcml0ZXJpJHtcbiAgICAgICAgY3JpdGVyaWEubGVuZ3RoID09PSAxID8gXCJvblwiIDogXCJhXCJcbiAgICAgIH1gLFxuICAgICk7XG4gIH0gZWxzZSBpZiAoYXNzZXNzbWVudHMubGVuZ3RoIDwgY3JpdGVyaWEubGVuZ3RoKSB7XG4gICAgcHJvYmxlbXMucHVzaChcbiAgICAgIGBvbmx5ICR7YXNzZXNzbWVudHMubGVuZ3RofSBvZiAke2NyaXRlcmlhLmxlbmd0aH0gYWNjZXB0YW5jZSBjcml0ZXJpYSBhcmUgYXNzZXNzZWQgaW4gdGhlIGNsb3N1cmUgYmxvY2tgLFxuICAgICk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICBjb25zdCBzdGF0dXMgPSBlbnRyeS5zdGF0dXM7XG4gICAgaWYgKFxuICAgICAgc3RhdHVzICE9PSBcInVucmVxdWVzdGVkXCIgJiZcbiAgICAgIEVWSURFTkNFX1JFUVVJUkVELmluY2x1ZGVzKHN0YXR1cykgJiYgIWVudHJ5Lmhhc0V2aWRlbmNlXG4gICAgKSB7XG4gICAgICBwcm9ibGVtcy5wdXNoKFxuICAgICAgICBgXFxgJHtzdGF0dXN9XFxgIGVudHJ5IG5hbWVzIG5vIGV2aWRlbmNlOiBcIiR7ZW50cnkudGV4dH1cImAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBuZWVkc1JlYXNvbiA9IHN0YXR1cyA9PT0gXCJ1bnJlcXVlc3RlZFwiIHx8XG4gICAgICBSRUFTT05fUkVRVUlSRUQuaW5jbHVkZXMoc3RhdHVzIGFzIENyaXRlcmlvblN0YXR1cyk7XG4gICAgaWYgKG5lZWRzUmVhc29uICYmICFlbnRyeS5oYXNSZWFzb24pIHtcbiAgICAgIHByb2JsZW1zLnB1c2goXG4gICAgICAgIGBcXGAke3N0YXR1c31cXGAgZW50cnkgY2FycmllcyBubyByZWFzb246IFwiJHtlbnRyeS50ZXh0fVwiYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBhcHBsaWNhYmxlOiB0cnVlLFxuICAgIHZhbGlkOiBwcm9ibGVtcy5sZW5ndGggPT09IDAsXG4gICAgY3JpdGVyaWEsXG4gICAgZW50cmllcyxcbiAgICBwcm9ibGVtcyxcbiAgfTtcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgaXNzdWUgY29tbWVudCByZXBvcnRlZCB3aGVuIHRoZSBjbG9zdXJlIGJsb2NrIGlzIG1pc3Npbmcgb3JcbiAqIG1hbGZvcm1lZCAoSXNzdWUgIzQyMzQpOiBpdCBpcyByZXBvcnRlZCBvbmNlIGluIHRoZSBzZXNzaW9uLCB3aGF0ZXZlclxuICogcmVtYWlucyBpcyBuYW1lZCBpbiB0aGUgUFIncyByZXZpZXdlciBub3RlLCBhbmQgdGhlIFBSIGlzIHJhaXNlZCBhbnl3YXkuXG4gKlxuICogTmFtZXMgZXZlcnkgcnVsZSBicm9rZW4gYW5kIHJlc3RhdGVzIHRoZSByZXF1aXJlZCBzaGFwZSwgc28gdGhlIG5leHQgYXR0ZW1wdFxuICogY2FuIGZpeCB0aGUgc3VtbWFyeSB3aXRob3V0IHJlLWRlcml2aW5nIHRoZSBmb3JtYXQuXG4gKlxuICogVGhlIHNoYXBlIHByaW50ZWQgaXMgYFJFVklFV19CTE9DS19URU1QTEFURWAsIHRoZSBzYW1lIGJsb2NrIHRoZVxuICogaW5kZXBlbmRlbnQtcmV2aWV3IGdhdGUgcHJpbnRzLCBpbmNsdWRpbmcgaXRzIGAjIyBTdGFuZGFyZHMgUmV2aWV3YCBoYWxmOlxuICogdGhhdCBnYXRlIHJ1bnMgaW1tZWRpYXRlbHkgYWZ0ZXIgdGhpcyBvbmUgYXQgdGhlIHNhbWUgY2hva2Vwb2ludCwgc28gYVxuICogY3JpdGVyaWEgYmxvY2sgd3JpdHRlbiBmcm9tIGEgdGVtcGxhdGUgaXQgcmVqZWN0cyBvbmx5IHRyYWRlcyBvbmUgZmluZGluZyBmb3JcbiAqIHRoZSBuZXh0IChJc3N1ZSAjNzUxKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQ2xvc3VyZUdhdGVDb21tZW50KFxuICByZXN1bHQ6IEFjY2VwdGFuY2VDbG9zdXJlUmVzdWx0LFxuKTogc3RyaW5nIHtcbiAgY29uc3QgcHJvYmxlbXMgPSByZXN1bHQucHJvYmxlbXMubWFwKChwKSA9PiBgLSAke3B9YCkuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIFtcbiAgICBcIuKaoO+4jyAqKkFjY2VwdGFuY2UtY3JpdGVyaWEgY2xvc3VyZSBtaXNzaW5nLioqIFRoaXMgaXNzdWUgc3RhdGVzIGFjY2VwdGFuY2UgXCIgK1xuICAgIFwiY3JpdGVyaWEsIHNvIHRoZSBQUiBzdW1tYXJ5IHNob3VsZCBjbG9zZSBlYWNoIG9uZSBvdXQ7IGFueSBsZWZ0IHVuY2xvc2VkIFwiICtcbiAgICBcImlzIG5hbWVkIG9uIHRoZSBwdWxsIHJlcXVlc3QsIHdoaWNoIGlzIHJhaXNlZCBhbnl3YXk6XCIsXG4gICAgXCJcIixcbiAgICBwcm9ibGVtcyxcbiAgICBcIlwiLFxuICAgIFwiQWRkIGEgYCMjIEFjY2VwdGFuY2UgQ3JpdGVyaWFgIGJsb2NrIHRvIFwiICtcbiAgICBcImBkb2NzL2FyY2hpdmUvcHItc3VtbWFyaWVzL3ByLXN1bW1hcnktPGlzc3VlPi5tZGAgd2l0aCBvbmUgZW50cnkgcGVyIFwiICtcbiAgICBcImNyaXRlcmlvbiwgaW4gdGhpcyBzaGFwZSDigJQgdGhlIGAjIyBTdGFuZGFyZHMgUmV2aWV3YCBoYWxmIGlzIHByaW50ZWQgd2l0aCBcIiArXG4gICAgXCJpdCBiZWNhdXNlIHRoZSBpbmRlcGVuZGVudC1yZXZpZXcgY2hlY2sgcnVucyBuZXh0IGFuZCByZXBvcnRzIGEgY3JpdGVyaWEgXCIgK1xuICAgIFwiYmxvY2sgcmFpc2VkIHdpdGhvdXQgaXQ6XCIsXG4gICAgXCJcIixcbiAgICAuLi5yZXZpZXdCbG9ja1RlbXBsYXRlTGluZXMoKSxcbiAgXS5qb2luKFwiXFxuXCIpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXVCQyxHQUVELFNBQVMsd0JBQXdCLFFBQVEsNkJBQTZCO0FBS3RFLG1EQUFtRCxHQUNuRCxNQUFNLG9CQUF1QztFQUFDO0VBQU87Q0FBVTtBQUUvRCw0REFBNEQsR0FDNUQsTUFBTSxrQkFBcUM7RUFBQztFQUFXO0NBQVU7QUE0QmpFLDZFQUE2RTtBQUM3RSw4RUFBOEU7QUFDOUUsd0RBQXdEO0FBQ3hELDhFQUE4RTtBQUM5RSwyRUFBMkU7QUFDM0UseUVBQXlFO0FBQ3pFLE1BQU0sd0JBQ0o7QUFFRiw2RUFBNkU7QUFDN0Usd0VBQXdFO0FBQ3hFLGdGQUFnRjtBQUNoRixpREFBaUQ7QUFDakQsTUFBTSw4QkFDSjtBQUVGLGdGQUFnRjtBQUNoRiwrRUFBK0U7QUFDL0UsK0VBQStFO0FBQy9FLE1BQU0sNEJBQ0o7QUFFRix5RUFBeUU7QUFDekUsbUVBQW1FO0FBQ25FLDhFQUE4RTtBQUM5RSxzRUFBc0U7QUFDdEUsTUFBTSx1QkFBdUI7QUFFN0IsaUZBQWlGO0FBQ2pGLGlGQUFpRjtBQUNqRiwrRUFBK0U7QUFDL0UsTUFBTSxnQ0FDSjtBQUVGLHVEQUF1RDtBQUN2RCxNQUFNLGlCQUFpQjtBQUV2QiwrRUFBK0U7QUFDL0UsNkVBQTZFO0FBQzdFLDhFQUE4RTtBQUM5RSwyREFBMkQ7QUFDM0QsTUFBTSxlQUFlO0FB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
// denoCacheMetadata=16350393998123530310,10277938267474482685