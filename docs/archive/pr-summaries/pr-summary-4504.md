## Summary

Closes #4504.

Claude subscription selection now prefers the largest remaining seven-day share
rather than remaining share per hour. The five-hour gate stays: passing
credentials precede failures, and failures use the soonest five-hour reset.
Among usable passing credentials, weekly telemetry precedes the existing
non-weekly fallback; equal shares use reset time, then discovery order. Elapsed
windows count as full and unknown budgets remain last.

Claude's per-hour score and 10% low-share band are removed. A zero weekly share
with a future reset remains a separate exhaustion check: it ranks behind other
five-hour-passing credentials, ahead of five-hour failures. Spent weeks use the
soonest weekly reset. The credential pool refuses a spent week for a mid-run
eligible selection, and the restart check refuses it too.

The shared quota policy ranks Claude by remaining share. Codex retains its
remaining-per-hour score and 10% floor. The weekly pool capacity projection
draws the largest shares first, levelling equal shares together and refilling
credentials at their reset boundaries. Its burn-rate calculation and backlog
gate stay unchanged. Ranking reasons, logs and operator documentation describe
the new ordering.

The mutation follow-up adds six tests, removes three unreachable fallbacks, and
documents five behaviourally equivalent mutations below. No version file changes
are included.

## Spec

### Intent and Rationale

- Issue #4504 records a retrospective specification for PR #4502. Its owner
  conversation is unavailable; this summary does not independently verify it.
- Prefer the largest weekly share even when a smaller share resets sooner, while
  preserving the existing five-hour refusal and weekless fallback.

### Essential Design Decisions

- The twinned ranking rules are `claude_token_selection.ts` and
  `provider_quota.ts`'s `CLAUDE_QUOTA_POLICY`. Both compare remaining shares;
  Codex keeps the default per-hour policy and its floor.
- The pace projection uses the shared Claude policy to order shares at each draw
  interval, then draws tied shares together.
- Remove unreachable alternatives rather than inject impossible probe results or
  expose private comparators solely to make equivalent mutants fail.

### Undiscoverable Facts

- The requested summary was absent from this checkout. The historical version at
  `a4f71841` was read, then this file was rewritten against the current
  `origin/main` diff; its different spent-week/gate ordering was not copied.

## Evidence

- Operator sections read: `docs/SETUP.md`, "Several Claude tokens", and
  `docs/workflows/issue-processing.md`, the pool-wide weekly pace calculation.
  The branch updates those sections plus `docs/CONTAINER.md` and
  `docs/PROVIDER-PARITY.md`. In `docs/SETUP.md` the ranking rules (2-4), the
  decision-log examples and field description (`remaining=`, `week=spent`), the
  reason table and the "windows are not synchronised" paragraph describe the
  largest-share rule; the `container_restart_backoff.ts` doc comment names it
  too (PR #4520 review).
- PR #4520 review: the three Issue #4503 tests (repeat-call determinism,
  later-snapshot telemetry, per-shape `hasSevenDayTelemetry` flags) and the
  table loop's winner assertion are restored, with the later-snapshot test's
  expected order and reason adapted to the share rule. The first ranking test
  has provider-3 on a `seven_day` window again, so 81% against 44% between two
  weekly tokens decides it; the old per-hour rule would have picked provider-3
  (11%/h against 0.68%/h).
- Real-code tests cover Claude ranking, selection, probing, restart decisions,
  pool pace projection and the shared Claude/Codex quota policies.
- Mutation red checks ran with `deno test --no-check --allow-all` so a deleted
  required property had to fail a runtime assertion rather than type-checking.
  Each mutation was applied alone and restored before the next run.

## Test Plan

- Five changed test files, each re-run on the head:
  `claude_token_selection_test.ts` (51 tests at head),
  `claude_pool_budget_test.ts` (12 tests at head),
  `claude_credential_pool_test.ts` (33 tests at head),
  `claude_week_pace_pool_test.ts` (22 tests at head) and
  `provider_quota_test.ts` (12 tests at head), all under `worker/deno/tests/`:
  130 passed, 0 failed.
- Two unchanged regression suites also re-run on the head:
  `claude_token_budget_test.ts` (27 tests at head) and
  `claude_week_pace_test.ts` (20 tests at head): 47 passed, 0 failed.
- `deno task check:manifests`: passed (846 passed, 0 failed, 1 ignored).
- `deno lint` and `deno fmt --check` on the five changed TypeScript files:
  passed. `git diff --check`: passed.
- Full quality and capped mutation gates are left to the worker's rerun. The
  earlier 13 candidates past the mutation cap were not tested in this follow-up
  and are not claimed as passed.

### Required item 1: mutation red checks

Locations below use the notice's original line numbers. All test names are in
`worker/deno/tests/claude_token_selection_test.ts` unless stated otherwise.

| Mutation                                                                | Test that failed with only that mutation applied                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `claude_pool_budget.ts:152`, remove the absent-week guard               | `claude_pool_budget_test.ts::poolHasAnotherTokenWithBudget - an absent weekly reading does not exhaust a usable five-hour window` |
| `claude_pool_budget.ts:152`, remove the zero-share condition            | `claude_pool_budget_test.ts::poolHasAnotherTokenWithBudget - a positive weekly share before reset is worth restarting for`        |
| `claude_token_selection.ts:301`, delete unknown `rankWindow`            | `ranking returns an unknown reading without inventing a rank window or weekly exhaustion`                                         |
| `claude_token_selection.ts:303`, set unknown `sevenDaySpent` true       | `ranking returns an unknown reading without inventing a rank window or weekly exhaustion`                                         |
| `claude_token_selection.ts:303`, delete unknown `sevenDaySpent`         | `ranking returns an unknown reading without inventing a rank window or weekly exhaustion`                                         |
| `claude_token_selection.ts:370`, negate the spent-week reset comparison | `ranking orders spent weeks by reset, then discovery order`                                                                       |
| `claude_token_selection.ts:405`, remove runner-up band comparison       | `ranking distinguishes equal shares across gate bands in the selection reason`                                                    |
| `claude_token_selection.ts:406`, remove runner-up telemetry comparison  | `ranking distinguishes equal shares across telemetry types in the selection reason`                                               |

These tests pin existing supported behaviour; production behaviour was already
correct. The two reason tests also assert the selected log line.

### Required item 1: unreachable alternatives removed

- `worker/deno/lib/claude_credential_pool.ts:379`: removed `winner === null`.
  `selectEligible` ranks only after requiring at least two pool candidates;
  ranking preserves every candidate, including unknown readings.
- `worker/deno/lib/claude_pool_budget.ts:145`: removed the empty-window ternary.
  This path receives only `probeClaudeTokenBudget` results. A known probe
  requires a parsed headline window and therefore a non-empty window array; a
  response without windows is unknown. The restart/probe suites pass.
- `worker/deno/lib/claude_token_selection.ts:334`: removed the unreachable
  `false` default and the corresponding null alternatives for known windows.
  `reportedWindows` supplies the headline when the array is empty. The existing
  headline-fallback and elapsed-window tests pass.

### Required item 1: equivalent mutations

Each mutation below was applied alone with runtime checking and restored. The
ranking suite stayed green for the comparator mutation (51 tests, re-run at
head), and the pool pace suite stayed green for each mapping mutation (22
tests). The reasons explain why no supported input can distinguish them.

- `worker/deno/lib/claude_token_selection.ts:371` — exempt (untestable):
  equal-reset spent weeks enter the stable sort in discovery order; returning
  undefined compares them as equal and preserves exactly the same order as the
  index subtraction.
- `worker/deno/lib/claude_week_pace.ts:450` — exempt (untestable): providerId is
  ranker metadata; this private pace calculation consumes only ranked indices
  and remaining shares, never the returned provider identity.
- `worker/deno/lib/claude_week_pace.ts:451` — exempt (untestable):
  credentialLabel is ranker metadata; this private pace calculation consumes
  indices and shares and never emits or reads the returned label.
- `worker/deno/lib/claude_week_pace.ts:455` — exempt (untestable): the mapping
  supplies exactly one window, which the ranker selects through its first-window
  fallback even without its name; the remaining-share policy does not consume
  nominal hours.
- `worker/deno/lib/claude_week_pace.ts:457` — exempt (untestable): every mapped
  reset is future or infinity; removing it cannot change elapsed shares, and
  reset tie order cannot affect a draw that levels every equal-share credential
  together.
