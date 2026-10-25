## Summary

`runClaudeWithTimeoutBody` bounds each agent session by the two-hour finish. The timeout is the smaller of the requested `timeoutSeconds` and finish − now − `killAfterSeconds` − `WIP_CHECKPOINT_RESERVE_SECONDS` (`finishSessionReserveSeconds` in `worker/deno/lib/run_timeline.ts`). A budget under `MIN_AGENT_SESSION_SECONDS` (120) is not spawned. The user prompt, never the system prompt, ends with the finish instant and the seconds remaining. Closes #4244.

Version bump: not applicable — no `deno.json` version change.

## Spec

### Intent and Rationale
- A session started late in the two-hour window was still handed the caller's full timeout, so it could run past the finish. The clamp lives in the one runner every agent session uses.
- The user prompt states the deadline because the agent has to commit and push before it. The system prompt is the cached prefix and stays byte-identical.

### Essential Design Decisions
- `clampTimeoutToFinishDeadline` returns the budget, whether it was reduced, whether it is under 120 seconds, the finish ISO instant, and whole seconds until that instant (not the clamped budget).
- Under the floor the runner returns a typed result (`exitCode` 124, `timedOut`, `timeoutReason` `"hard-timeout"`, `finishDeadline: true`) and does not spawn. A spawned session that ends on the clamped hard timeout also sets `finishDeadline: true`. A silence watchdog, a call-storm, and a successful early exit do not.
- With no timeline published, the prompt, the arguments and the timeout are the caller's. `runClaudeWithRetry` copies `finishDeadline` onto a rebuilt timeout result. The Claude stdin payload is the prompt after the line is appended.

### Undiscoverable Facts
- When the argv contains `--max-turns`, the spawn log already includes `claude_timeout=`. When the clamp applies and that flag is absent, the same log still includes `claude_timeout=<seconds> (clamped to finish deadline <ISO>)`. The below-floor refusal logs that clause and `below 120s, not spawning the agent` before any spawn.
- The appended line is `Finish deadline: <ISO> (<remainingSeconds> seconds remaining). Commit and push your work before then.` An empty user prompt becomes that line alone.

## Evidence
- `worker/deno/lib/run_timeline.ts`: `MIN_AGENT_SESSION_SECONDS`, `clampTimeoutToFinishDeadline`, `finishDeadlinePromptLine`, `appendFinishDeadlinePrompt`.
- `worker/deno/lib/claude_runner.ts`: the clamp, the refusal, the log suffix, and the `finishDeadline` flag on `ClaudeRunResult`. `worker/deno/lib/claude_executor.ts` carries the same optional field.
- Tests: `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts` (5 passed, 0 failed). `deno fmt` and `deno lint` on the touched files passed.
- The five tests were first run against the unfixed runner: the 1 h 50 m case and the below-floor case failed, and the clamped-timeout case did not return until the unfixed 3600 s budget was killed. After the clamp they passed.

## Reproduction
- **symptom** — an agent session kept the caller's timeout past the two-hour finish, and the prompt did not state that deadline.
- **status** — `verified` — the regression test was observed failing against the unfixed code and passing after the fix.
- **regression test** — `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a session at 1h 50m is clamped to the finish deadline and the user prompt states it (Issue #4244)`

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A session started at 1 h 50 m gets a timeout ≤ 600 s − kill grace − reserve, and the prompt ends with the finish deadline and the seconds remaining. — evidence: `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a session at 1h 50m is clamped to the finish deadline and the user prompt states it (Issue #4244)` — reviewer: met
- **met** — A session with less than `MIN_AGENT_SESSION_SECONDS` left is not spawned, and the result carries `finishDeadline: true`. — evidence: `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - less than the minimum session is not spawned and carries finishDeadline (Issue #4244)` — reviewer: met
- **met** — A session ended by the clamp carries `finishDeadline: true`. — evidence: `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - a session ended by the finish clamp carries finishDeadline (Issue #4244)` — reviewer: met
- **met** — With no timeline set, the arguments, prompt and timeout are unchanged. — evidence: `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - with no timeline the prompt, arguments and timeout are unchanged (Issue #4244)` — reviewer: met
- **met** — The system prompt is byte-identical with and without a timeline. — evidence: `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts::runClaudeWithTimeout - the system prompt is byte-identical with and without a timeline (Issue #4244)` — reviewer: met
- **partial** — Tests and `./quality.sh` pass. — evidence: `deno test --allow-all tests/claude_runner_finish_deadline_4244_test.ts` (5 passed, 0 failed); `deno fmt` and `deno lint` on the touched files passed — reason: `./quality.sh` was not run in this session — reviewer: partial

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English in the new comments, the existing clock seam, no `deno.json` version bump, and the system prompt left byte-identical. `deno fmt` and `deno lint` were clean on the runner files, and the five session tests passed. — evidence: `worker/deno/lib/claude_runner.ts`, `worker/deno/lib/run_timeline.ts`, `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts`

## Test Plan

- CI repair: format the finish-deadline tests and align the existing watchdog,
  retry, spend-guard and concurrent-slot fixtures with the run timeline. The agent and
  dispatch clocks now use the same epoch; concurrent jobs advance one shared
  elapsed interval rather than adding an hour per job. The no-supervisor-cap
  case now verifies the finish bound required by #4245. All 94 focused tests
  pass, and `deno task check:manifests` passes (857 passed, 1 ignored).
- `worker/deno/tests/claude_runner_finish_deadline_4244_test.ts` — 5 passed, 0 failed, including the five acceptance cases above.
- Twins of the prompt rule: the user-prompt append in `runClaudeWithTimeoutBody` and the system-prompt argument, which the byte-identical test reads back from the stub. `runClaudeWithRetry` copies `finishDeadline` so the execute phase sees the same flag the body sets.
- `worker/deno/lib/vibe_env_registry.ts` keeps a single `VIBE_HARD_KILL_AT_EPOCH` entry, the Issue #4247 note. The second entry from the milestone merge is removed. It does not change the session clamp.

## Security sweep follow-up

Removed an unused prompt-result reassignment and a redundant timeout predicate
inherited from the milestone. The gate-retry test now checks for a leaked PR
URL with literal replacement instead of an unsafe regular expression; its
absence assertion is preserved.

### Test Plan for this push

All 127 related execution, GitHub-spawn and gate-retry tests passed. Formatting
and lint passed for the three affected TypeScript files. This push refreshes
the archived summary required by the PR summary freshness gate.

## Milestone merge validation

Reconciled PR #4382 with current main. Retained the one-hour start gate, two-hour session and extension bounds, and bounded drain, along with the milestone's security-sweep cleanups. Retained main's repository provider pins, container sandbox policy, typed disk admissions, nested Deno discovery and later-session infrastructure-fault handling. Validation: 301 focused tests and all 857 manifest checks passed (one ignored); all 22 conflicted TypeScript files pass formatting and lint.

The milestone resurrection gate found `codex_resume_sandbox_4333_test.ts`, which main deliberately deleted in #4363 when the container became the sandbox for orchestrated roles. Retained that deletion instead of restoring obsolete CLI-sandbox expectations; the current role-configuration tests remain in place. All 43 current orchestration, role-configuration and environment tests pass.

## Latest main integration for PR #4382

Preserved both finish-deadline clamping and the newly merged in-flight host-disk admission check before agent launch. Retained both the timeline-release and exhausted startup-suite rerun regressions after combining their shared test fixture parameters.
