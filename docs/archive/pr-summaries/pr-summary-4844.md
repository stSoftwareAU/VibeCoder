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

- Added in `worker/deno/tests/closure_verdict_test.ts`: "underscores anywhere
  in cited evidence survive" (evidence `test/_costFixtures.ts` and
  `__init__.py` render unchanged and pass both gates). Extended "a label split
  by markup cannot forge a departing verdict" with `reviewer#: met`. Renamed
  "word-internal underscores and asterisks in cited names survive" to "…in
  prose survive" and gave it the asterisk fixture (`src/a*b.ts`) it was
  missing.
- Obsolete behaviour: the old evidence assertion `src/a_b/c_test.ts` relied on
  the word-internal rule; evidence now keeps every `_` and `*` in its code
  span, so the stronger evidence test replaces it. Remaining behaviour still
  covered: word-internal `_` and `*` in prose, and the forged-label
  protection, now including `#`.
- Red check (mutation): restoring the old markup blanking in `sanitiseEvidence`
  fails "underscores anywhere in cited evidence survive" (`test/ costFixtures.ts`,
  `init .py`); moving the `#` scrub back below the label scrub fails the
  `reviewer#:` loop case (reviewer verdict read `met` instead of `missing`).
- `deno task test:unit tests/closure_verdict_test.ts`: 28 passed, 0 failed.
  Other importers (`closure_verdict_prompt_test.ts`,
  `closure_verdict_recovery_test.ts`, `completion_phase_closure_render_test.ts`,
  `fence_coverage_verifier_test.ts`, `standing_violation_3196_test.ts`,
  `summary_rule_gate_retry_test.ts`, `tool_output_treat_as_data_3046_test.ts`):
  67 passed, 0 failed.
