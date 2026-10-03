# PR Summary — Issue #3114

## Summary

Closes #3114.

Review-fix runs kept fixing only the locations a finding named and leaving
other instances of the same defect class in the head, so the re-review raised
the finding again as only partly fixed. Examples are VibeCoder#3066, #3068
and #3065, and GRQ-AutoTrader#2210 and #2220. This PR widens the existing
Issue #3086 rule. Before committing, the agent states the defect as a class
and checks every other instance of that class.

## Spec

### Intent and Rationale

A finding's file and line are one example. Stopping there leaves the same
false claim, missing guard, race order or stale clock somewhere else in the
head. Naming the class, and requiring each other instance to be fixed or
rebutted, is what stops the re-review from calling the fix partial.

### Essential Design Decisions

- The wording stays inside the Issue #3086 paragraph, Change Scope and
  Response Message. A second rule would have left the older pins describing
  a narrower check.
- "Every other instance" covers callers or builders of the same shape, test
  names as well as comments and docs, each order of a race and every window
  between the parties' steps, and every later iteration of a loop that reads
  a time budget.
- An instance left in the head is a blocking self-review finding. An instance
  that does not apply is rebutted with the reason, not edited.

### Undiscoverable Facts

- `prompts/pr_feedback/prompt.md` and `docs/workflows/pr-feedback.md` are the
  two surfaces the drift test reads. The section helper stops at the next
  heading, so the new sentences had to stay inside "Fix the defect everywhere
  it lives", Change Scope and Response Message.

## Evidence

- **Docs sweep** — grep: "state the defect as a class", "another caller of
  the same shape", "which other instances you fixed"; file updated:
  `docs/workflows/pr-feedback.md`; section: "Fix the defect everywhere it
  lives".

## Test Plan

- `deno test --frozen --lock=deno.lock --allow-read --allow-env tests/pr_feedback_defect_class_3114_test.ts tests/pr_feedback_fix_everywhere_3086_test.ts`: 8 passed, 0 failed.
- Against the prompt and the operator manual at `6120ced4` (before this
  branch's wording), all four tests in
  `worker/deno/tests/pr_feedback_defect_class_3114_test.ts` failed. Making
  Changes was missing "a finding's locations are examples, not the list".
  Change Scope was missing "another caller of the same shape". Response
  Message was missing "which other instances you fixed". The operator manual
  was missing "issue #3114". Those two files were restored to HEAD afterwards.
- `worker/deno/tests/pr_feedback_fix_everywhere_3086_test.ts` still passes on
  the head: 4 passed.

## Changes

| File | Change |
| --- | --- |
| `prompts/pr_feedback/prompt.md` | The defect-everywhere paragraph, Change Scope and Response Message now name the defect class and the other instances. |
| `docs/workflows/pr-feedback.md` | The same rule, under "Fix the defect everywhere it lives". |
| `worker/deno/tests/pr_feedback_defect_class_3114_test.ts` | Four section-scoped drift tests. |
