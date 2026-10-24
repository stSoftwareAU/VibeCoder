## Summary

The idle-detect audit's `classifyIssues` now models the claim scan's `label-author-not-allowed` refusal. A new `label_author_not_allowed` reason (in `ClaimableSkipReason` and `IssueExclusionReason`) is fed by the optional `untrustedLabelIssues` set, and `auditClaimableState` fills that set from an optional best-effort `untrustedLabelIssuesFn`. Closes #4212.

Version bump: not applicable; no `VERSION` file is touched by this change.

## Spec

### Intent and Rationale

- An issue whose priority label an untrusted author added was counted `claimable`, so `ALERT mis_classification` fired every cycle. The library now has a gate for it.
- Library-only, as the issue scopes it. #4213 (open) wires the production set.

### Essential Design Decisions

- The gate sits after `assignee_filter` and before `milestone_tracker`, and `pickDominantReason` ranks it directly above `assignee_filter` (below `milestone_tracker`), exactly as the issue specifies. The issue's claim that this is the scan's order is not quite right: the scan drops trackers earlier in `filterAndSort` and checks the label author later, per candidate. Both refuse the issue, so claimability is identical; only the reported reason differs for an issue that is both a tracker and untrusted. I followed the issue (its acceptance criteria require `milestone_tracker` to outrank the new reason) and corrected the comments and docs that said "mirrors the scan".
- A failed lookup logs `action=warn reason=untrusted_label_lookup_failed` and falls back to an empty set, so the over-count returns rather than a repo reading as having no work.

### Undiscoverable Facts

- `untrustedLabelIssuesFn` has no production caller yet (not yet: #4213 will pass it); until then the audit behaves as before.

## Evidence

Backend-only change; no UI files. Targeted run on the final head: `deno test -A tests/idle_detect_label_author_3964_test.ts tests/idle_detect_diagnostics_test.ts` passed (78 passed, 0 failed).

Full `./quality.sh` run on the final head: every stage passed except `deno tests` (29626 passed, 3 failed), the 3 failures being the `codex` provider-not-installed ones below; an earlier run also showed 2 more failures in suites this change does not touch, all environmental: `claude_runner_provider_fallback_4034_test.ts` (2) and `external_orchestration_3642_config_test.ts` (1) fail with "The running container image did not install the \"codex\" coding-agent provider", and `completion_phase_repo_formatters_test.ts` (2) fail with "formatter should commit the Rust fix". They were not re-run on the base branch. CI runs the gate on the PR.

#3964: Idle-detect audit counts an issue whose priority label an untrusted author added as claimable, so mis_classification fires every cycle (parent). #4213: Wire the untrusted-label set into the production idle-detect audit and document the gate.

**Docs sweep** — grep: `assignee_filter`, `milestone_tracker`, `pickDominantReason`, `mis_classification`; section: `docs/IDLE-TASK-FRAMEWORK.md#idle-detect-audit` (the run-local-hold / audit paragraphs near line 1090-1120); siblings: `assignee_filter`, `milestone_tracker`, `dependency_blocked` (the lists naming them are in `idle_detect_diagnostics.ts` and the one IDLE-TASK-FRAMEWORK paragraph, both updated); updated: `docs/IDLE-TASK-FRAMEWORK.md`, `worker/deno/lib/idle_detect_diagnostics.ts` doc comments; `docs/IDLE-TASK-FRAMEWORK.md:1099` — still true because it describes `dependency_blocked`/`time_deferred`, which this change does not alter.

## Reproduction

- **symptom** — an issue whose only priority label was added by an untrusted author was counted claimable, so `ALERT mis_classification` fired every cycle
- **status** — `verified` — with the gate removed from `classifyIssues` the new tests failed (3 failed, 5 passed); with the gate present all 8 pass. Reproduced at the library/audit level with a stubbed `untrustedLabelIssuesFn`, not against the live scan.
- **regression test** — `worker/deno/tests/idle_detect_label_author_3964_test.ts::auditClaimableState - a label-author-refused priority issue raises no mis_classification ALERT (Issue #4212)`

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — `classifyIssues` marks an issue in `untrustedLabelIssues` with `claimable: false, excludedBy: "label_author_not_allowed"`. — evidence: `worker/deno/tests/idle_detect_label_author_3964_test.ts::classifyIssues - an issue in untrustedLabelIssues is not claimable (Issue #4212)` — reviewer: met
- **met** — If the issue is also assigned to someone else, it still reports `assignee_filter`, which proves the gate order. — evidence: `worker/deno/tests/idle_detect_label_author_3964_test.ts::classifyIssues - assignee_filter keeps its reason ahead of the label-author gate (Issue #4212)` — reviewer: met
- **met** — Without `untrustedLabelIssues`, the existing verdicts are unchanged, and every existing `idle_detect_*` test passes untouched. — evidence: `worker/deno/tests/idle_detect_label_author_3964_test.ts::classifyIssues - no untrusted set keeps today's verdict (Issue #4212)`; `tests/idle_detect_diagnostics_test.ts` passes unedited — reviewer: met
- **met** — `pickDominantReason` returns `label_author_not_allowed` for a repo whose only exclusions are one `assignee_filter` and one `label_author_not_allowed`, and returns `milestone_tracker` when a `milestone_tracker` exclusion is added. A test covers both cases. — evidence: `worker/deno/tests/idle_detect_label_author_3964_test.ts::pickDominantReason - label_author_not_allowed outranks assignee_filter (Issue #4212)` and `::pickDominantReason - milestone_tracker outranks label_author_not_allowed (Issue #4212)` — reviewer: met
- **met** — `auditClaimableState` with an `untrustedLabelIssuesFn` that returns `{N}`, for a repo whose only open priority issue is `#N`: logs `claimable=0 reason=label_author_not_allowed`; logs no `ALERT mis_classification`. — evidence: `worker/deno/tests/idle_detect_label_author_3964_test.ts::auditClaimableState - a label-author-refused priority issue raises no mis_classification ALERT (Issue #4212)` — reviewer: met
- **met** — `auditClaimableState` with an `untrustedLabelIssuesFn` that rejects: logs the `untrusted_label_lookup_failed` warning; still counts `#N` as claimable, so the existing over-count is restored rather than the fault being hidden. — evidence: `worker/deno/tests/idle_detect_label_author_3964_test.ts::auditClaimableState - a rejecting untrustedLabelIssuesFn warns and falls back to the old over-count (Issue #4212)` — reviewer: met
- **met** — `deno task check` (fmt, lint, type-check, tests) passes. — evidence: `deno fmt --check`, `deno lint` and `deno task check` (type-check) exit 0; `deno test -A tests/idle_detect_label_author_3964_test.ts tests/idle_detect_diagnostics_test.ts` passes (78 passed, 0 failed); in the full `deno task test` run (31444 passed, 18 failed) none of the 18 failures touch this change — 13 (`pre_push_sweep_check_test.ts` 9, `sweep_drift_command_test.ts` 2, `milestone_sync_conflict_resolution_test.ts` 1, `claude_runner_pre_push_3394_test.ts` 1) fail identically on an untouched `main` checkout, and 5 are environmental (`codex` provider not installed; Rust formatter) in suites that do not import `idle_detect_diagnostics` — reviewer: met
- **unrequested** — a paragraph in `docs/IDLE-TASK-FRAMEWORK.md` describing the gate — reviewer: unrequested — reason: A Code Change Owes a Docs Change; the gate adds a documented audit reason

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — comments and docs claimed the gate order "mirrors the scan", but the scan drops trackers earlier — evidence: `worker/deno/lib/idle_detect_diagnostics.ts:756` — reason: fixed in this diff (claims reworded; behaviour kept as the issue's acceptance criteria require)
- **violation** — `untrustedLabelIssuesFn` has no production caller — evidence: `worker/deno/lib/idle_detect_diagnostics.ts:1196` — reason: required by #4212 (library-only scope; #4213 wires production); docs now say "Not yet: #4213"
- **clean** — no existing test assertion removed; every new test reaches its outcome; Australian English; no hidden files staged; failure reason test asserts the cause ("boom")

## Test Plan

- Added `worker/deno/tests/idle_detect_label_author_3964_test.ts` (10 tests). No existing test edited, so no assertion removed.
- Red-checks: gate removed from `classifyIssues` → 3 failed; `assignee_filter` ranked above `label_author_not_allowed` → 1 failed; warn log removed → 1 failed. Each restored byte-identical.
- Mutation red-checks (Issue #4146): deleting `number: issue.number` (`idle_detect_diagnostics.ts:761`), deleting `milestone: issue.milestone` (`:764`) and negating the `err instanceof Error` ternary (`:1403`) each fail the new tests (`a label-author verdict carries the issue number and milestone`, `the lookup warning carries the bare Error message, or the string form of a non-Error`). Each restored byte-identical.
- Final head: `deno test -A tests/idle_detect_label_author_3964_test.ts tests/idle_detect_diagnostics_test.ts` passed (78 passed, 0 failed).
- Existing callers of `classifyIssues`/`auditClaimableState` pass no new option, so their behaviour is unchanged; `tests/idle_detect_diagnostics_test.ts` covers them.

<!-- vibe-branch-outcomes -->
