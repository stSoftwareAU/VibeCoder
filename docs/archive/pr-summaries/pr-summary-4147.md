# Keep crashed runs and incomplete assignments in the worker queue

## Summary

Closes #4147. The fleet execute phase now rejects failed empty runs before the
analysis-only hand-off. It shares the standalone phase's completion check,
including structured failures, unfinished streams and zero model turns even when
the process exit code is zero. Recoverable local changes, commits and PRs still
proceed to completion.

Merged PRs that explicitly mark acceptance criteria missing leave the original
issue queued with its existing labels. Both closers stop applying `needs-human`,
and cached and uncached PR lookup stop treating an incomplete merge as finished
work. Open PRs and the cooldown for closed, unmerged attempts still prevent
duplicate work.

Acceptance statuses must lead their assessment entry. A test description that
mentions a "missing or unreadable value" no longer marks the whole criterion
missing and prevents closure.

## Acceptance Criteria

- **met** — Stale session IDs retry without resume and clear the stored ID.
  Already landed in #4148; reverified by `dead_session_resume_4147_test.ts`.
- **met** — Failed and zero-turn empty runs are failures in both execution
  paths, covered by `execute_phase_failed_run_4147_test.ts` and
  `execute_claude_phase_test.ts`.
- **met** — Resumed autocompact thrash retries with a fresh session. Already
  landed in #4148 and reverified by `dead_session_resume_4147_test.ts`.
- **met** — A successful, completed one-turn result can still yield
  `no_changes`; structured errors, unfinished streams and zero-turn results
  cannot. Providers without structured metadata retain their exit-code rule.

## Spec

### Intent and Rationale

- A failed invocation is a retryable run failure, not evidence that an
  implementation issue needs a human.
- The operator asked to correct false hand-offs and finish assigned work; a
  partial merge must not suppress the remainder of that assignment.

### Essential Design Decisions

- Both execution entry points call `emptyRunFailureReason` after recovery
  checks. Providers without structured completion metadata retain their
  exit-code behaviour.
- Read matched merged PR bodies live on the cached path. The existing persisted
  title-search cache shape and keys do not change.
- Keep the missing-criterion close guard, but remove its label/comment mutation.
  Missing criteria remain visible in logs and the lifecycle result.

### Undiscoverable Facts

- The earlier #4148 fix guarded the standalone command, while the fleet calls
  `workOnIssueExecuteClaude`; this explains repeated hand-offs after that merge.
- A private fleet repository's label events showed worker-created hand-offs
  immediately followed by removal of the operator's discovery labels.

## Evidence

- RED/GREEN: the active fleet phase originally failed the three crashed-run
  cases. Both entry points then failed the structured error, zero-turn and
  unfinished-stream cases with exit zero. All now pass.
- RED/GREEN: both merged-PR closers originally added `needs-human`; both PR
  lookup paths originally suppressed incomplete work. The regression tests now
  assert preserved labels, no hand-off comment and continued eligibility.
- Final focused run: 207 passed, 0 failed, including
  `dead_session_resume_4147_test.ts` for the already-landed fresh-session retry.
- Thirteen deliberate guard/operand mutations each produced assertion failures
  in an isolated checkout; the unmodified focused suite passed.
- The prose-status regression failed in both the parser and the real merged-PR
  closer before the fix. Its related parser, PR-body and closure suite then
  passed 105 tests.
- Full-suite investigation reproduced an existing file-lock test hang: its
  missing-file watcher starved pending lock I/O. Yielding between observations
  and stopping the watcher in `finally` preserves its atomicity assertions. The
  startup fixture also disables real host package updates. Both fixture suites
  passed all 29 tests afterwards.
- The completed full-suite run exposed six subprocess-fixture failures from
  permission flags that `deno eval` rejects. Those fixtures now use eval's
  implicit permissions; environment-isolation assertions are unchanged. Two
  terminal-reconciliation integration tests now assert the bounded retry and
  preserved heartbeat outcomes. The production-dispatch test also asserts that
  this infrastructure failure consumes no issue-failure attempt; the separate
  genuine-quality-failure test retains its existing charge check.
- No UI changed; screenshots are not applicable.

**Docs sweep** — grep: `holdIssueOpenForMissingCriteria`,
`buildMissingCriteriaHoldComment`, `missing_criterion_close_guard`,
`A crashed run is never analysis-only`, `statusOf`; section:
`docs/workflows/issue-processing.md#-acceptance-criteria-closure-before-the-pr`;
siblings: `runExecuteClaudePhase`, `workOnIssueExecuteClaude`,
`ensureIssueClosedIfPrMerged`, `closeIssuesForMergedPrs`; updated:
`docs/workflows/issue-processing.md`, `docs/INTERNALS.md` and the affected
module comments. Historical summaries remain historical; the missing-criterion
guard still prevents false closure.

## Test Plan

- `execute_phase_failed_run_4147_test.ts` exercises the real fleet phase,
  bounded retry, clean results and recovery of uncommitted, local, remote and PR
  work. `execute_claude_phase_test.ts` exercises its standalone sibling.
- `missing_criterion_close_guard_3177_test.ts` exercises both real closers,
  repeated sweeps, preserved existing human holds, cached and uncached lookup,
  the merged-PR precheck and the superseding-PR classifier. It keeps positive
  all-met closure and open/recently-closed duplicate-prevention coverage.
- Callers checked: the precheck, execute recovery and completion recovery use
  `findExistingPrForIssue`; `classifyExistingPrForIssue` feeds both execute and
  completion supersession checks. Incomplete merges now yield no completed PR;
  their existing no-PR paths continue the assignment. Both closer callers of the
  removed mutation helper now retain labels and emit diagnostics.
- `acceptance_criteria_gate_test.ts` and the missing-criterion closer test
  reject prose-only statuses while preserving explicit leading statuses. Parser
  callers also include claim freshness, unmet criteria, closure-met checks and
  degraded delivery; their explicit-status fixtures retain the same meaning.
- Execution fixtures use the production `CLAUDE_OUTPUT_ADAPTER.decode` and
  `buildRunStats`, matching the metadata produced by the real runner. Git and PR
  ports separately model absent work and each recovery path. The closure
  fixtures preserve GitHub's distinction between merged PRs and closed, unmerged
  PRs, including `mergedAt` in closed-list responses.
- Removed assertions expecting `needs-human` and one hand-off comment are
  replaced by no-label/no-comment assertions, as required by the operator's
  request to restore incorrectly parked assignments. The removed
  `buildMissingCriteriaHoldComment` test described a deleted hand-off API;
  missing-criterion text is now asserted in closer logs and the lifecycle
  reason, while all-met closure tests remain.

<!-- vibe-branch-outcomes -->

## Merge verification

Run the complete `./quality.sh < /dev/null` gate before publishing this PR.
Required CI and the repository's approving review must pass before merge. Config
integration requires a local configuration; Checkov requires its scanner or a
container runtime. Their local skips do not replace the required CI checks.
