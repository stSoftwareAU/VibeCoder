## Summary

*A Code Change Owes a Docs Change* only fired on a rename, a change of meaning, or a change to what a variant means. A purely **additive** change (a new field, enum variant, kind or column) leaves no old name to grep, so the doc listing the set stayed one short (GRQ-AutoTrader#1820, #2217, #2210, #2386). The rule now has an additive-member bullet: grep for one or two **existing sibling members**, then make every list of the set name the new member or reword it so it no longer reads as complete. Closes #3137.

- [x] Bullet added to `CODING-STANDARDS.md` → *A Code Change Owes a Docs Change*
- [x] The same bullet, word for word, in `prompts/coding_guidelines/prompt.md`
- [x] Matching sentence in `prompts/issue/prompt.md` step 3 (the docs sweep)
- [x] Regression test pinning all three surfaces

## Spec

### Intent and Rationale

- The new member's name is in no doc yet, so grepping for it always comes back clean. Only a grep for a sibling member finds the stale list, so the rule tells the agent to grep for those.

### Essential Design Decisions

- The bullet is identical on both twin surfaces, and the test asserts that equality. It sits before the meaning-change bullet, so the #2904 test still extracts that bullet unchanged.
- The issue prompt gets one sentence beside the manual-section sweep. It does not repeat the full bullet; it relies on the restated standard.

### Undiscoverable Facts

- The four motivating findings came from fleet PR reviews in stSoftwareAU/GRQ-AutoTrader. #1820 was raised again over six review iterations.

## Evidence

Docs/prompt-only change plus a test. There is no UI. `./quality.sh < /dev/null` passed on the final head (config integration was skipped, as on every local run).

**Docs sweep** — grep: "Owes a Docs Change", "owes a docs change", "unchanged name", "sibling"; section: `CODING-STANDARDS.md#a-code-change-owes-a-docs-change`; updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`. `prompts/pr_feedback/prompt.md` points at the standard (which now carries the bullet) and does not list the triggers itself, so it was left as is.

**Related existing rules checked**: the rename and old-name grep (section lead), the unchanged-name bullet (#2883), the state/variant meaning-change bullet (#2904), the rule-overlap bullet (#3077, prompt only), the manual-section sweep in the issue and pr_feedback prompts (#3073), *Prose about the PR's own change* (#3120), and *A Contract a Deployed Extension Reads Is Additive-Only*. That last one is about wire compatibility, not docs. None of them conflicts with the new bullet.

## Test Plan

- Added `worker/deno/tests/coding_guidelines_additive_member_3137_test.ts`:
  - `both surfaces carry the additive-member bullet, word for word (Issue #3137)` checks that the bullet appears in both docs-change sections, carries its key phrases, and is identical on both surfaces.
  - `issue prompt's docs step asks for a sibling-member grep on an additive change (Issue #3137)`.
  - Both tests failed before the doc edits ("could not locate the additive-member bullet in CODING-STANDARDS.md") and pass after.
- These existing tests also passed: `coding_guidelines_meaning_change_2904_test.ts`, `coding_guidelines_twin_drift_test.ts`, `coding_guidelines_layers_2574_test.ts`, `prompt_docs_sweep_3073_test.ts`, `existing_rule_conflicts_3077_test.ts`, and every test that loads the `issue` prompt.
- No existing test was edited.
- `./quality.sh < /dev/null` passed on the final head.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
