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

`compareBaseFailure` canonicalises every line of both logs the same way
(annotation prefix, timestamp and workflow marker removed; durations, TAP and
Mocha sequence numbers and the counts beside `passed`, `failed`, `failures`,
`tests` and similar words replaced). It then drops command echoes, passing test
lines in every runner format (`... ok`, TAP `ok <n>`, `✓`, `✔`, `√`, `--- PASS`,
`PASS`, pytest `PASSED`), lines made only of a test-run tally (including
minitest's generic `1) Failure:` header), the runner's exit line and other
generic assertion or command-failed lines. A failing-test name (Jest `●`/`✕`,
node:test `✖`, Bats `✗`, TAP `not ok`, Mocha `N)`, Vitest `FAIL a > b`, pytest
`FAILED id::name`, Go `--- FAIL:`, Deno or cargo `name ... FAILED`) must equal a
whole base-log line, so a name that is a prefix of a different test's name does
not match. Other lines (annotation messages, lines with a failure word) may sit
inside a longer base line. An annotation without a failure word is not
comparable. Unknown runner formats can still produce generic-only matches or
prevent a match, so this is not proof that all unrelated failures are
distinguished.

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
  63 passed, 0 failed.
- `worker/deno/tests/ci_base_failure_signature_test.ts` (33 tests at head) and
  `worker/deno/tests/pr_ci_processor_deferral_test.ts` (31 tests at head).
- Review round 3 and 4 tests, six of the 33 in
  `worker/deno/tests/ci_base_failure_signature_test.ts`:
  - `compareBaseFailure - a passing test whose name holds a failure word is not evidence, in every runner format`
    (Bats and node:test TAP with shifted numbers, node:test spec, Mocha, Jest
    verbose, Go, pytest verbose) gives `same`.
  - `compareBaseFailure - changing test counts in any runner's tally do not obscure the same failure`
    (pytest -q, RSpec, Bats pretty, Maven, dotnet, minitest) gives `same`.
  - `compareBaseFailure - a test name that is a prefix of another base test name is different`
    (Jest, Mocha, TAP, Deno) gives `different`, with a timestamped `same`
    control.
  - `compareBaseFailure - generic failure headers never stand for a failing test`
    (minitest is unreadable and never fetches the log; Bats pretty with
    different tests is `different`).
  - `failureSignatureLines - tally and count normalisation stays bounded on hostile input`
    covers the two count regexes with long runs of the shared characters.
  - `failureSignatureLines - tally detection drops count-only lines and keeps lines without a count or words`
    pins `isTallyLine` directly: `tests failed in 3m4s` is dropped, while
    `Total test failure result` and `✖ ✖` are kept. Each of the three survivors
    (`tokens === null` returning true, `hasCount` starting true, the `dur`
    operand dropped) turns it red.
  - Against the previous commit's module, the first four fail and the
    hostile-input test passes on both, as it guards the new regexes only.
- Branch outcomes, each flipped on its own with the named tests going red:
  passing-line drop (removed: the passing-line test fails), tally drop (removed:
  the tally, minitest header, Jest, Vitest and variable-output tests fail),
  whole-line test names (substring match restored: the prefix test fails), count
  normalisation (removed: the tally test fails), minitest header vocabulary
  (`failure` removed from the tally words: the generic-header test fails).
- Existing tests that earlier rounds edited keep their reasons: the semgrep and
  lint annotations in `pr_ci_processor_deferral_test.ts` carry a failure word
  because an annotation without one is not comparable; the deferral and charged
  paths are covered by
  `worker/deno/tests/pr_ci_processor_deferral_test.ts::processCiFailure - a non-audit check with a Depends on line and a red base is still deferred (Issue #3141)`,
  `processCiFailure - unrelated test failures sharing runner output are charged`
  and `processCiFailure - same test failure with different tallies is deferred`.

Risk: matching depends on the available log excerpts and recognised formats;
different excerpts can prevent deferral, and generic messages from unrecognised
formats can still match.
