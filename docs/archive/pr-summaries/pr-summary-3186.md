## Summary

Fixes the quadratic `(.*)$` label and list-item tails in the closure,
reproduction and independent-review gates, and adds the shape to the
regex-vetting rule. `.` does not cross a lone `\r`, so on a line holding one
the tail could not reach `$`. An unanchored label search then restarted at
every later occurrence of the label and rescanned to the end each time. An
anchored pattern split a run of spaces between `\s*` (or `\s+`) and `(.*)` in
every possible way. Closes #3186.

- `worker/deno/lib/reproduction_status_gate.ts`: `REASON_RE` and the three
  `FIELD_PATTERNS` (`symptom`, `status`, `test`) read the value with
  `([^\n]*)` and no `$`.
- `worker/deno/lib/acceptance_criteria_gate.ts`: `LABEL_PATTERNS.evidence`,
  `LABEL_PATTERNS.reason` and `LIST_ITEM_RE`, the same change.
- `worker/deno/lib/independent_review_gate.ts`: `LIST_ITEM_RE` had the closure
  gate's list-marker tail, so it gets the same change. Its `LABEL_PATTERNS`
  already used `([^\n]*)`.
- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`: the
  regex-vetting bullet gains one sentence naming the failing `(.*)$` tail and
  the `([^\n]*)` remedy, word for word identical on both surfaces.
- `docs/workflows/issue-processing.md`: a paragraph after the Issue #3164 one.

## Spec

### Intent and Rationale

- The issue named three patterns. Applying the regex-vetting rule to the same
  modules found the anchored `FIELD_PATTERNS` and the two `LIST_ITEM_RE`
  patterns with the same failing tail, quadratic on a padded value.

### Essential Design Decisions

- `([^\n]*)` with no `$` is a tail that cannot fail, so nothing backtracks and
  the first labelled occurrence wins. Entries and lines never hold `\n` (lines
  are split on `\r?\n`, continuations joined with spaces), so the value still
  stops where it did, except that a value after a lone `\r` is now read rather
  than dropped. Every value is trimmed or stripped before use, so trailing
  `\r` makes no difference.

### Undiscoverable Facts

- `\s*` matches `\r`, so a label sitting directly before the `\r` still
  matched on the unfixed pattern (after the quadratic search). The hostile
  cases put text between the last label and the `\r`.

## Evidence

This change has no UI.

Measured against the unfixed patterns: repeated `reason: ` cost about 0.24 s at
32 000 characters, and a padded `symptom:` value about 0.85 s. The hostile
cases at 190 000 characters took 7–36 s each before the fix and a few
milliseconds after.

**Docs sweep** — grep: "backtrack", "quadratic", "(.*)$", "LABEL_PATTERNS";
section: `docs/workflows/issue-processing.md` (the Issue #3164 regex-vetting
paragraph); updated: `docs/workflows/issue-processing.md`.

## Test Plan

- Added `worker/deno/tests/label_tail_redos_3186_test.ts` (8 tests, one per
  fixed pattern). It asserts parser output and reads no clock.
  - Before the `worker/deno/lib/` changes, every case failed, each after
    7–36 s. The first run had the two closure-label cases green, because their
    label sat directly before the `\r` (see Undiscoverable Facts). After text
    was put before the `\r`, those two failed too (`FAILED | 0 passed | 3
    failed` for the three label cases).
  - After the changes, all 8 passed.
- Added `worker/deno/tests/regex_vetting_rule_3186_docs_test.ts` (1 test). It
  failed against the base `CODING-STANDARDS.md` and coding_guidelines prompt
  (`FAILED | 0 passed | 1 failed`) and passed after the edit.
- The new files plus the existing suites for the touched modules
  (`acceptance_criteria_gate`, `reproduction_status_gate`,
  `independent_review_gate`, `heading_tail_redos_3164`, `closure_verdict`,
  `degraded_delivery`, the completion-phase closure and reproduction suites,
  `review_block_template`, `reviewer_verdict_rule`) and the drift suites
  (`regex_vetting_rule_3164_docs`, `coding_guidelines_twin_drift`,
  `coding_guidelines_layers_2574`, `prompt_house_vocabulary_drift`):
  `ok | 212 passed | 0 failed`.
- `deno fmt --check`, `deno lint`, `deno task check` (`687 passed | 0 failed`)
  and `deno task check:manifests` all pass. `markdownlint-cli2` reports 0
  issues. The full suite is left to CI.
