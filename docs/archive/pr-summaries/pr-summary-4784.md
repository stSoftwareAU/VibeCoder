## Summary

A `gone` coverage entry naming a test file no longer fails a test-change note
when another entry in the same note passes. It is reported only when no entry
passes, so a note whose only proof is a deleted test is still refused. The brief
now says `gone` is for removed production code. Closes #4784.

Version bump: not applicable; no `VERSION` change.

## Spec

### Intent and Rationale

- The reviewer followed the brief's `gone` definition (absent at the head or
  without `name`), listed a renamed test as `gone` beside verified `existing`
  coverage, and was refused with a finding the PR cannot answer.
- The simplest fix, as the issue proposes: defer the finding in `checkCoverage`
  and keep the brief aligned with the code.

### Essential Design Decisions

- A `gone` test-path entry never counts toward `passed` and is never probed; its
  problem text is unchanged.
- The deferred finding is emitted when `passed` is empty, so the existing 4655
  cases keep their message.

### Undiscoverable Facts

- None.

## Evidence

- `worker/deno/tests/review_fleet_prs_test_policy_4655_test.ts` new test
  "approval: a gone test-path entry beside verified existing coverage does not
  fail the note": approved with `existing` plus `gone` test entry (gone path
  never read), and still refused when the `existing` entry is absent at the
  head.
- Red check: restoring the base `test_change_policy.ts` fails the new test at
  `assertApproved` with "is a test file". The second case (refused when nothing
  else passes) passes on both sides and guards the unchanged behaviour.
- Related existing rules checked: `prompts/pr_review_brief/prompt.md` lines 78
  and 113-121, `.claude/skills/review-fleet-prs/SKILL.md` line 73. No test pins
  the old brief wording. Rule applied to this diff: nothing found.

## Test Plan

- `deno task test:unit` on `tests/review_fleet_prs_test_policy_4655_test.ts`,
  `tests/review_fleet_prs_test_policy_wiring_4655_test.ts`,
  `tests/pr_review_brief_shared_3395_test.ts`,
  `tests/pre_pr_verifier_test_notes_4655_test.ts`: 136 passed, 0 failed.
- Existing tests at the 4655 file's "a gone entry naming the deleted test file
  itself is refused" and "naming any test path is refused" are unchanged and
  still pass (no other entry passes there).
- Compound/branch outcome: `passed.length === 0` true (refused, existing tests
  and the new second case) and false (approved, new first case).
- `./quality.sh`: every stage passed except `deno tests`, whose only 2 failures
  (of 32,446) are
  `completion - an unformatted Rust change is formatted and committed…` and
  `completion - cargo fmt stages only the branch's .rs files…` in
  `worker/deno/tests/completion_phase_repo_formatters_test.ts`. That file is
  untouched by this PR and fails on its own run here; the failure is not in code
  this diff changes. The serial test pass did not run because the parallel pass
  failed.
