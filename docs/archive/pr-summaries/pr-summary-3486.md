## Summary

The degraded-run guard treated an issue whose criteria sit under a `## Done when`
heading as stating no criteria, because `extractAcceptedScope` recognised only
`## Acceptance Criteria` and grill-me's `### Accepted scope so far`. This change
adds a `DONE_WHEN_HEADING_RE` and falls back to it in `extractAcceptedScope` only,
so a `## Done when` issue reads as stating its scope and the no-follow-up "why"
sentence no longer claims the issue states no acceptance criteria. The closure
gate's own `extractAcceptanceCriteria` is unchanged.
Closes #3486.

## Spec

### Intent and Rationale

- A reviewer sent stSoftwareAU/GRQ#5175 back because its degraded-run section said the issue (stSoftwareAU/GRQ#5167, a `## Done when` list) stated no acceptance criteria, when it plainly did.
- `extractAcceptedScope` is the single place the degraded-run guard reads an issue's scope, so widening only that function fixes the sentence without changing what the closure gate treats as criteria.

### Essential Design Decisions

- `## Done when` counts as accepted scope, so it is recognised as a fallback in `extractAcceptedScope` only. `extractAcceptanceCriteria` stays reading the planner's `## Acceptance Criteria`, exactly as the issue's "not covered by #3350" note directs.
- The new regex reuses the ReDoS-safe tail `\s*(?::\s*)?$` (not `\s*:?\s*$`) and the list-item text `([^\n]*)` with no `$`, matching the existing heading and item patterns (Issues #3164 and #3186).

### Undiscoverable Facts

- None.

## Evidence

No UI and no runtime code — this is a one-line fallback plus a regex constant and their tests and doc updates.

**Docs sweep** — grep: "states no acceptance criteria", "Accepted scope so far", "acceptance criteria", "Done when" across `worker/deno/lib`, `docs/`, `prompts/`. Section: `docs/workflows/issue-processing.md` "A degraded run never closes an issue as complete" and the `extractAcceptedScope` doc comment in `worker/deno/lib/acceptance_criteria_gate.ts`; siblings: `ACCEPTANCE_HEADING_RE`, `ACCEPTED_SCOPE_HEADING_RE`. Updated: `docs/workflows/issue-processing.md` and the `extractAcceptedScope` doc comment. `requirements_rubric.ts` has its own separate `ACCEPTED_SCOPE_HEADING_RE` (grill-me's rubric regex, a different set) and `prompts/grill-me/prompt.md` defines grill-me's own heading — neither is the set this change extends, so both are left as-is.

## Reproduction

- **symptom** — an issue whose criteria are a `## Done when` list produced a degraded-run section saying "the issue states no acceptance criteria".
- **status** — `verified` — reproduced against the pre-fix head: both new tests failed, then passed after the fix.
- **regression test** — `worker/deno/tests/degraded_delivery_test.ts::extractAcceptedScope - reads a 'Done when' list (Issue #3486)`.

## Test Plan

- Ran `deno task test:unit tests/degraded_delivery_test.ts < /dev/null` from `worker/deno`: all tests passed on the fixed head (47 passed before this session's flip checks; 45 passed / 2 failed only while the flip was applied, then restored).
- Red checks: the two new tests (`extractAcceptedScope - reads a 'Done when' list (Issue #3486)` and `buildDegradedNoFollowUpSection - (c) does not claim a 'Done when' issue states no criteria`) failed against the pre-fix head and pass after the fix.
- `./quality.sh` on the head passed. Every stage passed, including `deno tests`, markdownlint and semgrep, except `config integration`, which was skipped.

Branch outcomes: the diff adds one condition `if (acceptedScope.length > 0) return acceptedScope;` (`worker/deno/lib/acceptance_criteria_gate.ts:183`):

- `worker/deno/lib/acceptance_criteria_gate.ts:183` — condition true (accepted-scope list present → returns it) — reached by `extractAcceptedScope - reads a grill-me 'Accepted scope so far' list and nothing after it` — flip (delete the early return) went red (43 passed / 4 failed, including that test and three fixtures that also use accepted-scope lists).
- `worker/deno/lib/acceptance_criteria_gate.ts:184` — condition false (accepted-scope list absent → falls through to the `## Done when` read) — reached by `extractAcceptedScope - reads a 'Done when' list (Issue #3486)` and `extractAcceptedScope - an issue stating neither yields no scope` — flip (force the condition true with `>= 0`) went red (45 passed / 2 failed, the done-when test and test (c)).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
