# A degraded run never closes an issue as complete (Issue #2562)

## Summary

Closes #2562.

On #2543 the implementation run asked for `opus`, was served
`claude-haiku-4-5` after a rate-limit fallback (its run-stats comment says
`Degraded: ⚠️ yes`), shipped one of seven accepted changes, wrote no PR summary,
and PR #2553 closed the issue. Three gaps lined up:

1. Nothing on the PR path read the degraded verdict.
2. With no summary file, the worker's minimal body is `Closes #N.`
3. Grill-me issues state scope under `### Accepted scope so far`, which the
   acceptance-criteria gate does not read, so no closure block was required.

**Design (owner's choice of the three options in the issue):** verdict +
follow-up. The PR is still raised with its closing keyword — the delivered work
is kept and a non-closing PR loops (#520) — but on a degraded run every accepted
scope item not shown `met` is filed as one `idle-task` follow-up (the one
work-trigger label the worker may apply itself, so the fleet picks it up with no
human), and the PR body opens with a "Degraded run — partial delivery" section
naming the gaps and linking the follow-up. If the follow-up cannot be filed, no
PR is raised.

## Changes

- `worker/deno/lib/degraded_delivery.ts` (new) — the verdict (same
  `buildDegradationReport` the run-stats comment uses, so the two cannot
  disagree), follow-up and PR-section rendering, and `fileDegradedFollowUp`
  (dedup via `fileFindingOnce`, keyed on the parent; label via
  `guardedLabelArgs`).
- `worker/deno/lib/acceptance_criteria_gate.ts` — `extractAcceptedScope`: the
  criteria, else grill-me's `Accepted scope so far`. The closure gate itself is
  unchanged, so healthy runs see no new requirement.
- `worker/deno/lib/phases/completion_phase.ts` — the guard, after the summary
  gates and before PR lookup/creation.
- `docs/workflows/issue-processing.md` — new section with a diagram.
- `docs/audits/lib-sweep-coverage.json` + `docs/audits/security-sweep-2562-degraded-delivery.md`
  — the top-up sweep record for the new module.

## Acceptance Criteria

- **partial** — A degraded run that delivers a subset does not result in that issue being closed as complete — evidence: `completion - a degraded run delivering one of two criteria files the residue and says so in the PR` — reason: per the chosen design the parent still closes on merge, but never *as complete*: the PR declares partial delivery and the residue continues in an auto-scheduled follow-up
- **met** — The partial delivery is recorded with named criteria — evidence: `buildDegradedFollowUpIssue - names every shortfall, the parent and the dedup marker`; `completion - #2543 reproduction: a degraded run with no summary on a grill-me issue files every scope item`
- **met** — A non-degraded run is unaffected — evidence: `completion - the same run, healthy and complete, raises the PR with no follow-up`; `completion - a healthy run is unaffected even when its summary reports a gap`
- **met** — Regression test, both directions — evidence: `worker/deno/tests/completion_phase_degraded_delivery_test.ts`

## Test Plan

- New: `worker/deno/tests/degraded_delivery_test.ts` (14) and
  `worker/deno/tests/completion_phase_degraded_delivery_test.ts` (6) — written
  first and observed failing before the implementation.
- Every test file importing the touched modules: 77 files, 1250 passed, 0 failed.
- `lib_sweep_coverage_test.ts`, markdownlint, `deno fmt`/`lint`/`check` on the
  changed files, and the issue-create-label and `gh`-spawn scanners run directly
  on the changed files: clean. The full `./quality.sh` is left to CI.
