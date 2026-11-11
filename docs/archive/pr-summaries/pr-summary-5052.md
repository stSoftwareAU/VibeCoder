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

### Undiscoverable Facts

- The two review examples motivating the change are recorded in Issue #5052.

## Evidence

Documentation and its section-scoped drift tests only; no visual or runtime
surface changed.

## Test Plan

- `worker/deno/tests/kept_assertions_3061_docs_test.ts` — passed, 3 tests.
- Drift pins against `origin/main` — all ten new pins were absent from their
  corresponding base sections.
- Removed each of the ten pinned phrases in turn — its corresponding test went
  red for all ten mutations, then the wording was restored.
- `deno fmt --check worker/deno/tests/kept_assertions_3061_docs_test.ts` — passed.
- `deno lint worker/deno/tests/kept_assertions_3061_docs_test.ts` — passed.
- `deno check --frozen --lock=deno.lock tests/kept_assertions_3061_docs_test.ts`
  from `worker/deno` — passed.
- `timeout 900 ./quality.sh < /dev/null` — failed only the one-second unit-test
  budget: `tests/auto_merge_ensure_draft_heal_wiring_4952_test.ts` took 1.28s
  in the gate. Its targeted rerun passed functionally but took 1.36s, so the
  same budget check failed. This file is outside this change. The gate’s lint,
  type check, format, and other reported checks passed; config integration and
  Checkov were skipped by the gate.

Removed from `worker/deno/tests/kept_assertions_3061_docs_test.ts`:

- `assertStringIncludes(text, "an issue requirement that makes it untrue");`
  - Obsolete: this pin encoded blanket preservation wording that did not
    distinguish behaviour assertions from broken “how” assertions.
  - Still covered by: `worker/deno/tests/kept_assertions_3061_docs_test.ts::coding standards - TDD rule keeps still-true assertions when editing a test`
  - Replaced by: `assertStringIncludes(text, "every other behaviour assertion")`,
    the “how” assertion deletion pin, and the outcome-assertion pin in that test.
- `assertStringIncludes(instructions, "the issue requirement that makes it untrue");`
  - Obsolete: the prompt’s preservation rule now distinguishes behaviour
    assertions from broken “how” assertions.
  - Still covered by: `worker/deno/tests/kept_assertions_3061_docs_test.ts::issue prompt - Instructions keep the change-only-what-the-issue-changes rule`
  - Replaced by: the behaviour-preservation, “how” deletion, blocking-removal,
    and outcome-assertion pins in that test.
- `assertStringIncludes(text, "the issue requirement that makes it untrue");`
  - Obsolete: the removal guidance now says the existing `Obsolete:` entry
    covers obsolete call-count and call-order assertions.
  - Still covered by: `worker/deno/tests/kept_assertions_3061_docs_test.ts::issue prompt - PR Summary Test Plan requires covering removed assertions`
  - Replaced by: `assertStringIncludes(text, "this existing entry also covers obsolete call-count and call-order assertions")`.
