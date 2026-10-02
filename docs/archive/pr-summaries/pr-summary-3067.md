## Summary

Closes #3067. Fleet PRs threaded a new argument through several callers and
tested only one: VibeCoder#2918 passed `RED_CHECK_CONCLUSIONS` to
`buildFailedCheckRunsLookup` from `findFailedCiChecks`, but the REST stub
ignored `--jq`, so reverting that caller kept every test green;
GRQ-AutoTrader#2220 left the `screen_candidates` caller of `commit_buy`
untested for its new `is_held` argument. The guidelines now require
reverting each changed call site and seeing a test go red.

## Spec

### Intent and Rationale

- A test of a shared helper, or of some of its callers, does not cover the
  other callers' wiring. The only way to know a call site is actually
  exercised is to revert it on its own and watch a test fail.
- The rule sits alongside the #3060 "negative test must be able to fail"
  rule, so it rides into every code-writing run through the injected
  guidelines, and the issue prompt checks it again at the self-review step.

### Essential Design Decisions

- The paragraph is identical on both twin surfaces (`CODING-STANDARDS.md`
  and `prompts/coding_guidelines/prompt.md`). A drift test pins it, as
  #3060 did for its paragraph.
- The Test Plan self-review step in the issue prompt is extended rather
  than replaced, so existing Test Plan guidance keeps its wording.

### Undiscoverable Facts

- The motivating cases (VibeCoder#2918, GRQ-AutoTrader#2220) are recorded
  only in the issue body.

## Evidence

- `CODING-STANDARDS.md` › **Test coverage expectations** and its injected
  twin `prompts/coding_guidelines/prompt.md` › **Test Coverage
  Expectations**: a new paragraph, word for word identical on both
  surfaces, requiring that each changed call site be reverted on its own
  and seen to go red.
- `CODING-STANDARDS.md` › **Units**: a back-reference bullet pointing at
  the new paragraph.
- `prompts/issue/prompt.md` › PR Summary File step 7, Test Plan: the
  self-review sentence now requires a changed-call-site revert to have
  been seen going red.
- `docs/workflows/issue-processing.md`: a new paragraph next to the #3060
  "A negative test must be able to fail" paragraph, explaining the rule.
- To check that the new drift test can itself fail, the issue prompt's
  Test Plan sentence was removed and the test was run. It went red; after
  the sentence was restored, it passed again.

**Docs sweep** — grep: "A negative test must be able to fail", "Units:",
"Test Plan"; updated: `CODING-STANDARDS.md`,
`prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`,
`docs/workflows/issue-processing.md`

`./quality.sh < /dev/null` — all checks passed.

## Test Plan

- Added `worker/deno/tests/changed_call_site_red_3067_test.ts` (3 tests):
  - both surfaces carry the identical rule with its key phrases
  - **Units** points back at the rule
  - the issue prompt's Test Plan step requires seeing a reverted call site
    go red
- Existing `worker/deno/tests/negative_test_must_fail_3060_test.ts` and
  `coding_guidelines_twin_drift_test.ts` still pass.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
