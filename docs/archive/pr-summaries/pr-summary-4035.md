## Summary

Closes #4035.

A grill-me round whose agent run ended because the provider refused to serve
now releases its claim without posting the `## Grill-Me Failed` marker. The
consecutive-failure counter reads that marker, so a provider outage can no
longer escalate a healthy issue to `needs-human`. The next scan retries the
round. Task failures, timeouts and rounds that post nothing still count, as
before.

## Spec

### Intent and Rationale

- On GRQ-23 (2026-10-20), GRQ-AutoTrader#3788 went to `needs-human` after two
  rounds that Codex refused in about five seconds each (HTTP 400, #4019).
  Rounds 1–3 had succeeded on DeepSeek. Nothing about the issue had failed.
- A wait that clears by itself must never become `needs-human`, and provider
  unavailability is normal: park quietly and retry.

### Essential Design Decisions

- Classification reuses `isProviderUnavailableFailure` (`agent_output.ts`).
  Its contract already says "callers must not charge such a run to a streak";
  the merge-conflict agent applies it, and grill-me did not.
- Applies only when the run exited non-zero with a classified `agentFailure`.
  An unclassified failure keeps the marker, so real round failures still
  escalate.
- A forced final round that hits a provider outage is not escalated either. It
  is retried like any other round.

### Undiscoverable Facts

- The refusal reached grill-me as `exitCode: 1` with
  `agentFailure.category: "model-unavailable"`, decoded by the Codex output
  adapter from its JSONL stream (stdout and stderr were empty).

## Evidence

The two new provider-refusal tests were red before the change (a marker was
posted). The task-failure control passed both before and after. After the
change, 159 tests pass across `grill_me_processor_test.ts`,
`grill_me_processor_escalation_test.ts`, `grill_me_run_stats_test.ts` and
`grill_me_processor_graft_codegraph_2561_test.ts`. `deno check`, `deno lint`
and `markdownlint-cli2` are clean.

## Test Plan

- `processGrillMe - a provider refusal posts no failure marker, so it cannot
  build a streak (Issue #4035)`: `model-unavailable` and `quota-exhausted`
  post no marker, add no `needs-human`, and release the claim.
- `processGrillMe - a provider refusal after one real failure does not
  escalate (Issue #4035)`: composition through `countConsecutiveFailures`;
  the streak stays at one.
- `processGrillMe - a task failure still posts the failure marker (Issue
  #4035)`: the control direction.
