## Summary

Closes #3646.

Add opt-in evidence-based issue allocation with fixed-subscription admission,
per-provider estimated API-equivalent budgets, host capacity/weights, durable
dry-run and restart state, bounded gradual changes, and persistent quality
rollback. Include the unmerged reporting foundation needed to consume the
existing lifecycle ledger; report mature merges against mature costs.

## Spec

### Intent and Rationale

- Optimise verified merged issues within existing subscription and fleet
  capacity, with no purchases, entitlement changes or metered API activation.
- Retain a randomised incumbent control and exploration while immature,
  incomplete, biased or uncertain evidence holds the current allocation.

### Essential Design Decisions

- Separate recommendations, estimated admission budgets and issue routing.
  Automatic routing requires explicit opt-in and a recorded preview.
- Use bounded independent host-day clusters and sequential error spending,
  mature cohorts, measured throughput/idle/quota evidence and latency guards.
  Declared independence and cost/cluster bounds are operator assumptions.
- State is versioned, locked and atomically saved in durable agent state.
  Policy/schema mismatches require an explicit reset, never silent migration.
- Preserve native Sonnet/Haiku control, existing issue discovery, review/CI
  and merge gates. Candidates use the role runner; no fallback to Fable.

### Undiscoverable Facts

- The owner clarified Sonnet/high plus Haiku as the incumbent, with Opus
  post-PR review; the issue's earlier Opus-manager wording is superseded.
- #3645 was cancelled without its reporting branch merging. Its read-only
  report, arm definitions and synthetic fixtures are included as prerequisites
  without reopening that ticket. Synthetic results are not live evidence.
- Local process-tree tests also fail on the base in this execution host;
  PR #4007 passed all CI including those suites on GitHub's runners.

## Evidence

- The full local gate passed completeness, type checking, lint and formatting;
  its parallel pass had 29,348 passes and two process-tree failures reproduced
  on the base. The serial pass did not run after that failure. A final focused
  run covers the timer, floor and configured-report refinements. Local
  markdownlint and semgrep are unavailable; required CI runs both.
- Deliberately disabling subscription admission, quality rollback and the
  control floor made their behavioural assertions fail. The floor check
  exposed a test that stopped too early; it now continues beyond saturation.
- The allocation simulation shows gradual shifts with preserved control and
  exploration floors; immature, missing-cost, uncertain, biased, capacity-limited
  and correlated-outage evidence cannot justify a shift.
- Runtime tests exercise real file-backed preview/apply/reset, corrupt-state
  refusal, refresh failure isolation and stable cohort attribution on retries.
- Main-loop tests observe native Sonnet/Haiku control, independent candidate
  role selections and pre-invocation admission refusal with declared categories.
- Report tests cover deduplication, future-event filtering, mature merge
  numerators, reconciled costs, failures, censoring and read-only command output.
- Docs sweep — grep: "subscription_allocation", "fleet-experiment-report"; updated `docs/CONFIGURATION.md`, `docs/SUBSCRIPTION-ALLOCATION.md`; section: CONFIGURATION issue execution settings and SUBSCRIPTION-ALLOCATION rollout/evidence/recovery; siblings: "external_orchestration", "issue_executor_split", "agent_providers" retain native defaults unless allocation is explicitly enabled.
- #3646: Introduce evidence-based subscription budget allocation with safety guardrails.
- #3645: Run randomized fleet experiments and report merged-issue efficiency.

## Test Plan

- `worker/deno/tests/subscription_allocation_3646_test.ts`: gradual simulation,
  floors, uncertainty, maturity, quality rollback/pause, cadence, subscription,
  quota, budgets, durable preview/apply, reset, refresh and retry attribution.
- `worker/deno/tests/subscription_allocation_phase_3646_test.ts`: production
  execute-phase integration for native control, candidate dispatch and refusal.
- `worker/deno/tests/fleet_experiment_report_test.ts`,
  `worker/deno/tests/fleet_experiment_arms_test.ts`,
  `worker/deno/tests/fleet_experiment_synthetic_test.ts` and
  `worker/deno/tests/fleet_experiment_report_command_test.ts`: report foundation
  and read-only/synthetic command behaviour.
- Replaced `assertEquals(commands.length, 154)` in
  `worker/deno/tests/mod_test.ts`. Required by: "Configurable per-provider estimated API-equivalent cost budgets and host/capacity limits". Replaced by: `assertEquals(commands.length, 156)` in the same test, accounting for the report and allocation commands; command-file registration and description assertions remain.
- Standalone role dispatch remains independent of allocation; the main-loop
  production seam is `resolveIssueAllocation` in `issue_worker_wiring.ts`.
  Terminal issue, closed-PR and scan callbacks call the guarded refresh helper;
  a one-minute timer continues during long work and stops on worker cleanup.
  The existing mock infrastructure returns no selection when allocation is off.

## Branch outcomes

- Preview-only, explicit opt-in, missing receipt, corrupt/old state and reset — `worker/deno/tests/subscription_allocation_3646_test.ts`.
- Sufficient separated evidence shifts gradually; low/immature/uncertain evidence holds — `worker/deno/tests/subscription_allocation_3646_test.ts`.
- Quality regression restores baseline and pauses through restart; unavailable subscriptions, quota and budgets prevent admission — `worker/deno/tests/subscription_allocation_3646_test.ts`.
- Native control, external candidate and declared refusal — `worker/deno/tests/subscription_allocation_phase_3646_test.ts`.
- Duplicate/future events and immature merges — `worker/deno/tests/fleet_experiment_report_test.ts`.

## Merge verification

Required CI is pending. The local gate result and host limitation are recorded
above; all implementation and operator documentation are complete.
No live subscription feasibility or performance advantage is claimed.
