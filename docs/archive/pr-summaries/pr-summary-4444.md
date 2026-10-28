## Summary

The milestone sync gate treated a Deno type check that could not fetch remote
modules (esm.sh, "unsuccessful tunnel") as a refusal, and the same fault left
milestone/4050 of GRQ-AutoTrader held back. Leaving a connection-class
module-fetch failure in `checkMergedTree` to CI (Issue #4422's
`detectRemoteModuleGap`) is already on main from PR #4452 (Issue #4451). This
PR adds what the report was still missing: the left-to-CI state is carried as
a structured `checkLeftToCi` field through `checkMergedTree`,
`verifyResolvedTree`, `syncMilestoneBranchWithDefault`, the
`CHECK LEFT TO CI:` push note and the conflict report, so the report names the
check that did not run instead of claiming it passed. The same code change is
open for #4441 as PR #4459 (identical fault, other milestone); this branch
carries it too plus the docs update. Version bump: not applicable. Closes #4444.

## Spec

### Intent and Rationale

- The refusal repeated every cycle because an environment fault (no route to
  esm.sh) was judged as a code fault. A check that did not run must be reported
  as not run, never as passed.

### Essential Design Decisions

- Fail closed is unchanged: a tree where nothing but left-to-CI tasks ran is
  still `skipped`; only a genuine connection-class cause after an
  `Import ... failed` line is excepted, so 404s, checksum and type errors still
  refuse.
- `checkLeftToCi` mirrors `suiteLeftToCi` rather than overloading `detail`
  strings.

### Undiscoverable Facts

- The fix was first built on the #4441 branch (PR #4459); this branch re-applies
  it because that PR is not yet merged.

## Reproduction

- **symptom** — the gate refused the merge resolution because `deno task check`
  failed with
  `error: Import 'https://esm.sh/react@19.2.8/jsx-runtime?target=es2022' failed ... unsuccessful tunnel`,
  and a left-to-CI check could be reported as passed.
- **status** — `verified` — with the four `lib/` files restored to `244a4d18`
  the new tests fail (5 failed, 57 passed); on this head 62 passed, 0 failed.
- **regression test** —
  `worker/deno/tests/milestone_env_fault_not_charged_test.ts::the merge gate names a Deno check left to CI as checkLeftToCi, so the report cannot claim it passed (Issue #4441)`

## Evidence

Backend only. Changes: `worker/deno/lib/milestone_merge_gate.ts`,
`milestone_resolution_gate.ts`, `milestone_sync_conflict.ts`, `git_pull.ts`;
docs `docs/INTERNALS.md` and `docs/workflows/milestones.md`, hand-wrapped
edits to the surrounding text only (PR #4465 review: an earlier commit had run
`deno fmt` over both whole files, so they were restored to main's text and
the edits re-applied):

- The merge-down section of each file: the sentences saying the Issue #4422
  exception covers only the resolution gate's tasks now say it also covers the
  `checkMergedTree` type check (Issue #4451), and that on the resolution path
  a type check left to CI lands as `checkLeftToCi` only when another project's
  check passed; a tree where nothing else was checked is `skipped` and the
  resolution is refused (`verifyResolvedTree`, and the `skipped` refusal in
  `git_pull.ts`).
- INTERNALS "Nothing unverified is published": says what each path does. On a
  clean merge `gateThenPushMilestoneBranch` refuses only `failed`, so a tree
  whose only check was left to CI is `skipped` and pushed with the `UNGATED:`
  note (`git_pull.ts`, `gateNote`); with another project's check passed it is
  `passed` with `checkLeftToCi` and a `CHECK LEFT TO CI:` note. Only the
  resolution path refuses a `skipped` tree. The `checkMergedTree` exception is
  credited to Issue #4451, and #4444 only for the `checkLeftToCi` reporting.
- INTERNALS merge-only paragraph: the merge gate's left-to-CI citation now
  names Issues #4422 and #4451.

## Test Plan

- Tests: `worker/deno/tests/milestone_env_fault_not_charged_test.ts`,
  `milestone_resolution_gate_test.ts`,
  `milestone_gate_repair_land_unverified_4326_test.ts`,
  `milestone_sync_conflict_resolution_test.ts` (new cases only, no existing
  assertion removed); `milestone_sync_gate_repair_test.ts` re-run unchanged.
- `deno task test:unit` on those five files: 62 passed, 0 failed. `deno lint`
  and `deno fmt --check` clean on the touched files.
- Red check: `lib/` restored to base `244a4d18` → 5 new tests fail.
- After the PR #4465 review doc fix, on the final head: the five files above
  re-run 62 passed, 0 failed; `lib/` restored to `244a4d18` still gives 57
  passed, 5 failed. markdownlint (0 issues), `check-mermaid` (passed) and
  `check:manifests` (passed) ran on the two docs' final text, and
  `git diff origin/main -- docs/INTERNALS.md docs/workflows/milestones.md`
  holds only the hand-wrapped sentence edits.
- `./quality.sh` was not run: the review-fix host cannot reach jsr.io; CI runs
  it.

<!-- vibe-quality-gate-skipped reason="jsr.io unreachable on the review-fix host; CI runs the same checks on the PR" -->
