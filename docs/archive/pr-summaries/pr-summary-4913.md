## Summary

Claude's default 10-minute foreground command ceiling cut off gates that fit
inside VibeCoder's 30-minute repair budget. Default the Claude child environment
to `BASH_MAX_TIMEOUT_MS=1800000` and size the prompt's command timeout to the
measured gate and remaining budget. Closes #4913.

## Spec

### Intent and Rationale

The prompt required a 15-minute foreground command while leaving the tool
ceiling at 10 minutes. Repeated feedback sessions therefore could not produce
the gate evidence requested by the reviewer.

### Essential Design Decisions

- An explicit parent `BASH_MAX_TIMEOUT_MS` wins, including a deliberately lower
  ceiling. The parent environment is not mutated.
- The default per-command timeout is unchanged. The prompt asks the agent to
  request a matching tool timeout in milliseconds; a shell timeout alone does
  not extend the tool ceiling.
- Outer phase deadlines, stall watchdogs, foreground execution and remaining
  budget checks are unchanged. This grants no merge or validation bypass.
- The current image pins Claude Code 2.1.310 in `container/tools.json`.
  [Official Claude Code documentation](https://code.claude.com/docs/en/env-vars)
  documents the 600000 ms default and `BASH_MAX_TIMEOUT_MS` override.
- `docs/CONFIGURATION.md` describes the separate tool ceiling next to the
  existing run timeout settings.

## Reproduction

- **symptom** — foreground gates longer than ten minutes cannot complete under
  the default Claude tool ceiling, despite a longer phase budget.
- **status** — reproduced at the spawn environment and prompt boundary. Three
  assertions failed on the previous implementation and pass with this change.
- **regression test** — `worker/deno/tests/claude_env_test.ts`, default ceiling,
  unchanged default command timeout, parent immutability and explicit overrides;
  `worker/deno/tests/repo_config_test.ts`, bounded foreground instruction.

## Test Plan

- 73 tests passed across the two affected suites, including type checking.
- Changed TypeScript formatting and lint passed; `git diff --check` passed.
- Focused tests used a local checkout of Deno's standard library because JSR is
  unreachable here. The repository lockfile is unchanged; CI validates the
  locked dependencies.
- Read the existing foreground execution and gate budget rules; the generated
  prompt still requires both. No duplicated implementation was introduced.

## Merge verification

CI and independent review are pending. Auto-merge remains subject to the
repository's required checks.

## Not done

A live Claude command lasting over ten minutes was not run. The full local
quality gate and locked manifest checks remain blocked by this environment's
unreachable JSR, as established during the companion repair. This change does
not supply native toolchains or make an over-budget full gate fit.
