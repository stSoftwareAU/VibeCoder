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

Fix for the second retry: a `bash -n` that exits 126 or 127 (bash missing or not
executable) is no longer counted as an unviable mutant, which let the run report
`completed` with nothing tested. `runMutantLoop` now returns an `error` saying
bash is unavailable, and the script is restored. `docs/mutation-check.md` now
says that a `foo()` header with the brace on the next line is not recognised as
structural, and that a covered-scripts `error` (failing baseline or bash
unavailable) is returned as the result rather than `not_checked`.

Closes #3860.

## Spec

The issue asks that the diff-scoped mutation gate also cover changed shell
scripts. Each requirement and how this change meets it:

- **Shell is a mutation language.** `shell` is added to `MutationLanguage`, and
  a built-in shell mutator (`generateShellMutantsDetailed`) sits beside the Deno
  one.
- **Detection regardless of repo language.** A changed file is a shell script
  when its name ends in `.sh` or `.bash`, or when it is extensionless and its
  first line is an `sh` or `bash` shebang (`hasShellShebang`). The repo's own
  language does not matter.
- **A Deno repo with `.sh` changes runs both passes.** The Deno/Cargo pass and
  the shell pass both run; their results are merged.
- **Line-based mutator operators.** Shell mutants are made per added line (guard
  insertion, operator flips, return and exit flips, and statement deletion to
  `:`), not from a parsed syntax tree.
- **Covering-test discovery.** A script is covered when a shell, bats or Deno
  test names its repo-relative path or its basename. A script with no covering
  test is `not_checked`, which blocks the gate.
- **Shared budget and result.** The shell pass draws on the same budget clock as
  the Deno pass, and the merged result takes the worst kind.
- **`bash -n` rejects are unviable.** A mutant that `bash -n` rejects is unviable:
  it is neither killed nor a survivor. Exit 126 or 127 is not a rejection: it is an `error` (bash unavailable).
- **Case syntax is never replaced by `:`.** Case patterns and their `;;`
  terminators are never mutated by `:` replacement.
- **Out of scope.** #3901 and #3875 are untouched by this change.

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

**Red-checks** (temporary breaks in `worker/deno/lib/`, each restored with
`git checkout --`, run with `deno task test:unit tests/mutation_gate_test.ts tests/mutation_runner_test.ts < /dev/null` from `worker/deno`):
- `lib/mutation_runner.ts:327` `else if (syntax.code !== 0) unviable = true;` removed: `runMutationCheck shell - a mutant bash -n rejects is unviable, not killed, and parseable siblings are still killed` went red.
- `lib/mutation_runner.ts:327` 126/127 branch disabled: `runMutationCheck shell - bash -n exiting 127 is an error, not unviable mutants and a clean pass` went red.
- `lib/mutation_gate.ts:956` whole case-pattern guard disabled: `generateShellMutantsDetailed - case patterns and terminators are never deleted` and `generateShellMutantsDetailed - a command beside case clauses still mutates, as do $(...) statements` went red.
- `lib/mutation_gate.ts:956` `SHELL_CASE_PATTERN` operand alone removed: the same two tests went red.
- `lib/mutation_gate.ts:956` `SHELL_CASE_TERMINATOR` operand alone removed: `generateShellMutantsDetailed - case patterns and terminators are never deleted` went red.

**Docs sweep** — grep: `generateDenoMutants`, `MutationLanguage`, `not_checked`, "mutation check", "Not applicable"; section: `docs/mutation-check.md#built-in-shell-mutations`; siblings: `isDenoSource`, `generateDenoMutantsDetailed` (the shell mutator mirrors it; the Deno mutation tables name their own lists); updated: `docs/mutation-check.md`

<!-- vibe-branch-outcomes -->
