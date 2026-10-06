## Summary

Adds a check to the guidance: a run that writes or changes a rule must apply
that rule to its own PR's diff before raising the PR. That diff covers the
rule's examples, the code and tests, helper doc comments and the PR summary
lists. The new **Apply a new rule to your own diff** bullet sits in
`CODING-STANDARDS.md` § Prompt Engineering Guidance, directly after **Check
the existing rules before you add one**. The same check is copied into the
coding-guidelines prompt, step 3 of the issue prompt, and the pr_feedback
prompt, since review-fix runs reword rules too. Closes #3249.

## Spec

### Intent and Rationale

- VibeCoder#3160, #3236 and #3240 were each sent back because the PR's own example, tests or summary list broke the rule the PR added. The existing-rules check only covers *existing* rules in the guidance files, so it never looked at the PR's own new content.
- The new check sits beside the existing-rules check in each surface, so a run adding a rule meets both checks together.

### Essential Design Decisions

- The rule offers two fixes for a self-breach: change the content, or narrow the rule so it names the allowed use. Its worked example agrees with drift-test condition 1, which already treats `flatWholeFile` on a phrase literal as allowed and a positive pin over a page's text as a finding.
- The PR body or `.pr_response_message` must say the rule was applied to the PR's own diff and name what was found. That gives reviewers the verification surface the issue asks for.

### Undiscoverable Facts

- The three cited PRs and their review findings come from the issue body. The #3236 history sentence says the model sentence "over-claimed what the scan covered" and makes no claim about how the scan behaves today, because #3264 has since changed that scan.

## Evidence

Prompt and standards change only. No runtime code changed. It is covered by the
documentation-drift test `worker/deno/tests/own_diff_rule_check_3249_docs_test.ts`.

**Existing rules checked** (per **Check the existing rules before you add
one**): that bullet itself (`CODING-STANDARDS.md`); its copies in
`prompts/coding_guidelines/prompt.md` (A Code Change Owes a Docs Change) and
`prompts/issue/prompt.md` step 3; **Verify a claim about another component**
and **Prose about the PR's own change** (`CODING-STANDARDS.md`), along with
their pr_feedback forms **Verify a claim…** and **Hold prose about this PR's
own change…**; and drift-test condition 1 on `flatWholeFile`
(`CODING-STANDARDS.md` § Documentation-drift tests). None conflicts with the new
rule. The new rule's `flatWholeFile` example repeats condition 1's existing
allowance.

**Applied the new rule to this PR's own diff:** I grepped
`git diff origin/main...HEAD` for the nouns the rule governs: `flatWholeFile`,
`Branch outcomes:`, "example" and "helper doc comment".

- The new test pins every phrase through `flat(section(...))` and never calls
  `flatWholeFile`.
- The rule's one example (the `flatWholeFile` narrowing) matches condition 1
  as written at the head.
- The history sentences make no present-tense claim about code.
- This summary carries a `Branch outcomes:` line and states the result of the
  rule check.

Nothing needed changing.

**Docs sweep**: grep: "Check the existing rules", "existing rules on the
same", "own diff", "Prompt Engineering Guidance" over `README.md` and `docs/`
(excluding `docs/archive/`). No manual documents this check, so the section is
`none`. `docs/workflows/pr-feedback.md:397`: still true, because it describes
the Issue #3072 claim rule, which is unchanged. The other "own diff" hits
(`docs/SECURITY-TREE-SWEEP.md:302`,
`docs/audits/security-sweep-2183-lib-delta-12d-12f.md:278`) describe other
subjects and are still true. Updated: `CODING-STANDARDS.md`,
`prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`,
`prompts/pr_feedback/prompt.md`.

## Test Plan

- Added `worker/deno/tests/own_diff_rule_check_3249_docs_test.ts`, with four
  section-scoped cases: `CODING-STANDARDS.md` § Prompt Engineering Guidance,
  `prompts/coding_guidelines/prompt.md` § A Code Change Owes a Docs Change,
  `prompts/issue/prompt.md` § Instructions, and `prompts/pr_feedback/prompt.md`
  § Making Changes.
- `deno task drift-pins-on-base origin/main <doc> "<section>" <phrases...>` ran
  once for each of the four sections. Every pinned phrase was reported
  `absent on base`, and each run exited 0.
- Red check: with only the `CODING-STANDARDS.md` hunk reverted, the
  CODING-STANDARDS case failed (`missing "Apply a new rule to your own diff"`).
  After the hunk was restored, all four cases passed.
- `deno task test:unit tests/own_diff_rule_check_3249_docs_test.ts tests/existing_rule_conflicts_3077_test.ts tests/coding_guidelines_layers_2574_test.ts tests/coding_guidelines_run_scope_3135_test.ts`
  passed (22 passed, 0 failed). The 16 other test files that read
  `prompts/pr_feedback/prompt.md` passed too (67 passed, 0 failed).
- No existing test was edited, so no assertions were removed.
- `./quality.sh`: see the result line below.

Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
