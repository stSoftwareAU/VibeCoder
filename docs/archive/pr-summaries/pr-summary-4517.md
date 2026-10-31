## Summary

A milestone branch refused the agent rung only because too little of the cycle
was left (`agent deferred: cycle budget`) was counted as a refusal. After
`MILESTONE_REFUSAL_CEILING` (3) such cycles the next one was charged `failed`
and climbed to the roll-back, which files the `merge-fallback` issue "agent
deferred" (#4517) and closes the milestone. No agent ever looked at the
conflict, and a roll-back frees no cycle budget. `judgeSyncFailure` now returns
the deferral as `not-charged` without the `refusal` flag, so it is never added
to `refusedCycles` and never reaches the ceiling; the branch waits for a cycle
with the runway. A merge-gate refusal of the resolution is still a counted
refusal and still climbs at the ceiling. Closes #4517.

Version bump: `VERSION` is not edited by this change; the merged commit records
the final version.

```mermaid
flowchart LR
    C["conflict, agent rung refused: too little cycle left"] --> D["not-charged, NOT counted (#4517)"]
    D --> W["retried next cycle; never rolls back"]
    G["merge gate refused the resolution"] --> N{"refused 3 cycles already?"}
    N -- no --> K["not-charged, counted"]
    N -- yes --> X["charged, climbs to roll-back (#4328)"]
```

## Spec

### Intent and Rationale

- Same reasoning as #4451 (cargo withhold never climbs): the fault is the
  cycle's runway, not the branch, and rolling back frees no runway.
- Dropping the `refusal` flag (rather than special-casing the reason in
  `escalateRepeatedRefusal`) also keeps deferrals out of `refusedCycles`, so
  deferrals cannot pre-load the ceiling for a later gate refusal.

### Essential Design Decisions

- This reverses the part of #4328 that counted `agent deferred: cycle budget`
  towards the ceiling. Accepted trade-off: a branch whose cycles never reach the
  24-minute floor (`DEFAULT_MIN_MS_PER_CONFLICT_ATTEMPT` plus overhead) stays
  behind, visible in the per-cycle log line, rather than being rolled back for
  it. No lowered "starvation" floor was added; that would be new behaviour
  beyond the issue.
- The presync twin (`milestone_presync.ts`) needs no code change: it calls the
  same `judgeSyncFailure` and `escalateRepeatedRefusal`.

### Undiscoverable Facts

- The issue's runs ran on hosts whose logs are not in the repo; the cause of the
  short runway on those hosts was not observed. The fix removes the roll-back
  consequence, not the short runway itself.

## Evidence

Backend only; no UI files touched. Code:
`worker/deno/lib/milestone_branch_sync.ts` (`judgeSyncFailure`,
`AGENT_DEFERRED_CYCLE_BUDGET`, `escalateRepeatedRefusal`),
`worker/deno/lib/milestone_sync_streak.ts` (`concludeConflictAttempt` counts
only `refusal === true`). Docs updated: `docs/INTERNALS.md`,
`docs/workflows/milestones.md`, `docs/MERGE.md`. Issue number cited as
provenance: #4328 (refusal ceiling), #4451 (environment faults not climbing),
#4326 (cargo withhold), #2309 (cycle-budget deferral) — all looked up in the
existing code and docs.

## Reproduction

- **symptom** — `merge-fallback` "agent deferred":
  `refused 4 cycles in a row (agent deferred: cycle budget) — climbing to the next rung`
- **status** — `verified` — the first three new tests went red with
  `refusal: true` restored in `judgeSyncFailure` and pass with the fix; the
  fourth (PR #4581 review) is red on its own change, see the Test Plan
- **regression test** —
  `worker/deno/tests/milestone_cycle_budget_not_counted_4517_test.ts`

## Test Plan

- New `worker/deno/tests/milestone_cycle_budget_not_counted_4517_test.ts`, four
  tests for the original change: sweep with ceiling+3 deferrals (no roll-back,
  `refusedCycles` 0,
  `conflictAttempts` 0, sync really ran each cycle); presync twin likewise;
  mixed deferrals and gate refusals (deferrals do not advance the streak; the
  gate refusal still climbs on the fourth).
- PR #4581 review: short-cycle operator logs distinguish an uncounted agent
  deferral from a counted merge-gate refusal. A fifth test captures both logs
  and checks that the gate refusal advances `refusedCycles`.
- Red check: restoring `refusal: true` in the `!agentAllowed` verdict fails the
  first three (cycle 4 rolled back / deferral 1 counted / streak advanced).
- PR #4581 review: a deferral cycle still added one to `SyncStreakEntry.count`,
  which the resolver ladder reads as prior declines (`resolverRungDue`,
  `priorRefusals = entry.count - 1`). The sweep now skips `recordSyncFailure`
  when the verdict is `AGENT_DEFERRED_CYCLE_BUDGET`. A fourth test runs 3, 6 and
  9 deferrals then one agent decline and asserts `count` 0 after the deferrals,
  then attempt 1 of 3 with no roll-back, rebuild or close. Red check: restoring
  the unconditional `recordSyncFailure` fails it (`count` 3, then
  `recovery rung: rollback` with the count assertion loosened). The general
  outage-streak case is #4587, outside this PR.
- Edited `worker/deno/tests/milestone_sync_refusal_ladder_4328_test.ts`: tests
  that used the agent-deferred error as the counted, climbing refusal now use
  the gate-refused resolution (`gateRefusedError()`), with every assertion kept
  (only the expected reason text `(agent deferred` became
  `(the merge gate refused the resolution`); the agent-deferred conclusion test
  now asserts `refusal === undefined` for the deferral. The two-kind loop became
  the gate kind only. Removed from
  `worker/deno/tests/milestone_sync_refusal_ladder_4328_test.ts`: the agent-kind
  run of the climbing test. Required by: "refused 4 cycles in a row (agent
  deferred: cycle budget) — climbing to the next rung" (the behaviour the issue
  reports as a worker failure); the climb is still covered by the gate kind, and
  the deferral's no-climb by the new file.
- Edited `worker/deno/tests/milestone_merge_only_4326_test.ts:223`:
  `conclusion.refusal` for an agent-deferred conclusion is now `undefined` (was
  `true`); red check: with `refusal: true` restored it fails.
- `worker/deno/lib/milestone_branch_sync.ts:3161` exempt (untestable): the
  `{ count: 0, escalated: false }` fallback is unreachable. Line 3161 sits
  inside `if (streakPath)`, and the same block has already stored an entry for
  the key at line 2619 (`?? { count: 0, escalated: false }`) and line 2760
  (`openConflictAttempt`) before the sync runs, so `streaks[streakKey]` is never
  undefined there; flipping `false` to `true` was run and no test can go red.
  Not removed here because this round changes tests and docs only.
- Passed at the head: `deno task test:unit` over the new 4517 file, the 4328
  ladder, 4326 merge-only, `milestone_branch_sync` and `milestone_presync` tests
  (161 passed, 0 failed). `deno fmt`, `deno lint`, `deno check` on the edited
  files: clean. Full `./quality.sh` passed through markdownlint, semgrep and the
  release-tag ruleset checks, then timed out at 580 s in the unit-test stage.
- Push after the `validate-scripts / validate` failure (Summary freshness,
  #3768): the remote head held a worker "Fix PR #4581 quality issues" commit
  (`3a4f9000`) that solved the ladder-count problem a second way (a separate
  `resolverFailures` field) while this branch had already solved it by not
  recording a deferral in `count`. The two were merged keeping this branch's
  approach, so `milestone_branch_sync.ts`, `milestone_sync_streak.ts` and the
  4517 test file are identical to the tree this summary already describes (no
  `resolverFailures` field exists). Re-run:
  `deno task test:unit tests/milestone_cycle_budget_not_counted_4517_test.ts`
  (4 passed, 0 failed) and `deno task pr-summary-ci` (Summary freshness passes
  once this summary is the newest change).
- `deno fmt --check` fails on `docs/INTERNALS.md` and
  `docs/workflows/milestones.md` at HEAD for unrelated paragraphs; they were not
  reflowed.

<!-- vibe-quality-gate-skipped reason="the full ./quality.sh did not finish inside the 600s foreground cap (timed out in the unit-test stage after the lint, semgrep and markdownlint stages passed); targeted tests ran, CI runs the full gate" -->
