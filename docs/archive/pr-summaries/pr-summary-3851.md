## Summary

Fleet tests meant to pin which of two similar values the code reads (or that
two figures read the same field) were built on fixtures where both candidates
were equal, so they passed whichever value the code read. This PR rewords the
existing rule instead of adding one: **A negative test must be able to fail**
is renamed **A test must be able to fail on the wrong input** and gains the
source/agreement case. The fixture must give the candidates different values,
the break is to read the sibling value, and the Test Plan records that break
(`reads base B instead of A → red`). Closes #3851.

## Spec

### Intent and Rationale

- The old rule's trigger was a *negative* assertion, so it was never applied to positive source or agreement tests. The issue asked for the rule to be widened under a name that triggers for both, rather than for a new paragraph.
- A deterministic gate is not feasible (the issue's own assessment): no mutation operator swaps a read for a sibling field, so the fix is prose in every surface that states the rule.

### Essential Design Decisions

- The paragraph stays word-for-word identical in `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`, and the drift tests pin this.
- Every reference to the old name now uses the new name: the new-test rule's cross-reference, "Choosing assertions", the issue prompt's Test Plan step and the issue-processing manual. No live surface keeps the old name.

### Undiscoverable Facts

- The issue gave "around line 1326" for the issue-prompt self-review item. The item that actually points at the rule is the Test Plan step in "PR Summary File", now at `prompts/issue/prompt.md:1453`.

## Evidence

This is a docs and prompt change only, with no production code. Changed surfaces:

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`: the renamed and widened rule, plus the new-test rule's cross-reference. `CODING-STANDARDS.md` "Choosing assertions" also asks the sibling-value question.
- `prompts/issue/prompt.md` (PR Summary File → Test Plan step): a sibling-value test counts only once its fixture gives the candidates different values and it went red with the code pointed at the sibling value.
- `prompts/pr_review_brief/prompt.md` step 4: the fleet reviewer and the pre-PR verifier now check that the candidates differ. The brief is shared (#3395), so both get it.
- `docs/workflows/issue-processing.md`: the operator-manual paragraph is renamed and records #3851.

Issue numbers cited as provenance: #3060: Fleet negative tests pass without their guard: the fixture never contains the forbidden value (VibeCoder#2961, private-repo-A#2209). #3851: this issue.

Related existing rules checked: **A new test must go red without its change** (its cross-reference was updated), **An edited expectation must still go red without its guard**, **A test named for one step must reach that step**, **A refusal test must be refused by the rule it names**, "Choosing assertions", the pr_review_brief step 4 per-step and drift-pin checks, and the issue-prompt Test Plan step. None contradicts the widened rule. I applied the rule to this PR's own diff. The new drift test pins phrases that are absent on base, so it has no "two equal candidates" shape. The edited 3060/3374 tests pin the renamed heading, which differs from the old one, and both go red on base docs. I found nothing to fix.

**Docs sweep** — grep: "A negative test must be able to", "negative test", "wrong source"; section: `docs/workflows/issue-processing.md#reproduction-status-on-a-bug-fix`; siblings: `A refusal test must be refused by the rule it names`, `An edited expectation must still go red without its guard`; updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`, `prompts/pr_review_brief/prompt.md`, `docs/workflows/issue-processing.md`; `worker/deno/tests/negative_test_must_fail_3060_test.ts:9` — still true because it records the old name as history; the remaining "negative test" hits (`CODING-STANDARDS.md` precondition rule and workflow-validator rule) describe negative tests generally and remain true.

## Test Plan

- Added `worker/deno/tests/sibling_value_fixture_3851_docs_test.ts` (6 tests). It pins the widened rule on both surfaces (identical), the new-test cross-reference, "Choosing assertions", the issue prompt Test Plan step, the review brief and the issue-processing manual.
  - Red check: with the five docs restored to `origin/main`, all 6 tests FAILED. With the head docs, all 6 pass.
  - Pins absent on base: `deno task drift-pins-on-base origin/main <doc> <section> <phrase>...` printed `absent on base:` for every pinned phrase in all six doc/section groups.
- Edited `worker/deno/tests/negative_test_must_fail_3060_test.ts`: `PARAGRAPH_START` now points at the renamed heading, and the doc comment is updated.
- Removed from `worker/deno/tests/negative_test_must_fail_3060_test.ts`: ``assert( text.includes("A negative test must be able to fail"), `Choosing assertions is missing the back-reference: ${text}`, );``
  Required by: "to cover source and agreement tests"
  Replaced by: ``assert( text.includes("A test must be able to fail on the wrong input"), `Choosing assertions is missing the back-reference: ${text}`, );``
- Edited `worker/deno/tests/edited_expectation_red_3374_docs_test.ts`: `NEXT_START` points at the renamed heading, and its message is reworded.
- Removed from `worker/deno/tests/edited_expectation_red_3374_docs_test.ts`: ``assert( next > start, `${what}: the edited-expectation rule must precede the negative-test rule`, );``
  Required by: "to cover source and agreement tests"
  Replaced by: ``assert( next > start, `${what}: the edited-expectation rule must precede the wrong-input rule`, );``
- Edited-expectation red checks:
  - 3060 "both surfaces" test: restoring the base `CODING-STANDARDS.md` and guidelines made it go red.
  - 3060 "Choosing assertions" test: restoring the base `CODING-STANDARDS.md` made it go red.
  - 3374 "both surfaces" test: with the base docs, the ordering assertion went red.
- `./quality.sh < /dev/null` on the final head passed: every check reported PASSED except `config integration`, which reported SKIPPED; the overall result line was `Result: PASSED (with skipped checks)`.

<!-- vibe-branch-outcomes -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
