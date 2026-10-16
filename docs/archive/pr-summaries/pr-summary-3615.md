## Summary

Adds the **A guard decides the unreadable case itself** rule. Some guards stand
before an irreversible or outward action (arming auto-merge, merging, pushing,
claiming, closing) and read their input through a helper that returns `""`,
`null`, `[]`, `false` or "not gated" when the read fails. For such a guard, the
failed read is one of its own outcomes. The guard must fail closed and must not
let a truthiness check skip it. It also needs its own `unreadable` branch
outcome, with a test whose stub makes the read fail. Closes #3615.

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`: the new
  bullet goes in **Never Fail Silently — Fail Loud**, directly after "Absence of
  a success marker is not success". Its body is word for word the same on both
  surfaces.
- In both files, the outcome list of the **Every outcome of a branch you add
  needs a test that reaches it** paragraph now names `unreadable` and points at
  the new bullet. The paragraph is still identical on both surfaces.
- `prompts/issue/prompt.md`: the Test Plan step that enumerates branch outcomes
  now requires the `unreadable` outcome. A guard that goes ahead on unread input
  is a blocking self-review finding.

## Spec

### Intent and Rationale

- Fleet PRs VibeCoder#3065 and #3514 were sent back for the same mistake. A
  guard's input helper turned a failed read into a falsy value, the guard read
  that as "does not apply", and the push or auto-merge went ahead.
- The existing **No silent pass on unread input** rule sits under **Writing a
  gate over text**, so it does not reach a guard in ordinary worker code.
- The rule goes next to the fail-loud bullets, and the branch-outcome rule and
  the issue checklist point at it. An agent that enumerates outcomes therefore
  meets the failed read as an outcome of its own.

### Essential Design Decisions

- Gates over text are the one named exception. **No silent pass on unread
  input** still lets such a gate report unread input as "not checked", so the
  new broad "never go ahead" rule does not contradict that rule.
- The rule says the `unreadable` outcome is never `exempt (untestable)`,
  because a stub that throws or exits non-zero can always stage it.
- "Fix the helper first" is held to **Narrowing a shared helper changes every
  caller**, because making a helper throw where it once returned `""` changes
  what every other caller receives.

### Undiscoverable Facts

- The issue's listed instances: #3321, #3613 and #3614 are now closed, and
  PRs #3065 and #3514 have merged.

## Evidence

This change touches documentation and prompts only. It is verified by the
documentation-drift test `worker/deno/tests/guard_unreadable_case_3615_test.ts`
and the existing twin tests.

**Docs sweep** — grep: "fail-closed default", "absent/empty", "Absence of a
success marker", "Never Fail Silently", "No silent pass on unread input",
"fail\w* open"; section: `CODING-STANDARDS.md#never-fail-silently--fail-loud`;
siblings: "Absence of a success marker is not success", "No silent fallback
that masks a fault" (Never Fail Silently bullets), "fail-closed default"
(branch-outcome list); updated: `CODING-STANDARDS.md`,
`prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md`;
hits left in place:

- `docs/BEST-PRACTICES-SCAN.md:613` — still true because it describes the
  merged-stub scan, not the guard rule.
- `worker/deno/lib/branch_outcomes_gate.ts:1292` — still true because its
  outcome list ends "and so on" and does not claim to be complete.
- `prompts/pr_feedback/prompt.md:80` — still true because it defers to the
  guidelines' branch-outcome rule, which now carries the `unreadable` pointer.

Related existing rules checked: **No silent pass on unread input**
(CODING-STANDARDS.md, Writing a gate over text), now named as the one exception
on every surface. **A gate over text catches the variants and never passes what
it skipped** (issue prompt Instructions) is the same. **No silent fallback that
masks a fault** (guidelines) agrees. The **Every outcome of a branch you add**
`exempt (untestable)` clause agrees, because a stub stages the failure.
**Narrowing a shared helper changes every caller** is cross-referenced.

I applied the rule to this PR's own diff and found nothing to fix. The diff
adds no guard and no code branch; its only code is a drift test that reads
committed files.

Each restatement gives the same answer for the decided edge case: a guard
whose input read fails defers, holds or refuses, and only a gate over text may
report the input as not checked. That answer is the same in the
CODING-STANDARDS.md bullet, the guidelines bullet, the issue prompt's Test Plan
sentence and this summary.

Provenance numbers cited: #3615 (this issue: "Fleet guards skip themselves when
their input read fails…").

## Test Plan

- Added `worker/deno/tests/guard_unreadable_case_3615_test.ts`, with three
  tests:
  - The bullet carries its pins on both surfaces, is identical on both, and
    sits directly after the "Absence of a success marker" bullet.
  - The branch-outcome paragraph points at the bullet on both surfaces.
  - The issue prompt's PR Summary File Test Plan step requires the
    `unreadable` outcome.
- Red checks, each run with only that edit removed:
  - Removing the CODING-STANDARDS.md bullet turned the first test red, and so
    did removing the guidelines bullet.
  - Reverting the pointer in either file turned the second test red.
  - Removing the issue-prompt sentence turned the third test red.
- Drift pins on base: `deno task drift-pins-on-base
  origin/milestone/fleet-guidance-guards-side-effects-and-concurrency …`
  reported every pinned phrase "absent on base" for each pinned section:
  - Never Fail Silently in both twins, all 12 phrases.
  - Test Coverage Expectations in both twins, the pointer phrase.
  - The issue prompt's PR Summary File section, 5 phrases.
- `deno task test:unit` passed on the head: 43 passed, 0 failed. It ran
  `tests/guard_unreadable_case_3615_test.ts`,
  `tests/branch_outcome_coverage_3069_test.ts`,
  `tests/failure_reason_cause_3429_test.ts`,
  `tests/compound_condition_operands_3376_docs_test.ts`,
  `tests/branch_outcomes_record_3147_test.ts`,
  `tests/coding_guidelines_twin_drift_test.ts`,
  `tests/coding_guidelines_layers_2574_test.ts` and
  `tests/existing_rule_conflicts_3077_test.ts`.
- No existing test was edited and no assertion was removed.
- `./quality.sh < /dev/null` ran on the head commit and passed: "Result:
  PASSED (with skipped checks)". Deno tests, lint, type check, fmt,
  markdownlint, mermaid and semgrep all passed. Only "config integration" was
  skipped.

<!-- vibe-branch-outcomes -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
