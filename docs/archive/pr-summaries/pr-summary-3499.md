## Summary

Removes the fixed `(Issue #N)` suffix from the four `wip:` commit-subject builders. These subjects are pushed to whichever repository the worker is working on. In a target repo, a bare `#47`, `#218`, `#3088` or `#769` links to that repo's own unrelated issue. The handover-only subject now cites the run's own issue (`on issue #<n>`), which is the one number that is correct in the target repo. `isWipCommitSubject` matches on the `wip:` prefix, so commits already pushed with the old subjects are still recognised. Closes #3499.

## Spec

### Intent and Rationale

- This fixes the same class of defect as #3345 and #3338: a fixed `#<n>` in text written to every repo cross-references an unrelated issue. PR #3496 fixed only the periodic checkpoint subject.
- The fix drops the suffix rather than writing `stSoftwareAU/VibeCoder#N`. A qualified reference would still add a cross-reference to a VibeCoder issue's timeline on every push. Provenance for the code stays in the doc comments, where it belongs.

### Essential Design Decisions

- The handover-only builder already knew the run's issue number, so its subject is now `wip: handover note for the interrupted run on issue #<n>`. That `#<n>` resolves to the right issue in the target repo.
- The interrupted, uncommitted-work and declared hand-off builders take no issue number. Their subjects now cite none.
- Old-shape test fixtures (`... (Issue #47)` and similar) are left unchanged. They now act as evidence that subjects already on remote branches are still read as WIP.

### Undiscoverable Facts

- No parser reads the WIP suffix. `extractIssueNumberFromPrTitle` (`worker/deno/lib/pr_body.ts:245`) parses PR titles only, and WIP detection uses only the `wip:` prefix.

## Evidence

Issue numbers the diff and this summary cite, each viewed with `gh issue view` / `gh pr view` in this run:

- #3499: Interrupted, uncommitted-work, declared-hand-off and handover-only `wip:` commit messages write VibeCoder issue numbers into target repos
- #3345: WIP checkpoint commit message hard-codes a citation to non-existent Issue #4170
- #3338: Fleet PRs cite a wrong or never-filed issue number as a change's provenance (VibeCoder#3068, #3308)
- PR #3496: WIP checkpoint commit message hard-codes a citation to non-existent Issue 4170 (Issue #3345)

| Builder | Before | After |
| --- | --- | --- |
| `buildInterruptedWipCommitMessage` | `… preserving N uncommitted file(s) (Issue #47)` | `… preserving N uncommitted file(s)` |
| `buildUncommittedWorkWipCommitMessage` | `… a run that raised no PR (Issue #218)` | `… a run that raised no PR` |
| `buildDeclaredHandoffWipCommitMessage` | `… a declared hand-off (Issue #3088)` | `… a declared hand-off` |
| `buildHandoverOnlyWipCommitMessage` | `wip: handover note … (Issue #769)` | `wip: handover note for the interrupted run on issue #<n>` |

**Docs sweep** — grep: `buildInterruptedWipCommitMessage`, `buildUncommittedWorkWipCommitMessage`, `buildDeclaredHandoffWipCommitMessage`, `buildHandoverOnlyWipCommitMessage`, "preserving", "handover note", "a declared hand-off", "raised no PR"; section: the doc comments on the four builders in `worker/deno/lib/wip_checkpoint.ts` and `worker/deno/lib/phases/run_wip_preservation.ts`; siblings: `buildInterruptedWipCommitMessage`, `WIP_CHECKPOINT_COMMIT_MESSAGE`, "handover note"; updated: the four builder doc comments. `README.md` and `docs/` (archive excluded) contain none of the subject phrases. Hits left in place: the `(Issue #47)` text in log and issue-comment strings in `worker/deno/lib/phases/run_wip_preservation.ts` is not a commit subject and is posted to the VibeCoder-side record, so it is out of this issue's scope.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Drop the `(Issue #47)` suffix from `buildInterruptedWipCommitMessage` — evidence: `worker/deno/lib/wip_checkpoint.ts:127` — reviewer: met
- **met** — Drop the `(Issue #218)` suffix from `buildUncommittedWorkWipCommitMessage` — evidence: `worker/deno/lib/wip_checkpoint.ts:146` — reviewer: met
- **met** — Drop the `(Issue #3088)` suffix from `buildDeclaredHandoffWipCommitMessage` — evidence: `worker/deno/lib/wip_checkpoint.ts:167` — reviewer: met
- **met** — Drop the `(Issue #769)` suffix from `buildHandoverOnlyWipCommitMessage`; cite the run's own issue if provenance is wanted — evidence: `worker/deno/lib/phases/run_wip_preservation.ts:233` — reviewer: met
- **met** — Commits already pushed with the old subjects are still recognised by `isWipCommitSubject` — evidence: `worker/deno/tests/wip_checkpoint_test.ts:384` asserts four old-shape subjects — reviewer: met
- **met** — Extend the #3345 test so no builder's output contains a bare `#<digits>` other than the run's own issue number — evidence: `worker/deno/tests/wip_checkpoint_test.ts:384` (all five causes plus the uncommitted-work and hand-off builders); `worker/deno/tests/execute_phase_handover_test.ts:337` (the private handover-only builder, whose only `#<n>` is the run's issue) — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — No material departures. The only issue number the new code cites is #3499, the issue being closed. Every test named here exists at the head. The reviewer's optional note to collapse the template literal at `worker/deno/lib/phases/run_wip_preservation.ts:233-237` was declined, because `deno fmt` accepts the current form.

## Test Plan

- **RED on base production code:** the three new or extended assertions fail on base 21bde1f7. They are `worker/deno/tests/wip_checkpoint_test.ts` "interrupted, uncommitted-work and hand-off subjects cite no issue number…", `worker/deno/tests/execute_phase_handover_test.ts` "execute_phase #769 - a clean tree with checkpoint commits still commits the note", and `worker/deno/tests/declared_handoff_phase_3088_test.ts` "the hand-off commit subject is a WIP marker". Result: 3 failed.
- **GREEN at the head:** the targeted run of those files plus `worker/deno/tests/wip_commit_marker_test.ts` gave 116 passed, 0 failed.
- **Edited expectations:**
  - `worker/deno/tests/wip_commit_marker_test.ts:99-100`: `"file(s) (Issue #47)"` became `"file(s)"`. Red-check: restoring ` (Issue #47)` in the builder makes the test fail (1 failed). The source was then restored.
  - `worker/deno/tests/issue_worker_test.ts:4095` ("a deadline timeout with a dirty tree preserves WIP on the issue branch"): the `"Issue #47"` pin became `"preserving 2 uncommitted file(s)"`, plus a new assertion that the subject contains no `#<digits>`. Red-check: restoring the suffix fails the test at `:4100`. The source was then restored.
  - No assertion was removed. Only the pinned suffix changed, and the `issue_worker_test.ts` check is stronger than before.
- A grep confirms that no other test pins `Issue #47`, `#218`, `#3088` or `#769` as an expected subject string.
- `./quality.sh < /dev/null`: exit 0, "Result: PASSED (with skipped checks)". The only skip is config integration, because no `.config.json` is present.
- No field, parameter, type or export was added, so the production-reader check has nothing to check.

**Branch outcomes:** none added

## Pre-PR Security Self-Check

- [x] Input validation: no new external input.
- [x] Secrets: none staged.
- [x] Injection surface: no new shell, SQL, filesystem or HTTP calls. The subject interpolates only an integer issue number.
- [x] Output encoding: not applicable.
- [x] Authentication/authorisation: unchanged.
- [x] Error handling: unchanged.
- [x] Dependencies: none added.
- [x] Path confinement: no path guards.
