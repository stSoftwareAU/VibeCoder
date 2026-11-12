## Summary

Corrected four doc comments that claimed a sandbox or an enforced tool denial
for orchestrator role calls that Codex does not get. No production code line
changed. Also cleared a process-wide quota latch at the start of the faked
`pr-maintenance` tests. Without that, a rate-limited host failed them and the
pre-push gate refused this branch. Closes #4981.

## Spec

### Intent and Rationale

- Since Issue #4356, `buildCodexArgs` (`worker/deno/lib/codex_executor.ts`) always pushes `STANDARD_FLAGS`, which include `--dangerously-bypass-approvals-and-sandbox`. A role call only adds `approval_policy="never"` and `features.multi_agent=false`. The comments said otherwise, which invited callers to build a boundary on a sandbox that does not exist.
- `disallowedTools` becomes `--disallowed-tools` only in `buildClaudeCliArgs` (`worker/deno/lib/agent_provider.ts`). Codex receives the list as prompt text, so the `MANAGER_DENIED_TOOLS` comment now says the denial is enforced only on the Claude CLI path.

### Essential Design Decisions

- The comments say the container is the boundary, and that read-only roles rely on checkout restoration (`worker/deno/lib/orchestration/read_only_guard.ts`), which does not deny Bash. They never call restoration an OS sandbox.
- A fourth comment beyond the issue's three, `RunClaudeOptions.orchestrationRole` in `worker/deno/lib/claude_runner.ts`, made the same "Enforced CLI sandbox" claim, so it is fixed here too.
- Preventing an orchestration call from switching to an unvetted provider is left to #4986, as the issue says.
- The test fix calls the production helper `clearPrimaryQuotaLatch()` (`worker/deno/lib/primary_quota_latch.ts`, also called in `worker/deno/lib/run_core.ts`) next to the existing `_resetMergeQueueMemo()`. It does not fake every real-`gh` test in the file, because that would be a larger rewrite outside this issue.

### Undiscoverable Facts

- The `MANAGER_DENIED_TOOLS` instance was reported in an issue comment by the PR reviewer, not in the issue body.
- On this host, the earlier tests in `worker/deno/tests/pr_maintenance_command_test.ts` that call the real `gh` hit GitHub's secondary GraphQL rate limit. `noteSecondaryLimitCooldown` (`worker/deno/lib/github.ts`) then latched a 60s pause, and the faked Issue #4424 and #4613 tests skipped their calls. The five tests failed the same way on `origin/main`, passed when run alone, and main's CI (where `gh` is not rate-limited) stayed green.

## Evidence

Backend change: doc comments plus one test file; no UI. `docs/ROLE-CONFIGURATION.md` and the `read_only_guard.ts` header already describe the behaviour correctly, so they are not edited. A grep of `worker/deno/lib`, `worker/deno/tests` and `docs/` (excluding `docs/archive/`) for the old phrases ("Enforced sandbox", "opt into the CLI sandbox", "every editing tool is denied", "Enforced CLI sandbox") finds no remaining hit.

## Test Plan

- `worker/deno/tests/pr_maintenance_command_test.ts`: added `clearPrimaryQuotaLatch()` at the start of the Issue #4424 merge-queue test and in the `strictRefreshPutCount` helper used by the four Issue #4613 tests. No assertion was removed or changed.
  - Red without the change: `deno task test:unit ./tests/pr_maintenance_command_test.ts` gave `FAILED | 23 passed | 5 failed` (on this branch and on `origin/main`). With the change it gave `ok | 28 passed | 0 failed`.
- Comment edits: `deno fmt --check` and `deno check` on the four touched lib files passed. `deno test -A` on `agent_provider_codex_test.ts`, `codex_role_read_only_guard_4356_test.ts`, `claude_runner_test.ts`, `claude_runner_command_test.ts`, `orchestration_3642_orchestrator_test.ts` and `role_configuration_3643_test.ts` (all under `worker/deno/tests/`) passed: 143 passed, 0 failed.
- Full unit suite on head `75600cee`: `deno task test:unit` (the pre-push gate plans 1,893 test files for this diff, effectively the whole suite) gave `ok | 34432 passed | 0 failed` for the parallel pass and `ok | 1038 passed | 0 failed` for the serial pass. `./quality.sh` passed (config integration and checkov skipped by the gate itself).
- Not checked: the other real-`gh` tests in `pr_maintenance_command_test.ts` still reach GitHub. They pass, but they are not hermetic.
