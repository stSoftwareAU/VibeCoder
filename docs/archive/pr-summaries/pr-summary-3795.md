## Summary

Adds the coverage carry-over check, a PR-raise gate beside the mutation check. When a PR deletes an existing Deno test file or removes lines from one, the gate runs the base versions of those tests with line coverage at the merge base. It keeps the production lines they executed that are still present and unchanged at head, then blocks when no head test executes one of them. This catches the `rewritten-test-drops-live-branch` pattern: a test the issue rightly retires was the only test of a branch the PR leaves in place. Closes #3795.

## Spec

### Intent and Rationale

- The removed-assertion gate judges the stated reason and the mutation check mutates only added lines, so an unchanged branch orphaned by a retired test went unchecked. Which lines a test reaches is a runtime property, so the check measures coverage instead of reading source.
- A worker gate, not an optional task: the miss is information the agent never looks at.

### Essential Design Decisions

- Tests run only for PRs that remove test lines; every other PR pays only the diff collection, and pure test additions run no tests. A PR diff that cannot be collected (including an unresolvable base ref) is an error and blocks, whatever the PR touches. The base run covers only the removed or edited test files, in a temporary detached `git worktree` that is removed afterwards.
- Lines are mapped through `git diff --unified=0 --no-renames <base>...HEAD`; deleted or rewritten lines are out of scope. With `--no-renames`, a renamed production file counts as deleted and is not checked.
- The head side runs in two steps, per Deno project: first the head versions of the edited tests that still exist; then, only for files that still have an unexecuted carried line, the tests that import that file directly (`SIMPLE-ON-PURPOSE`), skipping the edited tests already run. Importers run one carried file at a time in its own batch, and what is still unexecuted is recomputed after each batch, so a file reached by an earlier batch's importer (directly, or through that importer's own imports) is skipped — a deleted whole test file whose loaded modules share importers runs a bounded number of them, not every importer of every module in one `deno test` call. When the edited tests reach every carried line, no importer runs. A line reached only indirectly is reported and can be exempted with the mutation check's `` `path:line` exempt (untestable): <reason> `` convention (`parseMutationExemptions` is reused).
- A runner error fails closed (blocks); a budget exhaustion (fixed 600 s) warns and never passes; `skip_coverage_carryover_check` opts a repository out. The verdict sets `needsTestChanges`, so the recovery turn may add tests.

### Undiscoverable Facts

- Rust is not checked yet: the container installs `cargo-mutants` but not `cargo-llvm-cov`. A diff that removes lines from a `.rs` file under a `tests/` directory (and from no Deno test file) reports not applicable with that reason; any other Rust change, including a removed `#[cfg(test)]` unit test in `src/`, reports the generic "removes no lines from an existing Deno test file" reason.
- Observed: `deno coverage --lcov <dir>` prints `SF:/abs/path/m.ts` and `DA:<line>,<count>` records and leaves `*_test.ts` files out by default.

## Evidence

Backend/worker change; no UI files touched. Two real git + deno integration tests build a repository, delete the only test reaching a branch, and assert that branch's line is reported (and cleared when the remaining test reaches it).

```mermaid
flowchart TD
    A["PR summary final"] --> P{"PR diff collected?"}
    P -- no --> X
    P -- yes --> B{"diff removes lines from a Deno test?"}
    B -- no --> Z["Not applicable"]
    B -- yes --> C["Merge-base worktree: run base tests with --coverage"]
    C --> D["Map executed lines through the diff to head"]
    D --> E["Head: run the edited head tests with --coverage"]
    E --> I["Head: direct importers of files with a carried line still unexecuted"]
    I --> F{"carried line unexecuted and not exempt?"}
    F -- yes --> X["Block: recovery turn names file:line"]
    F -- no --> Z2["Raise PR"]
```

**Docs sweep** — grep: `skip_mutation_check`, "mutation check", "late summary gates", "late-summary gates"; section: `docs/mutation-check.md#flow`; siblings: `skip_mutation_check`, `mutation_check_budget_seconds` — the new `skip_coverage_carryover_check` row sits beside them in `docs/CONFIGURATION.md`; updated: `docs/coverage-carryover-check.md` (new; its when-it-runs, steps, Rust, outcomes and limits text matches the head code), `README.md`, `docs/CONFIGURATION.md`, `docs/mutation-check.md` (its late-summary-gate list now names the coverage carry-over check and the pre-PR verifier, matching `lateSummaryVerdicts`), comments in `worker/deno/lib/phases/completion_phase.ts`; `docs/workflows/issue-processing.md:2213` — still true because that list names the summary gates the claim check orders against and already omits the mutation check, so it is not a list of every late gate.

Issue numbers cited: #3795: Fleet PRs that rewrite or delete a test the issue retires leave a still-live branch with no test; #3393 and #3131 are cited only as the existing mutation and removed-assertion gates.

## Test Plan

- New: `worker/deno/tests/coverage_carryover_gate_test.ts` (diff parsing and line mapping, lcov parsing, verdict and comment).
- New: `worker/deno/tests/coverage_carryover_runner_test.ts` (fake-seam runner paths plus two real git + deno integration tests). Head-side narrowing: `the edited head test runs first, and importers run only for files it leaves unreached`, `when the edited head test reaches every carried line, no importer runs`, `a failing edited head test stops the check before any importer runs`, `importers run one carried file at a time and a file reached by an earlier batch is skipped`.
- New: `worker/deno/tests/completion_phase_coverage_carryover_gate_test.ts` (live completion phase: blocks, exemption, budget, fail-closed error, uncollectable diff, skip switch, unwired runner).
- Added tests to `worker/deno/tests/config_test.ts` (the `skip_coverage_carryover_check` key) and `worker/deno/tests/issue_worker_wiring_test.ts` (default wiring). No existing assertion is removed or edited.
- Pre-PR verifier repro: in a scratch worktree, the `config - getEnvOrDefault returns env var when set` case was removed from `worker/deno/tests/config_test.ts` and committed, and the runner was run against it with the real seams. Before the fix the head side selected 824 test files and hit the 600 s budget (the verifier's measurement). After it, the edited head `config_test.ts` alone reached all 5018 carried lines, no importer ran, and the check completed in 1.3 s with nothing uncovered.
- Red checks: widening the importer candidates back to every carried file turned `the edited head test runs first, and importers run only for files it leaves unreached` red; dropping the exemption line comparison, computing the insertion hunk end as `os + oc - 1`, replacing the base-failure cause with a fixed string, deleting the completion phase's standalone block, forcing the skip condition false, and removing the `createDefaultDeps` wiring each turned the named tests red; each was restored.
- Before integration, `./quality.sh < /dev/null` passed after the lib sweep ledger and head-side narrowing fixes (optional config integration skipped). This is historical validation of the earlier branch, not a full-gate result for the merged head.
- Integration with main `ec79d58b` retains both the coverage carry-over and security-fix discrimination runners, their wiring tests and the review-fix mutation documentation. The eight focused coverage/config/wiring/security suites pass with type checking: 329 tests, no failures, including both real-git coverage integrations. No existing assertion was removed or weakened; the branch-outcome citations are mapped to the integrated source. The subsequent main `3b6cc28f` summary integration also passes the body-sync, summary-loader and facts suites with type checking. Required hosted checks validate the pushed head.
- Entry points checked: `completionBody` (the standalone block and the `lateSummaryVerdicts` fold), `createDefaultDeps` (default wiring), `loadConfig` (repo_config key).
- Known limit: git C-quotes paths with non-ASCII or special characters; such a test file is not recognised, so its removal is not checked.

<!-- vibe-branch-outcomes -->
