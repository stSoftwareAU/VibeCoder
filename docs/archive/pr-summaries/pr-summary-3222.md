# PR summary: a single entry point's wiring needs a red test too (Issue #3222)

## Summary

Closes #3222.

The rule **Every changed call site needs a test that goes red without it**
began with "when a change threads a new argument, flag or behaviour through
more than one production caller". PRs that wired a behaviour into one CLI
command or UI control read that as not applying to them. They tested only the
helper, so the wiring could be reverted with every test green
(VibeCoder#3203, GRQ-AutoTrader#2560).

- [x] The rule now covers every new or changed wiring between an entry point
      and the code it drives, including a single caller. It names the usual
      entry points: a CLI command or task, an HTTP route or handler, a
      scheduled job, and a UI control's event handler. The text is
      word-identical in `CODING-STANDARDS.md` and
      `prompts/coding_guidelines/prompt.md`.
- [x] There is a new UI sentence: a test must invoke a new or changed
      control's handler and assert what it sends or changes. When the
      issue's acceptance criterion is a user action, a test of the helper
      behind the control does not cover it.
- [x] The revert check now also allows restoring the old wiring, or pointing
      the handler at a no-op. The PR summary lists each entry point checked.
- [x] The issue prompt's Test Plan step now carries the same scope.
- [x] The operator manual (`docs/workflows/issue-processing.md`) records the
      change.

## Spec

### Intent and Rationale

- The existing revert check already catches this mistake, but its trigger
  skipped single-caller and UI cases. Widening the trigger, rather than
  adding a separate rule, keeps one rule for "wiring needs a red test".

### Essential Design Decisions

- The paragraph keeps its bold heading and the four phrases that
  `worker/deno/tests/changed_call_site_red_3067_test.ts` pins, so the #3067
  mirror check still holds.
- The issue has no `## Acceptance Criteria` heading. The change follows the
  issue's three proposed points.

### Undiscoverable Facts

- None. The motivating reviews are linked from the issue.

## Evidence

- `worker/deno/tests/entry_point_wiring_3222_test.ts` fails when run against
  `origin/main`'s three docs, and passes with the change.
- `deno task drift-pins-on-base origin/main …` reported every pinned phrase
  as `absent on base` in each section it reads. Those are
  CODING-STANDARDS.md "Test coverage expectations", coding_guidelines "Test
  Coverage Expectations" and issue prompt "PR Summary File".
- The existing #3067 test, plus the coding-guidelines layer, base-branch-red,
  run-scope and drift-pins tests, all pass.
- **Docs sweep:** I grepped
  `more than one (production )?caller|threads? a new argument|that caller'?s change|callers'? wiring|changed call site`
  across the repo, excluding the archive.
  - Updated: `CODING-STANDARDS.md:378`, `prompts/coding_guidelines/prompt.md:1282`,
    `prompts/issue/prompt.md:1079` and `docs/workflows/issue-processing.md`
    (a new paragraph after the #3067 one).
  - `CODING-STANDARDS.md:586` (the Units bullet, "does not cover its
    callers' wiring") is left in place. It is still true, because a
    single-caller entry point is a caller too.
  - `docs/workflows/issue-processing.md:1262` is left in place. It is still
    true, because it is the #3067 history, and the new paragraph below it
    extends it.
  - `worker/deno/tests/changed_call_site_red_3067_test.ts` is left in place.
    Its pins still hold.
- **Related rules checked:**
  - "A new test must go red without its change".
  - "Every outcome of a branch you add needs a test that reaches it".
  - "A new path to an existing outcome keeps that outcome's guards".
  - "Narrowing a shared helper changes every caller".
  - The CODING-STANDARDS "Choosing assertions" Units bullet.
  - The issue prompt's PR Summary File Test Plan step.

  None conflicts. The Units bullet already said a helper test does not cover
  callers' wiring, and the issue prompt step was changed to match.

## Test Plan

- Added `worker/deno/tests/entry_point_wiring_3222_test.ts`. On both rule
  surfaces it asserts that the changed-call-site paragraph names a single
  caller, a scheduled job, a UI control's event handler, invoking the
  control's handler, the "pressing X requests Y" criterion and the
  entry-point list. It also asserts that "more than one production caller"
  is gone. The test checks that the issue prompt's PR Summary File section
  requires invoking the handler and listing each entry point checked. It
  goes red against the base docs.
- `worker/deno/tests/changed_call_site_red_3067_test.ts` is unchanged and
  passes.
- Entry points checked: none, because the diff changes docs, prompts and a
  test only.
- Branch outcomes: none added.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
