## Summary

#3077 told agents to check a new rule against the **existing** rules. Three fleet PRs since then (#3240, #3308, #3550) were still sent back because their **own** sentences gave opposite answers for the same case. In #3550 the gap was an exception added in one place on a review-fix round and not carried to the rule's other restatements. This PR adds a rule, **Every restatement of a rule gives the same answer**: list every place the diff states or illustrates the rule, name the edge case the rule decides, and read each place for it. Any exception, fallback or scope limit is applied to every restatement, and the diff is then grepped for the old wording. The rule is in `CODING-STANDARDS.md` (with a pointer from **Check the existing rules before you add one**), the issue prompt, the coding-guidelines prompt and the PR-feedback prompt. Closes #3554.

## Spec

### Intent and Rationale

- The existing-rules check (#3077) and **Apply a new rule to your own diff** (#3249) do not ask whether the PR's own restatements of a rule agree with each other. All three cited failures were that kind of contradiction.
- A separate bullet, rather than a longer **Check the existing rules** bullet, keeps each rule to one subject. The existing-rules bullet now points at it, so readers of either bullet find both.

### Essential Design Decisions

- Every surface gives the same answer for the new rule's own edge case, an exception added in one place: apply it to every restatement, then grep the diff for the old wording. The three general surfaces say "whenever the diff adds … — on a review-fix round above all". The PR-feedback prompt is always a fix round, so it says "when the fix adds …".
- The PR-feedback prompt gets the rule as well as the coding-guidelines prompt. That prompt already carries the sibling rule ("A rule you add or reword applies to this PR first"), and review-fix rounds are where #3550 failed. The Standards reviewer flagged that the first draft left it out.

### Undiscoverable Facts

- The evidence for #3240, #3308 and #3550 comes from the review-fleet-prs round recorded in the issue body, not from anything in this repository.

## Evidence

This change touches documentation and prompts only. No UI is affected.

- New drift test `worker/deno/tests/own_restatements_agree_3554_docs_test.ts` pins the rule in four sections: `CODING-STANDARDS.md` § Prompt Engineering Guidance, `prompts/coding_guidelines/prompt.md` § A Code Change Owes a Docs Change, `prompts/issue/prompt.md` § Instructions, and `prompts/pr_feedback/prompt.md` § Making Changes.
- Related existing rules checked: **Check the existing rules before you add one** and **Apply a new rule to your own diff** (`CODING-STANDARDS.md`); the matching step-3 text in `prompts/issue/prompt.md`; the two matching bullets in `prompts/coding_guidelines/prompt.md`; and "A rule you add or reword applies to this PR first" in `prompts/pr_feedback/prompt.md`. The new rule extends them and contradicts none.
- **Applied the new rule to this PR's own diff.** The edge case is "an exception added in one place". All four restatements answer "apply it to every restatement and grep the diff for the old wording". A grep of `git diff origin/main...HEAD` for "review-fix round" and "restatement" found no restatement that limits the rule to review-fix rounds only. One finding: the first draft left out the PR-feedback prompt, which holds the sibling rule. It is fixed in this diff.
- Issue numbers cited as provenance (each checked with `gh pr view` / `gh issue view`):
  - #3077: the earlier issue that added "Check the existing rules before you add one", cited from the issue body.
  - #3240: Drift tests keep checking whole files despite condition 1 … (PR, merged).
  - #3308: Pre-commit gate: accept hidden paths the repo's tracked .gitignore re-allows (#3296) (PR, merged).
  - #3550: Retro: diagnose why a rule was ignored before proposing another rule (#3425) (PR, merged).
  - #3554: this issue.

**Docs sweep** — grep: "Check the existing rules before you add one", "Apply a new rule to your own diff", "applies to this PR first", "restatement"; section: `CODING-STANDARDS.md#prompt-engineering-guidance`; siblings: none — no existing set gained a member; updated: `CODING-STANDARDS.md`, `prompts/issue/prompt.md`, `prompts/coding_guidelines/prompt.md`, `prompts/pr_feedback/prompt.md`; no other hits outside `docs/archive/` and tests.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — `CODING-STANDARDS.md`, the "Check the existing rules before you add one" bullet — evidence: `worker/deno/tests/own_restatements_agree_3554_docs_test.ts` (pin "The rule's own restatements in this diff are held to the same standard") — reviewer: met
- **met** — The matching self-review lines in `prompts/issue/prompt.md` (~311) and `prompts/coding_guidelines/prompt.md` (~268), so issue runs and review-fix runs (PR-feedback phase) both see it — evidence: `worker/deno/tests/own_restatements_agree_3554_docs_test.ts` (issue-prompt and coding-guidelines cases) — reviewer: met
- **met** — Extend the rule from existing rules to the PR's own restatements: list every place this diff states or illustrates it, name the edge case the rule decides, read each place for that case, every place must give the same answer — evidence: `worker/deno/tests/own_restatements_agree_3554_docs_test.ts` — reviewer: met
- **met** — On a review-fix round that adds an exception, fallback or scope limit, apply it to every restatement, then search the diff for the old wording — evidence: `worker/deno/tests/own_restatements_agree_3554_docs_test.ts` (pins "apply it to every restatement, then search the diff for the old wording" and "… then grep") — reviewer: met
- **met** — An example that contradicts its own rule is the same defect as two contradictory rules — evidence: `worker/deno/tests/own_restatements_agree_3554_docs_test.ts` — reviewer: met
- **unrequested** — the trigger was widened from "on a review-fix round" to "whenever the diff adds an exception … — on a review-fix round above all" — reviewer: unrequested — reason: an exception added in a first round needs the same handling, and every restatement words it the same way
- **unrequested** — the case-study sentence citing #3240, #3308 and #3550 in the `CODING-STANDARDS.md` bullet — reviewer: unrequested — reason: neighbouring rules in that section record their provenance the same way, and these cases are the issue's own evidence table
- **unrequested** — the drift test `worker/deno/tests/own_restatements_agree_3554_docs_test.ts` — reviewer: unrequested — reason: a documentation-drift test is the repository's standard guard for a new prompt rule
- **unrequested** — the restatement in `prompts/pr_feedback/prompt.md` — reviewer: unrequested — reason: the Standards reviewer found it was needed so the rule agrees with that prompt's sibling rule and reaches review-fix rounds (this diff's own rule, applied to itself)

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Every restatement of a rule gives the same answer / Check the existing rules: the new rule was not restated in `prompts/pr_feedback/prompt.md`, which carries the sibling rule for review-fix rounds — evidence: `prompts/pr_feedback/prompt.md:113` — reason: fixed in this diff (new paragraph at `prompts/pr_feedback/prompt.md:115`, pinned by the fourth drift-test case)
- **clean** — Australian English. Restatements agree on the edge case. No overlap conflict with existing rules. Drift test is section-scoped with no subsumed pins. Every named test exists. No assertion removed or expectation changed in existing tests. Review-enforced rules checked: Check the existing rules before you add one, Apply a new rule to your own diff, Documentation-drift test conditions, A named test must exist, Scope a rule to the runs it is true for, Verify a claim about another component before you write it.

## Test Plan

- Added `worker/deno/tests/own_restatements_agree_3554_docs_test.ts` (4 cases). `deno task test:unit` on it and on `worker/deno/tests/own_diff_rule_check_3249_docs_test.ts` passed (8 passed, 0 failed).
- Red check: with the four docs restored to `origin/main`, the new test failed. The first three cases (3 failed) showed "section is missing pin" errors. Restoring only `prompts/pr_feedback/prompt.md` to base failed the fourth case (1 failed).
- Pins absent on base: `deno task drift-pins-on-base origin/main …` reported "absent on base" for every pin in all four sections.
- No existing test edited, so no assertions removed.
- Executors also ran these existing suites, which passed: coding_guidelines twin, layer and run-scope tests; the issue-prompt tests; and all `tests/pr_feedback*`.
- `./quality.sh` full gate on the head: "Result: PASSED (with skipped checks)". Only "config integration" was skipped. deno tests, lint, type check, fmt, markdownlint and semgrep all passed.

Branch outcomes: none added
