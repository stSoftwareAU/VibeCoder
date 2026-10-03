## Summary

Adds a concrete check for prose that describes **the PR's own new behaviour**,
so a doc or prompt sentence can no longer drop a condition the code checks or
use an absolute word the code does not guarantee. The same four steps land in
`CODING-STANDARDS.md` (§ PR Summary and Evidence, right after the paragraph
saying each assertion must match the head code), the docs step (step 3) of
`prompts/issue/prompt.md`, and § Making Changes of `prompts/pr_feedback/prompt.md`
(the review-fix prompt that edits docs). The existing rule stays as it was;
this adds a procedure for following it. Closes #3120.

The four steps:

1. For each added or edited sentence that says **when** the behaviour happens
   or **what it costs**, list every condition and path in the code that
   decides it. The sentence names each one, or is scoped to the path it
   describes.
2. An absolute word ("only", "never", "always", "any", "automatically",
   "exactly as before") needs a line of head code that guarantees it.
   Otherwise the sentence is rewritten.
3. A change that moves a cost (download, retry, push, fallback) says where the
   cost now lands.
4. A sentence about history is checked against the base-branch code.

## Spec

### Intent and Rationale

- #3058 covers claims about changes absent from the diff, and #3072 covers claims about other components. Neither covers prose about the PR's own component, which is where GRQ#5158, VibeCoder#3095, #3119, GRQ#5153 and GRQ-AutoTrader#2259 went wrong.
- The full rule lives in one place, CODING-STANDARDS.md. Each prompt carries a short restatement that points back to it by name, **Prose about the PR's own change**.

### Essential Design Decisions

- The standards text sits in § PR Summary and Evidence, not in § A Code Change Owes a Docs Change. That keeps `coding_guidelines_meaning_change_2904_test.ts` meaningful: its bullet regex reads to the end of that section.
- `prompts/coding_guidelines/prompt.md` is unchanged. The issue did not name it, and its text is paid for in every session.

### Undiscoverable Facts

None.

## Evidence

Docs and prompts only (plus a documentation-drift test). No runtime code changed.

- `worker/deno/tests/own_change_claims_3120_test.ts` has three section-scoped
  tests, one per surface. Each one went red when its doc alone was reverted,
  for example `PR Summary and Evidence is missing "Prose about the PR's own change"`,
  and green again when the doc was restored. Each pinned phrase was missing
  from the base version of its section.
- `./quality.sh < /dev/null` passed after the final edit. `config integration`
  shows as SKIPPED.

**Docs sweep** — grep: "must match the head code", "exclusive or negative claim", "Code Change Owes a Docs Change"; section: `CODING-STANDARDS.md#pr-summary-and-evidence`, `prompts/issue/prompt.md#instructions` (step 3), `prompts/pr_feedback/prompt.md#making-changes`; updated: `CODING-STANDARDS.md`, `prompts/issue/prompt.md`, `prompts/pr_feedback/prompt.md`

**Related existing rules checked** (none conflict; the new rule covers the PR's own change and the #3072 rules cover other components):

- CODING-STANDARDS.md § Prompt Engineering Guidance, "Verify a claim about another component before you write it" (#3072)
- CODING-STANDARDS.md § Prompt Engineering Guidance, "Check the existing rules before you add one" (#3077)
- CODING-STANDARDS.md § PR Summary and Evidence, "each assertion it makes must match the head code"
- issue prompt step 3, the other-component claim rule
- issue prompt § PR Summary File, "Hold every doc the diff adds or edits to the same rule"
- pr_feedback "A fix owes its docs change too", "Keep the PR summary true to the head" and "Verify a claim about another component before you write it" (#3090)

## Test Plan

- Added `worker/deno/tests/own_change_claims_3120_test.ts`, which follows the documentation-drift pattern of `system_behaviour_claims_3072_test.ts`.
- Re-ran `system_behaviour_claims_3072_test.ts`, `existing_rule_conflicts_3077_test.ts`, `coding_guidelines_meaning_change_2904_test.ts` and `coding_guidelines_layers_2574_test.ts`. All pass, and no existing test was edited.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
