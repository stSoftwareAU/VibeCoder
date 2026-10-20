## Summary

The **`timeout` command** bullet under **Cross-Platform Bash Compatibility** in
`prompts/coding_guidelines/prompt.md` told agents to use `$TIMEOUT_CMD`
"resolved to `gtimeout` on macOS by `check_dependencies()`". No such function
exists, and nothing exports `TIMEOUT_CMD`: `loop.sh` and `run.sh` each set
their own unexported copy. A script that followed the bullet aborted under
`set -u`. The bullet now stands on its own. A script picks `timeout`, else
`gtimeout`, else runs the command unbounded, using the same inline loop and
`bounded()` helper that `loop.sh` / `run.sh` use. The two other places that
assumed a pre-set `$TIMEOUT_CMD` (the **Streaming Reads** live-stream example
and **Test Timeout Protection**) now use a literal `timeout` with a `gtimeout`
note, so every restatement gives the same answer. Closes #3675.

## Spec

### Intent and Rationale

- A guideline rendered into every code-writing run must not name a helper that exists in no repository. The fix shows the pattern inline instead of pointing at shared code.
- The Streaming Reads and Test Timeout Protection examples made the same false claim ("`$TIMEOUT_CMD` resolves to …"). Fixing only the bullet would leave three places giving two answers.

### Essential Design Decisions

- The fallback when neither `timeout` nor `gtimeout` exists is to run unbounded, not to fail. This matches `bounded()` in `loop.sh` / `run.sh` and what the issue asked for.
- Bash-tool examples use a literal `timeout`, because agents run in the Linux container. Committed scripts are pointed at the portable snippet.

### Undiscoverable Facts

- `worker/deno/commands/quality_helpers.ts:283` and `worker/deno/lib/quality_gate_phase.ts:461` read `TIMEOUT_CMD` from the environment as an optional override. No code in the repo exports it (`git grep TIMEOUT_CMD`).

## Evidence

Prompt-only change plus a documentation-drift test; no UI. I ran the documented snippet under `set -euo pipefail` with `bash`. It printed `ok with [timeout]` normally and `ok with []` with `PATH=/nonexistent`, so the "neither present" fallback runs the command and does not abort.

**Docs sweep** — grep: `check_dependencies`, `TIMEOUT_CMD`, "resolves to `gtimeout`", "set to `gtimeout`"; section: `prompts/coding_guidelines/prompt.md#cross-platform-bash-compatibility`; siblings: none — no existing set gained a member (the bullet was rewritten, not added); updated: `prompts/coding_guidelines/prompt.md`. Hits left in place:
`worker/deno/lib/tail_anti_pattern.ts:60` — still true because it documents a token the detector recognises, not how the variable is set;
`worker/deno/lib/tail_anti_pattern.ts:84` — still true because `$TIMEOUT_CMD` remains a recognised guard token;
`worker/deno/lib/tail_anti_pattern.ts:108` — still true, same reason;
`worker/deno/lib/tail_anti_pattern.ts:162` — still true because the suggestion names the variable form and makes no claim that anything sets it (the detector has no production caller);
`worker/deno/lib/tail_anti_pattern.ts:173` — still true, same reason;
`worker/deno/tests/tail_anti_pattern_test.ts:107` — still true because `loop.sh` / `run.sh` do set their own `TIMEOUT_CMD` (gtimeout or timeout);
`worker/deno/commands/quality_helpers.ts:283` — still true because it reads an optional env override;
`worker/deno/lib/quality_gate_phase.ts:461` — still true, same reason.

Related existing rules checked:

- `CODING-STANDARDS.md` § "Shell code a test runs must behave the same on macOS". It lists "a bare `timeout`" as a form to guard, and the new snippet is that guard.
- The quality instructions' `timeout 900 <command>` for Bash-tool runs. It agrees with the literal `timeout` examples.

I applied the rule to this PR's own diff. The only shell code added is the documented snippet, which I ran as above. The test file runs no shell. The literal `timeout` examples are Bash-tool commands, and the committed-script case points at the portable bullet. I found nothing to fix.

## Test Plan

- Added `worker/deno/tests/timeout_cmd_portability_3675_test.ts`, three documentation-drift tests:
  - The Cross-Platform section pins the new wording and the `for candidate in timeout gtimeout; do` loop. It also checks that `check_dependencies` is absent from that section.
  - A whole-file check that `check_dependencies` is absent (an absence check on `flatWholeFile`).
  - The Streaming Reads and Test Timeout Protection sections pin the literal `timeout` examples. They also check that `$TIMEOUT_CMD 30` and `$TIMEOUT_CMD 900` are absent.
- Red check: with the base-branch `prompts/coding_guidelines/prompt.md` restored, all three tests FAILED. With the change in place, all three pass.
- `deno task drift-pins-on-base origin/milestone/fleet-guidance-tests-twins-and-portability prompts/coding_guidelines/prompt.md <section> <pins>…` reported "absent on base" for each of the 7 pinned phrases:
  - Cross-Platform Bash Compatibility: 3 phrases.
  - Streaming Reads: 2 phrases.
  - Test Timeout Protection: 2 phrases.
- `deno task test:unit tests/timeout_cmd_portability_3675_test.ts tests/gnu_only_shell_3504_test.ts tests/coding_guidelines_layers_2574_test.ts tests/tail_anti_pattern_test.ts`: 38 passed, 0 failed.
- `markdownlint-cli2 prompts/coding_guidelines/prompt.md`: 0 issues.
- No existing test edited; no assertions removed.
- `./quality.sh` on the head: Result: PASSED (with skipped checks — `config integration` SKIPPED; every other stage including semgrep and deno tests PASSED).

<!-- vibe-branch-outcomes -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
