# PR Summary — Issue #3334

## Summary

Closes #3334

`classifyIssues` already refused issues as `dependency_blocked` and
`time_deferred`, but neither was a `ClaimableSkipReason` with a rung in
`pickDominantReason`. So a repo whose only refused issues were
dependency-blocked or time-deferred fell through to the defensive
`reason=label_filter` in the idle-detect audit's per-repo line. Both reasons are
now first-class, and the audit reports them.

## Spec

### Intent and Rationale

- The audit's `reason=` should name the gate that actually refused the repo's
  work. `label_filter` misled operators into checking label config.

### Essential Design Decisions

- **Ranking.** The two new rungs sit below the PR, pace and hold gates and above
  `stream_occupied`. `dependency_blocked` outranks `time_deferred`. This follows
  the existing convention: a gate `classifyIssues` applies later only refuses
  issues every earlier gate passed, so it is the more specific answer. The PR
  gates are the exception and rank first because they may need a human.
- **Docstring.** The `pickDominantReason` docstring now lists the full order. It
  used to list only four reasons.

### Undiscoverable Facts

None.

## Evidence

- **Tests** in `worker/deno/tests/idle_detect_diagnostics_test.ts`:
  - `pickDominantReason - dependency_blocked only ⇒ dependency_blocked (Issue #3334)`
  - `pickDominantReason - time_deferred only ⇒ time_deferred (Issue #3334)`
  - `pickDominantReason - dependency_blocked wins over time_deferred (Issue #3334)`
  - `pickDominantReason - run_local_hold wins over dependency_blocked (Issue #3334)`
  - `pickDominantReason - time_deferred wins over stream_occupied (Issue #3334)`
  - `auditClaimableState - a repo whose only open issue is time-deferred reports reason=time_deferred (Issue #3334)`
    (body carries a `Deferred until` line for 2099)
  - `auditClaimableState - a repo whose only open issue has open native sub-issues reports reason=dependency_blocked (Issue #3334)`
- **Docs sweep** — grep: `reason=`, `label_filter`, `pace_suppressed`,
  `stream_occupied`, `pickDominantReason`, `ClaimableSkipReason`,
  `dependency_blocked` over `docs/`, `README.md`, `DESIGN-PRINCIPLES.md` and
  `CODING-STANDARDS.md`. Section: `docs/IDLE-TASK-FRAMEWORK.md`, the "third
  reader is the idle-detect audit" paragraph. Updated:
  `docs/IDLE-TASK-FRAMEWORK.md:1063-1071` and the `pickDominantReason`
  docstring. Remaining hits:
  - `docs/IDLE-TASK-FRAMEWORK.md:914` — still true because it quotes a
    historical census log line (`reason=stream_occupied`).
  - `docs/IDLE-TASK-FRAMEWORK.md:1407-1408` — still true because pace stays the
    audit's last gate, and an issue an earlier gate refuses (now including the
    dependency and deferral gates) keeps that earlier reason.
  - `docs/workflows/issue-processing.md:232` — still true because
    `reason=pace_suppressed` is unchanged.
  - `docs/INTERNALS.md:952,968` — still true because they describe the idle
    census's own `dependency_blocked` reason, a separate vocabulary from the
    audit.
  - `worker/deno/lib/idle_detect_diagnostics.ts:910` (#655 comment, "above
    everything applied before it") — still true because both new gates are
    applied before the hold.
- **Cited issues:**
  - `#3334`: idle-detect audit logs reason=label_filter for repos whose only
    refused issues are dependency-blocked or time-deferred
  - `#2873`: A time-gated analysis issue is escalated to needs-human on every
    run instead of parking until its data exists
  - `#3314`: fix: idle-inversion on stSoftwareAU/GRQ-AutoTrader — claimable work
    the claim scan keeps refusing, sustained across cycles
  - `#857`: idle-detect: missing dependency_blocked gate makes
    mis_classification fire every tick (third instance of #4223 / GRQ#4419)
  - `#655`: fix: idle-inversion on stSoftwareAU/VibeCoder — claimable work the
    claim scan keeps refusing, sustained across cycles
  - `#1915`: With the week-pace guard engaged the idle audit reads
    pace-suppressed issues as 'claimable', declares a disagreement and runs the
    idle-task filer: ~800 GraphQL calls a cycle to file work nobody may pick up
  - `#1050`: No idle task has been filed fleet-wide since 26 August: the
    existence gate counts work no idle slot can claim

## Test Plan

- **Unit tests.** `deno task test:unit` over `idle_detect_diagnostics_test.ts`,
  `idle_detect_week_pace_1915_test.ts`, `idle_detect_dependency_gate_test.ts`
  and `idle_detect_stream_occupancy_1050_test.ts`: 89 passed, 0 failed (final
  run of `idle_detect_diagnostics_test.ts` alone: 66 passed).
- **Quality gate.** `./quality.sh < /dev/null` PASSED. `config integration` was
  SKIPPED because there is no `.config.json`.
- **Red check, both rungs deleted.** 6 of the 7 new tests failed. The exception
  was `run_local_hold wins over dependency_blocked`, which is expected because
  it pins the existing hold rung.
- **Red check, rungs swapped.** Only
  `dependency_blocked wins over
  time_deferred` failed.
- No assertion removed.
- **Branch outcomes:**
  - `worker/deno/lib/idle_detect_diagnostics.ts:921`, returns
    `dependency_blocked`:
    - reached by `dependency_blocked only` and the audit sub-issues test;
    - deleting the rung went red.
  - `worker/deno/lib/idle_detect_diagnostics.ts:922`, returns `time_deferred`:
    - reached by `time_deferred only` and the audit deferred test;
    - deleting it went red;
    - swapping it above line 921 turned
      `dependency_blocked wins over
      time_deferred` red.
  - Fall-through when neither reason is present: unchanged, still reached by the
    existing `stream_occupied` and filter tests, which pass.

## Pre-PR Security Self-Check

- [x] Input validation: no new external input; the audit reads the same
      verdicts.
- [x] Secrets: none staged.
- [x] Injection surface: none added.
- [x] Error handling: unchanged.
