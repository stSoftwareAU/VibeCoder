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
- **partial** — Docs and markdown quality checks in `./quality.sh` pass. — evidence: markdownlint checked 227 files with zero errors; formatting and 687 manifest tests passed — reviewer: partial — reason: The complete official quality gate is pending; these scoped checks do not establish its result.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — KISS/DRY and the review-enforced over-engineering checks: no standard-library reinvention, unnecessary dependency, single-implementation abstraction or duplicated in-repo policy; the observer reuses the existing CI decision, ledger validation, event keys and maintenance hooks.
- **clean** — Fail-loud handling, allowlisted ledger data, old cache compatibility, deterministic deduplication, explicit unknown cost bounds, Australian English and scope discipline checked. Reopen/reclose, stale cached OPEN, current-head and late-quality observations have regression coverage.
- **clean** — Tests exercise public behaviour. Fifty-one unique runtime branch mutants were killed with named failing tests matching the facts file. The sole existing expected-object change adds the carried body while retaining every previous field; removing only body copying made the existing named test fail. No assertion coverage was discarded.
- **clean** — Quality evidence is accurately limited to completed scoped checks; full `./quality.sh` remains outstanding before PR creation. No remaining production or documentation correctness finding.

## Evidence

`docs/MODEL-AND-CACHING.md` covers all seven classifier states and the pre-merge quality/approval success rule, with the schema-1 allowlist checked against `lifecycle_ledger.ts`. `docs/CALLBACKS.md` maps existing callback fields to ledger fields. This issue changes documentation and has no UI screenshot surface.

Docs sweep — grep: "reconcileLifecycleEvents", "censored_at_cutoff"; updated `docs/MODEL-AND-CACHING.md` and `docs/CALLBACKS.md`; section: Token Usage & Cost Tracking, Model Pricing and What a hook receives; siblings: "readLifecycleLedger" and "appendLifecycleEvent" share the documented schema-1 contract.

## Test Plan

Provider-applicability registration for both new documentation headings passes the four existing `docs_provider_matrix_test.ts` tests; the final Markdown check reports zero errors.

The initial local gate passed Markdown structure and Mermaid checks. Final official quality validation is recorded in [pr-summary-3721.md](pr-summary-3721.md) before PR creation; no runtime tests are added for this documentation-only sub-issue.

<!-- vibe-branch-outcomes -->
