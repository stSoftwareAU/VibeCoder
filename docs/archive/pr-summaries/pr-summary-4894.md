## Summary

The `deno-quality` workflow template now runs `deno check .` instead of `deno check mod.ts`, so it works in Deno repositories whose entry point is not a root `mod.ts`. Closes #4894.

## Spec

### Intent and Rationale

- The spec applies to any repo with a root `deno.json`/`deno.jsonc`; naming `mod.ts` made the job fail with module-not-found where that file is absent. Checking the project without naming a file removes the repository-specific assumption (the issue's first suggested fix).

### Essential Design Decisions

- `deno check .` (observed on Deno 2.9.8: checks every module in the directory, exits 1 on a type error). The `deno check` detection pattern still matches, so existing audits recognise the step.

### Undiscoverable Facts

- None.

## Evidence

Backend/CLI only. Ran `deno check .` in a scratch project with `main.ts` and no `mod.ts`: exit 0; adding a file with a type error: exit 1.

## Test Plan

- Added `worker/deno/tests/workflow_definitions_test.ts` test "deno-quality template type-checks without naming an entry-point file (Issue #4894)". Red check: restoring `deno check mod.ts` in `worker/deno/lib/workflow_definitions.ts` makes it fail; with the fix it passes.
- `deno task test:unit` over `workflow_definitions_test.ts`, `linter_in_ci_check_test.ts`, `baseline_gate_test.ts`, `branch_protection_definitions_test.ts`, `workflow_auditor_test.ts`, `workflow_sync_actions_test.ts`, `workflow_template_audit_conformance_test.ts`: passed.
- Docs grep for `deno check mod.ts` outside the archive: no hits. `linter_in_ci_check_test.ts` uses `mod.ts` only as an input fixture for the auditor, unrelated to the template.
- `./quality.sh`: every stage passed except `deno tests`, where 6 tests failed in `worker/deno/tests/merge_fallback_issue_test.ts` and `worker/deno/tests/pr_maintenance_command_test.ts` (gh-call-routing assertions, e.g. "expected a merge-queue rules read"). They fail identically when run alone and exercise no workflow template code, so they are unrelated to this change; I did not run them against the base branch to confirm they are pre-existing.
