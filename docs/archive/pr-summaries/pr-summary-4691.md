## Summary

The issue prompt still tied `Part of #N` and `Closes #N` to a `missing`
criterion alone, although #4644 made a `partial` criterion withhold the close
too. The three sentences #4661 left behind now say `partial` or `missing`, as do
the human docs that described the old rule. Wording only: the guard
(`worker/deno/lib/missing_criterion_close_guard.ts`) already behaves this way.
Closes #4691.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

- An agent following the bold "The file MUST contain" item wrote `Closes #N` for
  a `partial`-only block, while the worker rewrote the PR body to `Part of #N`.
  Making the checklist agree with the guard removes the mismatch.

### Essential Design Decisions

- No new rule, gate or check: the issue asks for the one-word change #4661 made
  elsewhere, so the guard is reused as is.
- The criteria-less path (`prompts/issue/prompt.md` lines about an issue with no
  criteria heading) still says `missing` only, on purpose: no reviewer runs
  there, so an undone part is recorded as a `missing` entry.

### Undiscoverable Facts

- `deno task test:unit tests/merge_fallback_issue_test.ts` fails on the base
  branch too
  (`createFallbackFlagFiler - routes the label creation through the
  caller's gh`),
  so the full gate's deno-tests stage fails independently of this change.

## Evidence

- `prompts/issue/prompt.md`: the "appended automatically" sentence, the "must
  really be in the block" sentence and the bold item 1 now read `partial` or
  `missing`.
- Other places that stated the old rule, updated: `DESIGN-PRINCIPLES.md` (Finish
  in the PR bullet), `docs/INTERNALS.md` (closer paragraph, the `assemblePrBody`
  note, the mermaid node, the guard's table row), `docs/USAGE.md` (adoption
  paragraph), `docs/workflows/pr-feedback.md`, and a doc comment in
  `worker/deno/lib/closure_verdict_recovery.ts`.
- Remaining `missing`-only hits in the issue prompt (`prompt.md` about the
  criteria-less issue, and the line that names a `missing` entry in general) are
  still true: they describe the criteria-less path above.
- Related existing rules checked: `CODING-STANDARDS.md` lines about the closing
  keyword already say `partial` or `missing`; `prompts/pr_feedback/prompt.md`
  line 92 already says `partial` or `missing`. No rule disagrees.
- Applied the rule to this PR's own diff: grep of the diff for `missing` found
  nothing that ties the closing keyword to `missing` alone.

## Test Plan

- Added
  `worker/deno/tests/prompt_builder_test.ts::prompt builder - issue prompt gates the closing keyword on partial or missing (Issue #4691)`:
  renders the issue prompt and asserts the three corrected sentences and the
  absence of the three old fragments. Red check: with the base
  `prompts/issue/prompt.md` restored it fails (69 passed, 1 failed); with the
  edit it passes (70 passed, 0 failed).
- No existing test assertion removed or edited.
- `./quality.sh`: every stage passed except `deno tests`, whose single failure
  is `worker/deno/tests/merge_fallback_issue_test.ts` (line 496), which fails
  identically on the base commit in a clean worktree. The serial pass did not
  run because the parallel pass failed.
