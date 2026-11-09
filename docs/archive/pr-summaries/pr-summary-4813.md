## Summary

The reviewer's test-change policy no longer treats `unknown` anywhere in a `failsWithoutChange` statement as negative. `unknown` is now matched only as the leading word (like `no` and `false`), so a positive failure statement that names an `unknown` value or an identifier such as `unknownMerged` is accepted. Closes #4813.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- The substring check refused positive notes the shared brief asks for, and the fleet cannot answer that finding. Moving `unknown` to the leading-word rule keeps a statement that is itself an unknown (`unknown`, `Unknown: not run`) refused.

### Essential Design Decisions

- `would pass` stays a substring phrase: the issue only asks to move `unknown`.

### Undiscoverable Facts

- None.

## Evidence

Backend/CLI-only change; verified by tests, not screenshots. `failsWithout` in `.claude/skills/review-fleet-prs/scripts/test_change_policy.ts` now uses `/^(?:no|false|unknown)\b/`.

## Acceptance Criteria

The issue states no acceptance-criteria heading and nothing it asks is left undone.

## Test Plan

- `worker/deno/tests/review_fleet_prs_test_policy_wiring_4655_test.ts` ("never approved: a failsWithoutChange that does not show the test fails"): added `"Unknown: not run"` to the refused list and the two statements from #4810 to the approved list. Ran with `deno task test:unit` with the new tests and `review_fleet_prs_test_policy_4655_test.ts`: 127 passed, 0 failed.
- Red check: with the base-branch `test_change_policy.ts` restored, that test fails (56 passed, 1 failed). The still-refused entries (`unknown`, `Unknown: not run`) keep guarding the leading-word rule.
- No assertion removed from any existing test.

Not checked: the full `./quality.sh` gate was not run in this summary's scope.
