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

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Each fixture reconciles to a hand-computed expected total, by role and overall. — evidence: `worker/deno/tests/fixtures/lifecycle/scenarios.ts` defines six literal expected totals and role breakdowns, asserted by `worker/deno/tests/lifecycle_reconcile_test.ts` — reviewer: met
- **met** — The restart fixture's duplicated events are counted once. — evidence: `worker/deno/tests/lifecycle_reconcile_test.ts::lifecycle reconciliation fixture: restart` — reviewer: met
- **met** — Spend from a failed attempt and a timed-out attempt is included in the cohort total and in wasted spend. — evidence: `worker/deno/tests/lifecycle_reconcile_test.ts::lifecycle reconciliation fixture: failure` and `lifecycle reconciliation fixture: retry` assert total and wasted values for both results — reviewer: met
- **met** — Unknown usage or pricing appears as a non-zero unknown count with `partial: true`, never as 0 USD. — evidence: `worker/deno/tests/lifecycle_reconcile_test.ts::lifecycle reconciliation retains unknown usage and pricing as a partial estimate` and `lifecycle reconciliation preserves the priced part of split-model usage` — reviewer: met
- **met** — Tests and `./quality.sh` pass. — evidence: Hosted `./quality.sh` passed on `e842eb79adaf80084acc655af49c7d1064cd7a31` ([job evidence](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39024074189/job/117371486628)); parallel unit tests passed in 11m14s and serial unit tests passed in 3m01s. Semgrep checked 19 changed files; type checking, lint, formatting, Markdown, Mermaid and ruleset checks passed. Configuration integration was skipped because no `.config.json` exists, and the gate reported PASSED (with skipped checks) — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — KISS/DRY and the review-enforced over-engineering checks: no standard-library reinvention, unnecessary dependency, single-implementation abstraction or duplicated in-repo policy; the observer reuses the existing CI decision, ledger validation, event keys and maintenance hooks.
- **clean** — Fail-loud handling, allowlisted ledger data, old cache compatibility, deterministic deduplication, explicit unknown cost bounds, Australian English and scope discipline checked. Reopen/reclose, stale cached OPEN, current-head and late-quality observations have regression coverage.
- **clean** — Tests exercise public behaviour. Fifty-one unique runtime branch mutants were killed with named failing tests matching the facts file. The sole existing expected-object change adds the carried body while retaining every previous field; removing only body copying made the existing named test fail. No assertion coverage was discarded.
- **clean** — The complete hosted `./quality.sh` passed before PR creation; the reviewed implementation has no remaining production or documentation correctness finding. Final archive-only evidence changes are checked separately with the summary checker and Markdown rules.

## Evidence

The six fixtures in `worker/deno/tests/fixtures/lifecycle/scenarios.ts` assert hand-computed totals and roles for success, multiple PRs, failure, retry, cutoff and replay. `lifecycle_reconcile_test.ts` adds partial estimates, unknown counts, multiple files, cohort conflicts and attributed sibling waste. Shared validation and mutation evidence are in [pr-summary-3721.md](pr-summary-3721.md) and [its facts file](pr-summary-3721.facts.json).

Docs sweep — grep: "reconcileLifecycleEvents", "censored_at_cutoff"; updated `docs/MODEL-AND-CACHING.md` and `docs/CALLBACKS.md`; section: Token Usage & Cost Tracking and What a hook receives; siblings: "readLifecycleLedger" and "appendLifecycleEvent" retain the existing schema and deterministic identity contract.

## Test Plan

The shared frozen-lock integration run passed 220 tests. The complete hosted `./quality.sh` passed before PR creation; the exact tested commit and job are recorded above. Reconciler branch mutations are the subset below; the complete milestone record remains in the shared facts file.

<!-- vibe-branch-outcomes -->
