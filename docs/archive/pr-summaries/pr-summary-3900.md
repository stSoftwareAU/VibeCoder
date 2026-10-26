# PR Summary — Issue #3900: extend the fake-mirrors rule to a hand-faked response from the repository's own server

## Summary

Closes #3900

The #3224 rule "A fake mirrors the production implementation it stands in for" only fired for an in-process port. Two private fleet PRs faked a response from the repository's own server by hand, across processes and languages, and shipped a body or header the server never sends. This change rewords the trigger rather than adding a rule:

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`: the rule now covers a test that fakes a response from the repository's own server or service, requires a golden or a serialiser contract test, and requires checking a depended-on header against the deployed exposed-headers list.
- `prompts/issue/prompt.md`: the PR Raising Requirements self-review check carries the same checks, and a fixture the producer never emits is a blocking self-review finding.
- `docs/workflows/issue-processing.md`: the operator manual paragraph for the rule carries the same checks.
- `worker/deno/tests/fake_mirrors_production_3224_test.ts`: new pins for the wire-format wording on all four surfaces.

- [x] Reword the trigger on both guidance surfaces, the issue prompt and the operator manual
- [x] Pin the new wording in the drift test

## Spec

### Intent and Rationale

- The old trigger described an in-process interface, so it did not recognise a wire format. The wording now names the repository's own server or service.

### Essential Design Decisions

- No new rule and no worker gate: the issue's deterministic-check assessment finds a cross-repo gate infeasible, so the check lives in the target repo's own tests.

## Evidence

- `deno test -A tests/fake_mirrors_production_3224_test.ts`: 6 passed, 0 failed.

## Test Plan

One existing assertion was removed. The sentence it pinned was reworded because the rule now covers a faked server response as well as an in-repo port, so "that property" no longer has a single antecedent:

- Removed from `worker/deno/tests/fake_mirrors_production_3224_test.ts`: `assert( text.includes( "read the production implementation first and confirm it has that property", ), `PR Raising Requirements is missing the read-production-first requirement: ${text}`, );`
  Required by: "This applies across processes and languages, not only to in-process traits or interfaces."
  Replaced by: ``assert( text.includes( "read the production implementation first and confirm it has the property the change relies on", ), `PR Raising Requirements is missing the read-production-first requirement: ${text}`, );``
