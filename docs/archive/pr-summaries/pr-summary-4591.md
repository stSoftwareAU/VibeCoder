## Summary

When the pre-PR verifier gate still reported on the re-run, the PR's
`## Notes for the reviewer` comment named only the verifier findings and dropped
any unmet acceptance criterion. The verifier gate in `completionBody`
(`worker/deno/lib/phases/completion_phase.ts`) now builds its block with
`foldInLateSummaryVerdicts`, like every other summary gate, so the unmet-criteria
verdict, the one late verdict after it, is folded into the note and the PR
comment. Closes #4591.

Version bump: no `VERSION` change in this diff; the merged commit records the
final version.

## Spec

### Intent and Rationale

- The verifier gate hand-built its `SummaryRuleBlock` (`comment` = verifier
  comment, `sections: [comment]`). `reportSummaryRuleBlock` keeps only the first
  reporting gate's comment, so the later unmet-criteria comment was discarded.
  Calling the existing fold fixes it at the source and keeps `DESIGN-PRINCIPLES.md`
  ("the unmet criteria are named in one `## Notes for the reviewer` comment") true.

### Essential Design Decisions

- The fold's skip list is `[prePrVerifierVerdict]` only, not the four verdicts
  the issue suggests. The skip list seeds the block's categories, and the
  placeholder, mutation and coverage verdicts carry none, so listing them adds
  `summary_incomplete` and breaks the existing verifier-only expectation
  `["quality_check"]` (`completion_phase_pre_pr_verifier_3395_test.ts`). Those
  three gates run earlier and report first, so folding them here changes
  nothing a reader sees.
- The block's categories are still the verifier's own; `criteria_unmet` is added
  only when an unmet criterion exists. `verifierHoldComment` is unchanged (the
  fold sets it from the same verdict).

### Undiscoverable Facts

- None.

## Evidence

Backend only, no UI. `worker/deno/tests/completion_phase_verifier_unmet_fold_4591_test.ts`
runs the real completion phase with a verifier that reports a finding on every
call and one `partial` criterion: the in-session note and the single PR comment
each name the verifier heading, the unmet-criteria heading and the criterion
once. A second test (all criteria met) asserts the comment names the verifier
finding and no unmet heading. Issue numbers cited as provenance: #4583 (reviewer
note drops independent-review and reproduction findings), #4146 (unmet criteria
block the PR), #4234 (completion gates made advisory), #4591 (this issue).

## Test Plan

- Added `worker/deno/tests/completion_phase_verifier_unmet_fold_4591_test.ts`
  (two tests; the fixture asserts only the verifier and unmet gates report).
- Red check: restoring the old hand-built block made
  `completion - the verifier block folds in the unmet criteria ...` fail (the
  note lacked the unmet heading; with that assertion skipped, the PR comment
  also lacked it); the all-met test stayed green, as expected.
- `deno task test:unit` over the new file plus
  `completion_phase_pre_pr_verifier_3395_test.ts`,
  `completion_phase_reviewer_note_folds_4583_test.ts`,
  `completion_phase_summary_rule_retry_test.ts`, `unmet_criteria_gate_test.ts`:
  44 passed, 0 failed.
- Callers checked: every other `foldInLateSummaryVerdicts` call in
  `completionBody` (closure, review, reproduction, scrub, placeholder, mutation,
  coverage, unmet) is untouched; the verifier gate is the only block that was
  hand-built.
