## Summary

Review-fix runs added a test but left the archived PR summary's Test Plan
counts from the earlier iteration (VibeCoder#3075, #3105, #3108). The
pr_feedback prompt's **Keep the PR summary true to the head** rule now says a
test added, removed or renamed in the push changes the Test Plan: recount the
list of tests, every per-file test count and every quoted total from the head,
re-run the cited commands on the final head, and never carry a number over.
The rule is mirrored in `docs/workflows/pr-feedback.md` and pinned by a
section-scoped drift test. Closes #3117.

## Spec

### Intent and Rationale

- The existing #2879 rule already demands rewriting invalidated claims, but named only "a test's pass/fail result"; the runs did not see their own new test as invalidating the counts, so the rule now says so explicitly
- Extending that paragraph, rather than adding a separate rule, keeps one place that governs the summary refresh

### Essential Design Decisions

- The optional push-blocking guardrail (counting `Deno.test(` calls against `(N tests)` claims) is not implemented: the issue marks it optional, and a prompt rule is the smallest change that addresses the recurring miss
- The drift test pins only phrases absent from both sections on the base branch, per CODING-STANDARDS.md § Documentation-drift tests

### Undiscoverable Facts

- None.

## Evidence

Backend/prompt-only change; no UI files touched.

- `deno task test:unit tests/pr_feedback_test_plan_recount_3117_test.ts tests/pr_summary_final_state_2879_test.ts tests/pr_feedback_fix_everywhere_3086_test.ts` → `ok | 9 passed | 0 failed`
- Red runs: with only the prompt edit reverted, the first new test fails with `Making Changes is missing "changes the Test Plan, so recount it from the head"`; with only the doc edit reverted, the second fails with `no heading containing "Recount the Test Plan after a review fix"`
- Related existing rules checked: the #2879 "keep the PR summary true to the head" rule (extended in place, consistent with its "leave it untouched when your change does not affect what it says" clause), CODING-STANDARDS.md "A named test must exist" / "run on the final head" (#3058, consistent), the #3086 fix-everywhere rule and the #3089 PR-body sync note in `docs/workflows/pr-feedback.md` (consistent — the sync copies the summary, so the recount must land there). The `ci_fix` template carries the same #2879 rule but is out of this issue's scope.

**Docs sweep** — grep: "true to the head", "Test Plan", "pinned phrases"; section: `docs/workflows/pr-feedback.md#recount-the-test-plan-after-a-review-fix-issue-3117` (new, beside `#fix-the-defect-everywhere-it-lives-issue-3086`); updated: `docs/workflows/pr-feedback.md`

## Test Plan

- Added `worker/deno/tests/pr_feedback_test_plan_recount_3117_test.ts` (2 tests): the pr_feedback prompt's Making Changes section and the workflow doc's new section each carry the recount rule. Both seen red with only their change removed.
- No existing test edited.
