## Summary

The review brief's `verification` bullet now names the all-`gone` case that `checkNote` already enforces, so a reviewer that follows the brief no longer writes a note the code refuses. Closes #4812.

## Spec

### Intent and Rationale

- `checkNote` (`.claude/skills/review-fleet-prs/scripts/test_change_policy.ts:1003`) requires `verification` when `needsVerification || allGone`; the brief only pointed at `failsWithoutChange`'s conditions. The brief is aligned to the code; the #4655 check and its test are kept.

### Essential Design Decisions

- Wording-only change: no new obligation, since the code already enforces it.

### Undiscoverable Facts

- Two PRs hit this (private fleet PR 2026-11-04; VibeCoder#4941 on 2026-11-09, per the issue comment).

## Evidence

Backend/prompt-only change; no UI. Doc-drift test `worker/deno/tests/pr_review_brief_gone_verification_4812_test.ts` pins the new sentence in the brief's "Review Mode" section.

## Test Plan

- Added `worker/deno/tests/pr_review_brief_gone_verification_4812_test.ts`. Passed with `pr_review_brief_own_bump_4522_test.ts` and `pr_review_brief_shared_3395_test.ts` (11 passed, 0 failed).
- Red check: with the prompt sentence reverted the new test failed on the missing sentence; restored, it passes. The pinned phrase is new in the base section (the base ended "same conditions as `failsWithoutChange`.").
- Twinned rule: grepped for "same conditions as `failsWithoutChange`"; only the brief held it.
- `./quality.sh`: every stage passed except `deno tests`, where 6 tests failed in `worker/deno/tests/merge_fallback_issue_test.ts` and `worker/deno/tests/pr_maintenance_command_test.ts`. Neither touches the review brief; not investigated further here.
