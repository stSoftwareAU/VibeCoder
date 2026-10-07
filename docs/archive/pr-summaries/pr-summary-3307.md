## Summary

Adds a **Re-scoping an existing drift test** rule to `CODING-STANDARDS.md` §
Documentation-drift tests: when an existing whole-file drift test is converted
to `section()`, map each pin to its rule's section, leave no subsumed pin, keep
whole-file absence checks on `flatWholeFile`, and red-check each moved check
with one Test Plan line per moved check. Adds the optional guardrail
`assertPins(section, pins)` to `worker/deno/tests/support/markdown_docs.ts`,
which throws on a subsumed or duplicate pin, a missing pin or an empty list.
Closes #3307.

## Spec

### Intent and Rationale

- Condition 4 and the `drift-pins-on-base` task call a phrase already on base a finding, but a moved pin is meant to be on base, so nothing told the author how to prove a moved check still guards its rule. Review rounds sent VibeCoder#3240 (narrowed absence checks) and VibeCoder#3297 (subsumed "In an issue run" pin) back for this.
- Every surface that stated "a phrase the base section already held is a blocking self-review finding" now names the moved-pin exception, so the old rule and the new one do not tell the agent opposite things.

### Essential Design Decisions

- The rule is a paragraph after condition 4, not a fifth condition, so "all four conditions" and every "condition N" reference stay true.
- `assertPins` compares pins after the same whitespace collapse `flat()` applies, so a pin that differs only in wrapping is still caught as subsumed.

### Undiscoverable Facts

- Both example PRs were fixed before merge; the failures happened in review rounds (PR #3240 body "Review round — absence checks were still section-scoped"; PR #3297 body notes the "In an issue run" pin moved to the Blocked list).

## Evidence

Purely docs plus a test-support helper; no production code changed.

- `worker/deno/tests/rescoped_drift_pins_3307_test.ts` — 13 tests: 6 unit tests of `assertPins`, 7 drift tests over the new rule text.
- `./quality.sh < /dev/null` on the final head: `Result: PASSED (with skipped checks)` (`config integration` skipped, as on every run here).

**Docs sweep** — grep: `drift-pins-on-base`, "Documentation-drift tests", "already held is a blocking", `flatWholeFile`, "whole file rather than"; section: `CODING-STANDARDS.md#documentation-drift-tests`; updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`, `prompts/pr_feedback/prompt.md`, `prompts/test_audit/prompt.md`, `CONTRIBUTING.md`, `docs/workflows/issue-processing.md`; `docs/workflows/issue-processing.md:1416` — still true because it records the #3093 change that introduced condition 4.

Related existing rules checked: condition 1 (`flatWholeFile` allowed for a whole-file absence check — agrees), condition 4, "A new test must go red without its change" (CODING-STANDARDS + coding_guidelines — exception added), the issue prompt's Test Plan step and the pr_feedback "requested red run" rule (exception added), CONTRIBUTING's drift-pins bullet (exception added), test_audit's drift-test exemption (it called any whole-file assertion a finding; now scoped to positive assertions). Applied the new rule to this PR's own diff: the new drift tests pin only text this diff adds, every list goes through `assertPins` (so no subsumed pin), and the diff narrows no absence check; nothing found.

Provenance cited: #3307: Re-scoping existing drift tests drops coverage…; #3240: Drift tests keep checking whole files despite condition 1… (PR); #3297: Scope five drift tests to their sections (#3263) (PR).

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — `CODING-STANDARDS.md` § Documentation-drift tests: add a short rule after condition 1 or condition 4 — evidence: `CODING-STANDARDS.md` "Re-scoping an existing drift test", `worker/deno/tests/rescoped_drift_pins_3307_test.ts::CODING-STANDARDS - re-scoping an existing drift test keeps every check's reach` — reviewer: met
- **met** — repeat the cue wherever the issue prompt's test-change guidance mentions narrowing drift tests — evidence: `prompts/issue/prompt.md`, `prompts/pr_feedback/prompt.md`, `prompts/coding_guidelines/prompt.md`, `CONTRIBUTING.md`, `prompts/test_audit/prompt.md`; tests `issue prompt - …`, `pr_feedback prompt - …`, `coding guidelines - …`, `CONTRIBUTING - …`, `test_audit prompt - …` — reviewer: partial — reason: the reviewer found `prompts/coding_guidelines/prompt.md` ("A new test must go red") missing the cue; it was added in this diff after the review, with its own drift test
- **met** — Map each pin to its rule — evidence: `CODING-STANDARDS.md` bullet "Map each pin to its rule." — reviewer: met
- **met** — No subsumed pins — evidence: `CODING-STANDARDS.md` bullet; `worker/deno/tests/rescoped_drift_pins_3307_test.ts::assertPins - refuses a pin subsumed by a longer pin in the same list` — reviewer: met
- **met** — Absence checks keep their reach — evidence: `CODING-STANDARDS.md` bullet; `prompts/test_audit/prompt.md` carve-out — reviewer: met
- **met** — Red-check each moved check, not the test, with one Test Plan line per moved pin — evidence: `CODING-STANDARDS.md` bullet; `prompts/issue/prompt.md` "record here one line per moved check" — reviewer: met
- **met** — Optional guardrail: a shared helper `assertPins(section, pins)` that throws when one pin in a list is a substring of another — evidence: `worker/deno/tests/support/markdown_docs.ts::assertPins` — reviewer: met
- **unrequested** — rationale entry in `docs/workflows/issue-processing.md` — reviewer: unrequested — reason: that page records every prompt-rule change by issue; the docs sweep owed it an entry

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — named tests exist; drift-test conditions 1–4 (every pin via `section()` + `assertPins`, helper name imported via `assertPins.name`); `assertPins` subsumption logic traced against every pin list; no existing test assertion removed; review-enforced rules checked: "Apply a new rule to your own diff", "Check where you insert", condition 1's raw-`includes` ban, Australian English

## Test Plan

- New `worker/deno/tests/rescoped_drift_pins_3307_test.ts`: `deno test -A tests/rescoped_drift_pins_3307_test.ts` — 13 passed on the final head. No existing test edited, so no assertion removed.
- Per-phrase base check (`deno task drift-pins-on-base origin/main …`), every section the test reads: all 19 pinned phrases print `absent on base`, exit 0 — CODING-STANDARDS "Documentation-drift tests" (8), CODING-STANDARDS "Test coverage expectations" (2), issue prompt "PR Summary File" (3), pr_feedback "Making Changes" (2), coding_guidelines "Test Coverage Expectations" (2), test_audit "Source-text greps used as assertions" (1), CONTRIBUTING "Test layout" (1).
- Red run against base: with the five first-commit docs restored to `origin/main`, all five of their drift tests FAILED (`6 passed | 5 failed`); restored, green.
- `./quality.sh < /dev/null` on the final head: PASSED (with skipped checks).

**Branch outcomes:**

- `worker/deno/tests/support/markdown_docs.ts` `assertPins` empty-list assert — refuses `[]` — `assertPins - an empty pins list pins nothing and throws` — replacing the condition with `true` turned it red
- `assertPins` subsumption assert — refuses a subsumed or duplicate pin — `assertPins - refuses a pin subsumed by a longer pin in the same list`, `assertPins - a duplicate pin is subsumed by itself` — replacing the condition with `true` turned both red
- `assertPins` missing-pin assert — refuses a pin absent from the section — `assertPins - a missing pin names itself in the failure, and passes against the right section` — replacing the condition with `true` turned it red
- success path — every pin present, none subsumed — `assertPins - passes when every pin is present, including one that spans the line wrap`, `assertPins - the same section passes once the subsumed pin is dropped`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
