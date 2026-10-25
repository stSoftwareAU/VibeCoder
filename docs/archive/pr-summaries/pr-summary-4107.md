## Summary

Closes #4107.

The acceptance-criteria extractor now accepts a heading that ends in
"acceptance criteria" (for example `## Scope and acceptance criteria`), with up
to five words before the phrase. Previously only a bare `## Acceptance Criteria`
heading counted, so an issue using the longer heading was treated as having no
criteria and the closure gate never applied. The plain `## Acceptance Criteria`
heading still wins when present, and the wider heading is only a fallback that
tries every matching heading until one carries list items, so an earlier prose
heading such as `### Why the acceptance criteria` cannot hide a later real list.
All callers (`extractAcceptedScope`, `validateAcceptanceClosure`,
`claim_freshness`, `closure_verdict_recovery`, `independent_review_gate`) go
through `extractAcceptanceCriteria` and so inherit this ordering. The prompt and the issue-processing
manual state the wider heading.

**Docs sweep** — grep: `## Acceptance Criteria`, `ACCEPTANCE_HEADING_RE`, "acceptance criteria"; section: `docs/workflows/issue-processing.md#-acceptance-criteria-closure-before-the-pr`; siblings: `## Definition of done` (the existing fallback heading, already named beside it and unchanged); updated: `docs/workflows/issue-processing.md`, `prompts/issue/prompt.md`

**Branch outcomes:**
- `worker/deno/lib/acceptance_criteria_gate.ts` (`ISSUE_ACCEPTANCE_HEADING_RE`) — success (heading with 1–5 prefix words before "acceptance criteria", optional colon) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptanceCriteria - reads items under a heading ending in acceptance criteria and stops at the next heading (Issue #4107)` — flipped the prefix count to `{0,0}`, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts` (`ISSUE_ACCEPTANCE_HEADING_RE`) — success (zero prefix words, plain heading unchanged) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptanceCriteria - a plain Acceptance Criteria heading is unchanged (Issue #4107)` — flipped to require at least one prefix word, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts` (`ISSUE_ACCEPTANCE_HEADING_RE`) — absent (six or more prefix words) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptanceCriteria - a heading with seven prefix words before the phrase is not a heading (Issue #4107)` — flipped the bound to `{0,9}`, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts` (`ISSUE_ACCEPTANCE_HEADING_RE`) — absent (heading continues after the phrase) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptanceCriteria - a heading with acceptance criteria followed by more words is not a heading (Issue #4107)` — removed the `$` anchor, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts` (`ISSUE_ACCEPTANCE_HEADING_RE`) — downstream (the closure gate applies and fails without a block, and passes with one) — `worker/deno/tests/acceptance_criteria_gate_test.ts::validateAcceptanceClosure - applies to a heading ending in acceptance criteria and fails without the closure block (Issue #4107)` — flipped the prefix count to `{0,0}`, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts` (`ISSUE_ACCEPTANCE_HEADING_RE`) — downstream (scope assessment matches the plain heading's verdict) — `worker/deno/tests/degraded_delivery_test.ts::assessScopeShortfalls - a heading ending in acceptance criteria yields the same verdict as the plain heading (Issue #4107)` — flipped the prefix count to `{0,0}`, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts` (`extractAcceptanceCriteria`) — success (a prose-only wider heading ahead of a plain `## Acceptance Criteria` list still yields the plain list) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptanceCriteria - a prose heading ending in the phrase before the plain heading does not hide it (Issue #4107)` — dropped the exact-heading lookup, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts` (`extractAcceptanceCriteria`) — success (a wider heading carrying a list ahead of the plain heading does not win) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptanceCriteria - a wider heading with a list before the plain heading does not win (Issue #4107)` — dropped the exact-heading lookup, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts` (`firstListUnderAny`) — success (a list-less wider heading ahead of another wider heading does not hide it) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptanceCriteria - a list-less wider heading before another wider heading does not hide it (Issue #4107)` — reverted to first-match-only, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts` (`extractAcceptedScope`) — downstream (scope keeps the plain list despite an earlier prose heading) — `worker/deno/tests/acceptance_criteria_gate_test.ts::extractAcceptedScope - a prose heading before the plain Acceptance Criteria heading does not hide it (Issue #4107)` — reverted to first-match-only, test went red
- `worker/deno/lib/acceptance_criteria_gate.ts` (`validateAcceptanceClosure`) — downstream (the closure gate still applies to the plain list) — `worker/deno/tests/acceptance_criteria_gate_test.ts::validateAcceptanceClosure - a prose heading before the plain heading still applies the gate (Issue #4107)` — reverted to first-match-only, test went red

## Test Plan

No assertion was removed from an existing test. The diff only adds tests:

- `worker/deno/tests/acceptance_criteria_gate_test.ts` — new `extractAcceptanceCriteria`, `extractAcceptedScope` and `validateAcceptanceClosure` tests for the wider heading, the word-count bound, non-heading near-misses, a hostile padded heading and a wider-matching heading placed before the plain heading (with and without a list).
- `worker/deno/tests/degraded_delivery_test.ts` — one new `assessScopeShortfalls` test.
