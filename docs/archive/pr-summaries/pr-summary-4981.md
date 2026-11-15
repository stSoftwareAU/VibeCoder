## Summary

Corrected four doc comments that claimed a sandbox or an enforced tool denial
for orchestrator role calls that Codex does not get. No production code line
changed. Closes #4981.

## Spec

### Intent and Rationale

- Since Issue #4356, `buildCodexArgs` (`worker/deno/lib/codex_executor.ts`)
  always pushes `STANDARD_FLAGS`, which include
  `--dangerously-bypass-approvals-and-sandbox`. A role call only adds
  `approval_policy="never"` and `features.multi_agent=false`. The old comments
  said otherwise, which invited callers to build a boundary on a sandbox that
  does not exist.
- `disallowedTools` becomes `--disallowed-tools` only in `buildClaudeCliArgs`
  (`worker/deno/lib/agent_provider.ts`), which Claude and DeepSeek share. Codex
  receives the list as prompt text (`composeCodexPrompt`), so the
  `MANAGER_DENIED_TOOLS` comment now says the denial is enforced only on the
  Claude CLI path.

### Essential Design Decisions

- The comments say the container is the boundary, and that a read-only Codex
  role relies on checkout restoration
  (`worker/deno/lib/orchestration/read_only_guard.ts`), which does not deny
  Bash. They never call restoration an OS sandbox.
- The `AgentInvocationRequest.orchestrationRole` comment scopes the "held only
  by checkout restoration" claim to Codex roles, because a Claude role also gets
  enforced tool denials.
- A fourth comment beyond the issue's three,
  `RunClaudeOptions.orchestrationRole` in `worker/deno/lib/claude_runner.ts`,
  made the same "Enforced CLI sandbox" claim, so it is fixed here too.
- Preventing an orchestration call from switching to an unvetted provider is
  left to #4986, as the issue says.

### Undiscoverable Facts

- The `MANAGER_DENIED_TOOLS` instance was reported in an issue comment by the PR
  reviewer, not in the issue body.
- An earlier attempt on this branch also added a quota-latch reset to
  `worker/deno/tests/pr_maintenance_command_test.ts`. `origin/main` then fixed
  the same flakiness itself (a42f06807), so the merge took main's copy and this
  PR no longer touches that file.

## Evidence

This is a backend comment-only change with no UI. Claims checked against the
head code:

- `worker/deno/lib/codex_executor.ts`: `buildCodexArgs` pushes `STANDARD_FLAGS`,
  then adds only the two `-c` overrides when `orchestrationRole` is set.
- `worker/deno/lib/agent_provider.ts`: `buildClaudeCliArgs` is the only place
  `--disallowed-tools` is emitted. The Codex descriptor passes `disallowedTools`
  to `buildCodexArgs` and `composeCodexPrompt`.
- `worker/deno/lib/orchestration/capabilities.ts`: `assertRoleSupported` admits
  Codex for the manager's denied list, and its own comment already says that
  Bash is not denied.

`docs/ROLE-CONFIGURATION.md` and the `read_only_guard.ts` header already
describe this correctly, so they are not edited. On the final head,
`git grep -i` (excluding `docs/archive/`) finds no remaining "Enforced sandbox",
"opt into the CLI sandbox", "every editing tool is denied" or "Enforced CLI
sandbox". The two remaining "sandboxed role" hits, in
`worker/deno/lib/codex_executor.ts` and
`worker/deno/tests/codex_role_read_only_guard_4356_test.ts`, explain why the CLI
sandbox was dropped, and they are still accurate.

Issue numbers cited: #4356 (`buildCodexArgs` sandbox bypass, already cited in
the code); #4986: preventing an orchestration call from switching to an unvetted
provider (per the issue body); #5153: ephemeral_root_telemetry_5105 'slow shared
scan' test races a setTimeout(0) and fails under parallel load (filed this run).

## Test Plan

- No test added or changed. The diff edits only comments.
- `deno fmt`, `deno check` and `deno test -A tests/agent_provider_codex_test.ts`
  (`worker/deno/tests/agent_provider_codex_test.ts`) on the edited
  `agent_provider.ts` passed: `ok | 24 passed | 0 failed`.
- `./quality.sh` on head `9bc77bcbd`: every stage passed except `deno tests`.
  Its parallel pass gave `FAILED | 34581 passed | 1 failed`. The one failure was
  `worker/deno/tests/ephemeral_root_telemetry_5105_test.ts` "the registered
  build probe returns low during one slow shared scan", a `setTimeout(0)` race
  under load that this diff does not touch. Run alone it gave
  `ok | 20 passed | 0 failed`. It is filed as #5153.
