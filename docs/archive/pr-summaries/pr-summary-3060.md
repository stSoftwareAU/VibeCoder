## Summary

Adds the rule **"A negative test must be able to fail"** to the testing
guidance. Fleet PRs (VibeCoder#2961, GRQ-AutoTrader#2209, GRQ-AutoTrader#1902)
were sent back for negative or guard tests whose fixture never contained the
value the test forbids, so each test passed with or without its guard. Closes
#3060.

- `CODING-STANDARDS.md` › **Test coverage expectations** and its injected twin
  `prompts/coding_guidelines/prompt.md` › **Test Coverage Expectations**: the
  same paragraph, word for word. A negative assertion needs a fixture that
  contains the forbidden thing, and the guard must be broken on purpose and the
  test seen going red before the PR is raised. A negative test that stays green
  without its guard is a blocking self-review finding.
- `CODING-STANDARDS.md` › **Choosing assertions**: the "would it fail on a
  legitimate redesign?" question now has its opposite: would the assertion fail
  if the guard it protects were removed?
- `prompts/issue/prompt.md` › Test Plan self-review step: a negative test counts
  only after it has been seen going red with its guard broken.
- `docs/workflows/issue-processing.md`: explains the rule next to the #2924
  "What a red run proves" paragraph.

## Spec

### Intent and Rationale

- #2924 ties a red run to the base branch, but that only covers bug fixes. A
  new guard has no unfixed base to go red against, so the check has to be "break
  the guard and watch the test go red".
- The rule sits next to the base-branch-red and named-test rules, so it rides
  into every code-writing run through the injected guidelines, and the issue
  prompt checks it again at the self-review step.

### Essential Design Decisions

- The paragraph is identical on both twin surfaces. A drift test pins it, as
  #2924 did for its paragraph.
- The Standards reviewer's "always a violation" list in
  `issue_executor_agents.ts` is not changed. The reviewer reads
  `CODING-STANDARDS.md`, which now calls this a blocking finding, and the issue
  named only the two guidance surfaces.

### Undiscoverable Facts

- The motivating cases come from fleet PR review send-backs on 2026-10-01 and
  2026-10-02, which are recorded only in the issue body.

## Evidence

Docs and prompts only, with no runtime code change. Verification:

- `worker/deno/tests/negative_test_must_fail_3060_test.ts` (3 tests) passes,
  alongside the #2924 drift tests, `coding_guidelines_twin_drift_test.ts`,
  `coding_guidelines_layers_2574_test.ts` and `prompt_builder_test.ts`.
- To check that the new drift test can itself fail, the paragraph was removed
  from `prompts/coding_guidelines/prompt.md` and the test was run. It failed
  (`could not locate the negative-test rule in coding_guidelines`). After the
  paragraph was restored, it passed.
- `./quality.sh < /dev/null` passed (one check, config integration, was
  skipped).

**Docs sweep** — grep: "negative test", "legitimate redesign", "named-but-absent";
updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`,
`prompts/issue/prompt.md`, `docs/workflows/issue-processing.md`

## Test Plan

- Added `worker/deno/tests/negative_test_must_fail_3060_test.ts`:
  - both surfaces carry the identical rule with its key phrases
  - **Choosing assertions** points back at the rule
  - the issue prompt's Test Plan step requires seeing the guard go red

🤖 Generated with [Claude Code](https://claude.com/claude-code)
