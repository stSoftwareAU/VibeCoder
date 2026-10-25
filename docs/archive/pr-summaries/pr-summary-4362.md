# PR Summary — Issue #4362

## Summary

An infrastructure fault recorded as `criteria-unmet` no longer cools the issue. A Codex transcript whose later session has no working tools (the code-mode host missing, after the implementing agent had already used tools) is `tool-runtime`: transient, no `failed-once`, no escalating cooldown. A `criteria-unmet` run whose tools actually worked stays on the ladder.

The existing held-issue gate comment is deleted in the scan that sees its blocking PR merged, when that scan did not replace the hold with a new gate. Same marker, same comment. Absence from the capped open-PR list is not treated as a merge.

`selection-reasoning` lists configured-label skips first in `blocked=` and drops other entries first once the field would pass 1024 characters, so a truncated line still names why a top-priority issue was skipped. `configured-label-blocked` stays the full count.

Part of #4362. The draft continuation for fleet issue 4139 was not resumed: this change does not call live GitHub beyond reading the issue.

## Spec

### Intent and Rationale

- A verifier or agent with no working tools was recorded as `criteria-unmet` / `failed-once`, which cooled a top-priority issue for hours after the fault was fixed.
- The hold comment "PR N is open on this stream" was only written for issues still in the held set. Once the PR merged, the issue left that set (often into cooldown) and the comment was never cleared.
- `blocked=` followed input order. Cooldown notes are appended last, and external log truncation dropped the top-priority skip.

### Essential Design Decisions

- Reuse `tool-runtime` and the coding-failure ladder. A worker-gate category stays on the ladder unless the transcript itself shows the runtime failure. Quoted gate prose cannot forge that class.
- A provider error counts when no tool call after it succeeded. Tools that succeeded before the error are an earlier session.
- Reuse the `vibe-held-issue-gate` comment. Clear it only when the remembered key is `held-gate-pr-open-<N>` and `<N>` is in this scan's merged set, and this scan did not already report a new gate. A delete failure throws and leaves the cache so the next scan retries. A stranger's marker is not deleted.
- `tier` on a blocked entry is optional. Entries without it keep their input order, so existing lines are unchanged until a tier is set.

### Undiscoverable Facts

- `classifyRunFailure` answered every worker-gate category before it read the transcript, and `transcriptShowsToolRuntimeFailure` returned false if any tool in the whole transcript had succeeded. Both had to move.
- `planCodingFailure` with `ladderApplied: true` still cools the issue even when the final reason reads transient. That rule is unchanged; only a tool-runtime classification skips the cooldown.
- Open PRs are listed at most ten per author (`prs_<user>`). The closed listing is refetched when an open PR previously seen disappears, which is how the same cycle can observe `mergedAt`.
- The hold cache key is `held_issue_gate_<issue>` and the value's `key` is `held-gate-pr-open-<pr>`.

## Evidence

Backend change. No UI.

The new tests were run first, before the fix, from `worker/deno`:

`deno test --frozen --lock=deno.lock --allow-read --allow-env --allow-run --allow-write --allow-sys=hostname tests/run_outcome_classifier_test.ts tests/coding_failure_ladder_test.ts tests/issue_finder_logger_test.ts tests/find_oldest_issue_gate_comment_test.ts --filter "Issue #4362"`

Result before the fix: `FAILED | 1 passed | 4 failed`. The control (a `criteria-unmet` run whose tools worked stays on the ladder) passed. The other four failed: tool-runtime was `agent-outcome`, the ladder still set a cooldown, the hold comment was not deleted, and `#4139(cooldown)` sat at the tail of `blocked=`.

The same command after the fix: `ok | 5 passed | 0 failed`.

The four files plus `tests/worker_gate_repeat_failure_test.ts`, without the filter: `ok | 143 passed | 0 failed`.

## Reproduction

- symptom: a top-priority issue cooled for hours after a code-mode host outage was recorded as `criteria-unmet` / `failed-once`, the "PR N is open on this stream" comment stayed after that PR merged, and the truncated `blocked=` list no longer named the skip
- status: verified
- test: `classifyRunFailure - a criteria-unmet run whose later session has no tools is tool-runtime (Issue #4362)`, `planCodingFailure - an infra tool-missing failure recorded as criteria-unmet does not cool the issue (Issue #4362)`, `findOldestIssue - a merged blocking PR clears the pr-open hold comment (Issue #4362)`, and `issue_finder_logger - selection-reasoning names a top-priority skip ahead of a truncated blocked list (Issue #4362)`
- The four tests failed against the unfixed code and passed after the fix.

## Acceptance Criteria

- **met** — A `failed-once` / cooldown caused by an infrastructure fault (verifier or agent with no working tools) does not cool the issue. It is retried on the next cycle once the fault is fixed. — evidence: `tests/run_outcome_classifier_test.ts` and `tests/coding_failure_ladder_test.ts`, the two Issue #4362 cases; observed failing before the fix and passing after — reviewer: missing — reason: no independent reviewer has read this diff yet
- **met** — The held-issue gate comment is cleared or rewritten when its blocking PR merges, in the same cycle. — evidence: `tests/find_oldest_issue_gate_comment_test.ts`, `findOldestIssue - a merged blocking PR clears the pr-open hold comment (Issue #4362)`; the second scan deletes the fleet comment for PR #77 — reviewer: missing — reason: no independent reviewer has read this diff yet
- **met** — `selection-reasoning` logs why a specific top-priority issue was skipped even when the `blocked=` list is truncated. — evidence: `tests/issue_finder_logger_test.ts`, `owner/fleet#4139(cooldown)` is named ahead of the work-on filler — reviewer: missing — reason: no independent reviewer has read this diff yet
- **missing** — The draft continuation for issue 4139 is resumed and marked ready, or the issue is recorded as complete. — reason: that draft lives in a private fleet repository, and this change was not allowed to call live GitHub except `gh issue view` — reviewer: missing — reason: the gap is the private draft, which this repository cannot resume

## Test Plan

- [x] A `criteria-unmet` transcript whose later session has the code-mode host missing is `tool-runtime`, transient, and `planCodingFailure` sets neither `applyLadder` nor `cooldownKind`
- [x] The same category with working tools stays `agent-outcome` and `cooldownKind: "non_transient"`
- [x] Scan 1 posts `PR #77 is open on this stream`; after `prs_bot` is invalidated and PR 77 is merged, scan 2 deletes that fleet comment while the issue is in cooldown
- [x] A configured-label `cooldown` entry is named in `blocked=` ahead of a long work-on list, and `configured-label-blocked` stays the full count
- [x] Existing cases in the four files and `tests/worker_gate_repeat_failure_test.ts` still pass (`143 passed`)
