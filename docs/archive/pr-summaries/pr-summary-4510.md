## Summary

A CI-fix commit no longer counts as the fleet answering a `CHANGES_REQUESTED`
review. `isReviewSupersededByFleetFix` and `fetchPrCommitProvenance` are
removed, and `findPrCommentsToFix` no longer reads `pulls/{pr}/commits` for
reviews. Closes #4510.

## Spec

### Intent and Rationale

- A CI-fix pass pushes single-parent, fleet-authored commits, the same shape
  `isFleetAnswerAfter` accepted, but never answers a review. On
  NEAT-AI-Discovery#2443 that hid an unanswered review. The issue's option 1
  (drop the supersession) was chosen over option 2 (identify PR-feedback commits
  by trailer), as it is the simpler one.
- Duplicate runs stay covered: a handled review is dismissed (Issue #3383) and
  an in-flight run holds a live `pr_review` claim lease
  (`hasLivePrReviewClaim`), both unchanged.

### Essential Design Decisions

- `CommitProvenance.parentCount` and the merge check in `isFleetAnswerAfter`
  were removed: only `fetchPrCommitProvenance` populated it, so production could
  never reach the check. `isFleetAnswerAfter` still serves comment supersession
  by fleet push (Issue #211), unchanged.
- A review is retired only by dismissal or the reviewer's later review (Issue
  #2697).

### Undiscoverable Facts

- None.

## Evidence

Backend only; no UI files changed. Behaviour is covered by
`worker/deno/tests/review_supersession_2702_test.ts`, which uses the #2443
commit shapes: base merge, `github-actions[bot]` bump and a single-parent
`VibeCoderST` CI-fix commit.

Docs updated: `docs/INTERNALS.md` ("Staleness check" paragraph) and
`docs/workflows/pr-feedback.md` (review-skip sentence and flowchart node).
`docs/MERGE.md` was grepped; its hits describe branch-update withholding, which
is unchanged.

## Test Plan

- `worker/deno/tests/review_supersession_2702_test.ts` (modified): the new case
  "a single-parent fleet CI-fix commit after the review leaves it actionable and
  the history unread (Issue #4510)" asserts the review is returned and no
  `pulls/{pr}/commits` call is made. Run with `pr_feedback_supersede_test.ts`
  and `review_supersession_latest_review_2697_test.ts`: 28 passed.
- Red check: with the base `pr_maintenance.ts` and `pr_feedback_supersede.ts`
  restored, the CI-fix case failed (`Actual undefined, Expected "pr_review"`).
  The base-merge/bot-bump case also failed there, because the mocked history no
  longer carries `parentCount`, so that red is a fixture effect; both go green
  with the fix.
- Removed from `worker/deno/tests/review_supersession_2702_test.ts`: the
  `isReviewSupersededByFleetFix` unit tests (base merge and bot bump, fleet fix
  after review supersedes, fleet fix before review, human push, unknown data)
  and the scan tests "a review followed by a real fleet fix is superseded" and
  "an unreadable history never drops the review".
  - Required by: "Do not let a CI-fix commit supersede a review." The function
    and the history read no longer exist.
  - The "stays actionable" and "current head" scan tests are kept; the
    human-push and unknown-data cases have no remaining code to test.
- Added to `worker/deno/tests/pr_feedback_supersede_test.ts`: "a bot's later
  commit does not supersede, even with a fleet author" reaches the `[bot]` early
  return in `isFleetAnswerAfter`
  (`worker/deno/lib/pr_feedback_supersede.ts:123`), which the removed review
  tests used to cover; the coverage-carry-over line is now reached by a head
  test. 9 passed in that file.
- Quality gate (`./quality.sh`): all chokepoint, completeness, lint, type check,
  fmt, semgrep passed. Two failures: markdownlint MD018 in `docs/INTERNALS.md`,
  fixed afterwards and re-run alone (`check-markdownlint`: passed, 241 files);
  and `worker/deno/tests/merge_fallback_issue_test.ts` ("routes the label
  creation through the caller's gh"), which fails identically on a clean
  checkout of the branch's base `HEAD` and is unrelated to this change. The
  serial test pass did not run because the parallel pass failed.
