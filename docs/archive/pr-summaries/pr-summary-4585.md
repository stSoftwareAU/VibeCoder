## Summary

Text the worker posts in a target repository no longer cites VibeCoder issue
numbers, which GitHub resolves against the target repo (NEAT-AI#4131 was sent
back for `#4146`). The `(Issue #N)` / `(Issues #N, #M)` suffixes are dropped
from the output strings the issue names, and from the same-class strings in the
same failure paths. Provenance stays in the code comments beside them. Closes
#4585.

Version bump: no `VERSION` change in this diff; the merged commit records the
final version.

## Spec

### Intent and Rationale

- A bare `#N` in a target repo links to an unrelated issue or PR, and agents
  copy the number into the target repo's own files. Dropping the suffix removes
  the source; the comments next to each string keep the history.

### Essential Design Decisions

- Besides the strings the issue lists, the same suffix was removed from the
  other `getFailureDiagnosis` detail bullets and the two
  `getFailureDiagnosisOneliner` causes (`failure_diagnosis.ts`), and the
  pre-push bullet's `(PR #3716 review)`. The detail bullets are posted only by
  `recordRepoConfigRefusal` (`label_failure.ts`, the "Paused (Repository
  Configuration)" comment); the "Automated Processing Failed" comment carries
  only the one-line cause. They are the same defect on a sibling path, so one
  sweep covers the category.
- `formatDriftResidual` also had a `#### Mutation check (Issue #3750)` heading
  in the same drift-check reply; it is now `#### Mutation check`, with the
  provenance in the code comment above it. The pins in
  `pr_feedback_drift_check_3750_test.ts` and
  `pr_feedback_processor_mutation_check_3750_test.ts` use the new heading.
- The `Part of #N` / `Closes #N` placeholders in the note and draft bodies are
  literal text, not digits, and `Part of #${issueNumber}` is the target repo's
  own number; both stay.
- Not changed: `console.warn` operator logs in `label_failure.ts` (local, not
  posted), and agent-facing prompt text `prompts/issue/prompt.md` and
  `docs/MODEL-AND-CACHING.md`, which are not posted to a target repo.

### Undiscoverable Facts

- `tests/completion_phase_repo_formatters_test.ts` lines 480 and 567 fail on
  this host (no rustup) with or without this change; checked on a pristine
  `HEAD` copy (6 passed, 2 failed).

## Evidence

Backend only, no UI. Tests assert on real builder output:
`worker/deno/tests/unmet_criteria_gate_test.ts`,
`worker/deno/tests/draft_continuation_4146_test.ts`,
`worker/deno/tests/pr_feedback_drift_check_3143_test.ts`,
`worker/deno/tests/failure_comment_no_vibecoder_numbers_4585_test.ts`. Issue
numbers cited as provenance:

- #4585: Unmet-criteria note, draft-continuation PR bodies, drift-check reply
  and failure comment still cite VibeCoder issue numbers in target repos
  (NEAT-AI#4131).
- #3750: Diff-scoped mutation gate (#3393) runs only at PR raise: review-fix
  rounds still add branches no test pins (VibeCoder#3160, #3312, #3716).

The mutation-check
manual (`docs/mutation-check.md`, Review-fix runs and Outcomes)
and PR-feedback manual (`docs/workflows/pr-feedback.md`, drift check) were read
and updated to name the emitted `### Drift check` and `#### Mutation check`
headings.

## Test Plan

- Added in `unmet_criteria_gate_test.ts`:
  `unmetCriteriaReason and
  buildUnmetCriteriaGateComment - carry no issue number in their output`.
- Added in `draft_continuation_4146_test.ts`: one test each for
  `buildUnmetDraftBody` and `buildDraftContinuationBody` (only `#42`, the passed
  issue number, may appear).
- Added in `pr_feedback_drift_check_3143_test.ts`:
  `formatDriftResidual - carries
  no issue number in its output`.
- Added `failure_comment_no_vibecoder_numbers_4585_test.ts`: every
  `FailureCategory` through `getFailureDiagnosisOneliner`,
  `getFailureDiagnosis`, `markIssueAsFailedOnce` (issue 42) and the repo_config
  route (`handleIssueFailure`).
- Red checks, old string restored in the lib then restored again: each of
  `unmetCriteriaReason`, `buildUnmetCriteriaGateComment`, `buildUnmetDraftBody`,
  `buildDraftContinuationBody`, `formatDriftResidual` turned its new test red;
  `(Issue #4158)` in `label_failure.ts`, `(Issue #1475)` in the one-liner and
  `(Issue #2682)` in the detail bullet turned the failure-comment tests red.
- Added in `pr_feedback_drift_check_3143_test.ts`:
  `formatDriftResidual - the mutation check section carries no issue number`,
  covering a residual with `mutationSurvivors`, `mutationNote` and
  `mutationCheckUnavailable` in turn.
- Mutation check: it reported "baseline tests fail before mutation" for 48 test
  files and so judged no mutants. Those files pass when run directly on this
  head (e.g. `failure_comment_no_vibecoder_numbers_4585_test.ts`,
  `host_fault_test.ts`, `semgrep_check_test.ts`, `never_hand_back_4227_test.ts`,
  `run_outcome_test.ts`: 86 passed, 0 failed), so the failure comes from the
  mutation runner's baseline environment, not from a changed line. The changed
  output strings are asserted by the tests above; the operator manuals also
  document the updated headings.
- Edited pins (no assertion removed): the heading pins in
  `unmet_criteria_gate_test.ts` (`startsWith`),
  `pr_feedback_drift_check_3143_test.ts` and
  `pr_feedback_processor_drift_check_3143_test.ts` now use the heading without
  the suffix; the negative `!includes` in the processor test uses
  `### Drift check`, so it still catches a posted drift section. Red check on
  the `startsWith` pin: restoring the suffix failed it.
- `./quality.sh`: every stage passed except `deno tests`, parallel pass 31544
  passed, 2 failed, both in `completion_phase_repo_formatters_test.ts` (lines
  480 and 567, no cargo/rustup here, failing on a pristine `HEAD` too). The
  serial pass did not run because the parallel pass failed; `config integration`
  and `checkov` were skipped for local prerequisites.
