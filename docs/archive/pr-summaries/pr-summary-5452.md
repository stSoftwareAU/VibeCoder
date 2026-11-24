## Summary

Consolidated the docs-change search rule into the same paragraph in the coding
standards, shared guidelines and issue prompt. Closes #5452.

## Spec

### Intent and Rationale

- Put old-name and old-wording searches together instead of spreading them
  across six trigger-specific bullets.

### Essential Design Decisions

- Retain removed or rewritten doc lines as search terms, the manual-section
  lookup, additive-member and insertion-point guidance, and rule-consistency
  requirements. Keep the `pr_feedback` sweep unchanged.
- Remove the issue prompt's redundant docs-summary sentence; add no gate or
  reporting obligation.

### Undiscoverable Facts

None.

## Evidence

- Documentation and documentation-test changes; no UI surface changed.
- Checked the twinned standards/guidelines rule, its issue-prompt restatement,
  the manual lookup, `pr_feedback` sweep and Prompt Engineering Guidance's
  existing-rule, own-diff and restatement rules. Applied the rewritten rule to
  this diff: corrected two references to the removed bullet to say paragraph.
- Re-ran old-wording searches on the committed implementation. The remaining
  live hits are the unchanged `pr_feedback` sentence and the issue prompt's
  whole-file absence assertion. Historical records retain their original text.
- The three paragraph copies and the tests agree on meaning changes behind an
  unchanged name, including statements outside the diff and wording removed by
  the diff.

## Test Plan

- Modified `worker/deno/tests/coding_guidelines_meaning_change_2904_test.ts`:
  obsolete bullet wording is replaced by pins for behaviour, meaning, defaults,
  values, old names and stems, removed doc lines and the final-head re-run.
  Word-for-word parity between the standards and guidelines remains checked.
- Modified `worker/deno/tests/source_doc_comments_3219_docs_test.ts`:
  the separate source-comment and definitions/callers wording is replaced by
  the paragraph's source-comment scope, sentence review and outside-diff pins.
  Step 3 must carry the same paragraph and retain its pointer and manual lookup.
  The removed summary requirement now has a whole-file absence check; the
  `pr_feedback` assertions are unchanged.
- Test-first run against unchanged documentation: three expected failures,
  with the unchanged `pr_feedback` test passing. Final targeted run through
  `deno task test:unit`: **30 passed, 0 failed**, covering both modified files
  and these six unchanged neighbouring suites:
  - `worker/deno/tests/coding_guidelines_additive_member_3137_test.ts`
  - `worker/deno/tests/insertion_point_rule_3194_docs_test.ts`
  - `worker/deno/tests/existing_rule_conflicts_3077_test.ts`
  - `worker/deno/tests/own_diff_rule_check_3249_docs_test.ts`
  - `worker/deno/tests/own_restatements_agree_3554_docs_test.ts`
  - `worker/deno/tests/coding_guidelines_layers_2574_test.ts`
- Targeted Deno formatting, lint and type checks passed.
- `timeout 900 ./quality.sh --sequential < /dev/null`: **passed with skips**;
  both unit passes, lint, type check, formatting, Markdown lint, Semgrep and
  gitleaks passed. Config integration lacked `.config.json`; Checkov lacked
  its pinned binary or container image.
- `deno task pr-summary-check`: passed, with zero blocked or unchecked gates.

## Merge verification

CI and independent review are pending.

Not checked: config integration and Checkov as above, CI, and the effect on
future fleet doc-drift recurrence. The shorter wording's effectiveness remains
unmeasured.
