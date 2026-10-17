## Summary

Reconcile lifecycle-ledger events into assignment and cohort estimates, with role, attempt and follow-on breakdowns, wasted spend and explicit unknown counters. Closes #3722. The shared delivery record is [pr-summary-3721.md](pr-summary-3721.md).

## Spec

### Intent and Rationale

- Provide deterministic analysis of estimated API-equivalent cost across retries and PRs.

### Essential Design Decisions

- Deduplicate deterministic event keys across host files; preserve original cohorts and gated outcomes.
- Unknown-only estimates are `null`; priced partial subtotals remain lower bounds. Follow-on costs retain their PR and cycle, with an explicitly unattributed role.

### Undiscoverable Facts

- Initial invocations have no PR identity, so mixed successful/abandoned siblings permit waste attribution only for explicitly linked follow-on records.

## Evidence

The six fixtures in `worker/deno/tests/fixtures/lifecycle/scenarios.ts` assert hand-computed totals and roles for success, multiple PRs, failure, retry, cutoff and replay. `lifecycle_reconcile_test.ts` adds partial estimates, unknown counts, multiple files, cohort conflicts and attributed sibling waste. Shared validation and mutation evidence are in [pr-summary-3721.md](pr-summary-3721.md) and [its facts file](pr-summary-3721.facts.json).

Docs sweep — grep: "reconcileLifecycleEvents", "censored_at_cutoff"; updated `docs/MODEL-AND-CACHING.md` and `docs/CALLBACKS.md`; section: Token Usage & Cost Tracking and What a hook receives; siblings: "readLifecycleLedger" and "appendLifecycleEvent" retain the existing schema and deterministic identity contract.

## Test Plan

The shared frozen-lock integration run passed 220 tests. The official quality gate must pass before PR creation. Reconciler branch mutations are the subset below; the complete milestone record remains in the shared facts file.

<!-- vibe-branch-outcomes -->
