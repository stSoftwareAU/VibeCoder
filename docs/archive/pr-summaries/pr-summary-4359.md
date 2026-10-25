# PR Summary — Issue #4359

## Summary

An issue run that had already delivered its branch could still die at completion when GitHub rejected the pull request body: `Body is too long (maximum is 65536 characters)`. Idle-task issue bodies were already clamped to `GITHUB_ISSUE_BODY_MAX_CHARS` in `worker/deno/lib/idle_task_body_limit.ts`. The pull request body built by `assemblePrBody` — the summary file plus the worker's own sections, footer and markers — was not.

The completion phase now checks that assembled body after image URLs are expanded, and again after a pre-PR review head note is prepended. Over the limit, it does not cut. It gives the agent one fresh turn to rewrite `docs/archive/pr-summaries/pr-summary-<n>.md`: keep the gate blocks, condense the prose, and link the full file on the branch. The prompt does not paste the summary. The rewritten file is committed and completion runs again, so the same checks see it, and that body is what `gh pr create --body` and the recover path's `gh pr edit --body` publish.

A mechanical cut is only the last resort, when that turn throws, times out, exits non-zero, or the rewrite is still over the limit. The cut keeps the worker footer and the `## Acceptance Criteria`, `## Standards Review` and `## Reproduction` sections, links the summary file, and logs the shortening. The pull request is still raised. A `gh` failure that is not this length error still fails the run.

`syncPrBodyFromSummary` (`gh pr edit --body-file`) has no agent of its own. The summarise turn belongs to completion, which commits the rewritten file this edit then reads. A body that is still over the limit is shortened and the edit still happens. If GitHub then says the body is too long, the edit is retried once with a tighter cut. Any other `gh` error is returned.

Closes #4359.

## Spec

### Intent and Rationale

- The delivered run failed after the branch was pushed, because `gh pr create` was the first thing that noticed the body length.
- Cutting first would drop the blocks the gates read, and the agent would never get a chance to keep them. The cut is the fallback, after one rewrite.

### Essential Design Decisions

- The limit is the existing `GITHUB_ISSUE_BODY_MAX_CHARS` (65,536). No second constant.
- `assemblePrBody` in `worker/deno/lib/pr_body_sync.ts` is the builder. Completion applies `applyPrBodyLengthPolicy` to that body before the create/recover split, so both `gh pr create --body` and `recoverExistingPr`'s `gh pr edit --body` publish the checked body. The REST fallback and the deferred-create payload use the same body.
- The summarise turn is one call to `runClaudeWithRetry` (`phase: "issue"`), not a resumed session, and the browser is not enabled. The attempted flag is set before the call, so a throw cannot ask twice.
- Sync does not grow an agent hook. A later fix run that finds the summary still over the limit shortens it and still edits. `commands/git_operations.ts` also calls `recoverExistingPr`, with a body the caller supplies; that path does not build the summary body and is unchanged. Milestone summary pull requests use `buildSummaryPrBody`, a different builder, and are unchanged.

### Undiscoverable Facts

- `extractAcceptanceCriteria` does not read a `## Done when` list (`extractAcceptedScope` does, for the degraded-run guard). This issue states its requirements under `## Done when`, so the closure gate does not apply and this summary has no acceptance-criteria block.
- `recoverExistingPr` already treats an edit failure as non-fatal and still returns the existing pull request. The length policy runs before that call, so the body it is given is at or under the limit.

## Evidence

Backend change. No UI.

Tests, from `worker/deno`, with `deno test --allow-all`:

- `tests/pr_body_length_4359_test.ts` and `tests/completion_phase_pr_body_limit_4359_test.ts`: `ok | 7 passed | 0 failed`.
- `tests/pr_body_sync_test.ts`: `ok | 44 passed | 0 failed` (the three Issue #4359 cases are in that count).
- `deno check` on `lib/pr_body_length.ts`, `lib/pr_body_sync.ts`, `lib/phases/completion_phase.ts` and `lib/issue_worker_types.ts`.
- `deno lint` on those files and the three test files: checked, no problems.

The completion case uses an injected `runClaudeWithRetry` and `runGhCommand`. It does not call GitHub. The over-long summary is `LENGTH-FILLER-4359` repeated until the assembled body is past 65,536 characters. The agent writes a short summary. The created body is at or under the limit, contains `SHORT-SUMMARY-MARKER-4359`, and does not contain the filler. The prompt contains the summary path, `65536`, `vibe-spec-review` and `Condense`, and does not contain the filler. The existing-PR case asserts there is no `gh pr create` and that the recovered body is the short one. The thrown-agent case still creates, with the summary path in the shortened body. The authentication-failed case is `status: "failure"` and the reason is that string.

## Test Plan

CI repair: applied Deno formatting to the five files reported by CI, registered the new module in the security coverage ledger, and registered the numeric-only prompt builder with an explicit no-untrusted-input reason. The builder receives no summary body or other free-form text. Merged the latest main branch without dropping either side. Local validation: 90 body-length, completion, sync and ledger tests; five prompt-coverage tests; and all 857 manifest checks passed (one ignored). Formatting and lint checks pass for the repaired TypeScript files.

- [x] An over-long summary triggers exactly one summarise turn, and `gh pr create --body` publishes the shorter body
- [x] An existing pull request is updated with that shorter body and `gh pr create` is not called
- [x] A thrown summarise turn is not retried, and the pull request is still created with a shortened body that links the summary file
- [x] `gh pr create` failing with `authentication failed` after a successful rewrite fails the run, and the reason is not `Body is too long`
- [x] `degradePrBodyToGitHubLimit` leaves a short body unchanged, and an over-long body keeps the standards-review marker, the worker marker, the summary link and `Closes #N`, at or under 65,536 characters
- [x] `assessPrBodyLength` asks before it cuts, and the prompt does not carry the summary text
- [x] `syncPrBodyFromSummary` publishes a shortened body for an over-long summary and still edits
- [x] A sync edit that fails with `authentication failed` stays an error
- [x] A sync edit that fails with `Body is too long` is retried once with a shorter body that still carries the worker marker
- [x] `tests/pr_body_sync_test.ts` (the existing sync cases) still passes

## Reproduction

- **symptom** — a delivered issue run fails at phase `completion` with `PR creation failed: gh command failed (exit 1): pull request create failed: GraphQL: Body is too long (maximum is 65536 characters) (createPullRequest)`, and no pull request is opened.
- **status** — `verified`. Before this fix, `tests/completion_phase_pr_body_limit_4359_test.ts` was run against the worktree at `a08c560fa` (origin/main). The three summarise tests failed with `agentCalls.length` actual `0`, expected `1`. The authentication-failure test passed without the feature, because the long body was sent to the stubbed `gh pr create` and that stub rejected it. After the policy, the same file is `4 passed`.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — The limit is the existing constant. `pr_body_length.ts` imports `GITHUB_ISSUE_BODY_MAX_CHARS` and does not declare another 65,536.
- **clean** — The summarise prompt is worker-authored and the completion test asserts it does not contain the summary filler.
- **clean** — A real `gh` failure is not swallowed. The completion test and the sync test both require `authentication failed` to fail the call.
- **clean** — Australian English in the new module, the prompt and this summary (`summarise`, `behaviour`).
