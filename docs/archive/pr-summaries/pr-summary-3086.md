## Summary

Closes #3086. Fleet review fixes patched only the spot a finding named. The
same defect stayed live on another path or in another copy
(GRQ-AutoTrader#2279, #2227, VibeCoder#3071). The `pr_feedback` prompt now
tells the agent to fix the outcome the finding protects, wherever that outcome
can break.

- [x] New rule **Fix the defect everywhere it lives, not only where the
      finding points** in `prompts/pr_feedback/prompt.md`, next to **Fix the
      general case** (the issue's proposed text).
- [x] **Change Scope**: every other instance of the defect counts as "what is
      needed to resolve them".
- [x] "Fix the issue the comment describes and nothing more" reconciled.
- [x] The reply names, for each finding, the other paths and copies checked.
- [x] Documented in `docs/workflows/pr-feedback.md`.
- [x] Contract test added.

## Spec

### Intent and Rationale

A finding's file, line, repro and suggested fix are one example of the
defect. Earlier runs stopped at that example. Examples of what they missed:

- a retry or timer path into the same state;
- the PR title when only the body was fixed;
- the archived summary or other docs still carrying the same claim.

Agents read the scope rules ("nothing more", "Change Scope") as forbidding the
wider fix. The new sentences say those other instances are part of resolving
the finding. No review or testing rule is loosened.

### Essential Design Decisions

- The new rule is a separate paragraph rather than a widened **Fix the general
  case**. That rule is about inputs (no special case keyed to the flagged
  value). The new one is about paths and copies.
- The "nothing more" sentence now reads "fix the defect the comment describes
  — wherever it lives, as **Fix the defect everywhere it lives** below
  requires — and nothing more". The two rules no longer pull against each
  other.
- `prompts/ci_fix/prompt.md` is unchanged. Its "Fix the general case" rule is
  about fixture values, and the issue scopes this change to PR feedback.

### Undiscoverable Facts

- The three motivating cases are recorded only in the issue body.
- The issue gives a success measure: a 14-day before/after `jq` over
  `log.jsonl` matching `only partly|partly fixed|still says`. It is for
  follow-up measurement and is not implemented here.

## Evidence

- `worker/deno/tests/pr_feedback_fix_everywhere_3086_test.ts` pins four parts
  of the loaded `pr_feedback` prompt:
  - the new rule;
  - the Change Scope sentence;
  - the reconciled "nothing more" wording (the old sentence must be absent);
  - the reply requirement.
- Break check:
  - Deleting the new paragraph turned the first test red.
  - Deleting the Change Scope sentence turned the second test red.
  - Both were restored and pass.
- `./quality.sh < /dev/null`: PASSED. Only config integration was skipped (no
  `.config.json` in the worktree).
- **Related existing rules checked**:
  - `prompts/pr_feedback/prompt.md`: "nothing more" (now reconciled), **Change
    Scope** (sentence added), **Fix the general case**, **A fix owes its docs
    change too**, **Keep the PR summary true to the head**. These agree: the
    docs and summary copies are now explicitly part of the fix.
  - `prompts/ci_fix/prompt.md` **Fix the general case**: fixture-scoped, no
    conflict.
  - `prompts/issue/prompt.md` **Solve the general case**: no conflict.
  - `prompts/coding_guidelines/prompt.md` / `CODING-STANDARDS.md` **Stay in
    scope** and **Do not hardcode to the tests**: no conflict. Other instances
    of the same defect are the defect, not adjacent work.
- **Docs sweep**:
  - Searched `README.md`, `docs/` (excluding archive) and `*/README.md` for
    `general case`, `Change Scope`, `flagged line` and `nothing more`.
  - Updated `docs/workflows/pr-feedback.md` with a new subsection.
  - The hits in `docs/SPEC-KIT-COMPARISON.md` and
    `docs/workflows/issue-processing.md` mention Change Scope only in passing
    and stay accurate.

## Test Plan

- `cd worker/deno && deno task test:unit
  tests/pr_feedback_fix_everywhere_3086_test.ts
  tests/pr_feedback_finding_resolution_2917_test.ts
  tests/pr_feedback_processor_test.ts < /dev/null`: 41 passed.
- `./quality.sh < /dev/null`: PASSED.
