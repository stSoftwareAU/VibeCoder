## Summary

Closes #3910.

Milestone completion now closes a completed milestone directly when the compare
API reports no changed files, even if sync merge commits leave the milestone
branch ahead. It creates neither a tracker nor a final roll-up PR in that case.
Invalid commit counts and missing or malformed file lists on ahead branches keep
the normal branch-present flow, so incomplete comparison data cannot close a
milestone. Zero commits ahead still establishes that there is nothing to merge.

## Spec

### Intent and Rationale

- Avoid the empty final PR described in the issue: a milestone with 12 sync
  commits ahead and an empty changed-file list.

### Essential Design Decisions

- Extend the existing comparison read and completion decision; retain the
  existing completion, tracker cleanup and milestone-close sequence.
- Read the file list as an array, preserving the distinction between an empty
  list and unavailable comparison data.

### Undiscoverable Facts

- The repository's live default branch is `main`; this PR targets it.

## Evidence

- #3910: Milestone completion raises an empty roll-up PR when the milestone
  branch is ahead only by main-sync merge commits.
- All three new regression tests failed against unchanged base production code.
  The completion regression created a summary PR before the fix and closes the
  milestone without a tracker or summary PR after it.
- The two affected milestone suites pass: 168 tests, no failures.
- Manifest completeness checks pass: 687 passed, one existing ignored test.
- Docs sweep — grep: "0 commits ahead", "nothing to merge", "ahead_by";
  updated `docs/workflows/milestones.md`, `docs/INTERNALS.md` and completion
  comments/logging; section: `docs/workflows/milestones.md` → "Decision points
  and exceptions"; siblings: none — extends an existing decision, with no new
  member of a documented set. `docs/INTERNALS.md:4477` still describes the
  separate sync-PR retirement decision, whose commit-ancestry requirement is
  unchanged.

## Test Plan

- Added the ahead-with-empty-files regression and an end-to-end completion
  regression that asserts the milestone closes without creating an issue or PR.
- Added malformed comparison cases, including invalid counts, missing file lists,
  non-array file values, invalid JSON and blank output.
- Updated existing comparison fixtures to return the new JSON projection. Kept
  the existing assertions and positive work-present cases.
- Checked individual condition changes against the tests: bypassing integer
  validation, allowing negative counts, ignoring zero commits, accepting a
  non-array file list, and ignoring the file count each made a test fail.
- Ran the two affected milestone suites and `deno task check:manifests`.

<!-- vibe-branch-outcomes -->
