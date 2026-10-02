# PR Summary — Issue #3021

Closes #3021

## Summary

In GRQ-www#103 and #102 a worker PR added `--no-suppress-errors` to `semgrep ci`.
The README called the flag a validated invariant, but `validateSemgrepWorkflow`
never checked it — only `persist-credentials` was pinned. This PR adds one
rule, "a workflow behaviour change extends the workflow validator", to every
surface a run or reviewer reads. An invariant documented but not validated is
now a blocking self-review finding.

- [x] `CODING-STANDARDS.md` and its injected twin
      `prompts/coding_guidelines/prompt.md`: the new paragraph in Test coverage
      expectations
- [x] `prompts/issue/prompt.md`: new subsection "A behaviour change extends the
      workflow validator" in the Workflow Files section
- [x] Standards reviewer brief (`issue_executor_agents.ts`): a third
      always-`violation` departure
- [x] `docs/workflows/issue-processing.md`: the Standards reviewer bullet
- [x] Pin test `workflow_validator_contract_3021_test.ts`

## Spec

### Intent and Rationale

- A flag the CI's correctness depends on must fail a test when it is dropped,
  not only be described in prose.

### Essential Design Decisions

- Mirrors the #3011 placement: standards doc, its prompt twin, the issue
  prompt, the reviewer brief, and the design doc.
- The issue-prompt rule sits beside the file-scoped `WORKFLOW_FILE_CHECKS`,
  which check fleet baseline hygiene and cannot know a repo's own contract.
- Guidance only; no deterministic gate (scope).

## Evidence

- Red run: all five tests in
  `worker/deno/tests/workflow_validator_contract_3021_test.ts` failed before the
  edits (`0 passed | 5 failed`) and pass after (`5 passed`).
- `coding_guidelines_layers_2574_test.ts`: the new issue-prompt heading was
  added to its pinned heading union, as for #2873, #2930 and #2688.
- `./quality.sh < /dev/null`: PASSED (config integration skipped, as usual).
- Docs sweep: grepped for "Two departures are always" and `standards-reviewer`;
  `docs/CONFIGURATION.md` and `docs/MODEL-AND-CACHING.md` name the reviewer but
  do not list its departures, so they needed no change.

## Test Plan

- `cd worker/deno && deno task test:unit tests/workflow_validator_contract_3021_test.ts tests/phantom_test_and_stub_contract_3011_test.ts tests/coding_guidelines_layers_2574_test.ts < /dev/null`
- `./quality.sh < /dev/null`
