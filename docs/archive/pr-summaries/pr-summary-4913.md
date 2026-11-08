## Summary

Raised the agent's foreground Bash ceiling so the bounded foreground gate run
the prompts already require can actually run: every `claude` child now gets
`BASH_MAX_TIMEOUT_MS=1800000` (30 minutes) in its spawn environment, and the
quality-instruction example timeout is sized to the gate instead of a fixed
`timeout 900`. Closes #4913.

## Spec

### Intent and Rationale

- Claude Code stops a foreground Bash command at 600 000 ms unless
  `BASH_MAX_TIMEOUT_MS` raises the ceiling, and nothing set it, so
  `timeout 900 …` could never run past 10 minutes. Setting the variable makes
  the existing instruction executable without adding a gate or rule.

### Essential Design Decisions

- A separate `CLAUDE_BASH_TIMEOUT_ENV` constant sits beside
  `CLAUDE_SUBAGENT_CAP_ENV`, with the same rule that an explicit parent value
  wins. 1 800 000 ms matches the 1800 s default PR-feedback timeout.
- The prompt wording now says `timeout <seconds> <command> < /dev/null` with
  `<seconds>` sized to the gate cost stated in the budget line above, and to set
  the shell tool's own timeout argument to match.

### Undiscoverable Facts

- Variable confirmed against the pinned CLI: `strings` on the installed `claude`
  2.1.310 (the version in `container/tools.json`) shows `BASH_MAX_TIMEOUT_MS`
  and `BASH_DEFAULT_TIMEOUT_MS` in its env-var tables.
- Only the `claude` provider's child is built by `buildClaudeChildEnv`; the
  `deepseek` child (`buildDeepSeekChildEnv`) is unchanged.

## Evidence

Backend/CLI change; no UI files touched. Verified by unit tests (below). Docs:
`docs/MODEL-AND-CACHING.md` gains a "Foreground command ceiling (Issue #4913)"
subsection after "Sub-agent spawn caps". Siblings grepped:
`CLAUDE_SUBAGENT_CAP_ENV`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `timeout 900`
(remaining hits in `docs/CONFIGURATION.md`, `ci_failure_classifier.ts` and the
coding-guidelines prompt describe CI/other commands, not this instruction).

## Test Plan

- `worker/deno/tests/claude_env_test.ts`: default child env carries
  `BASH_MAX_TIMEOUT_MS` `"1800000"` (literal); a parent `"900000"` wins; the
  empty-env test also expects the new entry. Red check: replacing the loop's
  source with `{}` made 2 tests fail; restored.
- `worker/deno/tests/repo_config_test.ts`: edited expectation — `timeout 900`
  assertion replaced by `timeout <seconds> <command> < /dev/null` plus a check
  that `timeout 900` is gone. Removed from
  `worker/deno/tests/repo_config_test.ts`:
  `assertStringIncludes(text, "timeout 900")`; Required by: "Reword
  `repo_config.ts:165` so the example timeout is sized to the gate instead of
  the fixed `timeout 900`". The edited test goes red if the old wording returns
  (the new negative assertion).
- Ran
  `deno task test:unit tests/claude_env_test.ts tests/repo_config_test.ts tests/agent_env_audit_journal_2400_test.ts tests/agent_state_dir_test.ts`:
  87 passed, 0 failed. fmt, lint and check pass on touched TS files.
- `./quality.sh` on the head: every stage passed except `deno tests`, which had
  33158 passing and one failing:
  `tests/merge_fast_checks_credentials_4705_test.ts:101`, whose expected argv
  lacks the host's `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` variables. That test
  does not touch `claude_env.ts` or `repo_config.ts`. The serial pass did not
  run after that failure.
