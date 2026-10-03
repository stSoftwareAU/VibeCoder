## Summary

Adds **Scope a rule to the runs it is true for** to `CODING-STANDARDS.md` §
Prompt Engineering Guidance, next to "Check the existing rules before you add
one", with a one-line pointer from `docs/EXTENDING.md` § Phase-scoped
coding-guidelines layers. A sentence added to
`prompts/coding_guidelines/prompt.md` about what the worker does must hold for
every run that loads its layer. If it holds for only some, it names those runs
or moves to that run type's own `prompts/<type>/prompt.md`. Closes #3135.

## Spec

### Intent and Rationale

- Two fleet PRs (#3075, #3095) wrote issue-run-only claims into the shared
  guidelines. The claims were false for CI-fix and PR-feedback runs, which
  load the same `code` layer.
- A guidance rule is the smallest fix: a layer marker cannot say "issue runs
  only", because `CODING_GUIDELINES_LAYER_BY_PHASE` maps `issue`, `ci_fix`,
  `pr_feedback`, `merge_conflict`, `custom_pr` and `workflow_setup` to the
  same `code` layer.

### Essential Design Decisions

- The rule lists every run type in the `code` layer, including custom PR and
  workflow-setup runs. The issue's proposed text names only four.
- The drift test imports `CODING_GUIDELINES_LAYER_BY_PHASE` to check the
  rule's premise (`issue`, `ci_fix` and `pr_feedback` all map to `code`), so
  that table is not retyped in the test.

### Undiscoverable Facts

None.

## Evidence

This is a documentation and standards change only, so no screenshot applies.

- The claims about other components were checked against the code:
  - `worker/deno/lib/prompt_builder.ts:120` holds the `CODING_GUIDELINES_LAYER_BY_PHASE` table.
  - `worker/deno/lib/pr_ci_processor.ts:2275` calls `_resolveBaseBranchDeferral` on the `Depends on owner/repo#N` line.
  - `worker/deno/lib/pr_feedback_processor.ts:1182` calls `detectEscapeHatch(customMessage, repo)`.
- Related existing rules checked:
  - "Check the existing rules before you add one" and "Verify a claim about another component before you write it" in `CODING-STANDARDS.md`.
  - The layer table and marker rules in `docs/EXTENDING.md` § Phase-scoped coding-guidelines layers.
  - The pr_feedback prompt's "Verify a claim about another component" rule.
  - The new rule adds to these and contradicts none of them.

**Docs sweep** — grep: `CODING_GUIDELINES_LAYER_BY_PHASE`, "guidelines-layer", "Phase-scoped coding-guidelines layers"; section: `docs/EXTENDING.md#phase-scoped-coding-guidelines-layers`; updated: `CODING-STANDARDS.md`, `docs/EXTENDING.md`

## Test Plan

- Added `worker/deno/tests/coding_guidelines_run_scope_3135_test.ts`, a section-scoped documentation-drift test with two cases:
  - The `CODING-STANDARDS.md` Prompt Engineering Guidance section carries the rule's phrases, and the live layer table maps `issue`, `ci_fix` and `pr_feedback` to `code`.
  - The `docs/EXTENDING.md` Phase-scoped coding-guidelines layers section carries the pointer.
- Red check: with the new `CODING-STANDARDS.md` bullet removed, case (a) failed with `Prompt Engineering Guidance is missing "Scope a rule to the runs it is true for"`. With the `EXTENDING.md` pointer removed, case (b) failed the same way. Both passed once the text was restored.
- `deno test` over the new test plus `existing_rule_conflicts_3077_test.ts`, `system_behaviour_claims_3072_test.ts` and `coding_standards_model_agnostic_test.ts`: 20 passed, 0 failed.
- No existing test was edited.
