## Summary

Corrected the stale module header to describe cargo-budget withholds as
uncharged, uncounted refusals that do not climb the recovery ladder. Closes
#4702.

Version bump: no version files changed for this documentation-only correction.

## Spec

### Intent and Rationale

- The header contradicted the test and current cargo-budget behaviour; it now
  states the contract introduced by Issue #4588.

### Essential Design Decisions

- No executable code or assertions changed.

### Undiscoverable Facts

- `gh issue view 4588` confirmed Issue #4588 is closed and concerns cargo
  withholds advancing `refusedCycles`.

## Evidence

- `judgeSyncFailure` returns cargo-budget withholds as `not-charged` without a
  refusal flag; `escalateRepeatedRefusal` returns those verdicts unchanged.
- The `SyncStreakEntry.refusedCycles` doc comment says cargo-budget withholds
  do not count. `docs/INTERNALS.md` and `docs/CONTAINER.md` state that a withhold
  is never charged and never climbs the recovery ladder.

## Test Plan

- `worker/deno/tests/milestone_merge_only_4326_test.ts` and
  `worker/deno/tests/milestone_cargo_withhold_not_counted_4588_test.ts` —
  `deno task test:unit tests/milestone_merge_only_4326_test.ts tests/milestone_cargo_withhold_not_counted_4588_test.ts`
  passed (23 tests).
- `deno fmt --check worker/deno/tests/milestone_merge_only_4326_test.ts` passed.
- `timeout 900 ./quality.sh < /dev/null` failed its Deno unit-test time budget:
  unchanged `tests/launcher_harness_reclaim_stub_test.ts` exceeded the 1-second
  budget (2 tests, 3.23 seconds total). Lint, type check, formatting, and the
  other reported checks passed. Config integration and Checkov were skipped by
  the gate because their required configuration/tooling was unavailable.
