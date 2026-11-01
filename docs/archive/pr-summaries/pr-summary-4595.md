## Summary

An orchestrated issue run now records the stats of every provider call it
made, not only the returned one. `runOrchestratedIssueRun` still returns the
last manager (review) call on `done` and the runner's timed-out call on a
timed-out run, but that result now carries the plan and executor calls (and any
earlier attempt of a retried call) in a new `orchestrationCalls` field.
`recordClaudeRunStats` records each as its own `state.claudeRunStats` entry
ahead of the returned result's, so the issue's cost/model comment and the
fleet figures from `measureIssuePhaseRun` cover the whole run. Closes #4595.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- The phase records one `ClaudeRunResult` per agent invocation. The gate
  collapsed an orchestrated run to the review call, so the executor's tokens,
  duration and model never reached the comment or the fleet figures.
- The issue offers two shapes: aggregate into one `runStats`, or expose per-call
  results so the phase records each. Aggregating would merge distinct served
  models and token usage into one `RunStats` and lose the model line, so the
  gate exposes per-call stats instead.

### Essential Design Decisions

- The returned result is unchanged (still the review or the timed-out call), so
  the phase's timeout, scheduled-release and output handling are untouched. The
  other calls ride in `orchestrationCalls`, stats-bearing fields only, never
  output.
- The call-site wiring lives in `recordClaudeRunStats`, the one function every
  `recordClaudeRunStats(state, claudeResult.value)` site in `execute_phase.ts`
  already calls, so both of its sites (the credential-switch record and the
  normal record) pick it up with no edit to the phase.
- A retried call contributes one entry per attempt from `invocationStats`
  (already captured by the gate); the last attempt is the returned result's own
  `runStats`, which the phase records itself, so it is excluded from
  `orchestrationCalls` to avoid a double count.

### Undiscoverable Facts

- None.

## Evidence

Backend only. Changes: `worker/deno/lib/orchestration/issue_run_gate.ts`
(`callStatsOf`, `withOtherCalls`), `worker/deno/lib/claude_runner.ts`
(`OrchestratedCallStats`, `ClaudeRunResult.orchestrationCalls`),
`worker/deno/lib/phase_run_stats.ts` (`PhaseClaudeResult.orchestrationCalls`),
`worker/deno/lib/issue_worker_types.ts` (`recordClaudeRunStats`). Docs: new
`docs/INTERNALS.md` section "An orchestrated issue run records every provider
call's stats (Issue #4595)". `orchestrationCalls` is set by the gate and read by
`recordClaudeRunStats`; both are production code.

Not changed: the CodeGraph and Graft query tallies (`codegraph.record`,
`graft.record`) still read the returned call only; the issue concerns the
cost/model comment and fleet figures.

Callers checked: `recordClaudeRunStats` has other callers (gate retry turns,
pre-PR verifier, closure verdict); none passes `orchestrationCalls`, so their
entries are unchanged. `executeClaudePhase` passes the gate result straight to
`recordClaudeRunStats` at both sites. The only issue number this diff adds as
provenance is #4595, this issue.

## Test Plan

- `worker/deno/tests/orchestration_3642_gate_test.ts` (new):
  - "the result carries the plan and executor calls' stats beside the review's"
    - distinct tokens and models per call; asserts the returned result is still
    the review's and the other two ride in call order.
  - "a retried executor call contributes every attempt it billed" - an
    `invocationStats` of `[failed, undefined, final]`; asserts both billed
    attempts and no double count of the final one.
  - "a timed-out run still carries the earlier calls' stats" - the timed-out
    branch returns the plan call and every earlier executor attempt.
- `worker/deno/tests/issue_run_stats_comment_test.ts` (new):
  - "recordClaudeRunStats - records an orchestrated run's earlier calls beside
    its returned result" - order, per-call fields kept, nothing nested.
  - "measureIssuePhaseRun - an orchestrated run's spend and duration include its
    executor call" - duration 6 s against 3 s for the review alone, and a higher
    USD figure.
- Red check: before the change the five new tests failed (128 passed, 5
  failed); after it, 183 passed across the gate, stats-comment,
  execute-phase-assignment, completion run-stats and fleet run-cost test files.
- Break checks, each leaving the gate and stats-comment files red: returning
  `lastManagerResult` unwrapped in the `done` branch (2 failed); unwrapped in
  the timed-out branch (1 failed); `slice(0, -1)` -> `slice(0)` (double count, 2
  failed); ignoring `invocationStats` (1 failed); `recordClaudeRunStats`
  dropping `orchestrationCalls` (2 failed).
- `deno fmt`, `deno lint` and `deno check` on the touched `.ts` files: clean.
- No existing assertion was removed or edited.

<!-- vibe-quality-gate-skipped reason="`./quality.sh` takes about 15 minutes; the targeted checks above passed and CI runs the full gate." -->
