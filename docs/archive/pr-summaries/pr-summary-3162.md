## Summary

Adds the rule **"A refusal test must be refused by the rule it names"**. Fleet
refusal tests passed on a refusal from a different rule because they checked
only *that* something refused (GRQ-AutoTrader#2386, #2393, VibeCoder#3079). The
rule now appears in the places #3105 put its rule. Closes #3162.

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`: the
  paragraph sits directly after **A negative test must be able to fail**, word
  for word as the issue suggested, and is identical on both surfaces.
- `prompts/issue/prompt.md`: the Test Plan step counts a refusal test only once
  it names the error variant or rule and its made-legal input is accepted. A
  change that adds an earlier refusal must re-run the existing later-refusal
  tests.
- `prompts/pr_feedback/prompt.md`: a new **A refusal finding is fixed at the
  rule it names** paragraph. It also tells review-fix runs to re-check every
  other probe in the test, so the mistake does not come back one level down
  (as at GRQ-AutoTrader#2386 `7200aa9e`).
- `docs/workflows/issue-processing.md`: a paragraph recording the rule and the
  three examples, next to the #3060 paragraph.

## Spec

### Intent and Rationale

- The existing rules (**A new test must go red without its change**, **A
  negative test must be able to fail**) miss two cases. In a parity test where
  both sides refuse for an unrelated reason, nothing is compared. In an
  existing, untouched test, a new earlier refusal can now satisfy the test
  before it reaches its own rule. The new rule covers both.

### Essential Design Decisions

- The standards paragraph and the coding_guidelines paragraph must stay word
  for word identical. The drift test asserts this, as it does for the #3060 and
  #3093 rules.
- The issue and pr_feedback prompts point at the guidelines rule rather than
  copying it, so there is one source of truth.

### Undiscoverable Facts

None.

## Evidence

This is a documentation and prompt change only, with no UI.

The new drift test `worker/deno/tests/refusal_test_rule_3162_test.ts` pins key
phrases of the rule in all four surfaces. It also asserts that the standards
and guidelines paragraphs are identical.

**Docs sweep** — grep: "A negative test must be able to fail", "refused",
"refusal test"; section: `docs/workflows/issue-processing.md` (the
test-discipline paragraphs, #3060/#3069/#3067); updated:
`docs/workflows/issue-processing.md`.

**Related existing rules checked.** The new rule agrees with each of these:

- **A new test must go red without its change**: it already names "a fake that
  throws into a catch that returns the expected value". The new rule adds the
  case of an existing test that is reached early.
- **A negative test must be able to fail**: that rule covers does-not-happen
  assertions; this one covers is-refused assertions.
- **Every outcome of a branch you add needs a test that reaches it**
- pr_feedback's **A requested red run is shown, not claimed**

None of them conflicts with the new rule.

## Test Plan

- Added `worker/deno/tests/refusal_test_rule_3162_test.ts` (3 tests).
  - With only the doc changes reverted (`git checkout origin/main --
    CODING-STANDARDS.md prompts/coding_guidelines/prompt.md
    prompts/issue/prompt.md prompts/pr_feedback/prompt.md`), all 3 failed
    (`FAILED | 0 passed | 3 failed`), for example `AssertionError: could not
    locate the refusal-test rule in CODING-STANDARDS.md`.
  - With the changes restored, all 3 passed.
- Existing drift tests still pass: `negative_test_must_fail_3060_test.ts`,
  `new_test_must_go_red_3093_test.ts`, `coding_guidelines_twin_drift_test.ts`
  and `coding_guidelines_layers_2574_test.ts` (30 passed).
- No existing test was edited.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
