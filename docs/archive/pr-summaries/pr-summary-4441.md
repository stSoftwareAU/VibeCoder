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
- The push-note labels are one exported set, `SYNC_UNCHECKED_NOTE` in
  `milestone_conflict_triage.ts`. `git_pull.ts` builds its notes from it and
  `buildResolutionCommitMessage` names each one, so the merge commit no longer
  says the repository's own check passed when its note says `CHECK LEFT TO CI`
  or `TESTS LEFT TO CI` (PR #4459 review).

### Undiscoverable Facts

- None.

## Evidence

Changes: `lib/milestone_merge_gate.ts` (new `checkLeftToCi` on
`MergeGateOutcome`), `lib/milestone_resolution_gate.ts` (carried onto the passed
verdict), `lib/milestone_sync_conflict.ts` (field and report wording),
`lib/git_pull.ts` (`CHECK LEFT TO CI:` push note and result field),
`lib/milestone_conflict_triage.ts` (`SYNC_UNCHECKED_NOTE`, and the resolution
commit message names all four notes).

Manuals read and updated (PR #4459 review): `docs/workflows/milestones.md`
("Every automatic resolution is verified before it is pushed" and the merge-down
mermaid edge) and `docs/INTERNALS.md` (the merge-down section's two
exceptions, its mermaid edge, the "Nothing unverified is published" bullet and
the conflict-triage mermaid edge). They now say a Deno type check whose module
host is unreachable is left to CI by `checkMergedTree`, lands with
`checkLeftToCi` and gets the `CHECK LEFT TO CI:` note; the "type check is
unchanged" sentences are gone. Siblings grepped: `suiteLeftToCi`,
`TESTS LEFT TO CI`, `CARGO SKIPPED` and `UNGATED` across `docs/`, `README.md`,
`DESIGN-PRINCIPLES.md`, `prompts/` and `worker/deno/lib`. `docs/CONTAINER.md`'s merge-only
paragraph said mixed trees must pass every Deno check; it now names the
left-to-CI exception and both notes. The remaining hits
(`docs/CONTAINER.md:1386`, `docs/INTERNALS.md:4471`, `:4506`, `:4515`) describe
`UNGATED` alone and stay true.

Review-fix tests: `milestone_conflict_triage_test.ts` 31 passed;
`check:manifests` files 846 passed.

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
- Review fix: new
  `milestone_conflict_triage_test.ts::buildResolutionCommitMessage - names every note that means a check did not run, never claiming it passed (Issue #4441)`.
  Red check: with the commit message restored to its "UNGATED or CARGO SKIPPED"
  wording, it fails.
