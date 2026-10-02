# PR Summary — Issue #3077

## Summary

Adds a rule saying a new or changed prompt or standards rule must be checked against the existing rules on the same subject before it is written. If an existing rule overlaps, the new rule must agree with it, or the existing rule must be changed in the same diff. Rules that contradict each other are a defect to fix before the PR is raised, not a follow-up. The rule is in three places:

- `CODING-STANDARDS.md` → **Prompt Engineering Guidance**, as the bullet **Check the existing rules before you add one**, citing #3066 and #3075.
- `prompts/coding_guidelines/prompt.md` → **A Code Change Owes a Docs Change**, as the injected copy.
- `prompts/issue/prompt.md` → step 3 of **Instructions**, the prompt- and doc-edit step.

Closes #3077.

## Spec

### Intent and Rationale

- Two fleet PRs (#3066, #3075) each added a rule that contradicted one the prompts already had, and left the old rule in place. In both cases, one grep for the nouns the new rule governs would have found the conflict.
- This complements #3072's **Verify a claim about another component** rule. That rule checks factual claims against code. This one checks a new instruction against the existing instructions.

### Essential Design Decisions

- In the coding guidelines, the rule is a bullet inside **A Code Change Owes a Docs Change**, not a new `##` heading. A new heading would have to be classified in the phase-layer split pinned by `coding_guidelines_layers_2574_test.ts`. The bullet comes before the state-meaning bullet: `coding_guidelines_meaning_change_2904_test.ts` reads from that bullet to the end of the section, so it has to stay last.
- The guidelines copy names the VibeCoder paths but adds "or the repository's equivalents", because the guidelines are injected into runs on other repositories.

### Undiscoverable Facts

- `TOOL_OUTPUT_IS_DATA_RULE` (#3066) is not on the default branch; that PR was sent back. This PR only cites it as history.

## Related existing rules checked

This PR follows its own rule. The search covered `CODING-STANDARDS.md`, `prompts/*/prompt.md` and `worker/deno/lib/` for overlapping rules: rule, follow-up, scope, conflict and "existing rule".

- **Stay in scope** in the coding guidelines (note separate work for a follow-up) and **Change Scope** in the issue prompt ("Do not update unrelated documentation"). These overlap: someone could read fixing an old rule as scope creep. The new rule carves this out by name: fixing a conflicting rule is part of the change, not a follow-up under **Stay in scope**.
- **Mind the token economy** and the guidelines' "one clear statement" rule agree with the new rule; neither needed a change.
- **Verify a claim about another component** (#3072) is a complementary rule on a different axis; no change needed.
- **A Code Change Owes a Docs Change** agrees with the new rule: both require fixing every overlapping surface in the same change.

## Evidence

This is a documentation and prompt change only; there is no UI.

- `worker/deno/tests/existing_rule_conflicts_3077_test.ts` checks that all three surfaces still carry the rule. As a red run, all three cases failed with the pre-edit files restored from `HEAD`, and pass with the edits.
- These targeted tests pass: `existing_rule_conflicts_3077_test.ts`, `system_behaviour_claims_3072_test.ts`, `coding_guidelines_twin_drift_test.ts`, `coding_guidelines_layers_2574_test.ts`, `coding_guidelines_meaning_change_2904_test.ts` and `negative_test_must_fail_3060_test.ts` (30 passed).
- `./quality.sh` passed in full; config integration was skipped, as it is locally.

**Docs sweep** — grep: "Prompt Engineering Guidance", "A Code Change Owes a Docs Change", "Before new prompt or doc text" across `README.md`, `docs/` (excluding `docs/archive/`) and `*/README.md`. No other surface restates these sections, so only the three files above were updated.

## Test Plan

- Added `worker/deno/tests/existing_rule_conflicts_3077_test.ts`, with one case per surface.
- No existing test was edited, and no assertions were removed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
