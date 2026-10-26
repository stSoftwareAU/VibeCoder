## Summary

Removed the fixed VibeCoder issue citations from three strings the fleet
posts into a **target** repository, where GitHub autolinks a bare `#N` to
that repo's own issue. Closes #3674.

- `worker/deno/lib/pr_base_integrity.ts` (`checkPrBaseIntegrity`): the
  mistargeted milestone-fix comment (posted on the fix PR and, prefixed, on
  the milestone's final PR) and the moved-onto-default comment no longer end
  with `(Issue #3433)`.
- `worker/deno/lib/milestone_partial_rollup.ts` (`buildPartialRollupBody`):
  the partial-rollup PR body no longer cites `(#2794)` or `(Issue #2830)`.

Provenance stays in code comments, the module doc and the local `log(...)`
lines, as #3501 did. The returned `outcome.message` strings are unchanged.

## Spec

### Intent and Rationale

- A VibeCoder issue number posted in another repo links to an unrelated issue there and writes a cross-reference into its timeline; dropping the suffix is the smallest fix, matching #3501

### Essential Design Decisions

- Only text posted with `gh pr comment` / `gh pr create --repo <target>` changes; local log lines and returned outcome messages keep `(Issue #3433)` for operators
- The final-PR comment still names `PR #<fix>`, a target-repo number, which the test allows explicitly

### Undiscoverable Facts

None.

## Evidence

Backend-only change; verified by unit tests.

- Issue numbers cited: #3433: Milestone-fix PRs get retargeted to the default branch and auto-merge there, bypassing the milestone's review; #3501: Security tree sweep issue body cites non-existent VibeCoder Issue #4193, which autolinks to an unrelated issue in the swept repo; #3674: Partial-rollup PR body and base-integrity PR comments still cite VibeCoder issue numbers in target repos.

**Docs sweep** — grep: "Raised automatically by the Vibe Coder", "cross-milestone dependency deadlock (#2794)", "close it (Issue #3433)", "human should retarget it", `buildPartialRollupBody`; section: none — no manual quotes these posted strings; siblings: none — no existing set gained a member; no hits outside the changed files

## Test Plan

- Added `worker/deno/tests/pr_base_integrity_test.ts`:
  - `check: the retargeted milestone-fix comments cite no bare #N beyond the target repo's own PR (Issue #3674)` — the fix-PR comment has no `#N`; the final-PR comment has only `#9` (the fix PR). Red check: restoring ` (Issue #3433)` in the comment text → red.
  - `check: the moved-onto-default comment cites no bare #N (Issue #3674)` — red check: restoring ` (Issue #3433)` → red.
- Added `worker/deno/tests/milestone_partial_rollup_test.ts`:
  - `createPartialRollup - the PR body cites no bare #N (Issue #3674)` — drives the real create path through the existing `FakeGitHub`. Red check: restoring `(#2794)` alone → red; restoring `(Issue #2830)` alone → red.
- No existing assertion was removed or edited.
- `deno task test:unit tests/pr_base_integrity_test.ts tests/auto_merge_sweep_test.ts` — 56 passed, 0 failed.
- `deno task test:unit tests/milestone_partial_rollup_test.ts` — 21 passed, 0 failed.
- `deno fmt` and `deno lint` on the four changed files — clean.
- `./quality.sh` on the code commit — `Result: PASSED (with skipped checks)`; only `config integration` was skipped.

<!-- vibe-branch-outcomes -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
