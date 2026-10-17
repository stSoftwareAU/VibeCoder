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

## Evidence

`docs/MODEL-AND-CACHING.md` covers all seven classifier states and the pre-merge quality/approval success rule, with the schema-1 allowlist checked against `lifecycle_ledger.ts`. `docs/CALLBACKS.md` maps existing callback fields to ledger fields. This issue changes documentation and has no UI screenshot surface.

Docs sweep — grep: "reconcileLifecycleEvents", "censored_at_cutoff"; updated `docs/MODEL-AND-CACHING.md` and `docs/CALLBACKS.md`; section: Token Usage & Cost Tracking, Model Pricing and What a hook receives; siblings: "readLifecycleLedger" and "appendLifecycleEvent" share the documented schema-1 contract.

## Test Plan

The initial local gate passed Markdown structure and Mermaid checks. Final official quality validation is recorded in [pr-summary-3721.md](pr-summary-3721.md) before PR creation; no runtime tests are added for this documentation-only sub-issue.

<!-- vibe-branch-outcomes -->
