## Summary

`verifyFeedbackFix` no longer turns a review-fix verifier that could not run
(`runPrePrVerifier` returning `not_checked`) into a failed round. It logs a
warning with the reason and returns `ok`, the way the new-PR path does in
`phases/completion_phase.ts`. A blocked verdict still returns its error and
holds the review. Closes #4509.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

- A fault in the worker's own tooling (shallow checkout, unreadable bundle,
  malformed verifier JSON) was billed to the PR: a recovery turn fed a
  non-finding, the fix held unpushed, and a strike towards the Issue #4304
  close-and-redo. Treating "could not run" as "does not block" removes all
  three.

### Essential Design Decisions

- Nothing is approved: the review stays outstanding until review-fleet-prs
  reviews the pushed head and checks every earlier finding independently.
  An unavailable verifier is logged, never read as clean.
- The change is in `verifyFeedbackFix` only; `processPrFeedback` is unchanged
  because an `ok` result already takes its push path.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI files touched. Tests:

- `worker/deno/tests/pr_feedback_verifier_3784_test.ts`
- `worker/deno/tests/pr_feedback_review_dismissal_3383_test.ts`

Docs: `docs/INTERNALS.md` (review-fix verifier paragraph) said an unavailable
verifier blocks; reworded. Other docs grepped (README, DESIGN-PRINCIPLES,
`docs/` excluding archive, `prompts/`) have no sentence saying it blocks;
`docs/workflows/pr-feedback.md` "A build error holds the review" concerns
candidate build errors, which still hold.

## Test Plan

- New `feedback verifier - an unavailable verifier is logged and does not block
  (Issue #4509)` (`pr_feedback_verifier_3784_test.ts`): `verify` returns
  `not_checked` with the JSON-parse reason from the issue; asserts `ok`, exactly
  one `Review-fix verifier not checked` warning carrying that reason, and no
  `Review-fix verifier verdicts` record.
- New `review-fix verifier - an unavailable verifier does not block: the fix is
  pushed and addressed, with no failure charged (Issue #4509)`
  (`pr_feedback_review_dismissal_3383_test.ts`): runs the real
  `verifyFeedbackFix` through `processPrFeedback`; asserts one check, no
  recovery prompt, one `commitAndPushPending`, the review marked addressed and
  no `handlePrCommentFailure`. `runScenario` now also returns the agent prompts
  (additive).
- Blocked result unchanged: existing `persistent findings stay outstanding…`
  and `recovery must clear before pushing` tests pass unedited.
- Red check: with the old `throw` restored in the lib, both new tests fail
  (`checks` 2 vs 1; `result.ok` false vs true); with the fix they pass. The
  combined run of the two files: 32 passed, 0 failed.
- Removed from `worker/deno/tests/pr_feedback_verifier_3784_test.ts`: the
  `not_checked` / `timeout` case in `unavailable, malformed and blocking results
  fail closed` (renamed `malformed and blocking results fail closed`).
  - Required by: "turns a verifier that could not run (`runPrePrVerifier`
    returning `not_checked`) into the same error as a verifier that found the
    fix incomplete"
  - Moved to: `worker/deno/tests/pr_feedback_verifier_3784_test.ts` (the new
    unavailable-verifier test asserts the opposite outcome).
- Twinned rule: the new-PR path (`completion_phase.ts`, Issue #3395) already
  logs and does not block; the review-fix path now agrees.
- `deno fmt --check`, `deno lint`, `deno check` on the touched files: clean.
- `./quality.sh` on the final code head: lint, type check and fmt passed; the
  gate reported FAILED on the gh/git spawn chokepoint, spawn timeout, git ref
  chokepoint and completeness checks and on six deno tests (the same
  chokepoint/sweep-coverage tests). Every violation line names
  `worker/deno/commands/fleet_pr_babysitter.ts` (added by 806c02ed, #4543,
  already on `origin/main`); this diff does not touch that file. The
  completeness report was not read in full. Not verified on a clean base run.
