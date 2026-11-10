/**
 * The one two-axis review block both PR-summary gates print (Issue #751).
 *
 * `phases/completion_phase.ts` runs the acceptance-criteria gate
 * (`acceptance_criteria_gate.ts`) and then the independent-review gate
 * (`independent_review_gate.ts`) at the same PR-creation chokepoint. Each posts
 * a remediation comment when it blocks, and that comment is the instruction the
 * next attempt writes its summary from — more recent and more specific than the
 * prompt template, so it is what the run follows.
 *
 * The two comments used to print different shapes. The closure gate showed
 * `- **unrequested** — <change> — reason: <why>`; the independent gate then
 * rejected exactly that line for naming no `reviewer:` verdict, and showed only
 * `met` and `partial` examples, so it never demonstrated the shape it was
 * rejecting. Issue #728 died in phase `completion` four times over on that
 * contradiction — around fifty minutes of worker time, no PR raised, work that
 * had been complete since the first attempt.
 *
 * One block, printed by both, ends the contradiction by construction, and
 * `tests/review_block_template_test.ts` feeds it back through both validators
 * so it cannot drift from what either gate accepts. The shape is the one
 * `prompts/issue/prompt.md` documents.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /**
 * The `## Acceptance Criteria` half: the Spec reviewer's provenance marker and
 * one example per closure status, each naming the reviewer's verdict.
 */ const SPEC_BLOCK_LINES = [
  "## Acceptance Criteria",
  "",
  '<!-- vibe-spec-review inputs="diff+issue-body" -->',
  "",
  "- **met** — <criterion> — evidence: `tests/foo_test.ts::does the thing` — reviewer: met",
  "- **partial** — <criterion> — evidence: `lib/foo.ts` — reviewer: partial — reason: <one line — what is still outstanding>",
  "- **missing** — <criterion> — reviewer: missing — reason: <one line — why it is not done>",
  "- **unrequested** — <a change in the diff not traceable to the issue> — reviewer: unrequested — reason: <why it is here>"
];
/**
 * The `## Standards Review` half: its own reviewer's provenance marker, a
 * `violation` naming labelled evidence and its outcome, and the `clean` areas.
 *
 * The example outcome is `fixed in this diff`, never "why it stands": a breach
 * in a line the PR adds or changes is fixed before the PR is raised, and only a
 * pre-existing one may carry `pre-existing, filed #<n>` (Issue #3196). The gate
 * refuses any other reason, so the template shows the one a run will almost
 * always write.
 */ const STANDARDS_BLOCK_LINES = [
  "## Standards Review",
  "",
  '<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->',
  "",
  "- **violation** — <standard breached> — evidence: `lib/foo.ts:42` — reason: fixed in this diff",
  "- **clean** — <the areas the reviewer checked and found compliant>"
];
/**
 * The block both gates print, verbatim — headings, provenance markers and one
 * example per status, in the shape both validators accept.
 *
 * Copied into `docs/archive/pr-summaries/pr-summary-<issue>.md` and filled in,
 * it passes the closure gate and the independent-review gate alike; the
 * criterion count is the run's to match.
 */ export const REVIEW_BLOCK_TEMPLATE = [
  ...SPEC_BLOCK_LINES,
  "",
  ...STANDARDS_BLOCK_LINES,
  ""
].join("\n");
/**
 * The template as a fenced markdown block, ready to append to a gate comment.
 *
 * @returns The comment lines, fence included.
 */ export function reviewBlockTemplateLines() {
  return [
    "```markdown",
    REVIEW_BLOCK_TEMPLATE.trimEnd(),
    "```"
  ];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9yZXZpZXdfYmxvY2tfdGVtcGxhdGUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUaGUgb25lIHR3by1heGlzIHJldmlldyBibG9jayBib3RoIFBSLXN1bW1hcnkgZ2F0ZXMgcHJpbnQgKElzc3VlICM3NTEpLlxuICpcbiAqIGBwaGFzZXMvY29tcGxldGlvbl9waGFzZS50c2AgcnVucyB0aGUgYWNjZXB0YW5jZS1jcml0ZXJpYSBnYXRlXG4gKiAoYGFjY2VwdGFuY2VfY3JpdGVyaWFfZ2F0ZS50c2ApIGFuZCB0aGVuIHRoZSBpbmRlcGVuZGVudC1yZXZpZXcgZ2F0ZVxuICogKGBpbmRlcGVuZGVudF9yZXZpZXdfZ2F0ZS50c2ApIGF0IHRoZSBzYW1lIFBSLWNyZWF0aW9uIGNob2tlcG9pbnQuIEVhY2ggcG9zdHNcbiAqIGEgcmVtZWRpYXRpb24gY29tbWVudCB3aGVuIGl0IGJsb2NrcywgYW5kIHRoYXQgY29tbWVudCBpcyB0aGUgaW5zdHJ1Y3Rpb24gdGhlXG4gKiBuZXh0IGF0dGVtcHQgd3JpdGVzIGl0cyBzdW1tYXJ5IGZyb20g4oCUIG1vcmUgcmVjZW50IGFuZCBtb3JlIHNwZWNpZmljIHRoYW4gdGhlXG4gKiBwcm9tcHQgdGVtcGxhdGUsIHNvIGl0IGlzIHdoYXQgdGhlIHJ1biBmb2xsb3dzLlxuICpcbiAqIFRoZSB0d28gY29tbWVudHMgdXNlZCB0byBwcmludCBkaWZmZXJlbnQgc2hhcGVzLiBUaGUgY2xvc3VyZSBnYXRlIHNob3dlZFxuICogYC0gKip1bnJlcXVlc3RlZCoqIOKAlCA8Y2hhbmdlPiDigJQgcmVhc29uOiA8d2h5PmA7IHRoZSBpbmRlcGVuZGVudCBnYXRlIHRoZW5cbiAqIHJlamVjdGVkIGV4YWN0bHkgdGhhdCBsaW5lIGZvciBuYW1pbmcgbm8gYHJldmlld2VyOmAgdmVyZGljdCwgYW5kIHNob3dlZCBvbmx5XG4gKiBgbWV0YCBhbmQgYHBhcnRpYWxgIGV4YW1wbGVzLCBzbyBpdCBuZXZlciBkZW1vbnN0cmF0ZWQgdGhlIHNoYXBlIGl0IHdhc1xuICogcmVqZWN0aW5nLiBJc3N1ZSAjNzI4IGRpZWQgaW4gcGhhc2UgYGNvbXBsZXRpb25gIGZvdXIgdGltZXMgb3ZlciBvbiB0aGF0XG4gKiBjb250cmFkaWN0aW9uIOKAlCBhcm91bmQgZmlmdHkgbWludXRlcyBvZiB3b3JrZXIgdGltZSwgbm8gUFIgcmFpc2VkLCB3b3JrIHRoYXRcbiAqIGhhZCBiZWVuIGNvbXBsZXRlIHNpbmNlIHRoZSBmaXJzdCBhdHRlbXB0LlxuICpcbiAqIE9uZSBibG9jaywgcHJpbnRlZCBieSBib3RoLCBlbmRzIHRoZSBjb250cmFkaWN0aW9uIGJ5IGNvbnN0cnVjdGlvbiwgYW5kXG4gKiBgdGVzdHMvcmV2aWV3X2Jsb2NrX3RlbXBsYXRlX3Rlc3QudHNgIGZlZWRzIGl0IGJhY2sgdGhyb3VnaCBib3RoIHZhbGlkYXRvcnNcbiAqIHNvIGl0IGNhbm5vdCBkcmlmdCBmcm9tIHdoYXQgZWl0aGVyIGdhdGUgYWNjZXB0cy4gVGhlIHNoYXBlIGlzIHRoZSBvbmVcbiAqIGBwcm9tcHRzL2lzc3VlL3Byb21wdC5tZGAgZG9jdW1lbnRzLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbi8qKlxuICogVGhlIGAjIyBBY2NlcHRhbmNlIENyaXRlcmlhYCBoYWxmOiB0aGUgU3BlYyByZXZpZXdlcidzIHByb3ZlbmFuY2UgbWFya2VyIGFuZFxuICogb25lIGV4YW1wbGUgcGVyIGNsb3N1cmUgc3RhdHVzLCBlYWNoIG5hbWluZyB0aGUgcmV2aWV3ZXIncyB2ZXJkaWN0LlxuICovXG5jb25zdCBTUEVDX0JMT0NLX0xJTkVTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCIjIyBBY2NlcHRhbmNlIENyaXRlcmlhXCIsXG4gIFwiXCIsXG4gICc8IS0tIHZpYmUtc3BlYy1yZXZpZXcgaW5wdXRzPVwiZGlmZitpc3N1ZS1ib2R5XCIgLS0+JyxcbiAgXCJcIixcbiAgXCItICoqbWV0Kiog4oCUIDxjcml0ZXJpb24+IOKAlCBldmlkZW5jZTogYHRlc3RzL2Zvb190ZXN0LnRzOjpkb2VzIHRoZSB0aGluZ2Ag4oCUIHJldmlld2VyOiBtZXRcIixcbiAgXCItICoqcGFydGlhbCoqIOKAlCA8Y3JpdGVyaW9uPiDigJQgZXZpZGVuY2U6IGBsaWIvZm9vLnRzYCDigJQgcmV2aWV3ZXI6IHBhcnRpYWwg4oCUIHJlYXNvbjogPG9uZSBsaW5lIOKAlCB3aGF0IGlzIHN0aWxsIG91dHN0YW5kaW5nPlwiLFxuICBcIi0gKiptaXNzaW5nKiog4oCUIDxjcml0ZXJpb24+IOKAlCByZXZpZXdlcjogbWlzc2luZyDigJQgcmVhc29uOiA8b25lIGxpbmUg4oCUIHdoeSBpdCBpcyBub3QgZG9uZT5cIixcbiAgXCItICoqdW5yZXF1ZXN0ZWQqKiDigJQgPGEgY2hhbmdlIGluIHRoZSBkaWZmIG5vdCB0cmFjZWFibGUgdG8gdGhlIGlzc3VlPiDigJQgcmV2aWV3ZXI6IHVucmVxdWVzdGVkIOKAlCByZWFzb246IDx3aHkgaXQgaXMgaGVyZT5cIixcbl07XG5cbi8qKlxuICogVGhlIGAjIyBTdGFuZGFyZHMgUmV2aWV3YCBoYWxmOiBpdHMgb3duIHJldmlld2VyJ3MgcHJvdmVuYW5jZSBtYXJrZXIsIGFcbiAqIGB2aW9sYXRpb25gIG5hbWluZyBsYWJlbGxlZCBldmlkZW5jZSBhbmQgaXRzIG91dGNvbWUsIGFuZCB0aGUgYGNsZWFuYCBhcmVhcy5cbiAqXG4gKiBUaGUgZXhhbXBsZSBvdXRjb21lIGlzIGBmaXhlZCBpbiB0aGlzIGRpZmZgLCBuZXZlciBcIndoeSBpdCBzdGFuZHNcIjogYSBicmVhY2hcbiAqIGluIGEgbGluZSB0aGUgUFIgYWRkcyBvciBjaGFuZ2VzIGlzIGZpeGVkIGJlZm9yZSB0aGUgUFIgaXMgcmFpc2VkLCBhbmQgb25seSBhXG4gKiBwcmUtZXhpc3Rpbmcgb25lIG1heSBjYXJyeSBgcHJlLWV4aXN0aW5nLCBmaWxlZCAjPG4+YCAoSXNzdWUgIzMxOTYpLiBUaGUgZ2F0ZVxuICogcmVmdXNlcyBhbnkgb3RoZXIgcmVhc29uLCBzbyB0aGUgdGVtcGxhdGUgc2hvd3MgdGhlIG9uZSBhIHJ1biB3aWxsIGFsbW9zdFxuICogYWx3YXlzIHdyaXRlLlxuICovXG5jb25zdCBTVEFOREFSRFNfQkxPQ0tfTElORVM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICBcIiMjIFN0YW5kYXJkcyBSZXZpZXdcIixcbiAgXCJcIixcbiAgJzwhLS0gdmliZS1zdGFuZGFyZHMtcmV2aWV3IGlucHV0cz1cImRpZmYrQ09ESU5HLVNUQU5EQVJEUy5tZFwiIC0tPicsXG4gIFwiXCIsXG4gIFwiLSAqKnZpb2xhdGlvbioqIOKAlCA8c3RhbmRhcmQgYnJlYWNoZWQ+IOKAlCBldmlkZW5jZTogYGxpYi9mb28udHM6NDJgIOKAlCByZWFzb246IGZpeGVkIGluIHRoaXMgZGlmZlwiLFxuICBcIi0gKipjbGVhbioqIOKAlCA8dGhlIGFyZWFzIHRoZSByZXZpZXdlciBjaGVja2VkIGFuZCBmb3VuZCBjb21wbGlhbnQ+XCIsXG5dO1xuXG4vKipcbiAqIFRoZSBibG9jayBib3RoIGdhdGVzIHByaW50LCB2ZXJiYXRpbSDigJQgaGVhZGluZ3MsIHByb3ZlbmFuY2UgbWFya2VycyBhbmQgb25lXG4gKiBleGFtcGxlIHBlciBzdGF0dXMsIGluIHRoZSBzaGFwZSBib3RoIHZhbGlkYXRvcnMgYWNjZXB0LlxuICpcbiAqIENvcGllZCBpbnRvIGBkb2NzL2FyY2hpdmUvcHItc3VtbWFyaWVzL3ByLXN1bW1hcnktPGlzc3VlPi5tZGAgYW5kIGZpbGxlZCBpbixcbiAqIGl0IHBhc3NlcyB0aGUgY2xvc3VyZSBnYXRlIGFuZCB0aGUgaW5kZXBlbmRlbnQtcmV2aWV3IGdhdGUgYWxpa2U7IHRoZVxuICogY3JpdGVyaW9uIGNvdW50IGlzIHRoZSBydW4ncyB0byBtYXRjaC5cbiAqL1xuZXhwb3J0IGNvbnN0IFJFVklFV19CTE9DS19URU1QTEFURTogc3RyaW5nID0gW1xuICAuLi5TUEVDX0JMT0NLX0xJTkVTLFxuICBcIlwiLFxuICAuLi5TVEFOREFSRFNfQkxPQ0tfTElORVMsXG4gIFwiXCIsXG5dLmpvaW4oXCJcXG5cIik7XG5cbi8qKlxuICogVGhlIHRlbXBsYXRlIGFzIGEgZmVuY2VkIG1hcmtkb3duIGJsb2NrLCByZWFkeSB0byBhcHBlbmQgdG8gYSBnYXRlIGNvbW1lbnQuXG4gKlxuICogQHJldHVybnMgVGhlIGNvbW1lbnQgbGluZXMsIGZlbmNlIGluY2x1ZGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmV2aWV3QmxvY2tUZW1wbGF0ZUxpbmVzKCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFtcImBgYG1hcmtkb3duXCIsIFJFVklFV19CTE9DS19URU1QTEFURS50cmltRW5kKCksIFwiYGBgXCJdO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F3QkMsR0FFRDs7O0NBR0MsR0FDRCxNQUFNLG1CQUFzQztFQUMxQztFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0NBQ0Q7QUFFRDs7Ozs7Ozs7O0NBU0MsR0FDRCxNQUFNLHdCQUEyQztFQUMvQztFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7Q0FDRDtBQUVEOzs7Ozs7O0NBT0MsR0FDRCxPQUFPLE1BQU0sd0JBQWdDO0tBQ3hDO0VBQ0g7S0FDRztFQUNIO0NBQ0QsQ0FBQyxJQUFJLENBQUMsTUFBTTtBQUViOzs7O0NBSUMsR0FDRCxPQUFPLFNBQVM7RUFDZCxPQUFPO0lBQUM7SUFBZSxzQkFBc0IsT0FBTztJQUFJO0dBQU07QUFDaEUifQ==
// denoCacheMetadata=10986420163704976001,16855837477942872454