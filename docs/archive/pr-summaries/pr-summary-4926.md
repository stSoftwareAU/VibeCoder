## Summary

`buildDeepSeekChildEnv` now defaults `BASH_MAX_TIMEOUT_MS` to the shared
`CLAUDE_BASH_TIMEOUT_ENV` (1800000 ms), so a DeepSeek-routed PR-feedback,
CI-fix, quality-fix or merge-conflict run can finish a gate longer than ten
minutes. An explicit parent value wins. Closes #4926.

## Spec

### Intent and Rationale

- The `deepseek` binary is the Claude Code CLI (2.1.310, same artefact as
  `claude` in `container/tools.json`), so it keeps the 600 s foreground ceiling
  unless the variable is set, as #4913 fixed for `claude`.

### Essential Design Decisions

- The value is reused from `CLAUDE_BASH_TIMEOUT_ENV` rather than copied, so the
  two providers cannot drift. It is defaulted, not pinned: an explicit parent
  value wins, as in `buildClaudeChildEnv`.
- `buildDeepSeekChildEnv` is also called by `review_round.ts` and
  `babysitter_provider_choice.ts`, so those DeepSeek children get the ceiling
  too (same CLI, harmless).

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI files touched. Tests
(`worker/deno/tests/deepseek_env_test.ts`): default is `"1800000"` and an
explicit `"900000"` wins. Red check: replacing the default loop with a no-op
turned the default test red.

## Acceptance Criteria

The issue states no criteria heading and nothing it asks is left undone:
`CLAUDE_BASH_TIMEOUT_ENV` applied with parent-wins rule, CLI version confirmed
(`container/tools.json` deepseek notes: 2.1.310, same artefact), unit tests for
default and override, `docs/MODEL-AND-CACHING.md` paragraph updated.

## Test Plan

- Added in `worker/deno/tests/deepseek_env_test.ts`:
  `buildDeepSeekChildEnv - defaults BASH_MAX_TIMEOUT_MS to 30 minutes (Issue #4926)`
  and
  `buildDeepSeekChildEnv - an explicit parent BASH_MAX_TIMEOUT_MS wins (Issue #4926)`;
  both pass.
- Edited `worker/deno/tests/babysitter_provider_choice_4738_test.ts`: the
  whole-env expectation of the DeepSeek child gains
  `BASH_MAX_TIMEOUT_MS: "1800000"`; nothing removed. It failed before the edit
  and passes after. Callers checked: `agent_provider.ts`, `review_round.ts`,
  `babysitter_provider_choice.ts` (tests `review_round_test.ts`,
  `babysitter_provider_choice_4738_test.ts` pass).
- Docs updated: `docs/MODEL-AND-CACHING.md` (Foreground command ceiling),
  `docs/CONFIGURATION.md`, `docs/MANAGER-WORKER-CONTRACT.md` (line reference),
  doc comment in `worker/deno/lib/claude_env.ts`.
- `./quality.sh`: all stages passed except `deno tests`, which failed only in
  `tests/pr_maintenance_command_test.ts` (5 failures: merge-queue and #4613
  strict-base cases). They fail identically without this change (HEAD checkout
  run in isolation) and touch no DeepSeek code. `config integration` and
  `checkov` skipped by the gate itself.
