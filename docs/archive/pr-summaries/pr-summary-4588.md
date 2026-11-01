## Summary

A cargo-budget withhold no longer counts as a refusal, so it no longer advances
`refusedCycles`. Three or more withheld cycles on a host short of disk no longer
pre-load the refusal ceiling, and the first merge-gate refusal after the
shortage is refusal 1 of 3 rather than a straight climb to the roll-back. Closes
#4588.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- `judgeSyncFailure` marked the withhold `refusal: true`;
  `concludeConflictAttempt` adds one to `refusedCycles` for every not-charged
  verdict with that flag, and `escalateRepeatedRefusal` only exempted the
  withhold from _climbing_, not from being counted. The fix drops the flag, as
  Issue #4517 did for the cycle-budget deferral.

### Essential Design Decisions

- `escalateRepeatedRefusal` keeps its `reason === CARGO_BUDGET_AGENT_WITHHELD`
  early return as defence in depth; its comment now says so.
- One fix in `judgeSyncFailure` covers both the sweep and the pre-cut sync
  (`milestone_presync.ts`), since both conclude with
  `refusal: verdict.refusal === true`.

### Undiscoverable Facts

- None.

## Evidence

Backend only. `lib/milestone_branch_sync.ts` loses `refusal: true` from the
withhold verdict and its doc comments are corrected;
`lib/milestone_sync_streak.ts` doc comments (`MILESTONE_REFUSAL_CEILING`,
`refusedCycles`) now name the withhold alongside the deferral. No manual states
that a withhold counts toward the ceiling (`docs/` swept for `cargo budget`,
`CARGO_BUDGET_AGENT_WITHHELD`, `refusedCycles`; `docs/INTERNALS.md` and
`docs/workflows/milestones.md` cycle-budget text remains true).

## Reproduction

- **symptom** — withheld cycles raised `refusedCycles`, so the first gate
  refusal after three withholds climbed to the roll-back and filed a
  `merge-fallback` flag.
- **status** — `verified` for the counter: the new tests failed against the
  unfixed code (`a withhold is never counted`, actual 6, expected 0) and pass
  after the fix. The final roll-back on the first gate refusal was not observed
  on unfixed code because the counter assertion fails first.
- **regression test** —
  `worker/deno/tests/milestone_cargo_withhold_not_counted_4588_test.ts::syncMilestoneBranches - a cargo-budget withhold never climbs to the roll-back or counts as a refusal, however many cycles it repeats (Issue #4588)`

## Test Plan

- Added `worker/deno/tests/milestone_cargo_withhold_not_counted_4588_test.ts`:
  sweep (six withholds then one gate refusal ends with `refusedCycles` 1, no
  roll-back, no attempt spent), pre-cut sync (repeated withholds leave
  `refusedCycles` 0 and the budget unspent), and `judgeSyncFailure`
  (not-charged, no `refusal`). All three go red with `refusal: true` restored on
  the withhold verdict.
- Edited `worker/deno/tests/milestone_merge_only_4326_test.ts`:
  - Removed from `worker/deno/tests/milestone_merge_only_4326_test.ts`:
    `assertEquals(first.refusal, true);`
    - Required by: "Leave `refusedCycles` unchanged for a cargo withhold. For
      example, drop `refusal: true` from that verdict"
    - Replaced by: `assertEquals(first.refusal, undefined)`
  - Added the same assertion for the `judgeSyncFailure` block (~L604). Both go
    red with `refusal: true` restored. The existing `escalateRepeatedRefusal`
    never-climbs assertions are kept.
- Ran from `worker/deno`: `deno task test:unit` on the new file plus
  `milestone_cycle_budget_not_counted_4517_test.ts`,
  `milestone_merge_only_4326_test.ts`,
  `milestone_presync_merge_only_4326_test.ts`,
  `milestone_sweep_merge_only_4326_test.ts`,
  `milestone_env_fault_not_charged_test.ts`,
  `milestone_sync_refusal_ladder_4328_test.ts`, `milestone_branch_sync_test.ts`,
  `milestone_sync_streak_test.ts`: 187 passed, 0 failed. `deno fmt --check`,
  `deno lint`, `deno check` on the touched `.ts` files: clean.

<!-- vibe-quality-gate-skipped reason="`./quality.sh` ran past the 500 s foreground limit and was terminated (exit 124); targeted checks above passed. CI runs the full gate." -->
