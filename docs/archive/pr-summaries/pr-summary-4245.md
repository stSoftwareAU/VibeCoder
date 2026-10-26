## Summary

Progress-extension grants, the claim-runway floor and scheduled release now use the two-hour finish. A grant cannot move the deadline past finish − kill grace − the 120 s WIP reserve. The claim floor measures runway to the finish when that instant arrives before the supervisor ceiling, and still measures to the supervisor ceiling when the supervisor ends the run first. An agent result with `finishDeadline: true` is a scheduled release: the `wip:` commit is kept, and no `failed-once`, timeout cooldown or worker-fault filing is applied. Closes #4245.

Version bump: not applicable — no `deno.json` version change.

## Spec

### Intent and Rationale
- The extension ceiling, the claim floor and the failure ladder still treated the three-hour supervisor cap as the end of useful work. The finish is an hour earlier, so stopping there has to be a release.
- Issue #420's reason still holds: the execute phase passes the full requested `claudeTimeout` instead of truncating it at the one-hour target. The runner then clamps the effective session budget at finish minus kill grace and WIP reserve, and the same ceiling bounds extension grants. At minute 59, the default reserve leaves at most 58 minutes 30 seconds before preparation.

### Essential Design Decisions
- `extensionCeiling` picks the nearer of the supervisor ceiling and finish − reserve, and labels it `"the finish deadline"` or `"the run hard cap"`. `decideProgressExtension` keeps the #421 sentences when the label is absent. With the finish label, a shortened grant says `grant clamped to the finish deadline`, and no runway says `finish deadline reached`. The runner logs that reason on the `[progress-extension]` line and sets `finishDeadline` when the cause is `"finish-deadline"`.
- `anchorClaimCapToFinish` sets `finishMs` only when the finish is sooner than the supervisor ceiling. The floor (`hardCapRunwaySeconds`, `belowClaimRunwayFloor`) then measures to `finishMs`. When the supervisor ceiling is sooner, `finishMs` is left unset, the floor measures to that ceiling, and the stop line still says `the supervisor hard cap`.
- Execute classifies `finishDeadline: true` as `scheduled_release` with reason `the finish deadline was reached`. `handleIssueFailure` already returns before `failed-once` for that category. Merge-conflict, milestone sync, PR feedback, CI fix and the custom-label PR path log `released on schedule` and add no failure label.

### Undiscoverable Facts
- `resolveClaimHardCap` runs before `runCoreLoop` publishes the timeline, so that snapshot cannot see the finish. The serial scan and the slot pool call `anchorClaimCapToFinish` again at claim time.
- The execute phase and `commands/execute_claude_phase.ts` pass the finish label only when `extensionCeiling` returns it, so a run with no timeline keeps the hard-cap wording. The handler ceiling in `executePriorityHandler` is the minimum of the handler ceiling and the finish ceiling when a timeline is set.
- This is an expected-value change the issue requires. `execute_phase_full_budget_420_test.ts` still asserts the runner is handed the full `claudeTimeout`. The new test in that file asserts `progressExtension.ceilingMs` is the finish less `finishSessionReserveSeconds` and `ceilingLabel` is `"the finish deadline"`.

## Evidence
- Ceiling: `worker/deno/lib/run_timeline.ts` (`extensionCeiling`), `worker/deno/lib/progress_extension.ts` (`ceilingLabel`, cause `"finish-deadline"`), `worker/deno/lib/progress_extension_runtime.ts` (`buildProgressExtension`'s sixth argument), `worker/deno/lib/phases/execute_phase.ts`, `worker/deno/commands/execute_claude_phase.ts`, `worker/deno/lib/run_core.ts` (`executePriorityHandler`).
- Floor: `worker/deno/lib/claim_runway.ts` (`anchorClaimCapToFinish`, `claimRunwayBoundPhrase`). Both scan loops in `worker/deno/lib/run_core.ts` call it. `worker/deno/lib/run_core_production_deps.ts` anchors the deps snapshot as well.
- Release: `worker/deno/lib/failure_diagnosis.ts` (`ScheduledReleaseReason` `"finish-deadline"`), `worker/deno/lib/wip_checkpoint.ts` (the `scheduled-release` subject), `worker/deno/lib/run_outcome_classifier.ts`, `worker/deno/lib/label_failure.ts`. Handlers: `merge_conflict_agent.ts`, `pr_merge_conflict_processor.ts`, `milestone_conflict_ladder.ts`, `pr_feedback_processor.ts`, `pr_ci_processor.ts`, `custom_label_pr_dispatch.ts`.
- Docs: `docs/CONFIGURATION.md` stages 2, 4 and 5 of `### 🕰️ The cycle-deadline model`, the mermaid, `#### The run hard cap bounds every grant`, and the `min_claim_runway_seconds` and `run_finish_seconds` rows. The stale "not yet applied" sentence was removed from that row and from `worker/deno/types.ts`, `worker/deno/lib/config.ts` and `RunCoreConfig`.
- `worker/deno/tests/deadline_model_docs_check_test.ts` passed, including `deadline docs - this repository's own docs satisfy the model (Issue #426)` (26 tests in that file, 0 failed, when run beside `claim_runway_test.ts`).

## Reproduction
- **symptom** — an extension grant, a late claim and a finish-deadline stop were still judged against the three-hour supervisor cap, so stopping at two hours could be filed as a failure.
- **status** — `partial`
- **reason** — the new tests were written with the implementation and were not watched failing on the unfixed code. They pass on this head. No production run was reproduced here.
- **regression test** — `worker/deno/tests/progress_extension_hard_cap_421_test.ts::progress extension #4245 - a grant that would pass the finish is clamped, and the line says so`

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — An extension grant never moves the deadline past finish − reserve. A grant that would is clamped, and the `[progress-extension]` line says so. — evidence: `worker/deno/tests/progress_extension_hard_cap_421_test.ts::progress extension #4245 - a grant that would pass the finish is clamped, and the line says so` — reviewer: met
- **met** — The claim floor refuses a claim whose runway to the finish deadline is shorter than the floor. — evidence: `worker/deno/tests/claim_runway_test.ts::claim runway #4245 - the floor measures runway to the finish deadline, not the extension ceiling` — reviewer: met
- **met** — An execute run whose agent result carries `finishDeadline: true` is classified `scheduled_release`, keeps its `wip:` commit, and adds no `failed-once`. — evidence: `worker/deno/tests/execute_phase_handover_test.ts::execute_phase #4245 - a finish deadline keeps the wip commit and is a scheduled release`; `worker/deno/tests/execute_phase_scheduled_release_424_test.ts::execute_phase #4245 - a finish deadline is a scheduled release and adds no failed-once` — reviewer: met
- **met** — A merge_conflict / milestone-sync agent ended by the finish deadline applies no failure label. — evidence: `worker/deno/tests/merge_conflict_agent_test.ts::merge conflict agent - a finish deadline is released on schedule, not judged (Issue #4245)`; `worker/deno/tests/pr_merge_conflict_processor_test.ts::processMergeConflict - a finish deadline withdraws the attempt and adds no failure label (Issue #4245)`; `worker/deno/tests/milestone_conflict_ladder_test.ts::climbConflictLadder - a finish deadline applies no failure verdict (Issue #4245)` — reviewer: met
- **met** — The canonical deadline-model section describes the 1 h / 2 h / 3 h timeline, and `deadline_model_docs_check` passes. — evidence: `worker/deno/tests/deadline_model_docs_check_test.ts::deadline docs - this repository's own docs satisfy the model (Issue #426)` — reviewer: met
- **partial** — Tests and `./quality.sh` pass. — evidence: the focused Deno tests named in the Test Plan passed; `deno fmt` and `deno lint` on the touched files passed — reason: `./quality.sh` was not run in this session — reviewer: partial

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — one claim-floor function (`anchorClaimCapToFinish`) serves the serial scan, the slot pool and the production-deps snapshot; the extension label is passed only when it is the finish, so the hard-cap sentences stay. Australian English. No `deno.json` version bump. The cited #4245 tests passed. — evidence: `worker/deno/lib/claim_runway.ts`, `worker/deno/lib/progress_extension.ts`, `worker/deno/lib/phases/execute_phase.ts`

## Test Plan
- `worker/deno/tests/progress_extension_hard_cap_421_test.ts`, `worker/deno/tests/claim_runway_test.ts` (8 passed, 0 failed), `worker/deno/tests/execute_phase_full_budget_420_test.ts`, `worker/deno/tests/execute_phase_scheduled_release_424_test.ts`, `worker/deno/tests/execute_phase_handover_test.ts`, `worker/deno/tests/merge_conflict_agent_test.ts`, `worker/deno/tests/milestone_conflict_ladder_test.ts`, `worker/deno/tests/pr_merge_conflict_processor_test.ts`, `worker/deno/tests/pr_feedback_processor_no_changes_test.ts`, `worker/deno/tests/pr_ci_processor_no_changes_test.ts`, `worker/deno/tests/deadline_model_docs_check_test.ts` (26 passed, 0 failed).
- Expected-value change: `execute_phase_full_budget_420_test.ts` keeps the full-budget assertion and adds `execute_phase - a claim at minute 59 keeps the full budget and the extension ceiling is the finish (Issue #4245)`.
- Twins: `phases/execute_phase.ts` and `commands/execute_claude_phase.ts` both call `extensionCeiling`; `executePriorityHandler` in `run_core.ts` takes the minimum with the finish ceiling. `resolveClaimHardCap` in `run_core_production_deps.ts` and both `anchorClaimCapToFinish` call sites in `run_core.ts`. `buildScheduledReleaseReason`, the execute-phase `scheduled_release` category, and `handleIssueFailure`. The `released on schedule` path in `merge_conflict_agent.ts`, `milestone_conflict_ladder.ts`, `pr_feedback_processor.ts`, `pr_ci_processor.ts` and `custom_label_pr_dispatch.ts`. The WIP subject in `wip_checkpoint.ts`, `run_outcome_classifier.ts`, `failure_diagnosis.ts` and `docs/CONFIGURATION.md`. The "not yet applied" sentence in `types.ts`, `config.ts`, `RunCoreConfig` and the `run_finish_seconds` row.
- `worker/deno/lib/vibe_env_registry.ts` keeps a single `VIBE_HARD_KILL_AT_EPOCH` entry, the Issue #4247 note. The second entry from the milestone merge is removed. It does not change the finish ceiling.

## Independent review repairs for PR #4382

Quality remediation and security, summary and screenshot retries now recognise
the runner's typed `finishDeadline` result before starting another gate or
completion attempt. Their shared `releaseRunAtFinishDeadline` path calls the
existing WIP preservation helper and returns `scheduled_release`. Quality
remediation also bypasses dependency-bump audit after that release. No blocked
security run or `failed-once` attempt is charged for reaching the finish.

Custom-label PR dispatch now returns a typed finish outcome from its agent
seam instead of parsing an error message. A release posts a PR comment naming
the finish deadline and asking the developer to re-apply the consumed label;
it does not silently drop the request or enter push verification.

The five recovery regressions (including an applied dependency bump) and the
custom-label regression all failed before the repairs and pass afterwards.
They assert WIP push, preserved branch, no extra gate/completion run, no failure
ladder charge, no security blocked-run charge, and the visible PR retry comment.
Validation: 17 recovery/dispatch tests, 99 related integration tests and all
866 manifest checks pass (one ignored). Production wiring type-checks and all
11 touched TypeScript files pass lint. The duplicated housekeeping fragment
in `GH-API-OPTIMISATION.md` is removed, and `DEPLOYMENT.md` now describes the
supervisor cap as the outer kill, consistent with the finish-deadline model.

After #4380 merged, retained both configuration test groups and extended the
same typed scheduled-release handling to its new pre-push recovery turn. A
completion-level regression failed with `pre_push_gate` before this integration
fix; it now requires `scheduled_release`, no gate rerun, no normal push or PR
creation, and no failure attempt.
All 192 configuration, pre-push and recovery integration tests pass, along
with all 866 manifest checks (one ignored); formatting and lint pass.


## Final documentation review

Corrected the three operator-guide statements that promised a full 60-minute
session for a claim taken at minute 59. The unchanged requested timeout and
the effective finish-minus-reserve budget are now distinguished, including
the default 58-minute-30-second allowance before preparation. The matching
rationale above is corrected too. No runtime or test behaviour changes.
All 866 manifest checks pass (one ignored), including the deadline-model
documentation checks.
