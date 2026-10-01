# Security sweep — screenshot-gate extra turn (`screenshot_gate_retry.ts`)

**Issue:** [#2960](https://github.com/stSoftwareAU/VibeCoder/issues/2960) (chunk
top-up-2960) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12af) recorded their coverage:

- `worker/deno/lib/screenshot_gate_retry.ts` — added by #2960.

## `worker/deno/lib/screenshot_gate_retry.ts`

The module gives the agent one extra in-run turn to capture a missing
screenshot before the completion phase's screenshot gate
(`screenshot_validation.ts`) applies the `needs-screenshot` label, posts the
remediation comment and fails the run — the same path the gate took
unconditionally before #2960. It resumes the agent with the browser tool
attached, so the review looks at what that turn can reach, not at the
one-line predicate it replaces.

Shapes checked:

| Property | Result |
| --- | --- |
| the prompt is worker-authored | the resumed turn's prompt is the gate's own constant, `SCREENSHOT_FAILURE_MESSAGE` from `screenshot_validation.ts`; no issue, PR or comment text is interpolated into it |
| the browser grant is not widened | `mcpConfig: true` is reached only once the gate has already failed; the gate itself returns valid for a `skip_screenshot_check` repository, so an opted-out repository never starts the browser here — the same grant the execute run already had (`browser_grant.ts`) |
| bounded to one turn per run | `screenshotRetryAttempted` is set and the recorded block cleared before the agent is invoked, so a throw, a bad result or a re-entry of this function cannot loop; the timeout is `screenshot_retry_timeout_seconds` (default 600s), and `config.ts` rejects any value that is not a positive finite number |
| the commit path is the guarded one | HEAD is reconciled back onto the issue branch, then `commitAndPushPending` runs with the repository's own pre-flight spec (`resolvePreFlightSpec`) — the same chokepoint the PR-summary recovery (`summary_rule_gate_retry.ts`) already uses, so the hidden-path and secret gates apply here too |
| fail loud, nothing swallowed | a throw, `ok: false`, a timeout, a non-zero exit, or a recovery call with no recorded block each log at error level — these end the run — naming the cause and fall through to the original `needs-screenshot` label, comment and `failure` path; a commit reconcile or push failure also logs at error level. The comment posted on failure is always the constant gate message, so no stack trace or internal error text reaches the issue |
| session scope | the retry resumes the run's own `state.sessionResumeState` only — no other issue's or run's session is ever read or resumed |

No findings. The module is covered by
`worker/deno/tests/completion_phase_screenshot_retry_test.ts`.
