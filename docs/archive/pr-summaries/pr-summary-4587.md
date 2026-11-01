## Summary

The milestone resolver recovery ladder (Issue #4328) read
`SyncStreakEntry.count`, the count of every failed sync cycle, as the number of
prior resolver declines. Outages, non-conflict git failures, ruleset push
rejections and cargo-budget withholds all advance `count` and never climb, so
the first real decline after such a streak jumped straight to the roll-back,
rebuild or close rung. A new ledger field, `resolverDeclines`, now counts only
verdicts that climb the ladder (`climbsRecoveryLadder`), and both readers use
it: the sweep's `priorRefusals` and `resolverRungDue`. Closes #4587.

## Spec

### Intent and Rationale

- `count` stays the escalation-streak figure (needs-human threshold). The ladder
  needs its own figure, as the issue suggests; filtering `count` itself would
  break the escalation threshold.

### Essential Design Decisions

- `resolverDeclines` is zeroed by a landed sync and a landed rebuild (both
  through `resetConflictLedgerOnSuccess`). The moved-default-tip re-arm and a
  landed roll-back also call that reset but carry the field over, because
  `count` survived both before this change and the ladder's later rungs depend
  on the streak surviving.
- A ledger written before this change has no `resolverDeclines` and reads it as
  0, so an in-flight decline streak restarts at the resolve rung. This errs
  towards giving the resolver its budget again, never towards an early close.
- Six existing seeds in `tests/milestone_branch_sync_test.ts` moved from
  `count: N` to `resolverDeclines: N` (with `count: 0`): `ladder`,
  `ladder-in-cycle`, the long-refused retirement, retirement issue cleanup,
  merge-gate close, and rebuild-without-function close. Assertions are unchanged.

### Undiscoverable Facts

- Merge-fallback #4521 ("the conflict resolver declined", one agent run listed)
  fits the old path; not verified against the live ledger.

## Evidence

Backend ledger change. Run from `worker/deno`:

- `deno task test:unit tests/milestone_cycle_budget_not_counted_4517_test.ts tests/milestone_sync_refusal_ladder_4328_test.ts tests/milestone_branch_sync_test.ts tests/milestone_sync_streak_test.ts tests/milestone_sync_pr_budget_test.ts tests/milestone_sync_conflict_analysis_escalation_test.ts`
  — 171 passed, 0 failed.
- `deno fmt --check`, `deno lint`, `deno check` on the four touched TS files —
  clean.
- Docs updated: `docs/INTERNALS.md` (deferral paragraph, ledger field list and
  reset rules),
  `docs/workflows/milestones.md` (agent-rung paragraph), `docs/MERGE.md`
  (not-charged row). Grepped `README.md` and `docs/` (excluding archive) for
  "prior declines" and "recovery ladder"; no other hit reads `count` as
  declines. Grepped sibling fields `conflictAttempts`, `refusedCycles`,
  `rollbackFailures` and `rebuilds`: ledger and reset descriptions appear in
  INTERNALS, with operational descriptions in milestones and MERGE; no other
  ledger field list needed the new member.

## Test Plan

New tests in
`worker/deno/tests/milestone_cycle_budget_not_counted_4517_test.ts`:

- Sweep test: streaks of 3, 6 and 9 non-climbing failures (non-conflict git
  failure, provider-unavailable disruption), then one decline, end as attempt 1
  of 3 with no roll-back, rebuild or close. Red before the fix:
  `lastAttempt.reason` was `recovery rung: rollback`, expected
  `the conflict resolver declined`. Positive control: `count` equals the streak
  length.
- Charged non-climbing conflict and ceiling gate-refusal verdicts leave
  `resolverDeclines` at zero; after a budget re-arm for the latter, one genuine
  decline increments it to one without another hand-off. The focused file
  passes all 14 tests; removing the guard makes this new test fail.
- Three consecutive declines still climb, and `resolverRungDue` returns `null`
  for `{count: 9, resolverDeclines: 0}` and `"rollback"` for three declines. Red
  before the fix (got `"close"`).
- Persistence: an old-shape ledger (no `resolverDeclines`) loads as undefined; a
  saved value round-trips; `resetConflictLedgerOnSuccess` drops it. Red before
  the fix.
- Re-arm test: a moved default tip keeps `resolverDeclines`. Red without the
  carry (`-1 +4` at test line 775).
- Landed roll-back test: keeps `resolverDeclines`, zeroes `conflictAttempts`.
  Red without the carry.
- Callers of the changed ladder reader checked: the sweep's post-conclusion
  rung, `resolverRungDue` (used by the re-arm guard and the in-cycle hand-off),
  and `milestone_presync.ts`, which never advanced `count` and does not read the
  new field.
- Edited existing tests: only the six seeds above; no assertion removed.
- `./quality.sh`: completeness, formatting, lint, type check and markdownlint
  passed; the parallel Deno suite panicked in its runtime with `pledge test
  permissions called before restoring previous pledge`. Semgrep and Checkov
  were unavailable locally. Per-operand flips were not run beyond the red
  checks above.

<!-- vibe-quality-gate-skipped reason="local Deno parallel test runner panicked on permission pledge; targeted tests pass; CI runs the full gate" -->
