## Summary

The CI-fix base-branch deferral now compares the pull request's failure with the
red base run's log before accepting a `Depends on` claim. A red conclusion alone
can represent a different failure. Closes #4680.

- **Same:** every comparable PR failure line appears in the base log; defer
  without charging an attempt.
- **Different:** at least one comparable line is absent; follow the ordinary
  charged path.
- **Unreadable:** no comparable PR line or no readable base log; hold without
  charging, subject to the existing two-hold bound.

The base evidence remains the same check on the base head, or the same workflow
on a merged PR head with an identical tree. The worker does not rerun the check
on the base tree. Dependency audits retain their existing exception. `VERSION`
is unchanged.

## Spec

### Intent and Rationale

Comparing failure text prevents an unrelated red base check from automatically
deferring a PR failure. The comparison is conservative when logs cannot be read.

### Essential Design Decisions

`compareBaseFailure` reads both logs the same way. It removes ANSI, timestamps,
the output tests print (Deno `------- output -------` blocks, Jest `console.*`
and `● Console` blocks, Vitest `stdout |` blocks) and joins a Mocha `1) Parser`
header to the `parses header:` line under it. Each line is canonicalised
(annotation prefix and workflow marker removed; durations, TAP and Mocha
sequence numbers, Deno source positions and counts beside `passed`, `failed`,
`tests` and similar words replaced).

The pull request's comparable lines then exclude command echoes, passing test
lines in every runner format, lines made only of `<count> <word>` groups
whatever the noun (pytest warnings and deselected, PHPUnit `Deprecations: 3`),
the runner's exit line, generic assertion lines, assertion-library headers
(`Values are not equal.`, `throw new AssertionError(...)`), remote library stack
frames and Jest's `Test suite failed to run`. A failing-test name (Jest `●`, `✕`
and `FAIL file.test.js`, node:test `✖`, Bats `✗`, TAP `not ok`, Mocha `N)`,
Vitest `FAIL a > b`, pytest `FAILED id::name`, Go `--- FAIL:`, Deno or cargo
`name ... FAILED` and Deno `name => path:line:col`) must equal a whole base-log
line; other lines (annotation messages, lines with a failure word) may sit
inside a longer base line.

When no line qualifies, distinctive rule identifiers and file loci in the
failing step output are compared with standalone numbers ignored. Run metadata
and generic command echoes are not evidence; without a distinctive line the
result is unreadable. Deno formatter `from <path>:` lines identify files and its
file-count summary is ignored. Deno failure-section and Jest suite-failure
headers without a test or suite locus are unreadable.

Limits: output that a passing test prints without a recognised block marker
(inline logger lines in Mocha or node:test) is still compared, and unrecognised
runner formats can still match on or miss generic lines. This is not proof that
every unrelated failure is told apart.

### Undiscoverable Facts

The log fetcher receives the base check-run ID. The worker relies on the
available excerpt and does not reproduce the check on the base tree.

## Evidence

Backend-only change. `compareBaseFailure` is called by
`_resolveBaseBranchDeferral` in `worker/deno/lib/pr_ci_processor.ts` and uses
the injected Actions log fetcher. The matching rule is documented in
`docs/workflows/ci-fix.md`, `prompts/ci_fix/prompt.md`, `docs/PROMPTS.md`,
`CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`; the latter two
are twinned restatements. The new module has a lib-sweep coverage entry.

## Test Plan

- `deno task test:unit tests/ci_base_failure_signature_test.ts
  tests/pr_ci_processor_deferral_test.ts`:
  81 passed, 0 failed (45 and 36 tests respectively).
- `worker/deno/tests/ci_base_failure_signature_test.ts` covers Jest console
  output, differing formatter file loci and counts, and generic npm output.
  `worker/deno/tests/pr_ci_processor_deferral_test.ts` covers deferral using
  real Semgrep job 101249366081 output with different commit IDs and event, and
  formatter failures on the same or different files.
- The obsolete fallback compared all step output, including run metadata and
  command echoes. The remaining behaviour compares distinctive rule or file
  evidence and holds generic-only output as unreadable. Coverage:
  `worker/deno/tests/ci_base_failure_signature_test.ts::compareBaseFailure - generic npm step output is unreadable`
  and
  `worker/deno/tests/pr_ci_processor_deferral_test.ts::processCiFailure - real semgrep output ignores run-specific metadata`.
- The Jest fixture now includes the default reporter’s `● Console` header; it
  still verifies that the actual failure matches despite passing test output:
  `worker/deno/tests/ci_base_failure_signature_test.ts::compareBaseFailure - output a passing test prints is not part of the failure, in Deno, Jest and Vitest`.
- The obsolete Jest expectation excluded `FAIL <file>`; suite file identity
  remains required evidence, covered by
  `worker/deno/tests/ci_base_failure_signature_test.ts::compareBaseFailure - Jest identifies the failing test rather than shared suite output`.
  The Semgrep and lint annotations retain their original wording without an
  added failure word; deferral remains covered by
  `worker/deno/tests/pr_ci_processor_deferral_test.ts::processCiFailure - a Depends on line with a red base defers once, charging no attempt (Issue #1880)`
  and `worker/deno/tests/pr_ci_processor_deferral_test.ts::processCiFailure - a non-audit check with a Depends on line and a red base is still deferred (Issue #3141)`.
- The matching rule is documented in `docs/workflows/ci-fix.md` and
  `prompts/ci_fix/prompt.md`; both were updated together.

Risk: comparison depends on available excerpts and recognised formats;
unrecognised generic messages can still match, and missing evidence can hold a
claim even where the underlying failure is the same.
