## Summary

Narrows the "After any merge of the base branch ... re-verify each claim" rule
so a base merge that only moves a count, `path:line` citation or run result no
longer sends a PR back. A claim whose subject the merge absorbed is still
dropped, and a figure already wrong at the PR's last own commit is still a
finding. Closes #4563.

## Spec

### Intent and Rationale

- The old sentence was read literally by the fleet reviewer, but most base
  merges (GitHub `update-branch`, the merge-conflict resolver) have no turn that
  owns the summary. The merge-conflict resolver
  (`prompts/merge_conflict/prompt.md`, step 5) already says to leave the summary
  untouched when the merge does not change what it says; the standard now
  agrees.
- Reword only, as the issue proposes. No new check or obligation.

### Essential Design Decisions

- The phrase "a claim whose subject the merge absorbed is dropped" stays
  contiguous in both documents because
  `worker/deno/tests/pr_claims_verified_3058_test.ts` already pins it.
- `docs/USAGE.md` restated the old rule ("each claim is re-verified after any
  merge of the base branch"), so it carries the same narrowing.

### Undiscoverable Facts

- None.

## Evidence

- `CODING-STANDARDS.md` ("PR Summary and Evidence"): the base-merge sentence is
  replaced, and "the head" is defined as the PR's last own commit for counts,
  `path:line` citations and run results.
- `prompts/issue/prompt.md` ("PR Summary File"): the same two changes.
- `docs/USAGE.md`: the restatement is narrowed.
- `grep -n "After any merge of the base branch" CODING-STANDARDS.md prompts/issue/prompt.md`
  returns nothing.
- Docs sweep: grepped `merge of the base`, `match the head`, `matches the head`,
  `base has advanced` over `prompts`, `.claude/skills`, `worker/deno/lib`,
  `docs` (excluding `docs/archive`). The remaining hits are
  `prompts/merge_conflict/prompt.md:8`, the `pr_feedback` and `ci_fix` "Keep the
  PR summary true to the head" paragraphs (they concern a change the run itself
  makes, not a base merge) and unrelated code comments.

## Acceptance Criteria

The issue has no acceptance-criteria heading; nothing it asks is left undone.

## Test Plan

- Added
  `Issue #4563 - a base merge that only moves a figure does not reopen the summary`
  to `worker/deno/tests/pr_claims_verified_3058_test.ts`. Red check: restoring
  the old sentence in `CODING-STANDARDS.md` turned it red on the absence
  assertion; reverted.
- `deno task test:unit` over `pr_claims_verified_3058_test.ts`: 7 passed. Over
  the 44 test files that read these docs: 244 passed, 0 failed.
- `deno fmt --check` on the test file: passed.
- Not checked: the full `./quality.sh`, and the effect on a live fleet re-review
  round.

<!-- vibe-quality-gate-skipped reason="full gate not run in this run; CI runs the same checks on the PR" -->
