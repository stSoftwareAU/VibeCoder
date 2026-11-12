## Summary

Corrected four doc comments that claimed a sandbox or enforced tool denial for orchestrator role calls that Codex does not get. Comment-only: no code line changed. Closes #4981.

## Spec

### Intent and Rationale

- Since Issue #4356, `buildCodexArgs` always pushes `STANDARD_FLAGS` (including `--dangerously-bypass-approvals-and-sandbox`); a role call only adds `approval_policy="never"` and `features.multi_agent=false`. The comments said otherwise, inviting callers to build a boundary on a sandbox that does not exist.

### Essential Design Decisions

- Comments state the container is the boundary and read-only roles rely on checkout restoration (`worker/deno/lib/orchestration/read_only_guard.ts`), which does not deny Bash. They never call restoration an OS sandbox.
- A fourth comment beyond the issue's three (`RunClaudeOptions.orchestrationRole` in `worker/deno/lib/claude_runner.ts`) carried the same "Enforced CLI sandbox" claim, so it was fixed in the same pass.
- Provider switching for orchestration calls is left to #4986, as the issue says.

### Undiscoverable Facts

- The `MANAGER_DENIED_TOOLS` instance came from an issue comment by the PR reviewer, not the issue body.

## Evidence

Backend comment-only change; no UI. `docs/ROLE-CONFIGURATION.md` (lines 80-94) and the `read_only_guard.ts` header were read and already state the correct behaviour, so they were not edited.

## Test Plan

- No test added or changed: comments only, no behaviour change.
- `deno fmt --check` and `deno check` on the four touched files passed; `deno test -A` on `agent_provider_codex_test.ts`, `codex_role_read_only_guard_4356_test.ts`, `claude_runner_test.ts`, `claude_runner_command_test.ts`, `orchestration_3642_orchestrator_test.ts` and `role_configuration_3643_test.ts` passed (143 passed, 0 failed).
