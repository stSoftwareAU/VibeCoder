## Summary

The CI-fix base-branch deferral now compares the pull request's failure with
the red base run's log before accepting a `Depends on` claim. A red conclusion
alone can represent a different failure. Closes #4680.

- **Same:** every comparable PR failure line appears in the base log; defer
  without charging an attempt.
- **Different:** at least one comparable line is absent; follow the ordinary
  charged path.
- **Unreadable:** no comparable PR line or no readable base log; hold without
  charging, subject to the existing two-hold bound.

The base evidence remains the same check on the base head, or the same
workflow on a merged PR head with an identical tree. The worker does not rerun
the check on the base tree. Dependency audits retain their existing exception.
`VERSION` is unchanged.

## Spec

### Intent and Rationale

Comparing failure text prevents an unrelated red base check from automatically
deferring a PR failure. The comparison is conservative when logs cannot be read.

### Essential Design Decisions

`compareBaseFailure` extracts comparable failure lines, removes command echoes,
passing results, generic assertion and runner summaries, and compares all
remaining lines against the normalised base log. It recognises Jest, node:test,
TAP and Mocha failing-test names; TAP and Mocha sequence numbers are normalised.
Vitest file and test tallies are excluded, as are Deno, cargo, Jest and pytest
summaries. An annotation without a failure word is not comparable. Distinctive
failure text from other tools is still compared; unknown runner formats can
produce generic-only matches or prevent a match, so this is not proof that all
unrelated failures are distinguished.

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
  tests/pr_ci_processor_deferral_test.ts`: 58 passed, 0 failed.
- `worker/deno/tests/ci_base_failure_signature_test.ts::compareBaseFailure - TAP numbers change without changing the failure`
  covers shifted Bats and node:test numbers; the existing
  `compareBaseFailure - node and bats test names distinguish unrelated failures`
  now uses the same number for different names. The obsolete assumption that
  sequence numbers identify a test is replaced by name comparison.
- `worker/deno/tests/ci_base_failure_signature_test.ts::compareBaseFailure - Vitest file tallies do not obscure the same failure`
  covers changing file counts; generic tally comparison is obsolete and
  distinctive failure lines remain required.
- `worker/deno/tests/ci_base_failure_signature_test.ts::compareBaseFailure - Mocha names distinguish failures and ignore sequence numbers`
  covers both changed numbers and unrelated names with a shared assertion.
  These three tests failed before the fix and pass with it.
- `worker/deno/tests/ci_base_failure_signature_test.ts::compareBaseFailure - unrelated cargo and Deno failures do not match shared runner output`
  and `worker/deno/tests/pr_ci_processor_deferral_test.ts::processCiFailure - unrelated test failures sharing runner output are charged`
  cover different failures; `processCiFailure - same test failure with different tallies is deferred`
  covers the matching processor path.
- Existing deferral fixtures now include failure words in their semgrep and
  lint annotations because annotations without one are no longer comparable.
  The remaining deferral behaviour is covered by
  `worker/deno/tests/pr_ci_processor_deferral_test.ts::processCiFailure - a non-audit check with a Depends on line and a red base is still deferred (Issue #3141)`.

Risk: matching depends on the available log excerpts and recognised formats;
different excerpts can prevent deferral, and generic messages from unrecognised
formats can still match.
