## Summary

Closes #3977.

An active run now reconciles its exact merged implementation before completion
recovery and failure bookkeeping. Proved already-landed work releases with the
existing `claim_stale:work_already_merged` outcome, skips redundant recovery and
PR creation, and consumes no coding-failure attempt. Distinct local work and
explicit partial scope stay on the normal path.

## Spec

### Intent and Rationale

- Stop the remaining squash-merge recurrence without replacing branch management,
  inventing a failure taxonomy or discarding unpublished changes.
- Keep integration into a milestone separate from delivery to the default branch.

### Essential Design Decisions

- Reuse claim freshness, exact branch provenance, the existing branch-PR lookup
  and merged-commit ancestry. The shared bounded branch query finds milestone
  PRs even when GitHub's issue-closing connection is empty.
- Require repository, issue-closing contract, run branch, intended target and
  immutable merged/head commit identity. Fetch the pull ref without moving a
  branch; prove that local HEAD and the branch contain no work outside that
  merged PR, then repeat the local identity and clean-tree observations.
- Preserve explicit partial/missing or unassessed criteria, unrelated PRs,
  reapproved scope, dirty work, extra commits and unavailable evidence. A plain
  historical summary is accepted only for an issue without declared scope, and still needs the closing contract and commit proofs.
- Use shared Markdown logical units and code segments; code examples cannot
  manufacture the closing contract. Supported unrequested extras remain valid.
- Guard quality-phase failure recording, worker outcome derivation and the final
  production failure plan. Preserve a genuine failure already booked by a phase.
- Production stops the heartbeat timer but publishes the terminal marker only
  after the final decision, preventing provisional failure tallies and duplicate
  landed releases. Standalone cleanup keeps its existing behaviour.
- Both serial and pooled claim release retain target/default/merge provenance.
  These skips earn no success/failure callback or default-delivery credit. No
  historical failure labels or attempt records are stripped.

### Undiscoverable Facts

- The public milestone examples have no closing-PR nodes in the issue connection.
  PR #3959 supplies the exact #3740 branch and squash; PR #3618's own summary
  explicitly reports partial #3534 scope, so that historical example remains a
  negative control rather than being declared complete.

```mermaid
flowchart LR
  F[Recovery or failure boundary] --> P{Exact landed work proved?}
  P -->|Yes, clean and contained| S[Release explicit landed skip]
  P -->|No or unknown| N[Preserve normal recovery and failure handling]
```

## Evidence

- #3977: Reconcile already-merged work before push recovery and failure labelling
- #3740: Review-fix drift check (#3143) only logs Test Plan figures it cannot check: a per-round "added to" bullet hides its whole-file counts, and stale counts reach review (VibeCoder#3075, #3156, #3676)
- #3534: Add a versioned summary-facts schema, validator and Branch-outcomes renderer

- Replayed the public #3740 squash timeline from PR #3959 with its real branch,
  target, head, first replayed commit and squash identity. Replayed PR #3618
  for #3534 as a negative because its full historical summary reports partial
  criteria. Public snapshots are retained in
  `worker/deno/tests/fixtures/already_landed_3977.json`.
- Those two selected public records give one known positive and one partial-scope
  negative, both correctly classified. Synthetic refusal cases cover malformed
  metadata and unavailable evidence. This small selected corpus establishes no
  general recall estimate; unobserved false negatives remain unknown.
- 101 individual mutations produced assertion failures in the named regressions,
  including actual production worker dispatch, every new bookkeeping caller,
  both core release arms and deferred heartbeat publication. The facts companion
  records 98 nonredundant source anchors and tests; the three superseded whole-expression flips are covered by independent operand records. No type failure counts as a red test.
- Before the latest renderer integration and review fixes, twelve focused suites passed: 329 tests, no failures. After merging main `7bd0d619`, the twelve feature suites and five polling/default suites pass 748 tests with type checking enabled. Six affected mutation receipts were refreshed against the new source with passing baselines before and after; all 101 source/test hashes match the current files. Current integrated full validation remains pending. The repository quality
  gate is recorded separately when complete. No deployed-worker or fleet-wide
  recurrence improvement is claimed from these fixtures.
- Docs sweep — grep: "claim freshness", "already-landed", "Preservation runs
  before the existing-PR lookup"; section:
  `docs/workflows/issue-processing.md` → "Decision points and exceptions"; siblings:
  none — extends existing freshness and release owners rather than adding a
  parallel branch-management or telemetry subsystem.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A fixture reproduces another worker merging the exact implementation between this run's work and its final push; no failure label, failure attempt, duplicate PR or unnecessary recovery is produced. — evidence: production completion fixtures cover merges before recovery and during push; screenshot and summary recovery fixtures assert zero agent turns after a merge during gate checks. — reviewer: met
- **met** — The same holds when the state changes just before failure recording. — evidence: quality-handler and final production checks precede bookkeeping; deferred heartbeat publication avoids a provisional failure tally, while already-booked genuine failures remain failures. — reviewer: met
- **met** — Partial/unrelated merges, extra local work and unavailable GitHub state do not falsely succeed or lose changes. — evidence: provenance, partial-scope, dirty-work, extra-commit and unavailable-evidence controls; public #3740 is positive and #3534 remains negative because its PR explicitly reports partial scope. — reviewer: met
- **met** — Milestone-landed and default-branch-delivered outcomes remain distinguishable. — evidence: target/default/merge identity survives both serial and pool claim-release paths, without success/failure callback or throughput credit. — reviewer: met
- **met** — Tests cover the full completion → failure-handler path, not just PR lookup. — evidence: fixtures invoke real production processIssue wiring, completion, final reconciliation and failure handling; additional tests cover actual production worker publication, quality bookkeeping and both core release paths. — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Earlier guards missed quality bookkeeping and production discarded skip outcomes. — evidence: `worker/deno/lib/phases/quality_gate_remediation_phase.ts:226` and `worker/deno/lib/run_core_production_deps.ts:4901`. — reason: fixed with pre-write reconciliation and explicit outcome propagation through both core release paths.
- **violation** — A provisional heartbeat failure could remain in the tally after late reconciliation. — evidence: `worker/deno/lib/issue_worker.ts:235` and `worker/deno/lib/heartbeat.ts:289`. — reason: fixed by deferring the first terminal publication to the final production release, without rewriting history.
- **violation** — Code examples or an unassessed criteria block could falsely establish delivery. — evidence: `worker/deno/lib/claim_freshness.ts:425`. — reason: fixed using shared code segments, conservative indentation eligibility and the existing criteria extractor; refusal and legal controls pass.
- **violation** — The production release-ownership test only asserted an internal flag. — evidence: `worker/deno/tests/run_core_production_deps_test.ts:735`. — reason: fixed with actual workOnIssue dispatch through production and observable heartbeat-clear, interval and failure-handler assertions.

- **violation** — Whole-path mutations did not establish each provenance operand or the final local-state observations. — evidence: `worker/deno/lib/claim_freshness.ts:405`, `worker/deno/lib/claim_freshness.ts:487` and `worker/deno/lib/issue_worker.ts:163`. — reason: fixed with independent metadata operands, late-only dirty/HEAD/branch changes, separate local commit containment and terminal eligibility controls; all 101 recorded mutations fail assertions.
- **violation** — Markdown, closure and heartbeat decisions needed operand-specific accountability. — evidence: `worker/deno/lib/claim_freshness.ts:425` and `worker/deno/lib/issue_worker.ts:235`. — reason: fixed with 17 additional independent flips, incomplete-closure controls and actual worker publication controls for standalone, ordinary success, other stale reasons and ordinary pre-existing gate skips. The earlier 12-suite run passed 329 tests; integrated validation is recorded below.
- **violation** — Current issue scope could be bypassed by a legacy PR without closure entries — evidence: `worker/deno/lib/claim_freshness.ts:458` — reason: fixed with the existing accepted-scope extractor and semantic closure matcher, plus refusal fixtures for missing/unmatched acceptance, accepted-scope and done-when entries; the bare-closing regression first failed with AssertionError.
- **violation** — Deferred heartbeat publication put the workflow-scope fleet check before its durable tally entry — evidence: `worker/deno/lib/run_core_production_deps.ts:5216` — reason: fixed by checking the existing durable tally in the final claim-release owner; failed publication never supplies an inferred attempt.
- **clean** — Final independent source review found no remaining material findings and verified all 101 current-source mutation receipts. The 98 published facts retain the independent controls within the existing schema cap; three superseded aggregate flips are not duplicated. The integrated twelve-suite run passes 334 tests with type checking enabled; full quality validation remains pending. Earlier independent source review checked shared helper reuse, preserved existing assertions, qualified deployment evidence, specific source citations, indentation refusals and observable production publication. No additional concrete runtime blocker was found.

## Test Plan

- `worker/deno/tests/claim_freshness_test.ts`: exact merge proof, legacy and current
  summaries, code/indentation refusal controls, partial/unassessed scope,
  malformed/unavailable evidence, local preservation and public timeline replay.
- `worker/deno/tests/completion_phase_pre_push_gate_3689_test.ts`: actual completion
  through production's final failure handler; merge-before-recovery, during-push
  and before-bookkeeping races, preserved work, milestone targets and repeated
  notifications. The real content-integrity snapshot remains enabled.
- `worker/deno/tests/completion_phase_screenshot_retry_test.ts` and
  `worker/deno/tests/completion_phase_summary_rule_retry_test.ts`: no recovery
  agent turn when exact work merges during gate checks.
- `worker/deno/tests/issue_worker_test.ts`,
  `worker/deno/tests/issue_worker_infra_retry_test.ts`,
  `worker/deno/tests/run_core_production_deps_test.ts` and
  `worker/deno/tests/heartbeat_test.ts`: actual worker/production publication,
  quality failure-write boundary and preservation of an already-booked failure.
- The final release caller fixture covers durable-tally ordering, failed marker publication and ordinary/no-outcome/stale exclusions. Current-scope proof rejects unmatched subjects instead of relying on closure-entry counts. A redundant closure-entry guard and redundant branch-context decisions were removed. All 101 retained mutations now produce actual named assertion failures at this source, between passing 25-test baselines across their nine caller suites. Each receipt records both current source and test hashes.
- `worker/deno/tests/run_core_callbacks_test.ts`: serial and pooled release retain
  the landed target while awarding no failure or delivery credit.
- Existing dependency, lineage, security-recovery and production-wiring suites
  remain in the broader validation. Existing assertions are preserved; the
  zero-ahead fixture's PR-creation spy now recognises the actual create command
  when the added read-only provenance query runs.

<!-- vibe-branch-outcomes -->
