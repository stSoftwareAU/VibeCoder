## Summary

`recoverAndFinaliseExistingPr` now disarms auto-merge (`gh pr merge <n> --repo <r> --disable-auto`, via the existing `disarmAutoMerge`) in its `holdAutoMerge` branch, straight after labelling the PR `standing-violation`. An auto-merge armed by an earlier pass no longer stays live until the next Priority 1.65 sweep. Same pairing as `holdUnverifiedReview`. Closes #4075.

Version bump: `VERSION` is not touched by this change; the merged commit records the final version.

## Spec

### Intent and Rationale

- The completion-phase hold labelled the PR and posted "Auto-merge withheld" but left a prior arming live, so a reviewer approval inside the sweep gap could merge a PR the worker had said was held.
- Reusing `disarmAutoMerge` (never throws, logs a warning on failure) is the smallest repair; the sweep stays as the backstop.

### Essential Design Decisions

- The disarm runs after the label attempt and before the verifier-hold comment, so a disarm failure cannot skip either; it is non-fatal.
- The creation path and the sweep are unchanged.

### Undiscoverable Facts

- None.

## Evidence

Tests (in `worker/deno/tests/completion_phase_merged_pr_closure_test.ts`) pass: 9 passed, 0 failed. With the disarm call removed, three of the four new tests fail (held open PR, held PR with a verifier hold, failed disarm), and the `holdAutoMerge: false` test stays green by design.

**Docs sweep** — grep: `standing-violation`, `disarm\w*`, `withheld`; section: `docs/workflows/issue-processing.md#the-in-run-recovery-from-a-summary-rule-block`; siblings: none — no existing set gained a member; updated: `README.md`, `docs/workflows/issue-processing.md`; `docs/MERGE.md:667` — still true because it describes the sweep's own hold, which is unchanged; `docs/INTERNALS.md:2244` — still true because it describes the PR-feedback hold, which already disables auto-merge.

## Test Plan

- Added four tests to `worker/deno/tests/completion_phase_merged_pr_closure_test.ts`: held open PR is disarmed and never re-armed; held PR with a verifier hold is disarmed and still commented; `holdAutoMerge: false` makes no `--disable-auto` call; a failing disarm is non-fatal and the label is still applied.
- Removed assertions from existing tests: none.
- Red check: removing the `disarmAutoMerge` call turned the held-PR, verifier-hold and failed-disarm tests red.
- Callers of `recoverAndFinaliseExistingPr` with `holdAutoMerge: true` (`reportSummaryRuleBlock`) go through the changed branch; the `false` callers (`completionBody`) are unaffected.

<!-- vibe-branch-outcomes -->
