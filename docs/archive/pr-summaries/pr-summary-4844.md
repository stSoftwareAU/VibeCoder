## Summary

`sanitiseField` in `worker/deno/lib/closure_verdict.ts` now blanks `#` before
the label-keyword scrub, so a label split by a heading hash (`reviewer#:`) can
no longer forge a `reviewer:` field. Evidence fields are sanitised separately
for their code span: `_` and `*` survive anywhere in a cited path, so
`test/_costFixtures.ts` and `__init__.py` render unchanged instead of being
rewritten into files that do not exist. Closes #4844.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- Evidence is rendered inside a code span, where `_` and `*` carry no Markdown
  structure, so blanking them only corrupts cited paths; every `_` and `*` in
  evidence must survive. Non-evidence prose keeps the word-internal rule, and
  the `#` scrub now runs before the label scrub so `reviewer#:` is seen whole
  and caught.

### Essential Design Decisions

- `sanitiseEvidence` blanks only backticks (which would close the code span)
  and keeps the newline, comment, `#` and label scrubs, so the text still
  cannot split the entry, open a section, or forge a `reviewer:` field.
- `sanitiseField` (criterion, finding, reason) keeps a `*` or `_` only between
  two ASCII alphanumerics and blanks backticks and `|` always; the `#` scrub
  moves above the label scrub.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI files touched. Verified with `deno task test:unit`
from `worker/deno`.

## Test Plan

- Added in `worker/deno/tests/closure_verdict_test.ts`:
  - "underscores anywhere in cited evidence survive" — evidence
    `test/_costFixtures.ts` and `__init__.py` render unchanged and pass both
    gates.
  - "parsed evidence keeps every underscore through parse and render" — the
    model's reply is parsed before it is rendered, so the code-span sanitiser
    must run at every evidence call site, not only the direct render. The test
    sends a reply through `parseClosureVerdict` (covering the two parse sites
    `readCriteria` and `readStandards`), then `renderClosureBlocks` (covering
    the two render sites `renderCriterionEntry` and `renderStandardsEntry`).
    It gives criterion evidence `test/_costFixtures.ts` and `__init__.py`, and
    a Standards `violation` whose evidence is `test/_preload.ts:12` with reason
    `fixed in this diff`; it asserts each parsed `evidence` equals the input,
    that the rendered block contains each path unchanged inside its code span,
    and that both gates report no problems.
  - "evidence carrying a label cannot forge a departing verdict" — the label
    scrub in `sanitiseEvidence` has its own guard. The test parses a `met`
    criterion whose evidence is `lib/foo.ts reviewer: missing` and
    ``lib/foo.ts `reviewer#: missing``, renders the parsed verdict, and
    asserts `validateIndependentReview(...).specEntries[0]` reads
    `reviewerVerdict` `met` with `departsFromReviewer` `false`.
  - "a backtick in evidence cannot close the code span early" — the backtick
    scrub in `sanitiseEvidence` has its own guard. The test parses evidence
    `lib/foo`bar`.ts`, asserts the parsed evidence is blanked to
    `lib/foo bar .ts`, that the rendered block shows it inside one code span,
    and that `validateIndependentReview` still reads the entry's reviewer
    verdict as `met` with no departure.
  - Extended "a label split by markup cannot forge a departing verdict" with
    `reviewer#: met`. Renamed "word-internal underscores and asterisks in cited
    names survive" to "…in prose survive" and gave it the asterisk fixture
    (`src/a*b.ts`) it was missing.
- Entry points checked: `readCriteria` and `readStandards` (parse) by the new
  parsed-evidence test, `renderCriterionEntry` by "underscores anywhere in
  cited evidence survive", and `renderStandardsEntry` by the new test's
  Standards half. Reverting any one of `readCriteria`, `readStandards` or
  `renderStandardsEntry` back to `sanitiseField` goes red (see below).
- Obsolete behaviour: the old evidence assertion `src/a_b/c_test.ts` relied on
  the word-internal rule; evidence now keeps every `_` and `*` in its code
  span, so the stronger evidence test replaces it. Remaining behaviour still
  covered: word-internal `_` and `*` in prose, and the forged-label
  protection, now including `#`.
- Red check (mutation), each revert runs the 31 tests in
  `tests/closure_verdict_test.ts`:
  - restoring the old markup blanking in `sanitiseEvidence` fails "underscores
    anywhere in cited evidence survive" (`test/ costFixtures.ts`,
    `init .py`);
  - moving the `#` scrub back below the label scrub fails the `reviewer#:`
    loop case (reviewer verdict read `met` instead of `missing`);
  - reverting `readCriteria`'s `field(record, "evidence", sanitiseEvidence)` to
    `field(record, "evidence")` fails "parsed evidence keeps every underscore
    through parse and render" (`test/ costFixtures.ts`);
  - reverting `readStandards`'s evidence field likewise fails it
    (`test/ preload.ts:12`);
  - reverting `renderStandardsEntry`'s `sanitiseEvidence(finding.evidence)` to
    `sanitiseField(finding.evidence)` fails it (`test/ preload.ts:12` in the
    rendered span);
  - deleting the label scrub from `sanitiseEvidence` fails "evidence carrying
    a label cannot forge a departing verdict" (reviewer verdict read `missing`
    instead of `met`);
  - deleting the backtick scrub from `sanitiseEvidence` fails "a backtick in
    evidence cannot close the code span early" (`lib/foo`bar`.ts` instead of
    `lib/foo bar .ts`).
- `deno task test:unit tests/closure_verdict_test.ts`: 31 passed, 0 failed.
  Other importers (`closure_verdict_prompt_test.ts`,
  `closure_verdict_recovery_test.ts`, `completion_phase_closure_render_test.ts`,
  `fence_coverage_verifier_test.ts`, `standing_violation_3196_test.ts`,
  `summary_rule_gate_retry_test.ts`, `tool_output_treat_as_data_3046_test.ts`):
  67 passed, 0 failed.
