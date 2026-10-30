## Summary

Closes #4504.

Owner decision 2026-10-29, recorded as a reviewable specification in Issue
#4504: pick the Claude subscription token with the **most weekly (seven-day)
quota left**. This replaces Issue #1623's "use it or lose it" rule, which ranked
on seven-day remaining share divided by hours until reset.

Version bump: no `VERSION` change in this PR; the merged commit records the
final version.

New ranking (`rankClaudeTokenBudgets` in
`worker/deno/lib/claude_token_selection.ts`):

- **Five-hour gate kept.** A token that has used 80%+ of its five-hour window
  cannot run and ranks behind every token that can.
- **A spent week is demoted like a gate failure (PR #4502 review).**
  `RankedClaudeToken.sevenDaySpent` is true when the seven-day window is at 0%
  with its reset still ahead (a window whose reset has passed counts as full,
  and an unknown budget is never marked spent). Such a token joins band 1 with
  the gate failures, so it ranks behind every token that can run, however full
  its five hours are and whatever telemetry the others reported. This is an
  exhaustion check, not the removed 10% band. Band 1 is ordered by when each
  token can spend again (`refillAt`): the five-hour reset for a gate failure,
  the seven-day reset for a spent week, the later of the two when both apply.
- **`selectEligible` refuses a spent week.** `claude_credential_pool.ts` returns
  `null` when the winner fails the gate **or** has `sevenDaySpent`, so a mid-run
  switch never lands on a token that would hit its weekly limit at once.
  `selectToken` (a start) still never refuses.
- **New reason `seven-day-spent-soonest-reset`.** Used when no candidate can run
  and the winner passed the five-hour gate but has its week spent.
  `five-hour-gate-failed-soonest-reset` is kept for a winner that failed the
  gate. The candidate log line gains a trailing `week=spent` field for a spent
  week.
- **Seven-day telemetry first (#4503, merged from main).** Among tokens that can
  run, one that reported a seven-day window ranks ahead of one that did not,
  because a share of a five-hour window is not comparable with a seven-day
  share. Weekless tokens are ordered only among themselves, on the window they
  reported, and are never dropped. `RankedClaudeToken.hasSevenDayTelemetry`
  carries it.
- **Then the largest seven-day remaining share** (100 − utilisation). A window
  whose `resetAt` has passed counts as 100%. Ties go to the soonest seven-day
  reset, then discovery order.
- **Per-hour rate and 10% low-floor band removed.** A nearly spent week (above
  0%) has no band of its own and **still ranks ahead of every gate-passing
  weekless token**, because the telemetry rule is applied before share; only a
  week with nothing left is demoted. `CLAUDE_SEVEN_DAY_LOW_REMAINING`,
  `ratePerHour`, `hoursUntilReset` and the
  `low-seven-day-remaining-highest-rate` reason are gone, and `rateWindow` is
  renamed `rankWindow`.
- **Unknown budgets** still rank last and are never dropped.
- **Reasons:** `highest-remaining-per-hour` → `most-seven-day-remaining`;
  `equal-remaining-per-hour-soonest-reset` →
  `equal-seven-day-remaining-soonest-reset`. `tied-discovery-order`,
  `five-hour-gate-failed-soonest-reset` and `budget-unknown-discovery-order` are
  kept.
- **Log line:** the candidate line's `rate=X%/h` becomes `remaining=X%`, a spent
  week adds `week=spent`, and the `selected` line drops `rate=`.

`worker/deno/lib/provider_quota.ts` (the shared ranker for Claude and Codex): a
policy declares `rankBy: "remaining" | "remaining-per-hour"` (the default is per
hour). `CLAUDE_QUOTA_POLICY` ranks by `remaining` and has no
`lowRemainingFloor`. New reasons are `most-remaining` and
`equal-remaining-soonest-reset`. **Codex is unchanged**: `CODEX_QUOTA_POLICY`
still ranks by remaining per hour with its 10% floor.

Twinned copies found and changed together: `claude_token_selection.ts` and
`provider_quota.ts`'s `CLAUDE_QUOTA_POLICY`. `provider_quota.ts` does not model
a spent week (it has no seven-day/five-hour split); the credential pool calls
`rankClaudeTokenBudgets`, which does.

**Pool pace walk follows the new spend order.** `claude_week_pace.ts`'s
`walkPoolCapacity` now draws the largest remaining share first, so the top
shares level down together, as they do when every run picks the token with the
most left. Whatever a credential still holds when its week reopens lapses. The
burn-rate calculation and the backlog gate are unchanged.

## Evidence

- Manual section read: `docs/SETUP.md` "Several Claude tokens" (ranking list,
  decision-log example, reason table, "The windows are not synchronised"). Rule
  3 and item 4, the log-field description and the reason table now state that a
  nearly spent week still ranks ahead of gate-passing weekless tokens and that
  only a week at 0% is demoted.
- Docs updated: `docs/SETUP.md`, `docs/CONTAINER.md`, `docs/PROVIDER-PARITY.md`,
  `docs/workflows/issue-processing.md`. Doc comments updated in
  `claude_token_selection.ts`, `provider_quota.ts`, `claude_credential_pool.ts`,
  `claude_pool_budget.ts`, `claude_week_pace.ts` and
  `container_restart_backoff.ts`.
- Provenance: #4504 is the owner-decision issue this PR closes.
- Red-check (pace walk levelling): replacing the levelling with "drain the
  largest credential fully, then the next" fails the new levelling pool test.
- Red-check (spent week): removing `sevenDaySpent` from `band()` fails the
  spent-week ranking tests and the pool `selectEligible` test.
- Red-check (Codex floor): deleting the `lowRemainingFloor` branch in
  `provider_quota.ts`'s `band()` fails both Codex floor tests.

## Test Plan

Final-head runs of `deno test --allow-all` on each file:

- `worker/deno/tests/claude_token_selection_test.ts` (49 tests at head, 49
  passed, 0 failed). Includes the case that tells the rules apart (20% over 6 h
  loses to 90% over 6 days), the #4503 table recomputed under the share rule,
  and the review additions: a weekly token at 0% ranks behind a weekless one
  however full its five hours; a spent week whose reset has passed counts as
  full and is not demoted; spent weeks and gate failures are ordered by when
  each can spend again; when only spent weeks remain the one reopening first
  wins with `seven-day-spent-soonest-reset`; an unknown budget is never marked
  spent; log expectations carry `week=spent`.
- `worker/deno/tests/claude_credential_pool_test.ts` (33 tests at head, 33
  passed, 0 failed): the delegation test expects the 75% token with
  `most-seven-day-remaining`; new: a token at 0% weekly with a full five hours
  is never eligible.
- `worker/deno/tests/claude_week_pace_pool_test.ts` (21 tests at head, 21
  passed, 0 failed): the largest-first test comment is corrected (provider-2 is
  drawn alone and provider's full 30% lapses at 22 h); new "the top shares level
  down together" test, where the draw before the first reopening exceeds the gap
  between the two largest shares (20% used resetting in 143 h beside 60% used
  resetting in 56 h gives `off`; draining the largest first gives `engaged`).
- `worker/deno/tests/provider_quota_test.ts` (11 tests at head, 11 passed, 0
  failed): the Claude policy picks the 90%/6-day credential with
  `most-remaining`; Codex keeps remaining-per-hour; two Codex tests cover its
  floor.
- The five files together with `claude_week_pace_test.ts`: 134 passed, 0 failed.
- The full `./quality.sh` was not run in this round.
