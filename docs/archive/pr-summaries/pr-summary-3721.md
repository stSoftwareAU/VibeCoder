## Summary

Classify lifecycle outcomes per assignment and PR, reconcile estimated API-equivalent cost across host ledgers, and record PR observations during maintenance. Success requires a merge with passing quality and review observations on the merged head before the merge. Replayed events are counted once; unknown usage and pricing remain explicit partial estimates.

Closes #3721. Closes #3722. Closes #3723.

## Spec

### Intent and Rationale

- Make lifecycle success and costs reproducible from the append-only schema-1 ledger, retaining abandoned sibling PRs and censored work.
- Explain the estimate as published API-equivalent token pricing, excluding subscription fees, seat amortisation and billing.

### Essential Design Decisions

- Keep outcome classification and reconciliation pure. File reconciliation reads caller-supplied host paths; corrupt input remains an error.
- Preserve existing event keys. Timestamped `pr_open` gate observations represent reopen/reclose cycles. Gates bind to a PR head, and quality uses its own observation time.
- Reuse maintenance listings and check batches. Cached OPEN listings emit no new facts; markerless rows and already-recorded terminal observations avoid per-PR snapshot reads.
- Retain priced model subtotals and unknown counters. Follow-on records lack model-role detail and use an explicit unattributed role; their process run ID is not a deduplication key.

### Undiscoverable Facts

- Milestone 105's ledger foundation is already merged into main at `6effe8f3b2e261c89a22a2ea10e25c88c911ba00`.
- Local shell network access is restricted. The exact pinned dependency cache was recovered from a successful GitHub run; focused tests use the repository's frozen lockfile. The complete official quality gate is run remotely before PR creation.
- Initial issue invocations have no PR attribution. When one sibling merges and another is abandoned, only the abandoned PR's explicitly attributed follow-on work can be assigned to its wasted-spend subtotal.

## Evidence

- Deterministic fixtures cover success, multiple PRs, failure, retry, cutoff and restart, with hand-computed totals and role breakdowns.
- Regression tests cover changed heads, stale cached OPEN listings, reopen/reclose chronology, late quality observations, terminal replay, missing metadata and unknown cost bounds.
- No UI is changed; screenshots are not applicable.

Docs sweep — grep: "reconcileLifecycleEvents", "censored_at_cutoff"; updated `docs/MODEL-AND-CACHING.md` and `docs/CALLBACKS.md`; section: Token Usage & Cost Tracking, Model Pricing, What a hook receives; siblings: "readLifecycleLedger" and "appendLifecycleEvent" in the existing lifecycle ledger and its callers. The new APIs share schema validation and event keys with those readers and writers.

## Test Plan

- Frozen-lock lifecycle, bot lookup, merged-branch telemetry, branch cleanup, check-run batching and issue-query suites: 220 passed.
- `deno task check:manifests`: 687 passed, one ignored; scoped lint and formatting passed. The official `./quality.sh` must pass before raising the PR.
- Fifty-one targeted branch mutations in an isolated copy went red. Baseline tests type-check against the frozen lockfile; intentional runtime flips use `--no-check` so a changed narrowing condition is tested rather than counted as a compiler failure. Each flip was restored; the named failing tests are recorded below.
- Public analysis APIs are explicitly required by #3721 and #3722; they do not need an artificial runtime caller.

<!-- vibe-branch-outcomes -->
