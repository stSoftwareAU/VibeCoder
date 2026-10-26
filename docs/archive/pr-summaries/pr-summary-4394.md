## Summary

The CI-fix post-quality commit (`_runPostClaudeQualityCheck`, step 4) now unstages worker-owned state files (such as `.pr_response_message`) after `git add -A` and runs the pre-commit safety gate, instead of committing everything. If nothing real is staged it makes no commit and leaves the file on disk for `readPrResponseMessage`. Closes #4394.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- A CI-fix agent's reply file was committed and pushed into the PR. The other worker commit paths already unstage state files; this path did not.
- A shared helper, `unstageStateAndAssertSafe` (`worker/deno/lib/git_push.ts`), is now used by both this path and `stageAgentResolution`, so the two cannot drift.

### Essential Design Decisions

- `git add -A` still goes through `deps.git.runGitCommand`; the unstage and safety gate use real git against `cwd`, as `stageAgentResolution` does.
- On a helper failure the step returns `committedChanges: false` and leaves the working tree alone.

### Undiscoverable Facts

- `readPrResponseMessage` deletes `.pr_response_message` after the push, so the on-disk check in the new tests runs inside the mocked push.

## Evidence

Backend-only change; verified by tests below.

## Test Plan

- Added `worker/deno/tests/pr_ci_processor_state_file_4394_test.ts` (real git in a temp repo with no ignore rule): case A reply file alone makes no commit and stays on disk; case B a fix plus reply file commits the fix only; case C a staged `.env` is refused by the safety gate.
- Red check: stubbing the helper call out of `pr_ci_processor.ts` made all 3 tests fail; restored.
- Modified `worker/deno/tests/pr_ci_processor_test.ts`: two tests now `git init` the temp dir and really stage a file (`initRepoWithStagedFile`), because the helper uses real git. No assertion was removed.
- `deno task test:unit` on `pr_ci_processor_test.ts`, `pr_ci_processor_no_changes_test.ts`, `milestone_conflict_ladder_test.ts` and the new file: 76 passed, 0 failed.
- `./quality.sh`: every stage passed except deno tests, which failed on 2 tests in `worker/deno/tests/completion_phase_repo_formatters_test.ts` ("formatter should commit the Rust fix"). The same 2 fail on the unmodified base commit, so they are unrelated to this change.
- Twin copies checked: `stageAgentResolution` (now calls the shared helper) and `commitAndPushPending` (already unstages); none left.
