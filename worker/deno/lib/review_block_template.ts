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
 */

/**
 * The `## Acceptance Criteria` half: the Spec reviewer's provenance marker and
 * one example per closure status, each naming the reviewer's verdict.
 */
const SPEC_BLOCK_LINES: readonly string[] = [
  "## Acceptance Criteria",
  "",
  '<!-- vibe-spec-review inputs="diff+issue-body" -->',
  "",
  "- **met** — <criterion> — evidence: `tests/foo_test.ts::does the thing` — reviewer: met",
  "- **partial** — <criterion> — evidence: `lib/foo.ts` — reviewer: partial — reason: <one line — what is still outstanding>",
  "- **missing** — <criterion> — reviewer: missing — reason: <one line — why it is not done>",
  "- **unrequested** — <a change in the diff not traceable to the issue> — reviewer: unrequested — reason: <why it is here>",
];

/**
 * The `## Standards Review` half: its own reviewer's provenance marker, a
 * `violation` naming labelled evidence and its outcome, and the `clean` areas.
 */
const STANDARDS_BLOCK_LINES: readonly string[] = [
  "## Standards Review",
  "",
  '<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->',
  "",
  "- **violation** — <standard breached> — evidence: `lib/foo.ts:42` — reason: <fixed here, or why it stands>",
  "- **clean** — <the areas the reviewer checked and found compliant>",
];

/**
 * The block both gates print, verbatim — headings, provenance markers and one
 * example per status, in the shape both validators accept.
 *
 * Copied into `docs/archive/pr-summaries/pr-summary-<issue>.md` and filled in,
 * it passes the closure gate and the independent-review gate alike; the
 * criterion count is the run's to match.
 */
export const REVIEW_BLOCK_TEMPLATE: string = [
  ...SPEC_BLOCK_LINES,
  "",
  ...STANDARDS_BLOCK_LINES,
  "",
].join("\n");

/**
 * The template as a fenced markdown block, ready to append to a gate comment.
 *
 * @returns The comment lines, fence included.
 */
export function reviewBlockTemplateLines(): string[] {
  return ["```markdown", REVIEW_BLOCK_TEMPLATE.trimEnd(), "```"];
}
