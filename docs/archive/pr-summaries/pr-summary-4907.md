## Summary

The scheduler's spelling-fix and CI-fix callbacks in `createProductionRunCoreDeps` now build the quality and custom instructions and pass them to `processSpellingFailure` and `processCiFailure`, as the standalone `pr-spelling-processor` and `pr-ci-processor` commands already did. Before, the `<quality_instructions>` block rendered empty on the scheduler path and `custom_instructions` was dropped. Closes #4907.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- `prompts/ci_fix/prompt.md` and `prompts/spelling_fix/prompt.md` point the agent at `<quality_instructions>`; the scheduler path left it empty. The fix mirrors the standalone commands (`worker/deno/commands/pr_ci_processor.ts`, `pr_spelling_processor.ts`) and the PR-feedback callback.

### Essential Design Decisions

- CI fix: `runBudgetSeconds` is `reactivePhaseTimeout(config, "ci-fix")`, the same value the callback passes as `claudeTimeout`, with `pushGuarantee: "ci-fix"`. Spelling fix: `config.claudeTimeout` (what that callback passes as its timeout) with `pushGuarantee: "pre-flight-only"`, matching the standalone command.
- The two callbacks now use the factory's `setupRepoFn` / `runGitCommandFn` (defaults are the real `setupRepo` / `runGitCommand`, so production is unchanged), and four new optional test seams (`findFailedPrChecks`, `findFailedCiChecks`, `processSpellingFailure`, `processCiFailure`) default to the real functions.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI files. `docs/CONFIGURATION.md` ("spliced into every prompt with a `{{QUALITY_INSTRUCTIONS}}` placeholder") is now true for these two flows, so no doc edit was needed. Seams are read by production code (`options.X ?? X`) in `worker/deno/lib/run_core_production_deps.ts`.

## Test Plan

- Added `run-core spelling fix callback passes budgeted quality and custom instructions (Issue #4907)` and `run-core CI fix callback passes the CI budget and ci-fix push guarantee (Issue #4907)` in `worker/deno/tests/run_core_production_deps_test.ts`. Fixtures give distinct `claudeTimeout` (2400/3600) and `ciFixTimeout` (1200), so reading the wrong budget goes red; the CI test also asserts the ci-fix guarantee wording and the absence of the pre-flight wording.
- Red check: removing `qualityInstructions` / `customInstructions` from both processor deps made both new tests fail (37 passed, 2 failed); restored, `deno task test:unit tests/run_core_production_deps_test.ts` passes (39 passed).
- Callers checked: both scheduler callbacks changed; the standalone commands already passed the instructions.
- `./quality.sh < /dev/null` on the final head: passed (config integration and checkov skipped by the gate itself).
