## Summary

The milestone sync gate treated a Deno type check that could not fetch remote
modules (esm.sh, "unsuccessful tunnel") as a refusal, and the same fault left
milestone/4050 of GRQ-AutoTrader held back. A connection-class module-fetch
failure is now left to CI (Issue #4422's `detectRemoteModuleGap`), and the left-to-CI
state is carried as a structured `checkLeftToCi` field through `checkMergedTree`,
`verifyResolvedTree`, `syncMilestoneBranchWithDefault`, the `CHECK LEFT TO CI:`
push note and the conflict report, so the report names the check that did not
run instead of claiming it passed. The same code change is open for #4441 as PR
#4459 (identical fault, other milestone); this branch carries it too plus the docs
update. Version bump: not applicable. Closes #4444.

## Spec

### Intent and Rationale

- The refusal repeated every cycle because an environment fault (no route to esm.sh) was judged as a code fault. A check that did not run must be reported as not run, never as passed.

### Essential Design Decisions

- Fail closed is unchanged: a tree where nothing but left-to-CI tasks ran is still `skipped`; only a genuine connection-class cause after an `Import ... failed` line is excepted, so 404s, checksum and type errors still refuse.
- `checkLeftToCi` mirrors `suiteLeftToCi` rather than overloading `detail` strings.

### Undiscoverable Facts

- The fix was first built on the #4441 branch (PR #4459); this branch re-applies it because that PR is not yet merged.

## Reproduction

- **symptom** — the gate refused the merge resolution because `deno task check` failed with `error: Import 'https://esm.sh/react@19.2.8/jsx-runtime?target=es2022' failed ... unsuccessful tunnel`, and a left-to-CI check could be reported as passed.
- **status** — `verified` — with the four `lib/` files restored to `244a4d18` the new tests fail (5 failed, 57 passed); on this head 62 passed, 0 failed.
- **regression test** — `worker/deno/tests/milestone_env_fault_not_charged_test.ts::the merge gate names a Deno check left to CI as checkLeftToCi, so the report cannot claim it passed (Issue #4441)`

## Evidence

Backend only. Changes: `worker/deno/lib/milestone_merge_gate.ts`, `milestone_resolution_gate.ts`, `milestone_sync_conflict.ts`, `git_pull.ts`; docs `docs/INTERNALS.md` and `docs/workflows/milestones.md` (the sentence saying the #974 type check is outside the exception is corrected).

## Test Plan

- Tests: `worker/deno/tests/milestone_env_fault_not_charged_test.ts`, `milestone_resolution_gate_test.ts`, `milestone_gate_repair_land_unverified_4326_test.ts`, `milestone_sync_conflict_resolution_test.ts` (new cases only, no existing assertion removed); `milestone_sync_gate_repair_test.ts` re-run unchanged.
- `deno task test:unit` on those five files: 62 passed, 0 failed. `deno lint` and `deno fmt --check` clean on the touched files.
- Red check: `lib/` restored to base `244a4d18` → 5 new tests fail.
- `./quality.sh` was not run.

<!-- vibe-quality-gate-skipped reason="skipped for run budget; CI runs the same checks on the PR" -->
