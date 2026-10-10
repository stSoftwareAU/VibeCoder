## Summary

Adds the rule **An edited expectation must still go red without its guard**.
When an issue changes an expected value in an existing test, the edited test
must still fail with the code its name says it guards broken on purpose. If it
does not, the PR adds an assertion that does go red, or names the test the lost
check moved to, and the Test Plan records one red-check line per edited
expectation. Closes #3374.

## Spec

### Intent and Rationale

- Today the removed-assertion rule asks only for the issue requirement behind a new value, and the red-check rules cover only new and negative tests. That gap let VibeCoder#3372 and GRQ-AutoTrader#2408 ship edited tests that stayed green with their guarded code gone.
- The rule is a new paragraph placed right after **A new test must go red without its change**, which now points to it. The issue's proposed wording is kept almost as given, so the existing paragraph's drift test (`new_test_must_go_red_3093_test.ts`) stays untouched.

### Essential Design Decisions

- The paragraph is word-for-word identical in `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`, and a drift test pins this.
- Rule 3 of TDD and the issue prompt's **Change only what the issue changes** passage now point to the red-check. Both say that an issue requirement shows a new value is right, not that the test still guards anything, so the old and new rules agree.
- This is guidance only. No worker gate parses the red-check line.

### Undiscoverable Facts

- The issue's optional suggestion about the Standards reviewer brief is applied in the issue prompt's brief, where the removed-assertion request already sits. The reviewer agent's system prompt in `issue_executor_agents.ts` does not carry the removed-assertion request either, so it was left alone.

## Evidence

Purely prompt/docs change, with a documentation-drift test. Files changed:

- `prompts/coding_guidelines/prompt.md` and `CODING-STANDARDS.md`: the new paragraph in Test Coverage Expectations, and a forward pointer from the new-test rule. `CODING-STANDARDS.md` rule 3 also gets a pointer.
- `prompts/issue/prompt.md`: instruction 2 (Change only what the issue changes), the Standards reviewer brief, and the Test Plan step in PR Summary File.
- `docs/workflows/issue-processing.md`: a manual entry next to the #3093 entry.

Related existing rules checked: **Change only what the issue changes** / rule 3 (#3061, #3131), **A new test must go red without its change** (#3093), **A negative test must be able to fail** (#3060), **A refusal test must be refused by the rule it names**, the pr_feedback "A requested red run is shown, not claimed" rule, and **Choosing assertions**. The new rule agrees with each of them. It extends rule 3 rather than contradicting it.

I applied the new rule to this PR's own diff. The diff edits no expectation in any existing test; its only test is new. Nothing found.

Provenance cited in the diff: #3374: Edited test expectations pass without their guard: an issue-required value change leaves the test green with the guarded code broken (VibeCoder#3372, GRQ-AutoTrader#2408). VibeCoder#3372: Branch-outcomes parser skips a real header that follows a prose line read as a header… (Issue #3340). GRQ-AutoTrader#2408: policy: remove equal_weight sizing (Issue #2395).

**Docs sweep**: grep `new test must go red`, `Change only what the issue changes`, `edited expectation`. Section: `docs/workflows/issue-processing.md` (the per-rule entries beside **A new test must go red without its change (Issue #3093)**). Updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`, `docs/workflows/issue-processing.md`. Hits left in place:

- `prompts/pr_feedback/prompt.md:98`: still true, because it concerns a red run a review requests for a new test.
- `CODING-STANDARDS.md:791`: still true, because Choosing assertions' back-reference is about new tests.
- `docs/workflows/issue-processing.md:1406`: still true, because it is the #3093 history entry.

## Test Plan

- Added `worker/deno/tests/edited_expectation_red_3374_docs_test.ts`, with five section-scoped drift tests:
  - The paragraph is identical on both surfaces and sits between the new-test and negative-test rules.
  - Rule 3 has its pointer.
  - The issue prompt's Instructions has the red-check.
  - The issue prompt's PR Summary File has the red-check line.
  - The issue prompt's Independent Review has the Standards reviewer brief.
- Red-check: I restored the three prompt/standards files from `origin/milestone/fleet-guidance-issue-and-feedback-prompts` and ran `deno task test:unit tests/edited_expectation_red_3374_docs_test.ts`. Result: `0 passed | 5 failed`. I then restored the head files.
- Per-phrase base check with `deno task drift-pins-on-base origin/milestone/fleet-guidance-issue-and-feedback-prompts …`. All of these were reported `absent on base` in their sections:
  - `An edited expectation must still go red without its guard.`, `the code its name says it guards is broken`, `a de-duplicated list`, `move the lost check to a test that still covers it`, `Record the red-check result per edited expectation`, `An edited test that stays green without its guard`: in `CODING-STANDARDS.md` "Test coverage expectations" and `prompts/coding_guidelines/prompt.md` "Test Coverage Expectations".
  - `each edited expectation also owes the red-check`: in TDD.
  - `not that the edited test still guards anything`: in Instructions.
  - `record one red-check line per edited expectation`: in PR Summary File.
  - `still fails without the code it is named for`: in Independent Review Before the PR.
- The existing `worker/deno/tests/new_test_must_go_red_3093_test.ts`, `negative_test_must_fail_3060_test.ts` and `kept_assertions_3061_docs_test.ts` pass with the head docs.
- No existing test is edited and no assertion is removed.
- `./quality.sh < /dev/null` on the head: `Result: PASSED (with skipped checks)`. Only `config integration` was SKIPPED.

Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
