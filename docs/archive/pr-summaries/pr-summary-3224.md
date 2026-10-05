## Summary

Adds the rule **A fake mirrors the production implementation it stands in
for** to `CODING-STANDARDS.md` and to `prompts/coding_guidelines/prompt.md`,
word for word on both, directly after the stub-contract rule. It adds a
matching self-review check to the Bugs/Enhancements requirement in
`prompts/issue/prompt.md`, beside the existing "run the real tool on that case
first" check. The operator manual (`docs/workflows/issue-processing.md`)
records the change. Closes #3224.

## Spec

### Intent and Rationale

- Fleet PRs (GRQ-AutoTrader#2546, #2460, #2407, #1922) passed CI on an in-repo fake that had a property its production adapter lacks. The existing stub-contract and observe-real-tool rules cover only external callees, so nothing asked the author to read the production implementation in the same checkout.
- The rule text follows the wording proposed in the issue. Three sentences were added: one says how it differs from the stub rule, one says a fix to the fake is still held to **A red run counts only against the base branch**, and one makes a fake-only proof a blocking self-review finding.

### Essential Design Decisions

- The paragraph goes between the stub-contract and observe-real-tool paragraphs. This keeps the order that `worker/deno/tests/observe_real_tool_3082_test.ts` checks (stub before observe before workflow-validator).
- The paragraph is identical on both surfaces, and the new drift test checks that.

### Undiscoverable Facts

- The issue's "How to verify it worked" is measured over later fleet reviews (`review-fleet-prs` `log.jsonl`), so this PR cannot show it.

## Evidence

This is a documentation and prompt change only. Nothing in the runtime changed.

**Related existing rules checked:**

- "A stub mirrors the real callee's contract" and "Observe the real tool before you rely on it": they cover external callees, and the new rule says so.
- "A red run counts only against the base branch": the new rule defers to it when the fake is fixed.
- "Every changed call site needs a test that goes red without it": it says a test double that bypasses the production path does not count.
- "Every outcome of a branch you add needs a test that reaches it": it says a double that overrides the default does not reach the other outcomes.
- None of these conflicts with the new rule.

**Docs sweep:**

- grep: `stub mirrors`, `Observe the real tool`, `own ports`, `in-repo fake`, "fake\w* mirror"
- section: `docs/workflows/issue-processing.md` (the Issue #3082 observe-real-tool paragraph)
- updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`, `docs/workflows/issue-processing.md`
- Hits left in place:
  - `docs/workflows/issue-processing.md:1426`: still true, because it describes the external-tool rule, which is unchanged.
  - `worker/deno/lib/issue_executor_agents.ts:194`: still true, because it lists three departures the Standards reviewer always reports. That list is not a full list of standards, and this issue did not ask to extend it.

## Test Plan

- Added `worker/deno/tests/fake_mirrors_production_3224_test.ts`, a documentation-drift test with three checks:
  - Both surfaces carry the rule, and the two copies are identical once line wrapping is ignored.
  - The rule sits after the stub-contract paragraph and before the observe-real-tool paragraph.
  - The issue prompt's PR Raising Requirements carries the self-review check.
- Red against base: with the three edited Markdown files reset to `origin/main`, all 3 tests failed. With the edits restored, they pass.
- Pins checked against base: `deno task drift-pins-on-base origin/main …`, run on each pinned phrase across the three surfaces, reported every phrase as `absent on base`.
- `deno task test:unit` on the new test plus `observe_real_tool_3082_test.ts`, `phantom_test_and_stub_contract_3011_test.ts`, `coding_guidelines_layers_2574_test.ts`, `existing_rule_conflicts_3077_test.ts` and `coding_guidelines_base_branch_red_2924_test.ts`: 26 passed, 0 failed.
- `./quality.sh < /dev/null` on the final code commit passed. The only check not run was config integration, which the gate skipped.
- No existing test was edited, and no assertions were removed.

Branch outcomes: none added
