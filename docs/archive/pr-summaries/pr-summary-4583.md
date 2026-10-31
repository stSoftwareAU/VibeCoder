## Summary

The completion phase's reviewer note (and the one in-session note to the agent)
now also carries the independent-review and reproduction-status findings when
the closure gate, or the review gate, reports first. Closes #4583.

Both verdicts join `lateSummaryVerdicts` (first in the order), so
`foldInLateSummaryVerdicts` appends them to whichever gate reports first. Each
gate passes itself as `skip`, so it is not folded into its own block twice.
`pr_summary_check.ts` reports each gate on its own with no fold, so it needs no
change.

## Spec

### Intent and Rationale

- `reportSummaryRuleBlock` keeps only the first gate's comment on the re-run, so
  any gate not folded into that comment was dropped. Folding the two missing
  gates fixes both the in-session note and the PR comment with one change.
- Alternative (appending every gate's comment in the re-run branch) would
  duplicate the already-folded late verdicts and leave the first in-session note
  incomplete.

### Essential Design Decisions

- The review and reproduction validators now run before `lateSummaryVerdicts` is
  built; their own gates read the same results.
- The closure gate still folds with no skip; the review and reproduction gates
  skip themselves.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; verified by tests, no UI.

## Test Plan

- Added `worker/deno/tests/completion_phase_reviewer_note_folds_4583_test.ts`: a
  `bug`-labelled issue with criteria and a summary lacking closure, review and
  `## Reproduction` blocks. The in-session prompt and the single PR comment each
  name the closure, review and reproduction findings. A negative control
  (`work-on` only) asserts the reproduction finding is absent. Passed.
- Red check: removing both verdicts from `lateSummaryVerdicts` fails both tests;
  removing only `reproductionVerdict` fails the first test.
- Related completion-phase suites (`completion_phase_advisory_gates_4234`,
  `summary_rule_retry`, `pre_pr_verifier_3395`, closure, reproduction,
  placeholder, unmet criteria and others): 109 passed, 0 failed. No existing
  test changed.
- `deno fmt --check`, `deno lint`, `deno check` on the changed files: clean.

<!-- vibe-quality-gate-skipped reason="full ./quality.sh exceeded the 500s bound in its unit-test stage within the run budget; CI runs it" -->
