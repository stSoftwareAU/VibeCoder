## Summary

After the run's one-hour target nothing new starts: no ladder handler, slot claim, idle task, milestone-sync attempt or merge-conflict drain item. Work already running is not interrupted. Closes #4243.

- `run_timeline.ts`: new `pastRunTarget(now)`, which reads the process-wide timeline and is `false` when none is set (nothing refuses).
- `run_core.ts`: the Priority ladder checks `timeline.pastTarget(deps.now())` before each dispatch and, past it, logs one `stop reason=deadline — <handler> and any after it defer to the next cycle.` line and stops. The issue scan's deadline gate now applies on the first pass too, because the ladder can cross the target between the outer loop's check and the scan. The idle-task filer is refused past the target (one `reason=past_run_target` line, no permit spent, no hooks run) on both the outer-cycle and slot paths.
- `merge_conflict_drain.ts`: the drain starts no further resolution past the target, with one line, reported as a `deadline` stop so the deferral tracking treats it like a deadline.
- `milestone_branch_sync.ts`: no further repository or milestone is started past the target, with one line; the sync cursor still resumes there next cycle, and the #2215 "pass incomplete" line is not repeated for a target stop.
- `pr_auto_merge.ts`: when `deferSyncPastRunTarget` is set, the in-cycle milestone sync is deferred past the target (one line) and the PR is still armed. Only the Priority 1.65 sweep sets it (`run_core_production_deps.ts`); an issue run completing an already-claimed PR (`completion_phase.ts`) does not, so it still syncs. `EnableAutoMergeOptions` gained the flag and a `now` clock seam.
- Three existing tests had an injected watchdog clock that ran past the target; they now stop it one millisecond short (or, where the wedged handler is the subject, let only that handler cross it).
- Docs: `docs/CONFIGURATION.md`, `docs/workflows/merge-conflicts.md` and `docs/IDLE-TASK-FRAMEWORK.md`.

Version bump: `VERSION` is not touched by this change.

```mermaid
flowchart LR
    T[run timeline target] --> P[pastRunTarget / pastTarget]
    P --> L[ladder handler]
    P --> S[issue scan first pass]
    P --> I[idle-task filer]
    P --> M[milestone sync repo and milestone]
    P --> A[in-cycle sync in auto-merge]
    P --> D[merge-conflict drain item]
```

## Reproduction

- **symptom** — past the run's one-hour target the ladder, issue scan, idle-task filer, milestone sync and merge-conflict drain still started new work
- **status** — `partial` — each new gate was observed red by disabling it in place (see Branch outcomes: `if (false)`, restoring the old `iteration > 0 &&` skip, deleting the log call); the new tests were not run against a checkout of the base commit, where they cannot compile because `pastRunTarget` does not exist
- **reason** — the fail-before observation was by in-place gate mutation, not against the unfixed commit
- **regression test** — `worker/deno/tests/run_core_after_target_test.ts::run_core after target - a ladder handler reached past the target is never dispatched and one deadline line names it (Issue #4243)`

## Spec

### Intent and Rationale

- The target is a start gate only. Every gate sits between units of work, never inside one, so a handler, claim, sync or resolution already running is left to finish under its own budget.
- Past the target each refusal logs one line that says what was deferred, so an operator can tell a refusal from an empty queue.

### Essential Design Decisions

- The Priority 2 slot pool already refuses past `endTime`, which equals the target for the default run, so it is pinned by the one-slot and two-slot tests rather than changed. The maintenance lane has the same `endTime` check (`cycle deadline reached`, `run_core.ts:3512`); it is unchanged and no test added here pins it.
- The issue scan's first-pass skip was dropped (the ladder can cross the target before the scan). A milestone-sync target stop reuses the #2215 cursor, and the drain's target stop reuses the `deadline` outcome, as the issue asks.
- The gates read the process-wide timeline from #4242 (`pastRunTarget`). `runCoreLoop` never clears it, so a test file that drives `runCoreLoop` and later calls the drain, milestone sync, `enableAutoMerge` or the idle hooks must reset it; the new tests do (`resetRunTimelineForTests` in `finally`).
- `enableAutoMerge`'s sync gate is opt-in (`deferSyncPastRunTarget`), not unconditional: the issue-run completion phase shares that function, and "work already active continues" covers a claim finishing its own PR. Only the sweep and the completion phase pass a sync hook; the other callers have no sync to defer.

### Undiscoverable Facts

- Existing watchdog tests modelled a timer by adding its whole budget to the clock, which now carries the clock past the target and defers every handler after the first agent-backed one; that is why three existing test files changed.

## Evidence

Backend change only; evidence is the tests below.

**Docs sweep** — grep: `too little of the cycle`, `stopped for lack of budget`, `Milestone sync pass incomplete`, `In-cycle milestone sync`, `past_run_target`, `idle_capacity_used`, "Three bounds keep the drain"; section: `docs/CONFIGURATION.md#️-the-cycle-deadline-model`, `docs/workflows/merge-conflicts.md` (drain bounds table and pass-level stops), `docs/MERGE.md` (merge-conflict drain bullets), `docs/IDLE-TASK-FRAMEWORK.md` (filer latch); siblings: `idle_capacity_used` and `week_pace_engaged` (filer refusal reasons), the `cap` and `deadline` stop reasons of the drain; updated: `docs/CONFIGURATION.md`, `docs/workflows/merge-conflicts.md`, `docs/IDLE-TASK-FRAMEWORK.md`; `docs/MERGE.md` carries no change — still true because its drain bullet is about ruleset refusals; `docs/INTERNALS.md` mentions of "too little of the cycle" — still true because they describe the cycle budget, which is unchanged.

## Test Plan

- New: `worker/deno/tests/run_core_after_target_test.ts` (8 tests), `worker/deno/tests/milestone_sync_after_target_test.ts` (7), `worker/deno/tests/milestone_sync_after_target_wiring_test.ts` (1; drives the real `ensureAutoMerge` through `createProductionRunCoreDeps` with the `gh` spawn seam, no `Deno.env` change), `worker/deno/tests/merge_conflict_drain_after_target_test.ts` (5), and two `pastRunTarget` tests in `worker/deno/tests/run_timeline_test.ts`.
- Removed assertions: none. The edits to `worker/deno/tests/agent_run_termination_test.ts`, `worker/deno/tests/handler_watchdog_scope_test.ts` and `worker/deno/tests/run_core_watchdog_test.ts` replace `now += ms;` clock lines (not assertions) with a clock that stops short of the target, add `shutdown?.()` in one `processIssue` stub, and reword comments.
- Gate: `./quality.sh` on the final head (run after the last code edit): every stage passed except `deno tests` (parallel pass 29775 passed, 10 failed, 4 ignored; serial pass not run) and the skipped `config integration` and `checkov` stages. The 10 failures are in the seven files named under the last acceptance criterion; none mentions `run_timeline`, `pastRunTarget`, the drain, the milestone sync or `enableAutoMerge`. With `VIBE_IMAGE_AGENT_PROVIDERS` unset those files run 93 passed, 2 failed (the two `cargo fmt` tests; no Rust toolchain in the sandbox). The new and touched files (`run_core_after_target_test.ts`, `milestone_sync_after_target_test.ts`, `merge_conflict_drain_after_target_test.ts`, `run_timeline_test.ts`, `agent_run_termination_test.ts`, `handler_watchdog_scope_test.ts`, `run_core_watchdog_test.ts`) pass.

**Branch outcomes:**
- `worker/deno/lib/run_core.ts:6892` — ladder gate past the target: defers the handler and the rest with one line — `worker/deno/tests/run_core_after_target_test.ts::run_core after target - a ladder handler reached past the target is never dispatched and one deadline line names it (Issue #4243)` — flipped to `if (false)`, three tests went red
- `worker/deno/lib/run_core.ts:6892` — ladder gate before the target: handler dispatched — `worker/deno/tests/run_core_after_target_test.ts::run_core after target - a crossing mid-ladder lets the running handler finish and dispatches nothing after it (Issue #4243)` — the dispatched-once assertion; flipped past-target gate to `if (false)`, red
- `worker/deno/lib/run_core.ts:2856` — issue scan first pass past the target: no claim — `worker/deno/tests/run_core_after_target_test.ts::run_core after target - with one slot no new claim is taken past the target (Issue #4243)` — restored the old `iteration > 0 &&` skip, test went red
- `worker/deno/lib/run_core.ts:5287` — idle filer before the target: not refused — `worker/deno/tests/run_core_after_target_test.ts::run_core after target - the idle-task filer neither fires nor claims past the target, outer-cycle path (Issue #4243)` — flipped to always refuse (past-target outcome inverted to `return false`), both idle tests red
- `worker/deno/lib/run_core.ts:5288` — idle filer past the target: one `past_run_target` line — `worker/deno/tests/run_core_after_target_test.ts::run_core after target - the idle-task filer neither fires nor claims past the target, slot path (Issue #4243)` — deleted the log call, both idle tests red
- `worker/deno/lib/run_core.ts:4281` — slot idle path refuses past the target — `worker/deno/tests/run_core_after_target_test.ts::run_core after target - the idle-task filer neither fires nor claims past the target, slot path (Issue #4243)` — branch replaced with `false &&`, test went red
- `worker/deno/lib/run_core.ts:7100` — outer-cycle idle path refuses past the target — `worker/deno/tests/run_core_after_target_test.ts::run_core after target - the idle-task filer neither fires nor claims past the target, outer-cycle path (Issue #4243)` — branch replaced with `false`, test went red
- `worker/deno/lib/merge_conflict_drain.ts:431` — drain past the target: stops as a deadline, one line, no resolution — `worker/deno/tests/merge_conflict_drain_after_target_test.ts::merge-conflict drain after target - a clock past the target at drain start starts nothing` — flipped to `if (false)`, three tests went red
- `worker/deno/lib/merge_conflict_drain.ts:442` — no cycle deadline set: remaining time reported as 0 — `worker/deno/tests/merge_conflict_drain_after_target_test.ts::merge-conflict drain after target - a clock past the target at drain start starts nothing` — flipped `: 0` to `: 12345`; it stayed green, so the pass-summary assertion on `remainingMs` was added, and it then went red
- `worker/deno/lib/merge_conflict_drain.ts:431` — drain before the target and with no timeline: unchanged — `worker/deno/tests/merge_conflict_drain_after_target_test.ts::merge-conflict drain after target - before the target both PRs are resolved (control)` and `…with no timeline set the drain is unchanged (control)` — flipped the gate to `if (true)`, controls would resolve nothing; covered by the same gate flip going red on the in-flight test
- `worker/deno/lib/milestone_branch_sync.ts:1571` — repository gate past the target: no repository started, cursor saved at it — `worker/deno/tests/milestone_sync_after_target_test.ts::syncMilestoneBranches - past the run target no repository is started: no sync, no API call, one line, and the cursor resumes at the first repository (Issue #4243)` — flipped to `if (false)`, red
- `worker/deno/lib/milestone_branch_sync.ts:1669` — milestone gate mid-pass: in-flight sync finishes, next not started — `worker/deno/tests/milestone_sync_after_target_test.ts::syncMilestoneBranches - a sync already under way finishes when the target passes mid-pass, and the next milestone is not started (Issue #4243)` — flipped to `if (false)`, red
- `worker/deno/lib/milestone_branch_sync.ts:2577` — a target stop skips the #2215 line; a budget stop keeps it — `worker/deno/tests/milestone_sync_after_target_test.ts::syncMilestoneBranches - a budget stop with a cursor still logs the pass-incomplete line, and no target line (Issue #4243 control, Issue #2215)` — flipped `!stoppedForTarget` to `true`, the target-stop tests went red
- `worker/deno/lib/pr_auto_merge.ts:886` — operand `pastRunTarget(...)`: in-cycle sync past the target with the flag set: hook not called, one line, PR still armed — `worker/deno/tests/milestone_sync_after_target_test.ts::enableAutoMerge - past the run target the sweep's in-cycle sync is not called when deferred, one line is logged, and the child is still armed (Issue #4243)` — replaced the operand with `false`, red
- `worker/deno/lib/pr_auto_merge.ts:886` — operand `pastRunTarget(...)`: before the target the hook is called once, no target line — `worker/deno/tests/milestone_sync_after_target_test.ts::enableAutoMerge - before the run target the in-cycle sync is called once and no target line is logged (Issue #4243 control)` — replaced the operand with `true` (flag set), red
- `worker/deno/lib/pr_auto_merge.ts:885` — operand `deferSyncPastRunTarget === true`: without the flag (issue-run completion) the hook is still called past the target — `worker/deno/tests/milestone_sync_after_target_test.ts::enableAutoMerge - past the run target without the defer flag (the issue-run completion case) the in-cycle sync is still called once and no target line is logged (Issue #4243)` — removed the operand, red
- `worker/deno/lib/run_core_production_deps.ts:3602` — the sweep passes `deferSyncPastRunTarget: true` — `worker/deno/tests/milestone_sync_after_target_wiring_test.ts::Issue #4243: production sweep defers its in-cycle milestone sync past the run target` — removed the line, red
- `worker/deno/lib/run_timeline.ts:218` — no timeline set: nothing is past the target — `worker/deno/tests/run_timeline_test.ts::pastRunTarget - with no timeline set, nothing has passed the target for any clock reading` — flipped `?? false` to `?? true`, red
- `worker/deno/lib/run_timeline.ts:218` — timeline set: true at and after the target, false before — `worker/deno/tests/run_timeline_test.ts::pastRunTarget - false just before the target, true at it and just after` — flipped the expression to `return false`, red

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — With an injected clock past the target, each of these is tested separately and none starts: a ladder handler; a slot claim; an idle task; a milestone-sync attempt; a merge-conflict drain item. — evidence: `worker/deno/tests/run_core_after_target_test.ts` (ladder handler; one-slot and two-slot claim; idle filer on the outer-cycle and slot paths), `worker/deno/tests/milestone_sync_after_target_test.ts` (milestone branch sync and the Auto-Merge in-cycle sync), `worker/deno/tests/milestone_sync_after_target_wiring_test.ts` (the sweep passes the flag), `worker/deno/tests/merge_conflict_drain_after_target_test.ts` (drain item) — reviewer: met
- **met** — An iteration that starts before the target and crosses it mid-ladder dispatches no further handler (injected-clock test). — evidence: `worker/deno/tests/run_core_after_target_test.ts::run_core after target - a crossing mid-ladder lets the running handler finish and dispatches nothing after it (Issue #4243)` — reviewer: met
- **met** — A handler or claim already running when the target passes is not interrupted (injected-clock test). — evidence: `worker/deno/tests/run_core_after_target_test.ts::run_core after target - a handler already running when the target passes is not interrupted (Issue #4243)`, the claim variant in the same file, and the in-flight cases in `worker/deno/tests/merge_conflict_drain_after_target_test.ts` and `worker/deno/tests/milestone_sync_after_target_test.ts` — reviewer: met
- **met** — Each refusal logs exactly one line naming what was deferred. — evidence: `worker/deno/tests/run_core_after_target_test.ts::run_core after target - with two slots no new claim is taken and each slot stops once (Issue #4243)`, the one-line assertions in `worker/deno/tests/merge_conflict_drain_after_target_test.ts` (including the case with deferral tracking) and `worker/deno/tests/milestone_sync_after_target_test.ts` (counting the #2215 line too, with a cursor set) — reviewer: partial — reason: the first spec review found the milestone sync logged a second line (`Milestone sync pass incomplete`) with a cursor set and that the slot-path idle assertion was `>= 1`; both were fixed in this diff and are now pinned by tests that count the lines, so the departure from the reviewer's verdict is recorded here
- **met** — Tests and `./quality.sh` pass. — evidence: the new and touched test files pass; `./quality.sh` on the final head passes every stage except `deno tests`, whose 10 failures are the same 10 that fail on the base branch (provider and Rust-toolchain tests the sandbox cannot run), and the skipped `config integration` and `checkov` stages — reviewer: partial — reason: CI not yet verified — remaining: merge-verification-only

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Changing what a shared helper refuses changes every caller: the run-target gate in `enableAutoMerge` also stopped the issue-run completion phase's in-cycle sync for an already-claimed PR — evidence: `worker/deno/lib/pr_auto_merge.ts:885` — reason: fixed in this diff (opt-in `deferSyncPastRunTarget`, set only by the sweep at `worker/deno/lib/run_core_production_deps.ts:3602`; tests for the flag on, off and the sweep wiring)
- **violation** — A test named for one step must reach that step: the slot-path idle-filer assertion was `refusals >= 1` and the outer-cycle observer logs the same line — evidence: `worker/deno/tests/run_core_after_target_test.ts` — reason: fixed in this diff (asserts a slot-prefixed refusal line; breaking only the slot call site turns it red)
- **violation** — Doc comments made stale: the `run_timeline.ts` module doc said nothing reads the target, and the milestone sync cursor text said the cursor only records a budget stop — evidence: `worker/deno/lib/run_timeline.ts:5` — reason: fixed in this diff (`worker/deno/lib/run_timeline.ts`, `worker/deno/lib/milestone_branch_sync.ts`, `worker/deno/lib/milestone_sync_streak.ts` reworded)
- **violation** — A docs claim not true for every case: the idle filer logs one line for each refused observation, not one line — evidence: `docs/CONFIGURATION.md:2679` — reason: fixed in this diff (reworded to one line for each refused observation)
- **violation** — A test named "past the cycle deadline" whose fixture now keeps the clock one millisecond short — evidence: `worker/deno/tests/agent_run_termination_test.ts:622` — reason: fixed in this diff (renamed "at the cycle deadline"; every assertion unchanged)
- **violation** — Unit tests must not mutate process-wide state: the gates read the process-wide run timeline and the new tests set it — evidence: `worker/deno/tests/merge_conflict_drain_after_target_test.ts:102` — reason: fixed in this diff (this is the accessor the issue and #4242 specify; every new test resets it in `finally`, no test mutates `Deno.env` or the working directory, and the wiring test uses the `gh` spawn seam instead of a `PATH` change)
- **clean** — Checked and found compliant: no assertion is removed from the three edited watchdog test files (only `now += ms;` clock lines and comments change), Australian English, new `now` and flag options have production setters, the named tests exist, each insertion point was read for doc-comment placement, temporary directories are made with `Deno.makeTempDir`, log levels for expected refusals are info

## Edited expectations: red-checks

- `worker/deno/tests/run_core_watchdog_test.ts` (two tests), `worker/deno/tests/agent_run_termination_test.ts` (four) and `worker/deno/tests/handler_watchdog_scope_test.ts` (one): fixture-only edits (clock stopped one millisecond short of the target, or crossing it only where the Planning handler is the subject). Disabling the abandon call (`onTimeout`) turns six of the seven red; removing the agent floor turns the two floor tests red; disabling the termination call turns the scope and termination tests red. Two weaker guards stand as before this change: the CI Fix budget test cannot see the agent-backed budget under its instant fake timer (the budget is covered by the `handlerHardTimeoutMs` unit tests), and the Issue #1667 test passes with termination disabled because the Refinement handler is itself abandoned at once.
