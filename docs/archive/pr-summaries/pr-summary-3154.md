## Summary

The Escape Hatch section of `prompts/coding_guidelines/prompt.md` has no layer marker. That makes it core-layer text, so `CODING_GUIDELINES_LAYER_BY_PHASE` renders it into every phase. Step 3 told every run two contradictory things:

- A PR-feedback or CI-fix run keeps using the `.pr_response_message` escape hatch "including on a branch that already has commits".
- Then, unscoped: the worker releases its claim only while the branch has no commits, and "once work is committed, this free-text hand-off is not read".

The second claim holds only for an issue run. `pr_feedback_processor.ts` calls `detectEscapeHatch(customMessage, repo)` on `.pr_response_message` whatever the branch holds. The fix scopes the claim-release sentence to issue runs: "In an issue run, the worker releases its claim … only while the branch has no commits …; once work is committed, an issue-comment hand-off is not read." Closes #3154.

## Spec

### Intent and Rationale

- A shared-layer rule must hold for every run that loads it (CODING-STANDARDS.md, "Scope a rule to the runs it is true for"). Two contradictory rules in one step leave a PR-feedback or CI-fix agent unsure whether its committed-branch hand-off will be read.

### Essential Design Decisions

- I scoped the sentence in place instead of moving it to `prompts/issue/prompt.md`. The issue prompt already carries the same issue-scoped wording, and the shared text still needs to tell an issue run why it must not close the issue.
- The wording keeps the phrase "hands the issue to a human (`needs-human`) only while the branch has no commits" that `pr_claims_verified_3058_test.ts` pins.

### Undiscoverable Facts

- `detectEscapeHatch` has a single production caller, `pr_feedback_processor.ts:1182`, which reads `.pr_response_message` with no commit check. CI-fix runs share that path.

## Evidence

This change touches only prompt text and a test, so there is no screenshot.

- **Red without the change:** with only the prompt edit reverted, the new test failed with `AssertionError: Sentence about claim release or hand-off is not scoped to issue runs: "The worker releases its claim and hands the issue to a human (`needs-human`) only while the branch has no commits and no uncommitted changes against the base."`
- **Green:** `deno task test:unit tests/coding_guidelines_run_scope_3135_test.ts tests/pr_claims_verified_3058_test.ts tests/coding_guidelines_layers_2574_test.ts` gave `ok | 20 passed | 0 failed`.
- `./quality.sh < /dev/null` gave `Result: PASSED (with skipped checks)`. Only `config integration` was skipped, because there is no `.config.json` in this checkout.

**Docs sweep:** I grepped for `releases its claim`, `hand-off is not read` and `only while the branch has no commits` across `prompts/`, `CODING-STANDARDS.md`, `README.md`, `DESIGN-PRINCIPLES.md` and `docs/`.

- `prompts/issue/prompt.md` (lines 323-329) is already issue-scoped.
- The CODING-STANDARDS.md paragraph at line 1100 already opens with "In an issue run" and names the PR-feedback and CI-fix exceptions.
- The `docs/INTERNALS.md` and `run_core.ts` hits describe a different claim release.

No other surface needed a change.

**Related rules checked:**

- `prompts/coding_guidelines/prompt.md` Escape Hatch step 3: the PR-feedback/CI-fix exception and the issue-run free-text sentence.
- The "Blocked on another issue" section of the same file.
- `prompts/issue/prompt.md` Escape Hatch.
- `prompts/pr_feedback/prompt.md` and `prompts/ci_fix/prompt.md` (`.pr_response_message`, "Base-branch failures").
- CODING-STANDARDS.md: "Scope a rule to the runs it is true for", and the #3058/#3088 hand-off paragraph.

All of these now agree.

## Test Plan

- `worker/deno/tests/coding_guidelines_run_scope_3135_test.ts`, test "Escape Hatch rendered for a PR-feedback run scopes the claim-release sentence to issue runs (Issue #3154)":
  - Renders the guidelines through `selectCodingGuidelinesLayer` for the `pr_feedback` layer.
  - Asserts that the PR-feedback/CI-fix exception is present.
  - Asserts that every sentence mentioning "releases its claim" or "once work is committed" starts "In an issue run", and that at least one such sentence exists.
- The existing `pr_claims_verified_3058_test.ts` and `coding_guidelines_layers_2574_test.ts` pass unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
