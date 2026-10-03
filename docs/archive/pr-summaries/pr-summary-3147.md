# PR Summary — Issue #3147

## Summary

The branch-outcome test rule (Issue #3069), "every outcome of a branch you add
needs a test that reaches it", was prose only. Nothing checked it, so fleet PRs
kept shipping a new branch that no test reached. Review-fix rounds added the
test a finding named while their own rework opened new untested branches
(GRQ-AutoTrader#2368). One summary named a test that did not exist
(VibeCoder#3132).

This change makes the enumeration a recorded, checked artefact:

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md` now require
  a run that writes or refreshes a PR summary to record the enumeration as a
  `Branch outcomes:` list in its Test Plan. Each line names `path:line`, the
  outcome, the test that reaches it, and that flipping the outcome went red.
  A diff that adds no branch writes `Branch outcomes: none added`.
- `prompts/issue/prompt.md` names that list in the Test Plan step, says the
  worker will not raise the PR without it, and adds an example to the
  skeleton summary.
- `prompts/pr_feedback/prompt.md` requires a fix to re-enumerate every branch
  its own commits add and to refresh the list to the head.
- New `worker/deno/lib/branch_outcomes_gate.ts` is a summary-rule gate. It
  uses the docs-sweep gate's applicability test. It blocks a summary with no
  `Branch outcomes:` list, an empty or placeholder one, or one that names a
  test-file path not tracked at HEAD (`git ls-tree`, fail closed).
- `worker/deno/lib/phases/completion_phase.ts` runs the docs-sweep,
  result-placeholder and branch-outcomes gates as one late block.
  `reportSummaryRuleBlock` reports every one that fails in the single
  recovery turn. `foldInDocsSweep` is renamed `foldInLateSummaryGates`, and
  it folds the branch-outcomes verdict into an earlier gate's block too.

Closes #3147.

## Test Plan

- `worker/deno/tests/branch_outcomes_gate_test.ts`: parsing, validation and
  HEAD lookup of the `Branch outcomes:` list.
- `worker/deno/tests/completion_phase_branch_outcomes_test.ts`: the gate
  wired into the completion phase, including the fold into earlier gates'
  blocks.
- `worker/deno/tests/branch_outcomes_record_3147_test.ts`: a
  documentation-drift test that pins the rule in `CODING-STANDARDS.md` and in
  the coding_guidelines, issue and pr_feedback prompts.
- Existing completion-phase tests were updated for the new gate's git lookup.
- `docs/audits/lib-sweep-coverage.json` now registers
  `branch_outcomes_gate.ts` as a top-up slice. Without it,
  `lib_sweep_coverage_test.ts` failed. After the change,
  `deno test -A tests/lib_sweep_coverage_test.ts tests/lib_sweep_coverage_prompt_listing_test.ts tests/sweep_drift_command_test.ts`
  gave 45 passed, 0 failed. The tests that read
  `docs/workflows/issue-processing.md` gave 41 passed, 0 failed.

## Evidence

**Docs sweep** — grep: `foldInDocsSweep`, `foldInLateSummaryGates`, `branch_outcomes_gate`, `Branch outcomes`, `summary_rule_gate_retry`, `docs_sweep_gate`, `result_placeholder_gate`, "five summary gates", "all five", "summary-rule gate", "placeholder-token gate"; section: `docs/workflows/issue-processing.md#-a-branch-outcome-with-no-recorded-test-blocks-the-summary-issue-3147` (new), plus the docs-sweep gate, degraded-delivery guard, "A summary shortfall after the PR is not a failed run", security-gate-ordering and in-run recovery passages of the same file; updated: `docs/workflows/issue-processing.md` (the remaining "five summary gates" / "all five" counts are now six, and the docs-sweep gate's "standalone block" is now the late gates' combined block), `docs/audits/lib-sweep-coverage.json` (top-up-3147 slice). Reviewed and left unchanged: `docs/CONFIGURATION.md` (its placeholder mention covers the PR-reply chokepoint, which this change does not touch) and `docs/audits/security-sweep-2189-summary-rule-gate-retry.md` (a dated audit of #2189).
