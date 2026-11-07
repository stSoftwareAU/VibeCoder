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
blocks, Vitest `stdout |` blocks) and joins a Mocha `1) Parser` header to the
`parses header:` line under it. Each line is canonicalised (annotation prefix
and workflow marker removed; durations, TAP and Mocha sequence numbers, Deno
source positions and counts beside `passed`, `failed`, `tests` and similar
words replaced).

The pull request's comparable lines then exclude command echoes, passing test
lines in every runner format, lines made only of `<count> <word>` groups
whatever the noun (pytest warnings and deselected, PHPUnit `Deprecations: 3`),
the runner's exit line, generic assertion lines, assertion-library headers
(`Values are not equal.`, `throw new AssertionError(...)`), remote library
stack frames and Jest's `Test suite failed to run`. A failing-test name (Jest
`●`, `✕` and `FAIL file.test.js`, node:test `✖`, Bats `✗`, TAP `not ok`, Mocha
`N)`, Vitest `FAIL a > b`, pytest `FAILED id::name`, Go `--- FAIL:`, Deno or
cargo `name ... FAILED` and Deno `name => path:line:col`) must equal a whole
base-log line; other lines (annotation messages, lines with a failure word) may
sit inside a longer base line.

When no line qualifies, the lines of the failing step's own output (between its
`##[endgroup]` and `##[error]Process completed with exit code` lines) are
compared with standalone numbers ignored. That reads checks that print rule ids
rather than failure words (semgrep). Without such a step the failure is
unreadable, as is a failure whose only lines are generic.

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
  tests/pr_ci_processor_deferral_test.ts`: 76 passed, 0 failed.
- `worker/deno/tests/ci_base_failure_signature_test.ts` (42 tests at head) and
  `worker/deno/tests/pr_ci_processor_deferral_test.ts` (34 tests at head).
- Review round 5 tests (PR #4873 review), against the previous commit's module
  the run was 52 passed, 24 failed, the new tests among the failures:
  - `compareBaseFailure - output a passing test prints is not part of the failure, in Deno, Jest and Vitest`
    (Deno output and pre-test output, Jest `console.error`, Vitest `stdout |`).
  - `failureSignatureLines - an unclosed Deno output block ends at the omission marker`.
  - `compareBaseFailure - a check printing rule ids rather than failure words is compared on its step output`
    and `compareBaseFailure - the step-output fallback needs a failing step and is unreadable without one`
    (semgrep: same rule `same` with a shifted line, another rule `different`).
  - `compareBaseFailure - counts beside any noun in a tally line do not obscure the same failure`
    (pytest warnings, banner form, deselected, xfailed; PHPUnit Deprecations).
  - `compareBaseFailure - Deno tests with the same bare assertion are told apart by name and position`,
    `compareBaseFailure - Jest suite failures in different files are different`
    and `compareBaseFailure - Mocha failures under one describe block are told apart by test name`.
  - `failureSignatureLines - the new line patterns stay bounded on hostile input`.
  - `processCiFailure - a semgrep failure with no failure word in its output is deferred when the base log shows the same rule (Issue #4680)`,
    `processCiFailure - a semgrep failure whose base log names another rule is charged, neither deferred nor held (Issue #4680)`
    and `processCiFailure - output a passing test prints and changing test tallies do not stop the deferral (Issue #4680)`.
- Edited expectations: `failureSignatureLines(generic)` in
  `compareBaseFailure - Jest identifies the failing test rather than shared suite output`
  now expects `["fail src/sum.test.js"]` (the Jest `FAIL <file>` line is a
  suite locus, kept so suite failures in different files differ); the
  `different` assertion of that test still goes red if the `●` name is ignored.
  The semgrep and lint annotations in `pr_ci_processor_deferral_test.ts` are
  back to `semgrep: blocking code rules fired ...` and `lint: no-unused-vars`
  (no failure word); the fixtures now give the failing job a log whose step
  output holds them, so those tests reach the step-output fallback.
- Branch outcomes, each flipped on its own with the named tests going red
  (one test failing unless stated): Jest `console.*` skip, Vitest `stdout |`
  skip, Deno `pre-test` form, omission-marker end of a Deno block, Mocha
  header join, loose number matching of step output (2 failing), Deno
  position normalisation, `Deprecations: 3` label rule, noun-after-count rule
  (2 failing), remote library frame drop, Jest suite-failed line drop, Jest
  `FAIL file.test.js` as a test name, step boundary stop (9 failing). Every
  flip was run against both test files.
- Callers checked: `failureSignatureLines` is called only by the tests and
  `compareBaseFailure`; `compareBaseFailure` only by `_resolveBaseBranchDeferral`
  in `worker/deno/lib/pr_ci_processor.ts`, whose three outcomes the processor
  tests above reach.
- Docs: `docs/workflows/ci-fix.md` (the Issue #4680 comparison section and its
  two flowcharts) and `prompts/ci_fix/prompt.md` (the **Red** paragraph) were
  re-read and corrected; `docs/PROMPTS.md`, `CODING-STANDARDS.md` and
  `prompts/coding_guidelines/prompt.md` do not state the matching rule.

Risk: matching depends on the available log excerpts and recognised formats;
different excerpts can prevent deferral, and generic messages from unrecognised
formats can still match.
