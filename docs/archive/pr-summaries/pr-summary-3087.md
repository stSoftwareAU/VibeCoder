# PR Summary — Issue #3087

## Summary

Adds a standing rule, **"A new path to an existing outcome keeps that
outcome's guards."** Fleet PRs kept adding a second route to an outcome the
code already reached, and the new route skipped a guard the old route
applied. The rule is in `CODING-STANDARDS.md` and is restated word for word in
the `coding_guidelines` prompt. The self-checks in `prompts/issue/prompt.md`
(Test Plan step) and `prompts/pr_feedback/prompt.md` (Making Changes) point to
it.

Closes #3087

- [x] Add the rule to `CODING-STANDARDS.md` § Test coverage expectations, with
      a back-reference from § Choosing assertions
- [x] Mirror the rule in `prompts/coding_guidelines/prompt.md`
- [x] Point the issue prompt's Test Plan step at the rule
- [x] Point the PR-feedback prompt's Making Changes section at the rule
- [x] Record the rationale and the fleet examples in
      `docs/workflows/issue-processing.md`
- [x] Add a documentation-drift test

## Spec

### Intent and Rationale

The rule applies when a change adds an early return, a gate, a route or a
direct call that reaches an outcome an existing path already reaches. Examples
of such outcomes are finalising a PR, publishing state, charging an attempt
and ending a claim. Before adding the new path, the change must list every
guard and side effect the existing path applies before that outcome. For each
one, it either keeps it on the new path or states why it does not apply. Each
guard it keeps is proven by a test that goes red when the new branch is moved
ahead of the guard. The four fleet cases this rule targets:

- VibeCoder#3085: `reportSummaryRuleBlock` ran before the degraded-delivery
  guard.
- VibeCoder#2909: an `if (!prepared.ok)` early return came after
  `claimPrComment`, without replying or releasing the claim.
- VibeCoder#3065: the milestone sync skipped `isConflictAttemptDue`.
- GRQ-AutoTrader#2279: `publishBusy` skipped the freshness tracker's ticket
  check.

### Essential Design Decisions

- The rule sits beside the other "a test that goes red" rules (#3060, #3067,
  #3069) in § Test coverage expectations, and uses their shape:
  - It is a blocking self-review finding.
  - It is identical on both surfaces.
  - The issue prompt's Test Plan step points to it.
- The PR-feedback prompt has no Test Plan step, so its pointer goes in Making
  Changes, next to the other "before you commit" rules.

### Undiscoverable Facts

None.

## Evidence

This change is guidance only: it touches docs, prompts and one drift test,
and no production code.

- New test `worker/deno/tests/new_path_keeps_guards_3087_test.ts` checks four
  things:
  - The rule is identical in `CODING-STANDARDS.md` and the `coding_guidelines`
    prompt.
  - § Choosing assertions points back to it.
  - The issue prompt's Test Plan step requires it.
  - The PR-feedback prompt points to it.
- Each of the four assertions was broken on purpose and went red, then the
  file was restored.
- `deno task test:unit` passed 10 of 10 on the new test plus the #3067 and
  #3069 drift tests.
- 34 of 34 passed on the existing prompt-content drift tests (#2574, #2924,
  #3060, #3061, #3072, #3077, #3082, and the issue-prompt spec section).
- The full gate `./quality.sh` was run (result below).
- **Docs sweep:** I grepped for `Every changed call site` and `branch you add
  needs`, which are the sibling rules' headings. The hits were
  `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`,
  `prompts/issue/prompt.md` and `docs/workflows/issue-processing.md`. All four
  are updated, and `prompts/pr_feedback/prompt.md` is also updated as the
  issue asks.
- **Related existing rules checked:** none conflict, and the new rule refers
  to them rather than repeating them.
  - "A negative test must be able to fail"
  - "Every changed call site needs a test that goes red without it"
  - "Every outcome of a branch you add needs a test that reaches it"
  - "A red run counts only against the base branch"
  - "A workflow behaviour change extends the workflow validator"
  - The PR-feedback "Fix the general case" and "Call the existing owner" rules

## Test Plan

- `worker/deno/tests/new_path_keeps_guards_3087_test.ts` (new)
- Existing drift tests, unchanged and passing:
  - `worker/deno/tests/branch_outcome_coverage_3069_test.ts`
  - `worker/deno/tests/changed_call_site_red_3067_test.ts`
