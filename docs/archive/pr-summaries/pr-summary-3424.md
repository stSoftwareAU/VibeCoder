# PR Summary — Issue #3424: state each run's scope under its mode heading

## Summary

Closes #3424. The `pr_feedback` and `ci_fix` prompts gain a 3-bullet
"**This run's scope.**" block right under the mode heading, each bullet citing
a real drift. The `issue` prompt gains a one-line pointer to its existing
`## Change Scope`, which stays in place so the section pins from #3263 and #3262
are untouched. The phrasing is positive ("This run …"), per CODING-STANDARDS'
prefer-positive-instructions guidance.

- [x] pr_feedback scope block
- [x] ci_fix scope block
- [x] issue pointer
- [x] drift test
- [x] quality gate

## Spec

### pr_feedback

- This run answers the review comments on the PR.
- It fixes every instance of the defect (the #3086/#3114 rule). Drift:
  stSoftwareAU/VibeCoder#3075, where a review fix commit 96c7979e left the same
  conflict in the sentence beside the one named.
- It rewrites the summary only where the push made it false (#3143).
- It edits what Change Scope allows; an issue mentioned in passing goes to a
  follow-up via the existing Escape Hatch. No verified past drift was found for
  "took on an issue mentioned in passing", so that bullet points at the
  existing Escape Hatch rule rather than citing a drift.

### ci_fix

- This run fixes the one failing check it was started for. Other local-gate
  failures are reported in `.pr_response_message` and left alone (TagsTS#88
  deleted an unrelated CodeQL workflow; #3478's commit 4b93b693 loosened
  `runConfigSmokeTest`).
- It changes code under test only as far as the fix needs. GRQ-AutoTrader#2699
  commit edb11642 changed the shared `can_run` "0.0.0" sentinel and review
  called it unrelated; the run type of that commit is not recorded, so it is
  cited as a scope drift, not proven to be a ci_fix run.
- The bullet naming **Dependency audit failures** and **Base-branch failures**
  keeps the block agreeing with those two existing sections.
- Only #3424's scope lines from #3512 are done here; #3512's other items are
  not.

### issue

- One-line pointer to `## Change Scope`; the section is not moved.

## Evidence

- Files: `prompts/pr_feedback/prompt.md`, `prompts/ci_fix/prompt.md`,
  `prompts/issue/prompt.md` and the new test
  `worker/deno/tests/prompt_scope_boundary_3424_docs_test.ts`.
- Cited issues and PRs:
  - #3424: Prompts: state what pr_feedback and ci_fix runs do not do, next to the mode heading
  - #3512: Fleet PRs silently edit, loosen or delete an unrelated failing check to turn the gate green (TagsTS#88, VibeCoder#3308, #3478 and a private fleet PR)
  - #3263: Several drift tests pin phrases over the whole issue/pr_feedback prompt through a local whitespace-collapse helper, bypassing section() and the DocSection brand
  - #3262: action_sha_pinning_policy_test.ts pins prompt phrases as whole-file includes via an inline whitespace collapse, bypassing section()
  - #3301: Credit the skills guide and file vetting issues for prompt ideas and triggering tests
  - #3265: Apply Anthropic's skills guide to our Claude Code skill and prompts
  - #3114: Review-fix runs fix only the places a finding names, not the rest of the same defect class (VibeCoder#3066, #3068, #3065, GRQ-AutoTrader#2210, #2220)
  - #3086: Fleet review fixes patch only the spot a finding names, leaving the same defect on another path or copy (GRQ-AutoTrader#2279, #2227, VibeCoder#3071)
  - #3143: Review-fix runs get no drift check: summary and docs rules (#3114, #3117, #3120) are prose only, and fix pushes still leave docs contradicting the head (VibeCoder#3134, #3095, #3132)
  - #3478 (PR): Add a Floci CI job for VibeCoder's own CloudFormation template (#3369)
  - #3075 (PR): Fleet PRs repeatedly claim body/docs evidence absent from the diff (GRQ5084, GRQ5135, GRQ-validation904, VibeCoder3049, GRQ-AutoTrader2185, VibeCoder3054) (Issue #3058)
  - TagsTS#88 (PR): Restrict spellcheck workflow token to read-only contents (#59)
  - GRQ-AutoTrader#2699 (PR): Policy: replace ceiling_below_target_percent with minimum_upside_percent (#2695)
- Docs sweep: grep `this run's scope` over `docs`, `README.md`,
  `CODING-STANDARDS.md`, `DESIGN-PRINCIPLES.md` and `prompts` found only the
  three new blocks, so there is no older doc to conflict with them. grep
  `Change Scope` over `docs`, `README.md` and `CODING-STANDARDS.md`:
  `docs/workflows/pr-feedback.md:360` is still true because it says same-defect
  fixes fall under the prompt's Change Scope rule, which the new block repeats;
  `docs/workflows/issue-processing.md:998` is still true because it only
  mentions the prose rule in passing; `docs/SPEC-KIT-COMPARISON.md:87` is still
  true because the prose rule still exists; the remaining hits are archived PR
  summaries, which are historical records.
- Related existing rules checked (all agree with the new blocks; none
  changed): pr_feedback "Fix the defect everywhere it lives, not only where the
  finding points" (#3086/#3114); "Keep the PR summary true to the head"; "Every
  change-request finding ends fixed or rebutted"; "Answer every ask in a
  finding"; pr_feedback `## Change Scope` and `## Escape Hatch`; ci_fix
  "Dependency audit failures", "Base-branch failures" and "Response Message"
  (`.pr_response_message` is always written); issue `## Change Scope`;
  CODING-STANDARDS prefer-positive-instructions and token economy; the shared
  coding guidelines' "Stay in scope".
- Rule applied to this PR's own diff: the diff touches only the three prompts,
  one test and this summary; it does not take on #3512's other items. One
  forced deviation: the house-vocabulary drift test rejects a bare `VibeCoder`
  in prompt prose, so the citation is written `stSoftwareAU/VibeCoder#3075`.
  Nothing else flagged.
- Deno regression avoided: none (no tooling change).

## Test Plan

- Branch outcomes: none added
- New test (three cases, one per prompt), each slicing from the `## X Mode`
  heading to the next `## ` heading.
- Drift-pin base-absence: `deno task drift-pins-on-base
  origin/milestone/fleet-guidance-issue-and-feedback-prompts <prompt> "<X Mode>"
  <phrases>` reported every pinned phrase absent on base for each section:
  - pr_feedback: "**this run's scope.** this run answers the review comments on this pr", "every other instance of the same defect", "only where this push made it false", "keeps the scope that summary states", "mentions in passing goes to a follow-up issue"
  - ci_fix: "**this run's scope.** this run fixes the one failing check it was started for", "reported in `.pr_response_message` and left as it is", "only as far as that fix needs", "two sections below set their own scope"
  - issue: "**this run's scope** is what the issue asks, as **change scope** below defines it"
- Red check: restoring each prompt to base made exactly that prompt's case
  fail (2 passed, 1 failed each), then the edits were restored.
- Targeted: 90 test files touching these prompts (including house-vocabulary,
  2574, fable5, 3114, 3086, sleep-poll): 888 passed, 0 failed.
- `./quality.sh < /dev/null`: PASSED (config integration SKIPPED, as usual
  locally).
