## Summary

The babysitter repair prompt now keys its TDD rule 3 note to the PR's diff against its base instead of the review's request, so a repair no longer records the branch's own superseded wording as "obsolete". Closes #4933.

Version bump: no `VERSION` change; this edits a prompt string and its test only.

## Spec

### Intent and Rationale

- TDD rule 3 in `CODING-STANDARDS.md` is measured as `git diff <base>...HEAD`; the old prompt sentence started from what the review asked for, which is measured against the reviewed head, so a review-requested edit to a test the branch itself added left only the branch's own wording to call obsolete.

### Essential Design Decisions

- The sentence keeps the phrases the existing test pins (`CODING-STANDARDS.md TDD rule 3`, `obsolete behaviour`, `remaining behaviour`, `path::test in the PR summary`), so #4655's policy for real changes to base tests is unchanged.
- One short clarifying sentence says a net-zero change to a branch-only test owes no note; this removes an obligation and adds none.

### Undiscoverable Facts

- None.

## Evidence

Changed `buildRepairPrompt` in `worker/deno/commands/fleet_pr_babysitter.ts`; every repair kind (CI, review, conflict) shares the sentence.

## Test Plan

- Edited `worker/deno/tests/fleet_pr_babysitter_test.ts::repair prompt applies the shared evidence policy to test replacements`: added assertions for the new wording and that the old sentence is gone. No assertion removed.
- Red check: with `fleet_pr_babysitter.ts` restored to base, the test fails; with the change it passes.
- `deno test -A tests/fleet_pr_babysitter_test.ts`: 120 passed, 0 failed.
- Twin copies of the rule: none found outside `buildRepairPrompt` (grep for the old sentence).
