## Summary

Issue #4441's left-to-CI reporting for a Deno type check (`checkLeftToCi`, the
`CHECK LEFT TO CI:` push note and the conflict-report wording) has landed on the
base branch through Issues #4444 and #4451, so this PR no longer carries it.
What remains is the label set: the push-note labels are one exported
`SYNC_UNCHECKED_NOTE`, `git_pull.ts` builds its notes from it, and the
resolution commit message names every note that means a check did not run, so
the merge commit never says the repository's own check passed when its note says
`CHECK LEFT TO CI` or `TESTS LEFT TO CI`. The manuals now name the
`TESTS LEFT TO CI:` note beside `CHECK LEFT TO CI:` and say that a resolution
with both left to CI carries only the `CHECK LEFT TO CI:` note, whose detail
names the suite too (`gateThenPushMilestoneBranch` checks `checkLeftToCi` first,
PR #4459 review), and `docs/CONTAINER.md`
says what a merge-only mixed tree does when nothing ran. Version bump: not
applicable. Closes #4441.

## Reproduction

- **symptom** — the milestone sync gate refused (or reported as passed) a
  resolution whose `deno task check` could not fetch `https://esm.sh/...`
  ("unsuccessful tunnel"); the report never said the type check did not run.
- **status** — `verified` on the original branch; the behaviour now lives on the
  base branch (Issues #4444, #4451), and this PR's remaining change is the
  commit-message and push-note labels.
- **regression test** —
  `worker/deno/tests/milestone_conflict_triage_test.ts::buildResolutionCommitMessage - names every note that means a check did not run, never claiming it passed (Issue #4441)`

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

Merged diff against the base: `lib/milestone_conflict_triage.ts` (new
`SYNC_UNCHECKED_NOTE`; the resolution commit message names all four notes),
`lib/git_pull.ts` (push notes built from `SYNC_UNCHECKED_NOTE`),
`tests/milestone_conflict_triage_test.ts`, and the manuals
`docs/workflows/milestones.md`, `docs/INTERNALS.md` and `docs/CONTAINER.md`.
The gate and report logic (`milestone_merge_gate.ts`, `milestone_resolution_gate.ts`,
`milestone_sync_conflict.ts`) is the base branch's own, from Issues #4444 and
#4451. Merge resolution kept the base's wording on when a type check is left to
CI (only when another project's check passed) and added the
`TESTS LEFT TO CI:` note label to it.

## Test Plan

- Remaining test: `worker/deno/tests/milestone_conflict_triage_test.ts::buildResolutionCommitMessage - names every note that means a check did not run, never claiming it passed (Issue #4441)`.
  Red check: with the commit message restored to its "UNGATED or CARGO SKIPPED"
  wording, it fails.
- The earlier regression tests for `checkLeftToCi` are superseded by the base
  branch's own tests from Issues #4444 and #4451.
