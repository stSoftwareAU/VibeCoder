## Summary

A milestone sync whose merged tree passed the repository's Issue #974 type check
only because the host could not fetch a remote Deno module (Issue #4422's
left-to-CI carve-out) was reported as if that check had passed. The left-to-CI
note is now carried from the merge gate (`checkMergedTree`) and the resolution
gate (`verifyResolvedTree`) through the sync result into the conflict report and
the `CHECK LEFT TO CI:` push note, so the report names the check that did not
run instead of claiming it passed. Version bump: not applicable. Closes #4441.

## Reproduction

- **symptom** — the milestone sync gate refused (or reported as passed) a
  resolution whose `deno task check` could not fetch `https://esm.sh/...`
  ("unsuccessful tunnel"); the report never said the type check did not run.
- **status** — `verified` — the regression tests were observed failing against
  the unfixed `lib/` (the four changed lib files restored to `244a4d18`: 5
  failed, 49 passed) and passing after the fix (54 passed, 0 failed).
- **regression test** —
  `worker/deno/tests/milestone_env_fault_not_charged_test.ts::the merge gate names a Deno check left to CI as checkLeftToCi, so the report cannot claim it passed (Issue #4441)`

## Spec

### Intent and Rationale

- A check that did not run must not be reported as passed. `checkLeftToCi`
  mirrors the existing `suiteLeftToCi` (Issue #4422) for the type-check half.

### Essential Design Decisions

- Fail closed is unchanged: a tree where nothing but left-to-CI tasks ran is
  still `skipped`, and the early `skipped` return in `verifyResolvedTree` never
  carries `checkLeftToCi`.
- The conflict-report wording also names `suiteLeftToCi` and `cargoSkipped` when
  they are set, so one report states everything that was left to CI.

### Undiscoverable Facts

- None.

## Evidence

Changes: `lib/milestone_merge_gate.ts` (new `checkLeftToCi` on
`MergeGateOutcome`), `lib/milestone_resolution_gate.ts` (carried onto the passed
verdict), `lib/milestone_sync_conflict.ts` (field and report wording),
`lib/git_pull.ts` (`CHECK LEFT TO CI:` push note and result field).

## Test Plan

- New tests: two in `milestone_env_fault_not_charged_test.ts`, one in
  `milestone_gate_repair_land_unverified_4326_test.ts`, two in
  `milestone_resolution_gate_test.ts`, one in
  `milestone_sync_conflict_resolution_test.ts`.
- Red check: with `git_pull.ts`, `milestone_merge_gate.ts`,
  `milestone_resolution_gate.ts` and `milestone_sync_conflict.ts` restored to
  `244a4d18`, 5 of the new tests fail; restored to the branch head, all 54 tests
  in those four files pass.
- No existing test was edited.
