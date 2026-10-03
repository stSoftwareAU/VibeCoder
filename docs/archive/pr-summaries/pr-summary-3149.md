# PR Summary — Issue #3149

## Summary

Adds a **Writing a gate over text** subsection to `CODING-STANDARDS.md` (under
**Test coverage expectations**, before **Choosing assertions**) and a pointer to
it from step 1 (the testing step) of the issue prompt's `## Instructions`.
Closes #3149.

The checklist has four points, as the issue proposed:

1. **Evasion table**, run both ways: a test for each realistic variant the gate
   must still block, and, following the issue comment on VibeCoder#3157, a test
   for each look-alike it must not fire on (patterns inside string or template
   literals, `Deno.test.ignore` / `it.skip`).
2. **Corpus run**, reporting false-positive and false-negative counts in the
   Test Plan.
3. **No silent pass on unread input.** Input that is truncated, filtered,
   unparseable or skipped with `continue` fails closed or is reported as not
   checked.
4. **Compare like with like.** Normalise both sides of a comparison the same
   way, and use equality rather than substring containment unless containment
   is the contract.

## Spec

### Intent and Rationale

- Four independent fleet PRs (#3148, #3132, #3134, #3157) were sent back for
  the same kind of defect: a text matcher that missed realistic variants, or
  passed input it never read. A checklist the author runs before calling a gate
  done targets that kind of defect directly.
- This PR only adds guidance, as the issue asks. It changes no gate code.

### Essential Design Decisions

- The new subsection points at **Never Fail Silently — Fail Loud** and
  **Every outcome of a branch you add needs a test that reaches it**, and at
  the ReDoS guidance under **Unit tests**, rather than restating them. Point 3
  is presented as the fail-loud rule applied to a matcher.
- The issue prompt bullet sits beside **Solve the general case** in step 1, so
  it is read at the moment tests are being planned.

### Undiscoverable Facts

- The "run both ways" wording and the literal/skip-declaration variants come
  from the issue comment about VibeCoder#3157, not from the issue body.

## Evidence

This is a documentation and prompt change. It touches no UI or runtime code.

- `worker/deno/tests/text_gate_matcher_3149_test.ts` is a documentation-drift
  test. It pins the checklist's key phrases in the `CODING-STANDARDS.md`
  subsection and in the issue prompt's `## Instructions` section.
- **Related existing rules checked:** **Never Fail Silently — Fail Loud**,
  **A negative test must be able to fail**, **Every outcome of a branch you add
  needs a test that reaches it**, **A new test must go red without its change**
  and the ReDoS / growth guidance under **Unit tests** in `CODING-STANDARDS.md`,
  plus **Solve the general case** in `prompts/issue/prompt.md`. None of them
  conflicts with the new rule; it cross-references the first, third and fifth.

**Docs sweep** — grep: `Choosing assertions`, `A workflow behaviour change extends` (sibling subsections of the new one), `gate over text`; section: `CODING-STANDARDS.md#test-coverage-expectations`, `prompts/issue/prompt.md#instructions`; updated: `CODING-STANDARDS.md`, `prompts/issue/prompt.md`. `prompts/coding_guidelines/prompt.md` also matched the sibling grep, but it restates individual rules rather than indexing the subsections, so it needs no change.

## Test Plan

- Added `worker/deno/tests/text_gate_matcher_3149_test.ts` with two cases:
  - `CODING-STANDARDS.md carries the Writing a gate over text checklist (Issue #3149)`
  - `issue prompt testing step points at Writing a gate over text (Issue #3149)`
- **Red without the change:** with the new subsection heading and the prompt
  bullet text altered, each case failed with an `AssertionError` (heading not
  found / phrase missing). Restoring the text made both pass.
- `deno task test:unit tests/text_gate_matcher_3149_test.ts tests/coding_guidelines_layers_2574_test.ts tests/own_change_claims_3120_test.ts tests/existing_rule_conflicts_3077_test.ts`
  passed: 20 passed, 0 failed.
- `./quality.sh` passed on the final code commit. `config integration` was
  SKIPPED by the gate in this environment; every other stage passed (deno
  tests, lint, type check, fmt, markdownlint, mermaid, semgrep).
- No existing test was edited, so no assertions were removed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
