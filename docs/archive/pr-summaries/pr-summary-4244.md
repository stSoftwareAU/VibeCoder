# Run timeline: clamp every agent session to the 2 h finish deadline (#4244)

Part of #4224; depends on #4242.

## Summary

`runClaudeWithTimeoutBody` now asks the run timeline (`lib/run_timeline.ts`)
how long a session may run. The new pure module `lib/agent_session_deadline.ts`
returns either a timeout (the smaller of the requested one and
finish − now − kill grace − `WIP_CHECKPOINT_RESERVE_SECONDS`) or a refusal when
under `MIN_AGENT_SESSION_SECONDS` (120 s) is left. A session that may run gets
one worker line appended to the **end of the user prompt** (finish deadline as
ISO, seconds remaining, commit-and-push instruction); the system prompt is
never touched. A clamped `claude_timeout=` log line says
`(clamped to finish deadline <ISO>)`. A refused session is not spawned and
returns `finishDeadline: true`; a watchdog stop at the clamp also carries
`finishDeadline: true`. A progress extension cannot carry a clamped session
past the finish limit. With no timeline set nothing changes.

A defect found and fixed while closing the criteria: `RunClaudeOptions.runTimeline`
(the test seam) was declared but never read, so the runner-level tests did not
exercise the clamp and one hung; the runner now reads
`options.runTimeline ?? getRunTimeline()`.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A session started at 1 h 50 m (injected clock) gets a timeout ≤ 600 s − kill grace − reserve; the prompt it receives ends with the finish deadline and the seconds remaining — evidence: `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a session started late is clamped to the finish deadline and told it on the last prompt line (Issue #4244)`, `worker/deno/tests/agent_session_deadline_test.ts::late session is clamped to what the finish leaves less the reserve` — reviewer: met
- **met** — A session with less than `MIN_AGENT_SESSION_SECONDS` left is not spawned, and the result carries `finishDeadline: true` — evidence: `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a session with under the floor left is refused and never spawned (Issue #4244)`, `worker/deno/tests/agent_session_deadline_test.ts::one second under the minimum session time is refused` — reviewer: met
- **met** — A session ended by the clamp carries `finishDeadline: true` — evidence: `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a watchdog stop at the finish clamp reports finishDeadline, a stop at the session's own timeout does not (Issue #4244)`, `::runClaudeWithRetry - a clamped watchdog stop comes back as a timeout with finishDeadline, not as a refused session (Issue #4244)` — reviewer: met
- **met** — With no timeline set, the arguments, prompt and timeout are identical to today's — evidence: `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - with no timeline set, the prompt, timeout and log are exactly the caller's (Issue #4244)` (argv equality with and without a timeline is pinned by the byte-identical test below) — reviewer: met
- **met** — The system prompt is byte-identical with and without a timeline — evidence: `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - the system prompt and argv are byte-identical with and without a timeline (Issue #4244)` — reviewer: met
- **met** — Tests and `./quality.sh` pass — evidence: `deno test` over `agent_session_deadline_test.ts`, `claude_runner_finish_deadline_4244_test.ts` (17 passed), `agent_run_termination_test.ts` (15), `run_core_watchdog_test.ts` (3), `run_timeline_test.ts` (19); `./quality.sh` passes every check except the parallel deno test pass, whose 8 failures are all Codex-provider tests (`claude_runner_provider_fallback_4034_test.ts`, `execute_claude_phase_rtk_test.ts`, `execute_claude_phase_test.ts`, `execute_phase_assignment_3718_test.ts`, `external_orchestration_3642_*_test.ts`) failing in this sandbox with `The running container image did not install the "codex" coding-agent provider`; `execute_phase_assignment_3718_test.ts` fails identically on the base commit 753a90e7, so they are environmental, not caused by this diff; lint, type check, fmt, semgrep and markdownlint pass — reviewer: met
- **unrequested** — the progress-extension ceiling at the finish limit (`claude_runner.ts`) and the `resetRunTimelineForTests()` calls in `agent_run_termination_test.ts` / `run_core_watchdog_test.ts` — reviewer: unrequested — reason: the extension ceiling keeps a progressing clamped session from outliving the clamp the issue asks for; the resets stop a process-wide timeline left by an earlier `runCoreLoop` refusing those tests' agents

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — stale doc comment: `ScheduledReleaseReason` `"hard-cap"` described only the supervisor's cap — evidence: `worker/deno/lib/failure_diagnosis.ts:183` — reason: fixed in this diff
- **violation** — stale prose: the cycle-deadline model said an in-flight claim keeps its full budget and the supervisor cap is the only place a progressing agent is killed; `TROUBLESHOOTING.md` said the same — evidence: `docs/CONFIGURATION.md` (cycle-deadline model points 2 and 4), `docs/TROUBLESHOOTING.md` ("The hard cap was what stopped it") — reason: fixed in this diff
- **clean** — Australian English, `deno fmt`/`deno lint`, pure injected-clock module reusing `WIP_CHECKPOINT_RESERVE_SECONDS` and `clampToFinishMs` (KISS/DRY), tests for every new behaviour (TDD), comment style, audit ledger entry `docs/audits/lib-sweep-coverage/top-up-4244.json`
- **clean** — residual wording: the runtime failure reason "the supervisor's run hard cap was reached" (`failure_diagnosis.ts:423`) is pinned by `label_manager_test.ts` and `run_outcome_classifier_test.ts`; it is left as is because a finish-deadline release is out of the issue's scope and reuses the `hard-cap` reason by design

## Docs sweep

**Docs sweep** — grep: `run_finish_seconds`, `runFinishSeconds`, "finish deadline", "not yet applied", "nothing reads", `claude_timeout=`, `scheduledRelease`, "hard-cap", "Run timeline"; section: `docs/CONFIGURATION.md#the-run-hard-cap-bounds-every-grant` (run finish deadline row and timeline paragraph) and the cycle-deadline model list; siblings: `scheduledRelease: "hard-cap"` (gained a second cause), `min_claim_runway_seconds`; updated: `docs/CONFIGURATION.md`, `docs/TROUBLESHOOTING.md`, `worker/deno/lib/failure_diagnosis.ts` (doc comment), `worker/deno/lib/config.ts`, `worker/deno/types.ts`, `worker/deno/lib/run_timeline.ts`

## Test Plan

No assertion is removed from any existing test. The diff against the base only adds lines to existing test files (`worker/deno/tests/agent_run_termination_test.ts`: 3 added; `worker/deno/tests/run_core_watchdog_test.ts`: 4 added — each a `resetRunTimelineForTests()` call) and adds two new files (`worker/deno/tests/agent_session_deadline_test.ts`, `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts`).

Run with stdin from `/dev/null`: `cd worker/deno && deno test -A tests/agent_session_deadline_test.ts tests/claude_runner_finish_deadline_4244_test.ts tests/agent_run_termination_test.ts tests/run_core_watchdog_test.ts tests/run_timeline_test.ts`.

**Branch outcomes:**
- `worker/deno/lib/agent_session_deadline.ts:73` — refuse (under 120 s left) — `worker/deno/tests/agent_session_deadline_test.ts::one second under the minimum session time is refused` — flipped to never refuse, test went red
- `worker/deno/lib/agent_session_deadline.ts:76` — clamped vs. own timeout — `worker/deno/tests/agent_session_deadline_test.ts::late session is clamped to what the finish leaves less the reserve` — flipped to never clamp, test went red
- `worker/deno/lib/claude_runner.ts:1206` — absent (no timeline: pass-through) — `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - with no timeline set, the prompt, timeout and log are exactly the caller's (Issue #4244)` — flipped to supply a clamping timeline when none is set, test went red
- `worker/deno/lib/claude_runner.ts:1206` — `runTimeline` option wins over the process-wide timeline — `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a session with under the floor left is refused and never spawned (Issue #4244)` — flipped to ignore the option, test went red
- `worker/deno/lib/claude_runner.ts:1215` — refuse (not spawned, `finishDeadline: true`) — `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a session with under the floor left is refused and never spawned (Issue #4244)` — flipped to never refuse, test went red
- `worker/deno/lib/claude_runner.ts:1235` — run (prompt line appended to the user prompt) — `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a session started late is clamped to the finish deadline and told it on the last prompt line (Issue #4244)` — flipped to never append, test went red
- `worker/deno/lib/claude_runner.ts:1493` — clamped (log line names the clamp) — `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a session started late is clamped to the finish deadline and told it on the last prompt line (Issue #4244)` — flipped to never log the clamp, test went red
- `worker/deno/lib/claude_runner.ts:1749` — extension ceiling capped at the finish limit — `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a progressing clamped session is stopped at the finish limit, not extended past it (Issue #4244)` — flipped to the caller's own ceiling, test went red
- `worker/deno/lib/claude_runner.ts:2731` — watchdog stop at the clamp carries `finishDeadline` — `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a watchdog stop at the finish clamp reports finishDeadline, a stop at the session's own timeout does not (Issue #4244)` — flipped to never set the flag, test went red
- `worker/deno/lib/claude_runner.ts:3199` — retry ladder: refused session returns without retry or wait — `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithRetry - a refused session returns finishDeadline after one attempt, with no retry, wait or spawn (Issue #4244)` — flipped to skip the early exit, test went red
- `worker/deno/lib/claude_runner.ts:3352` — retry ladder carries `finishDeadline` through a timeout — `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithRetry - a clamped watchdog stop comes back as a timeout with finishDeadline, not as a refused session (Issue #4244)` — flipped to drop the flag, test went red
