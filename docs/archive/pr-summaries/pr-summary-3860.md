# The diff-scoped mutation gate now mutates changed shell scripts

## Summary

The diff-scoped mutation gate (#3393) mutated only Deno/TypeScript and Rust, so
fleet PRs could ship `.sh` changes that no test pinned. The gate now detects
changed shell scripts (`.sh`, `.bash`, or an `sh`/`bash` shebang), mutates their
added lines with a built-in shell mutator, and runs the covering shell tests.
A changed script that no test names is reported `not_checked`: blocked, never a
pass, never survivors. The Deno/Cargo pass and the shell pass share one budget
and their results are merged, the worst outcome winning. `docs/mutation-check.md`
documents the shell pass, the `not_checked` outcome and the merged flow.

Fix for the PR-summary gate retry: the structural-word list, the shell
test-file walker and the shebang check now each have a test that goes red when
the line is changed, and one redundant early return in the shell pass
(`covered.length === 0`) was removed because its removal changed no outcome.

Closes #3860.

## Test Plan

No assertion was removed from an existing test. The only removed test line is
an import (`import { assert, assertEquals, assertStringIncludes } from "@std/assert";`)
that gained further names; every test change adds tests.

New tests in `worker/deno/tests/mutation_gate_test.ts` and
`worker/deno/tests/mutation_runner_test.ts` cover the shell mutator, detection,
the `not_checked` gate verdict and the merge of results, including
`each structural word as a command is never deleted or guarded` (kills the
deleted `elif`, `while`, `until`, `do`, `in`, `select`, `function` and `{` list
entries), `defaultMutationRunnerSeams listShellTestFiles - …` (reaches the real
`listShellTestFiles` seam) and `an extensionless file is a script only when its
shebang names sh or bash`.

**Docs sweep** — grep: `generateDenoMutants`, `MutationLanguage`, `not_checked`, "mutation check", "Not applicable"; section: `docs/mutation-check.md#built-in-shell-mutations`; siblings: `isDenoSource`, `generateDenoMutantsDetailed` (the shell mutator mirrors it; the Deno mutation tables name their own lists); updated: `docs/mutation-check.md`

**Branch outcomes:**
- `worker/deno/lib/mutation_gate.ts:883` — success/fail-closed (shebang names `sh`/`bash` vs another interpreter) — `worker/deno/tests/mutation_gate_test.ts::hasShellShebang` tests — flipped to `return true`, test went red
- `worker/deno/lib/mutation_gate.ts:889` — success (`.bats` is a test file) — `worker/deno/tests/mutation_gate_test.ts::isShellTestFile` tests — flipped to never true, tests went red
- `worker/deno/lib/mutation_gate.ts:943` — absent (structural word is not deletable) — `worker/deno/tests/mutation_gate_test.ts::generateShellMutantsDetailed - each structural word as a command is never deleted or guarded` — deleted each of `elif`, `while`, `{`, `in` from the set, test went red
- `worker/deno/lib/mutation_gate.ts:1065` — absent (comment line yields nothing) — `worker/deno/tests/mutation_gate_test.ts::generateShellMutantsDetailed - comment and blank lines yield nothing` — flipped to mutate comments, test went red
- `worker/deno/lib/mutation_gate.ts:1168` — error/fail-closed (`not_checked` blocks, no survivors) — `worker/deno/tests/mutation_gate_test.ts::evaluateMutationGate - not_checked blocks and never reports survivors` — flipped to `blocked: false`, tests went red
- `worker/deno/lib/mutation_runner.ts:420` — error (merged `not_checked` keeps its kind) — `worker/deno/tests/mutation_runner_test.ts::mergeMutationResults - the more severe kind wins whichever side it is on` — branch disabled, tests went red
- `worker/deno/lib/mutation_runner.ts:502` — absent (extensionless file without an `sh`/`bash` shebang is not a script) — `worker/deno/tests/mutation_runner_test.ts::runMutationCheck shell - an extensionless file is a script only when its shebang names sh or bash` — branch disabled, test went red
- `worker/deno/lib/mutation_runner.ts:624` — error/success (a covered script's survivors are named when another script is `not_checked`; a runner error passes through) — `worker/deno/tests/mutation_runner_test.ts::runMutationCheck shell - a covered script's survivors are named when another script is not_checked` — flipped to always return the run result, test went red
- `worker/deno/lib/mutation_runner.ts:1348` — success (real seam lists shell tests only, skips `node_modules`, sorted) — `worker/deno/tests/mutation_runner_test.ts::defaultMutationRunnerSeams listShellTestFiles - finds shell tests, skips other files and skipped dirs, sorted` — flipped to match nothing, test went red
