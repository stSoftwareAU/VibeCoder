## Summary

Claude token ranking no longer compares a five-hour rate with a seven-day rate.
Within the same floor band of tokens that passed the five-hour gate (at or above
the 10% floor, or under it), a token whose probe reported a seven-day window now
ranks ahead of one that did not; the floor band is decided first, so a
gate-passing weekless token above the floor still beats a weekly token under it.
Among gate-passing tokens, those without one are ordered only among themselves,
on the window they reported. Tokens that failed the gate are unchanged: they are
still ordered by soonest five-hour reset, whatever their seven-day telemetry.
This re-applies the policy recorded in #1731, whose fix never reached main.
Closes #4503.

Version bump: no `VERSION` change in this PR; the merged commit records the
final version.

## Spec

### Intent and Rationale

- `rankingView` fell back to `windows[0]` (five-hour) when no seven-day window
  was reported, so its 5h `remaining / hours` rate was compared with weekly
  rates. A weekless token with a fresh five-hour window could win with its week
  nearly spent.
- The fix is a single comparator step plus a `hasSevenDayTelemetry` flag on the
  ranking view, not a new band, so the existing gate/floor semantics from #1685
  stay unchanged.

### Essential Design Decisions

- The band decides first: the five-hour gate and the 10% floor are applied
  before the telemetry tie-break, per #1731. A weekless token that passes the
  gate therefore beats a weekly token that is under the 10% floor or failing the
  gate. This is pinned by tests.
- Weekless is not a gate: if every candidate lacks a seven-day window, one is
  still selected, on the existing rate, reset and discovery-order rules.
- `winningReason` reports `highest-remaining-per-hour` (not a tie) when the
  winner and runner-up have an equal numeric rate on different windows.
- The log format is unchanged. A weekless line's `rate=` is the other window's
  rate; `docs/SETUP.md` now says it is not comparable with a seven-day rate.

### Undiscoverable Facts

- #1731's fix (PR #1739) landed only on a milestone branch whose roll-up PR was
  closed unmerged, so main never had `hasSevenDayTelemetry`.

## Evidence

Backend-only change; no UI files touched.
`deno test --allow-all tests/claude_token_selection_test.ts`: 44 passed, 0
failed. The credential-pool, pool-budget, token-isolation and week-pace suites:
70 passed, 0 failed. `run_worker_test.ts`: 35 passed, 0 failed.

Callers checked: `rankClaudeTokenBudgets` is called from
`lib/claude_credential_pool.ts` (and the standalone selector in the same module
as the ranking); both use the returned order and read no new field, so they
inherit the policy.

## Test Plan

- `worker/deno/tests/claude_token_selection_test.ts` gains table-driven cases
  `WEEKLY_TELEMETRY_CASES` (weekly beats weekless with a larger 5h rate; the
  issue's 95%-vs-90% scenario; two weekly tokens rank by rate; all weekless;
  mixed four-credential pool; gate boundaries in both directions; two gate
  failures staying ordered by soonest five-hour reset whatever their telemetry;
  sub-floor weekly vs gate-passing weekless; unknown last), plus tests for
  deterministic ties, a later snapshot restoring weekly ranking,
  `hasSevenDayTelemetry` flags, and the reason for an equal rate on different
  windows.
- Red checks, all in `worker/deno/tests/claude_token_selection_test.ts` (44
  tests at head): removing the comparator clause turned 6 tests red; removing
  the `winningReason` clause turned
  `weekly beats weekless with an equal rate on a different window, reason is not a tie (Issue #4503)`
  red; moving the telemetry step above the band-2 (gate failure) return turned
  `gate failures stay ordered by soonest five-hour reset, whatever their seven-day telemetry (Issue #4503)`
  red. Each was restored.
- Removed from `worker/deno/tests/claude_token_selection_test.ts`:
  `known("provider-3", 0.44, NOW + 4 * HOUR, "five_hour")` in the test "ranking
  returns the token with the most remaining budget per hour of its own window
  (Issue #1623)"
  - Replaced by: `known("provider-3", 0.44, NOW + 4 * HOUR, "seven_day")`. The
    order, winner and reason assertions are unchanged, so the test still checks
    that rate per hour decides between weekly tokens.
  - Required by: "A token whose probe carried no seven-day header is therefore
    ranked on its five-hour window against other tokens' weekly windows."
- Edited in the decision-log test
  (`the decision log names every candidate then the winner and its reason (Issue #1623)`):
  the first two candidate lines swap order and the `selected` line now names
  `provider (#1)`. Text of each line is unchanged. Required by: "The
  decision-log test in `claude_token_selection_test.ts` pins this: a
  five-hour-only 75% beats a seven-day 25%." Red check: that test failed with
  the comparator clause removed.
- Docs: `docs/SETUP.md` rule 3, rule 4, the `rate=` field paragraph and the
  `highest-remaining-per-hour` and `low-seven-day-remaining-highest-rate` reason
  rows. Related siblings read: `docs/PROVIDER-PARITY.md` line 39 (still true)
  and the week-pace paragraph in SETUP.md (about the pace gate, not ranking).
- `./quality.sh` on the final head: Result: PASSED (with skipped checks);
  checkov was skipped by the gate.
