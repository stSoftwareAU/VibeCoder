## Summary

Clarified that edited tests keep every still-true behaviour assertion, while a
broken “how” assertion is deleted and its behaviour remains protected by named
outcome assertions. The issue prompt’s existing removal entry now explicitly
covers obsolete call-count and call-order assertions. Closes #5052.

## Spec

### Intent and Rationale

- Resolve the conflict between preserving useful behaviour coverage and the
  existing rule refusing assertions that pin implementation interactions.

### Essential Design Decisions

- Keep the preservation rule focused on behaviour assertions. Delete a broken
  “how” assertion instead of re-counting or restoring it, and name the outcome
  assertions that still prove the behaviour.
- Use the existing `Obsolete:` and `Still covered by:` entry for obsolete
  interaction assertions; add no entry kind, gate or reporting obligation.
- The issue prompt’s no-test-deletion rule, outcome-testing guidance and removal
  entries all preserve the same behaviour-assertion exception.

### Undiscoverable Facts

- The two review examples motivating the change are recorded in Issue #5052.

## Evidence

Documentation and its section-scoped drift tests only; no visual or runtime
surface changed. The tests retain the requirement to justify removed behaviour
assertions alongside the new broken “how” assertion exception.

## Test Plan

- `worker/deno/tests/kept_assertions_3061_docs_test.ts` — passed, 3 tests.
- Drift pin `every other behaviour assertion` in the coding-standards TDD
  section: absent on `origin/main`; removing the wording made its test go red.
- The coding-standards TDD test now pins the complete narrowed clause:
  `Each removed behaviour assertion needs an issue requirement that makes it untrue, or the replacement or existing coverage that still proves the behaviour`.
  `drift-pins-on-base` confirmed this clause is absent on `origin/main`.
- Drift pin
  `A "how" assertion (rule 2 of **Dummy tests and "how" tests are
  refused**) that the change breaks is deleted, not re-counted or restored`
  in the coding-standards TDD section: absent on `origin/main`; removing it made
  its test go red.
- Drift pin `name the outcome assertions that still prove the behaviour` in the
  coding-standards TDD section: absent on `origin/main`; removing it made its
  test go red.
- Drift pin `A behaviour assertion removed without one is a` in the coding-
  standards TDD section: absent on `origin/main`; removing it made its test go
  red.
- Drift pin `every other behaviour assertion the test made` in issue prompt
  Instructions: absent on `origin/main`; removing it made its test go red.
- Drift pin
  `A "how" assertion (rule 2 of **Dummy tests and "how" tests are
  refused**) that the change breaks is deleted, not re-counted or restored`
  in issue prompt Instructions: absent on `origin/main`; removing it made its
  test go red.
- Drift pin
  `A behaviour assertion removed without one is a blocking self-
  review finding`
  in issue prompt Instructions: absent on `origin/main`; removing it made its
  test go red.
- Drift pin `name the outcome assertions that still prove the behaviour` in
  issue prompt Instructions: absent on `origin/main`; removing it made its test
  go red.
- Drift pin
  `this existing entry also covers obsolete call-count and call-
  order assertions`
  in the issue prompt PR-summary section: absent on `origin/main`; removing it
  made its test go red.
- `deno fmt --check worker/deno/tests/kept_assertions_3061_docs_test.ts` —
  passed.
- `deno lint worker/deno/tests/kept_assertions_3061_docs_test.ts` — passed.
- `deno check --frozen --lock=deno.lock tests/kept_assertions_3061_docs_test.ts`
  from `worker/deno` — passed.
- `deno task pr-summary-check --base origin/main --issue-body-file
  /tmp/issue-5052-body.md --labels top-priority
  ../../docs/archive/pr-summaries/pr-summary-5052.md`
  from `worker/deno` — passed; zero blocked or unchecked gates.
- `markdownlint-cli2 docs/archive/pr-summaries/pr-summary-5052.md` — passed; 245
  files selected by the repository configuration.
- Earlier implementation run: `timeout 900 ./quality.sh < /dev/null` — failed
  only the one-second unit-test budget:
  `tests/auto_merge_ensure_draft_heal_wiring_4952_test.ts` took 1.28s in the
  gate. Its targeted rerun passed functionally but took 1.36s, so the same
  budget check failed. This file is outside this change. The gate’s lint, type
  check, format, and other reported checks passed; config integration and
  Checkov were skipped by the gate.

Item 1 verification:

- Reproduced at the incoming head: independently replacing
  `requirement that makes it untrue` with
  `number, whether or not the behaviour changes` in each scoped section left all
  three tests passing.
- Coding-standards TDD section: after restoring the narrowed justification
  check, the same section-only mutation failed
  `worker/deno/tests/kept_assertions_3061_docs_test.ts::coding standards - TDD rule keeps still-true assertions when editing a test`;
  the other two tests passed.
- Issue prompt Instructions: the test now pins
  `for each removed behaviour assertion, the issue requirement that makes it untrue or the coverage that still proves the behaviour`.
  `drift-pins-on-base` confirmed this clause is absent on `origin/main`. The
  section-only mutation failed
  `worker/deno/tests/kept_assertions_3061_docs_test.ts::issue prompt - Instructions keep the change-only-what-the-issue-changes rule`;
  the other two tests passed.
- Issue prompt PR Summary File: restored the original
  `the issue requirement that makes it untrue` pin alongside the new exception
  pin. This retained protection is expected to be present on `origin/main`. The
  section-only mutation failed
  `worker/deno/tests/kept_assertions_3061_docs_test.ts::issue prompt - PR Summary Test Plan requires covering removed assertions`;
  the other two tests passed.
- All three document mutations were restored after verification. The targeted
  suite then passed all three tests.

Removed from `worker/deno/tests/kept_assertions_3061_docs_test.ts`:

- `assertStringIncludes(text, "an issue requirement that makes it untrue");`
  - Obsolete: the blanket wording is narrowed to removed behaviour assertions.
    The obligation to justify their removal remains.
  - Still covered by:
    `worker/deno/tests/kept_assertions_3061_docs_test.ts::coding standards - TDD rule keeps still-true assertions when editing a test`
  - Replaced by:
    `assertStringIncludes(text, "Each removed behaviour assertion needs an issue requirement that makes it untrue, or the replacement or existing coverage that still proves the behaviour")`.
- `assertStringIncludes(instructions, "the issue requirement that makes it untrue");`
  - Obsolete: the blanket wording is narrowed to removed behaviour assertions.
    The obligation to justify their removal remains.
  - Still covered by:
    `worker/deno/tests/kept_assertions_3061_docs_test.ts::issue prompt - Instructions keep the change-only-what-the-issue-changes rule`
  - Replaced by:
    `assertStringIncludes(instructions, "for each removed behaviour assertion, the issue requirement that makes it untrue or the coverage that still proves the behaviour")`.

The full quality gate was not repeated for this review fix; the worker will
re-run it. The earlier full-gate timing failure remains recorded above.
