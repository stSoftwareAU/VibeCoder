## Summary

Closes #4107.

The acceptance-criteria extractor now accepts a heading that ends in
"acceptance criteria" (for example `## Scope and acceptance criteria`), with up
to five words before the phrase. Previously only a bare `## Acceptance Criteria`
heading counted, so an issue using the longer heading was treated as having no
criteria and the closure gate never applied. The prompt and the issue-processing
manual state the wider heading.

**Docs sweep** — grep: `## Acceptance Criteria`, `ACCEPTANCE_HEADING_RE`, "acceptance criteria"; section: `docs/workflows/issue-processing.md#-acceptance-criteria-closure-before-the-pr`; siblings: `## Definition of done` (the existing fallback heading, already named beside it and unchanged); updated: `docs/workflows/issue-processing.md`, `prompts/issue/prompt.md`

**Branch outcomes:**
- `worker/deno/lib/acceptance_criteria_gate.ts:71` — success (heading with 1–5 prefix words before "acceptance criteria", optional colon) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptanceCriteria - reads items under a heading ending in acceptance criteria and stops at the next heading (Issue #4107)` — flipped the prefix count to `{0,0}`, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts:71` — success (zero prefix words, plain heading unchanged) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptanceCriteria - a plain Acceptance Criteria heading is unchanged (Issue #4107)` — flipped to require at least one prefix word, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts:71` — absent (six or more prefix words) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptanceCriteria - a heading with seven prefix words before the phrase is not a heading (Issue #4107)` — flipped the bound to `{0,9}`, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts:71` — absent (heading continues after the phrase) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptanceCriteria - a heading with acceptance criteria followed by more words is not a heading (Issue #4107)` — removed the `$` anchor, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts:71` — downstream (the closure gate applies and fails without a block, and passes with one) — `worker/deno/tests/acceptance_criteria_gate_test.ts::validateAcceptanceClosure - applies to a heading ending in acceptance criteria and fails without the closure block (Issue #4107)` — flipped the prefix count to `{0,0}`, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts:71` — downstream (scope assessment matches the plain heading's verdict) — `worker/deno/tests/degraded_delivery_test.ts::assessScopeShortfalls - a heading ending in acceptance criteria yields the same verdict as the plain heading (Issue #4107)` — flipped the prefix count to `{0,0}`, test went red

## Test Plan

No assertion was removed from an existing test. The diff only adds tests:

- `worker/deno/tests/acceptance_criteria_gate_test.ts` — new `extractAcceptanceCriteria`, `extractAcceptedScope` and `validateAcceptanceClosure` tests for the wider heading, the word-count bound, non-heading near-misses and a hostile padded heading.
- `worker/deno/tests/degraded_delivery_test.ts` — one new `assessScopeShortfalls` test.
