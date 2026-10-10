## Summary

`WIP_CHECKPOINT_COMMIT_MESSAGE` no longer ends in `(Issue #4170)`. That issue
does not exist in stSoftwareAU/VibeCoder (`gh issue view 4170` returns "Could
not resolve to an issue or pull request"), and the message is written into
every periodic checkpoint commit on every repository the worker touches. The
subject is now `WIP checkpoint: periodic agent progress snapshot`. Closes #3345.

## Spec

### Intent and Rationale

- A fixed `#<n>` in a commit message that goes to every repository will link to whatever unrelated issue later takes that number (the defect class #3338 describes). Dropping the number is the smallest fix and needs no caller changes. The alternative was to thread the run's issue or PR number into the message, but every caller would have to pass it, and the branch name already identifies the issue.

### Essential Design Decisions

- The `WIP checkpoint:` prefix is unchanged. Both readers, `isWipCommitSubject` in `wip_markers.ts` and in `wip_commit_marker.ts`, match on that prefix only. Checkpoint commits already pushed with the old `(Issue #4170)` suffix therefore still read as WIP, and the WIP-only PR gate still refuses them. This is the "read the old shape" option for a persisted value. The new test seeds an old-shape subject to pin it.

### Undiscoverable Facts

- Many source comments in `worker/deno/lib` cite `#4170` and other `#4xxx` numbers (for example `git_branch.ts:324` and `claude_env.ts:244`). The issue calls a sweep of them optional ("may be worth sweeping"). They are code comments, not output the worker writes into other repositories, so this PR leaves them alone to stay in scope.

## Evidence

Backend-only change: no UI files are touched.

- `worker/deno/tests/wip_checkpoint_test.ts::wip_checkpoint - checkpoint message cites no issue number, old-shape subjects still read as WIP (Issue #3345)`. With the base `lib/wip_checkpoint.ts` restored (`git checkout HEAD -- lib/wip_checkpoint.ts`, before the commit) it failed: `FAILED | 0 passed | 1 failed`. With the fix it passed: `ok | 1 passed | 0 failed`.
- Issue numbers this diff adds as provenance: #3345: WIP checkpoint commit message hard-codes a citation to non-existent Issue #4170.

**Docs sweep** — grep: `periodic agent progress snapshot`, `WIP_CHECKPOINT_COMMIT_MESSAGE`, `WIP checkpoint:`; section: `docs/workflows/issue-processing.md#-decision-points-and-exceptions` (the "Timed-out run" bullet); no doc updates needed. `docs/workflows/issue-processing.md:726` is still true because it names only the `WIP checkpoint: …` prefix, which is unchanged. `worker/deno/lib/wip_markers.ts:41-42` ("the rest of the subject carries … the issue reference") still describes the `wip:` timeout subject, which keeps its `(Issue #47)` reference. #47 exists and is the WIP-preservation issue.

## Test Plan

- Added one test to `worker/deno/tests/wip_checkpoint_test.ts`. It asserts the message contains no `#<digits>`, that the message is still a WIP subject, and that the old `(Issue #4170)` subject is still a WIP subject. No existing assertion was removed.
- `deno task test:unit tests/wip_checkpoint_test.ts tests/wip_markers_test.ts tests/wip_commit_marker_test.ts tests/completion_wip_only_gate_test.ts tests/handover_note_test.ts`: `ok | 55 passed | 0 failed`.
- `deno fmt`, `deno lint` and `deno check` on both changed files: clean.
- `./quality.sh`: every stage up to and including `release-tag ruleset` passed (completeness, mermaid, markdownlint, semgrep, the chokepoint checks). The sequential test-suite stage then ran past the 580s bound and was stopped (`exit=124`), so the full gate did not finish here.

<!-- vibe-quality-gate-skipped reason="budget: the container's sequential full test suite exceeds the 600s foreground bound; stages before it passed and CI runs the full suite" -->

Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
