# PR Summary — Issue #3069

## Summary

Adds the rule **"Every outcome of a branch you add needs a test that reaches
it"** to the guidance. Fleet PRs (VibeCoder#2909, GRQ-AutoTrader#2227) were sent
back because one outcome of a branch the PR itself added had no test: a
stale-remote guard's `ls-remote` exit 2, and a trait default that should return
an error. Flipping either one left every test green. The rule sits in
`CODING-STANDARDS.md` › Test coverage expectations, with a pointer from the
**Units:** bullet. The coding-guidelines prompt carries the same paragraph word
for word. The issue prompt's Test Plan step gains a matching requirement, and
`docs/workflows/issue-processing.md` records why the rule exists. Closes #3069.

## Spec

### Intent and Rationale

- Each outcome of a new condition, match arm, exit-code check or interface default needs a named test that reaches it. A test double that overrides the default, or a stub that always returns the same code, does not count.
- The new paragraph sits next to #3060's "A negative test must be able to fail" because both use the same method: break it on purpose and confirm the suite goes red.

### Essential Design Decisions

- The paragraph is identical in `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`. A drift test fails if the two diverge.
- In the issue prompt, the requirement is added to the Test Plan step (step 7), beside the named-but-absent-test step, as the issue asked.

### Undiscoverable Facts

- #3060 has merged (`52f99920`), so this rule goes directly after its paragraph, as the issue said to do in that case.

## Evidence

This change touches documentation and prompts only. A drift test protects the
rule:

- `worker/deno/tests/branch_outcome_coverage_3069_test.ts` checks three things: both surfaces carry the rule and the two paragraphs are identical, the Units bullet points back to it, and the issue prompt's Test Plan step requires a test for every branch outcome.
- **Red run:** with `CODING-STANDARDS.md` and `prompts/issue/prompt.md` restored to the base branch, all 3 tests failed. With the change they pass, and the #3060 drift test still passes.
- `./quality.sh < /dev/null` passed: deno tests, lint, type check, fmt, markdownlint, mermaid and semgrep. The `config integration` check was skipped by the gate itself.

**Docs sweep** — grep: "A negative test must be able to fail", "named-but-absent", "Units:"; updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`, `docs/workflows/issue-processing.md`

## Test Plan

- Added `worker/deno/tests/branch_outcome_coverage_3069_test.ts` (3 tests).
- Re-ran `worker/deno/tests/negative_test_must_fail_3060_test.ts`, which passes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
