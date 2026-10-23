# Security sweep — pre-push gate extra turn (`pre_push_gate_retry.ts`)

**Issue:** [#4128](https://github.com/stSoftwareAU/VibeCoder/issues/4128) (chunk
top-up-4128)

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12af) recorded their coverage:

- `worker/deno/lib/pre_push_gate_retry.ts` — added by #4128.

## `worker/deno/lib/pre_push_gate_retry.ts`

The module gives the agent one extra in-run turn to fix a block from the
completion phase's pre-push gate (the changed-file checks of #3689, run over the
branch's unpushed commits) before the run fails. It is entered only for a
verdict block, not an infrastructure failure, and only once per run. When the
turn finishes cleanly, the module commits what it left on the issue branch
through the guarded commit path, and the completion phase re-runs the same gate.
The re-run decides whether the push goes ahead.

Shapes checked:

| Property | Result |
| --- | --- |
| the prompt is worker-authored | the turn's prompt is built by `buildPrePushGateRetryPrompt`: its instructions are constant text, and the gate output is interpolated only through `fenceUntrustedIssueText`, under the boundary id, with the heading "untrusted data — quotes repository content" |
| the gate output is fenced under a per-render nonce | the boundary id is minted by `generateBoundaryId` (six bytes from `crypto.getRandomValues`) on every render, since `runPrePushGateRecoveryTurn` passes no id; `buildBoundaryIntegrityInstruction` names the same block, so the agent is told the fence is data |
| bounded to one turn per run | the completion phase enters only when `!state.prePushRetryAttempted` (`completion_phase.ts:2115`); the module sets `prePushRetryAttempted = true` before any agent call; the gate is re-run only when the turn reports `ran: true` |
| the timeout is configurable and validated | `pre_push_retry_timeout_seconds` defaults to 600 (`config_defaults.ts`, `prePushRetryTimeoutSeconds`); `config.ts` rejects any value that is not a number, not finite, or not above zero |
| the commit path is the guarded one | HEAD is reconciled onto the issue branch with `reconcileHeadToBranch`, then `commitAndPushPending` runs with `resolvePreFlightSpec(...) ?? { commands: [] }`, so the changed-file gate runs before the push (Step 1b precedes Step 2 in `git_push.ts`); the module's own code never passes `--no-verify`, and its prompt tells the agent not to use it |
| fail loud, nothing swallowed | a throw, `ok: false`, a timeout, or a non-zero exit each log at error level and return `ran: false` with the cause; the completion phase then does not re-run the gate and reports the original gate output; a reconcile or commit failure also logs at error level, and the gate re-run decides the run |
| session scope | the turn resumes the run's own `state.sessionResumeState` only, in the run's own `state.repoPath`; no other issue's or run's session is read |
| tool grant | the request sets no `mcpConfig`, so no browser MCP is written (`claude_runner.ts`: absent means no browser); no `disallowedTools` override is set, so the runner's default applies, which removes only the plan-mode tools |

No findings. The module is covered by
`worker/deno/tests/pre_push_gate_retry_test.ts` and
`worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts`.
