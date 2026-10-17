## Summary

Document estimated API-equivalent cost, the lifecycle ledger, callback-field mapping, outcome states and gated success. Closes #3723. See [the shared delivery record](pr-summary-3721.md) for implementation and validation evidence.

## Spec

### Intent and Rationale

- Define observed-token estimates using the existing published pricing rows, excluding subscription fees, seat amortisation and billing.

### Essential Design Decisions

- Document current schema fields, unknown and partial estimates, reopen/reclose chronology, head-bound gates and callback telemetry boundaries.
- Keep credit logging (#3616), role configuration (#3643) and future randomisation/analysis (#3645) distinct from the ledger contract.

### Undiscoverable Facts

None.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The cost definition states that it excludes subscription fees, seat amortisation and billing. — evidence: `docs/MODEL-AND-CACHING.md::Estimated API-equivalent cost and lifecycle ledger` and `docs/CALLBACKS.md::Lifecycle ledger cross-reference` — reviewer: met
- **met** — Every outcome state and the success rule are documented. — evidence: `docs/MODEL-AND-CACHING.md::Lifecycle outcomes and gated success` lists all seven states and requires both head-bound gates strictly before merge — reviewer: met
- **met** — The documented field names match the ledger types from #3718. — evidence: the allowlist table in `docs/MODEL-AND-CACHING.md` matches assignment, invocation, model, follow-on, gate and outcome fields in `worker/deno/lib/lifecycle_ledger.ts`; callback mapping is in `docs/CALLBACKS.md` — reviewer: met
- **met** — Docs and markdown quality checks in `./quality.sh` pass. — evidence: Hosted `./quality.sh` passed on `e842eb79adaf80084acc655af49c7d1064cd7a31` ([job evidence](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39024074189/job/117371486628)); parallel unit tests passed in 11m14s and serial unit tests passed in 3m01s. Semgrep checked 19 changed files; type checking, lint, formatting, Markdown, Mermaid and ruleset checks passed. Configuration integration was skipped because no `.config.json` exists, and the gate reported PASSED (with skipped checks) — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — KISS/DRY and the review-enforced over-engineering checks: no standard-library reinvention, unnecessary dependency, single-implementation abstraction or duplicated in-repo policy; the observer reuses the existing CI decision, ledger validation, event keys and maintenance hooks.
- **clean** — Fail-loud handling, allowlisted ledger data, old cache compatibility, deterministic deduplication, explicit unknown cost bounds, Australian English and scope discipline checked. Reopen/reclose, stale cached OPEN, current-head and late-quality observations have regression coverage.
- **clean** — Tests exercise public behaviour. Fifty-one unique runtime branch mutants were killed with named failing tests matching the facts file. The sole existing expected-object change adds the carried body while retaining every previous field; removing only body copying made the existing named test fail. No assertion coverage was discarded.
- **clean** — The complete hosted `./quality.sh` passed before PR creation; the reviewed implementation has no remaining production or documentation correctness finding. Final archive-only evidence changes are checked separately with the summary checker and Markdown rules.

## Evidence

`docs/MODEL-AND-CACHING.md` covers all seven classifier states and the pre-merge quality/approval success rule, with the schema-1 allowlist checked against `lifecycle_ledger.ts`. `docs/CALLBACKS.md` maps existing callback fields to ledger fields. This issue changes documentation and has no UI screenshot surface.

Docs sweep — grep: "reconcileLifecycleEvents", "censored_at_cutoff"; updated `docs/MODEL-AND-CACHING.md` and `docs/CALLBACKS.md`; section: Token Usage & Cost Tracking, Model Pricing and What a hook receives; siblings: "readLifecycleLedger" and "appendLifecycleEvent" share the documented schema-1 contract.

## Test Plan

Provider-applicability registration for both new documentation headings passes the four existing `docs_provider_matrix_test.ts` tests; the final Markdown check reports zero errors.

The complete hosted `./quality.sh` passed before PR creation, including Markdown structure and Mermaid checks; the exact tested commit and job are recorded above and in [pr-summary-3721.md](pr-summary-3721.md). No runtime tests are added for this documentation-only sub-issue.

<!-- vibe-branch-outcomes -->
