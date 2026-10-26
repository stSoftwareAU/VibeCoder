## Summary

`drainSlots` and the maintenance-lane drain wait no later than the finish plus the kill grace and the 120 s WIP reserve. At the finish they terminate in-flight agents so the execute path can checkpoint; at the end of that grace they release any claim still held, log one line per abandoned item, and the run exits through `Run duration complete. Exiting for refresh.` Once that grace has elapsed, the end-of-run slot-tail wait is zero rather than another `slotDrainGraceSeconds`, so the exit line is not held for a further 300 s. The success and always run hooks and the cycle heartbeat fire. No `failed-once` is added. Closes #4246.

Version bump: not applicable — no `deno.json` version change.

## Spec

### Intent and Rationale
- A slot still running at the two-hour finish used to hold the drain until the work settled or a shutdown grace elapsed. The finish needs its own bound so a healthy run ends through the normal path and does not sit until the three-hour kill.
- The checkpoint window is the same reserve the session clamp and the extension ceiling already leave clear of the finish (`finishSessionReserveSeconds`).

### Essential Design Decisions
- `finishDrainBound` is finish plus that reserve. `drainSlots` and `raceShutdownGrace` poll a real 50 ms timer and read `deps.now()`. The first time `now` is at or past the finish they call `terminateActiveAgentRuns("finish deadline reached", { keepTerminating: true })`. The first time `now` is at or past the grace they return.
- After the drain, `settleLiveSlotTails` still waits the slot grace when the run ends earlier than the finish bound, including a SIGTERM shutdown. When `now` is already at or past `drainAtMs`, that wait is zero. The hung-slot test records every `sleep` and requires the line `waiting up to 0s`, so a second 300 s wait cannot hide behind a no-op sleep.
- A finish release uses `deriveRunOutcome` with reason `Released on schedule: the finish deadline was reached`, phase `"execute"`, and callback `result: "success"`, so the success and always hooks fire and `handleIssueFailure` is not called. The shutdown path is unchanged: `result: "failure"`, phase `"shutdown"`, and the existing error log.
- One info line per abandoned slot hold: `Abandoned at the finish deadline: <repo>#<n> — claim released, work resumes next run`. The maintenance lane logs `<handler> released on schedule: the finish deadline was reached`. The outer loop then logs `Run duration complete. Exiting for refresh.` and returns `exitReason` `"Run duration expired"`.

### Undiscoverable Facts
- `runCoreLoop` publishes a timeline at start, so every loop has this bound. The outer `endTime` is still the one-hour target. After the drain returns past that target, the existing end path runs, including `runCycleCallback`.
- The slot-pool test drives the checkpoint by calling `startWipCheckpoints(...).runNow()` inside the mock `processIssue` once `terminateActiveAgentRuns` has fired. The next `runCoreLoop` claims the same issue and `resumeIssueBranch` checks out the pushed branch. `processIssue` is the worker in these tests, so the test performs the checkpoint the execute path's `wip_checkpoint.ts` performs in production.

## Evidence
- `worker/deno/lib/run_core.ts`: `finishDrainBound`, the finish branch of `drainSlots`, the finish branch of `raceShutdownGrace`, and the zero tail grace in `settleLiveSlotTails` once `now` is at or past `drainAtMs`.
- Tests: `worker/deno/tests/run_core_slot_pool_test.ts` — `slot pool - a slot that never settles does not hold the drain past the finish grace (Issue #4246)` and `slot pool - the finish deadline checkpoints, releases, and the next scan resumes the WIP branch (Issue #4246)`, both passed. The existing shutdown-grace tests in the same file still pass.
- `docs/CONFIGURATION.md` stage 5 describes this drain. `deadline_model_docs_check` passed.

## Reproduction
- **symptom** — in-flight work at the two-hour finish held the drain, so the run did not exit through `Run duration complete` and the next launch had no checkpoint to resume.
- **status** — `partial`
- **reason** — the two drain tests were written with the implementation and were not watched failing on the unfixed code. The tail-wait assertion was added in review and passes on this head; it was not run red against the unfixed 300 s tail. No production run was reproduced here.
- **regression test** — `worker/deno/tests/run_core_slot_pool_test.ts::slot pool - the finish deadline checkpoints, releases, and the next scan resumes the WIP branch (Issue #4246)`

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — With an injected clock, a run whose in-flight work reaches the finish deadline exits through "Run duration complete" no later than finish + grace. The end-of-run tail wait is 0 s once that grace has elapsed, and no sleep of the default 300 s slot grace is taken. — evidence: `worker/deno/tests/run_core_slot_pool_test.ts::slot pool - a slot that never settles does not hold the drain past the finish grace (Issue #4246)` — reviewer: met
- **met** — The WIP checkpoint commits and pushes, the claim is released, and a fresh run's scan claims the same issue and resumes from the WIP branch. — evidence: `worker/deno/tests/run_core_slot_pool_test.ts::slot pool - the finish deadline checkpoints, releases, and the next scan resumes the WIP branch (Issue #4246)` — reviewer: met
- **met** — The success/always run hooks and the cycle heartbeat fire, and `failed-once` is not added. — evidence: `worker/deno/tests/run_core_slot_pool_test.ts::slot pool - the finish deadline checkpoints, releases, and the next scan resumes the WIP branch (Issue #4246)` — reviewer: met
- **met** — A slot whose work never settles does not hold the drain past finish + grace. — evidence: `worker/deno/tests/run_core_slot_pool_test.ts::slot pool - a slot that never settles does not hold the drain past the finish grace (Issue #4246)` — reviewer: met
- **partial** — Tests and `./quality.sh` pass. — evidence: the two Issue #4246 slot-pool tests passed, and the two existing shutdown-grace tests in the same file passed; `deno fmt` and `deno lint` on the touched files passed — reason: `./quality.sh` was not run in this session — reviewer: partial

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — `drainSlots` and `raceShutdownGrace` share `finishDrainBound` and the same terminate-then-grace order. The shutdown release path still uses the slot grace when the finish bound has not elapsed; the two existing shutdown-grace tests passed. Australian English. No `deno.json` version bump. `deno fmt` and `deno lint` on `run_core.ts` and the slot-pool test passed. — evidence: `worker/deno/lib/run_core.ts`, `worker/deno/tests/run_core_slot_pool_test.ts`

## Test Plan
- `worker/deno/tests/run_core_slot_pool_test.ts` filtered to `Issue #4246` — 2 passed, 0 failed, including the `waiting up to 0s` tail and no sleep of 300 s or more. The two existing `shutdown grace` tests in the same file passed (2 passed, 0 failed).
- Twins: `drainSlots` and `raceShutdownGrace` in `worker/deno/lib/run_core.ts`, both calling `finishDrainBound`. The abandon callback uses `result: "success"`; the shutdown callback still uses `result: "failure"`. The checkpoint the drain waits for is `startWipCheckpoints` in `worker/deno/lib/wip_checkpoint.ts`, which the resume test calls directly because `processIssue` is mocked.
- `worker/deno/lib/vibe_env_registry.ts` keeps a single `VIBE_HARD_KILL_AT_EPOCH` entry, the Issue #4247 note. The second entry from the milestone merge is removed. It does not change the drain.

## Independent review repair for PR #4382

The original finish watcher covered pooled claims but missed the default
single-claim path. The serial path now awaits its claim through the shared
bounded drain, while retaining serial selection and ordinary shutdown timing.
At the finish it terminates the agent, releases a claim still running after
grace, fires the success/always hooks once, and reaches the normal cycle exit.
The shared drain also clears its watcher if processing rejects.

The hung-claim regression now covers slot counts 1 and 2 with all existing
release, callback, heartbeat and zero-tail-grace assertions. The serial case
failed against the previous head and passes after the repair. All 76
slot-pool, thrown-release and callback tests pass, as do the 866 manifest
checks (one ignored). Formatting and lint pass.

The second review added a wedged maintenance-lane regression. Its injected
clock stays at the finish until termination is observed, then reaches finish
plus reserve. The test asserts the CI Fix scheduled-release log, one cycle
heartbeat and the normal run-duration exit within that bound. It passes with
the existing maintenance-lane and shutdown tests.
Removing the finish bound from the lane call makes that regression fail with
`maintenance finish drain did not return`; restoring it passes.
