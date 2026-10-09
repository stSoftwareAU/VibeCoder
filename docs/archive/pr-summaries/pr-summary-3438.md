# Match removed assertions against the uncapped Test Plan body (Issue #3438)

## Summary

Before this fix, the removed-assertion gate compared each removed assertion with a Test Plan body that was cut to 2,000 canonical characters. An assertion named after that point was reported as unaccounted. The gate now compares against the whole canonical Test Plan body. The summary scan is still bounded by `MAX_SUMMARY_SCAN_CHARS` (200,000).

Closes #3438

## Spec

### Intent and Rationale

- The gate must accept an assertion named anywhere in the Test Plan, not only in its first 2,000 canonical characters. #3402 failed while its four assertions were listed below a test-command line, and passed once they were moved to the top of the Test Plan.

### Essential Design Decisions

- Both forms of the Test Plan body now use `canonicaliseUncapped`: the markdown-unescaped form (via `canonicaliseTestPlanBody`) and the raw form.
- A removed assertion's own canonical form is still capped by `MAX_CANONICAL_CHARS`. The issue only concerns the Test Plan side.

### Undiscoverable Facts

None.

## Evidence

- Regression tests in `worker/deno/tests/removed_assertion_gate_test.ts`:
  - `validateRemovedAssertions accounts for an assertion named after 2,000 canonical chars of the Test Plan` covers the unescaped path.
  - `validateRemovedAssertions matches a regex-escaped assertion named verbatim after 2,000 canonical chars` covers the raw path.
  - `validateRemovedAssertions still blocks a long Test Plan that does not name the removed assertion` is the negative case.
- `./quality.sh < /dev/null` passed. It reported "Result: PASSED (with skipped checks)" because config integration was skipped with no `.config.json`.

**Docs sweep** — grep: `MAX_CANONICAL_CHARS`, `canonicalise`, `2,000`, `removed-assertion`; section: the docs that describe the removed-assertion gate; updated: the doc comments on `MAX_CANONICAL_CHARS`, `canonicalise` and `canonicaliseTestPlanBody` in `worker/deno/lib/removed_assertion_gate.ts`; `docs/SECURITY-SCAN.md:671` — still true because it is about suppression markers; `worker/deno/lib/suppression_comments.ts:245` — still true because it is about suppression markers; `docs/PROMPTS.md:30` — still true because it describes the gate without a length cap; `worker/deno/tests/removed_assertion_gate_test.ts:216` — still true because it describes the assertion-side cap, which is unchanged.

## Reproduction

- **symptom** — a removed assertion named in the Test Plan after 2,000 canonical characters was reported as unaccounted. This is what happened on #3402, in the gate comment of 2026-10-08T23:23:35Z.
- **status** — `verified` — against the base production code, both new positive tests failed on `assert(result.valid)` ("37 passed | 2 failed"). Both pass with the fix.
- **regression test** — `worker/deno/tests/removed_assertion_gate_test.ts::validateRemovedAssertions accounts for an assertion named after 2,000 canonical chars of the Test Plan`

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Match against the uncapped canonical body (`canonicaliseUncapped`) — evidence: `worker/deno/lib/removed_assertion_gate.ts:1937`, `:2018` — reviewer: met
- **met** — The summary stays bounded by `MAX_SUMMARY_SCAN_CHARS` — evidence: that bound is unchanged by the diff — reviewer: met
- **met** — Regression test with a named assertion after more than 2,000 canonical characters — evidence: `worker/deno/tests/removed_assertion_gate_test.ts:266`, whose filler length is asserted — reviewer: met
- **unrequested** — two more tests (the regex-escaped path, and a negative look-alike) and doc-comment rewording — reviewer: minor. They test the same fix and keep the doc comments true.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — The reviewer found no violations. Areas checked:
  - A new test must go red without its change.
  - A negative test must be able to fail.
  - Writing a gate over text: the scan is still bounded, and truncation fails closed.
  - The regex rule: no regex was added.
  - The named-test, stub and workflow rules.
  - Australian English.
  - The review-enforced `SIMPLE-ON-PURPOSE` rule: no corner was cut.
  - Removed assertions: none.

## Test Plan

- [x] The two new positive tests fail against the base production code and pass with the fix.
- [x] With only the raw-form line (`removed_assertion_gate.ts:2018`) reverted, the regex-escaped test goes red (38 passed, 1 failed).
- [x] The negative test fixture holds the look-alike `-0.25` against the removed `-0.5`. The test asserts `!valid` with one unaccounted assertion.
- [x] Targeted run of `worker/deno/tests/removed_assertion_gate_test.ts`, `worker/deno/tests/removed_assertion_gate_context_test.ts` and `worker/deno/tests/completion_phase_removed_assertion_test.ts`: 118 passed.
- [x] `./quality.sh < /dev/null` passed.

**Branch outcomes:** none added. The diff swaps the canonicaliser the existing match calls and adds no condition.
