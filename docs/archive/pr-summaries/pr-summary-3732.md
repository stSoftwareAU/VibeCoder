## Summary

Adds the "Change every copy of a twinned rule" guidance the issue proposes.
The bullet sits next to the DRY bullet in both `CODING-STANDARDS.md` and its
injected twin, `prompts/coding_guidelines/prompt.md`. Before changing a rule,
gate, matcher or check, a run searches for text that declares a second copy
and for the rule or function name. It then changes every copy in the same PR,
makes one copy call the other, or adds a test that fails when they disagree,
and the Test Plan names the copies found.

For VibeCoder, the `pr-summary-check` paragraph in `CODING-STANDARDS.md` and
in the issue, pr_feedback and ci_fix prompts now says that
`worker/deno/lib/pr_summary_check.ts` is the twin of the completion phase's
PR-summary gates. A change to how the completion phase runs one of those gates,
or prepares its input, therefore changes `pr_summary_check.ts` the same way in
the same PR. A new drift test keeps the bullet word for word identical in its
two copies and pins the twin sentence on all four surfaces. Closes #3732.

## Spec

### Intent and Rationale

- In #3283, #3707 and a private fleet PR, the second copy was already declared in text the agent had in front of it, so the rule asks the agent to search for that declaration before changing a rule.
- Both copies of the bullet carry it, so it reaches fleet runs that see only the injected guidelines (the gap in #3283).

### Essential Design Decisions

- The bullet's rule text, from its bold lead-in to "or says none was found.", is identical in both files. `twinned_rule_3732_docs_test.ts` compares the two extracts, which makes the rule follow its own advice. Each copy then has its own last sentence naming the pairs in its own context.
- The `pr_summary_check.ts` sentence covers only changes to how the completion phase runs or feeds a gate. A change inside a shared validator such as `validateDocsSweep` already reaches both, because both files import the same validator.

### Undiscoverable Facts

- The issue also mentions a "stronger guard": a test that lists the completion phase's summary gates. This PR does not add it. Listing the gates would mean grepping `completion_phase.ts` source, and the standards forbid that kind of source-text test. The issue frames that test as optional, so this PR ships the guidance and the drift tests instead.

## Evidence

Documentation and prompt change only, with no UI and no runtime code. The rule is protected by `worker/deno/tests/twinned_rule_3732_docs_test.ts`.

**Docs sweep**: grep: "DRY", "pr-summary-check", "pr_summary_check", "twin"; section: `CODING-STANDARDS.md#coding-principles`, `CODING-STANDARDS.md#pr-summary-and-evidence`; siblings: none, because no existing set gained a member; updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`, `prompts/pr_feedback/prompt.md`, `prompts/ci_fix/prompt.md`. One hit was left in place: `docs/pre-pr-ci-audit.md:211` is still true because it is a historical audit row about #3707.

Related existing rules checked: the DRY bullet (both copies), **Every restatement of a rule gives the same answer** and **A Code Change Owes a Docs Change** (`CODING-STANDARDS.md`), **Call the existing owner — never copy it** (issue prompt), and the #3423 `pr-summary-check` paragraph (four surfaces). The new rule agrees with each of them, and "make one call the other" is the same advice as calling the existing owner.

I applied the new rule to this PR's own diff. It edits two twinned rules, and every copy of each was changed in this diff:

- The twinned-rule bullet has two copies, `CODING-STANDARDS.md` "Coding Principles" and `prompts/coding_guidelines/prompt.md` "General Coding Principles". Test 1 of the new test file fails when they disagree.
- The `pr-summary-check` paragraph has four copies, in `CODING-STANDARDS.md` "PR Summary and Evidence", `prompts/issue/prompt.md`, `prompts/pr_feedback/prompt.md` and `prompts/ci_fix/prompt.md`. Each carries the same twin sentence, which the new test pins.

I found no other copies.

## Test Plan

- Added `worker/deno/tests/twinned_rule_3732_docs_test.ts`, which has 5 tests:
  - One test compares the twinned-rule bullet across both copies and pins five phrases in each section.
  - Four tests pin the `pr_summary_check.ts` twin sentence on each surface.
- `./quality.sh` passed on the head commit (`Result: PASSED (with skipped checks)`; only `config integration` was skipped).
- `deno task test:unit tests/twinned_rule_3732_docs_test.ts tests/coding_guidelines_twin_drift_test.ts tests/coding_guidelines_layers_2574_test.ts tests/coding_guidelines_v42_test.ts tests/pr_summary_check_prompt_3423_test.ts`: 32 passed, 0 failed.
- Red check on the comparison test: I changed "Before changing a rule" to "Before altering a rule" in the guidelines copy only, and the test went red with "the twinned-rule bullet differs …". It is green again after restoring the word.
- Every pinned phrase is absent from the base section. `deno task drift-pins-on-base origin/milestone/fleet-guidance-tests-twins-and-portability …` printed `absent on base` for all five bullet pins in both "Coding Principles" and "General Coding Principles", and for "is the twin of the completion phase's PR-summary gates" in all four twin-sentence sections.
- No existing test was edited and no assertion was removed.

<!-- vibe-branch-outcomes -->
