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
- Local shell network access is restricted. The exact pinned dependency cache was recovered from a successful GitHub run; focused tests use the repository's frozen lockfile. The complete official quality gate passed remotely before PR creation. The hosted runner installs the identical pinned Deno binary in `/usr/local/bin`, because an existing bootstrap command test replaces the process PATH with standard tool directories; no repository test harness was changed.
- Initial issue invocations have no PR attribution. When one sibling merges and another is abandoned, only the abandoned PR's explicitly attributed follow-on work can be assigned to its wasted-spend subtotal.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Each of the seven states has a table-driven test case. — evidence: `worker/deno/tests/lifecycle_outcomes_test.ts` table covers all seven states — reviewer: met
- **met** — A merge without a recorded green quality gate, or without an approval, classifies as `merged` with `success: false`. — evidence: `worker/deno/tests/lifecycle_outcomes_test.ts::lifecycle outcome requires both gates on the merged PR strictly before merge` — reviewer: met
- **met** — Work still open at the cutoff classifies as `censored_at_cutoff`, never as a failure. — evidence: `worker/deno/tests/lifecycle_outcomes_test.ts::lifecycle outcome: censored_at_cutoff` and `worker/deno/tests/lifecycle_reconcile_test.ts::lifecycle reconciliation fixture: open PR at cutoff` — reviewer: met
- **met** — A two-PR issue (one closed unmerged, one merged after gates) classifies as success. — evidence: `worker/deno/tests/lifecycle_outcomes_test.ts::lifecycle outcome keeps each PR and chooses the gated merge` — reviewer: met
- **met** — Tests and `./quality.sh` pass. — evidence: Hosted `./quality.sh` passed on `e842eb79adaf80084acc655af49c7d1064cd7a31` ([job evidence](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39024074189/job/117371486628)); parallel unit tests passed in 11m14s and serial unit tests passed in 3m01s. Semgrep checked 19 changed files; type checking, lint, formatting, Markdown, Mermaid and ruleset checks passed. Configuration integration was skipped because no `.config.json` exists, and the gate reported PASSED (with skipped checks) — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — KISS/DRY and the review-enforced over-engineering checks: no standard-library reinvention, unnecessary dependency, single-implementation abstraction or duplicated in-repo policy; the observer reuses the existing CI decision, ledger validation, event keys and maintenance hooks.
- **clean** — Fail-loud handling, allowlisted ledger data, old cache compatibility, deterministic deduplication, explicit unknown cost bounds, Australian English and scope discipline checked. Reopen/reclose, stale cached OPEN, current-head and late-quality observations have regression coverage.
- **clean** — Tests exercise public behaviour. Fifty-one unique runtime branch mutants were killed with named failing tests matching the facts file. The sole existing expected-object change adds the carried body while retaining every previous field; removing only body copying made the existing named test fail. No assertion coverage was discarded.
- **clean** — The complete hosted `./quality.sh` passed before PR creation; the reviewed implementation has no remaining production or documentation correctness finding. Final archive-only evidence changes are checked separately with the summary checker and Markdown rules.

## Evidence

- Deterministic fixtures cover success, multiple PRs, failure, retry, cutoff and restart, with hand-computed totals and role breakdowns.
- Regression tests cover changed heads, stale cached OPEN listings, reopen/reclose chronology, late quality observations, terminal replay, missing metadata and unknown cost bounds.
- No UI is changed; screenshots are not applicable.

Docs sweep — grep: "reconcileLifecycleEvents", "censored_at_cutoff"; updated `docs/MODEL-AND-CACHING.md` and `docs/CALLBACKS.md`; section: Token Usage & Cost Tracking, Model Pricing, What a hook receives; siblings: "readLifecycleLedger" and "appendLifecycleEvent" in the existing lifecycle ledger and its callers. The new APIs share schema validation and event keys with those readers and writers.

## Test Plan

Provider-applicability registration for both new documentation headings passes the four existing `docs_provider_matrix_test.ts` tests; the final Markdown check reports zero errors.

- Frozen-lock lifecycle, bot lookup, merged-branch telemetry, branch cleanup, check-run batching and issue-query suites: 220 passed.
- `deno task check:manifests`: 687 passed, one ignored; scoped lint and formatting passed.
- Hosted `./quality.sh` passed on `e842eb79adaf80084acc655af49c7d1064cd7a31` ([job evidence](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39024074189/job/117371486628)); parallel unit tests passed in 11m14s and serial unit tests passed in 3m01s. Semgrep checked 19 changed files; type checking, lint, formatting, Markdown, Mermaid and ruleset checks passed. Configuration integration was skipped because no `.config.json` exists, and the gate reported PASSED (with skipped checks). The subsequent archive-only evidence update is checked with the issue-aware summary checker and Markdown rules.
- Fifty-one targeted branch mutations in an isolated copy went red. Baseline tests type-check against the frozen lockfile; intentional runtime flips use `--no-check` so a changed narrowing condition is tested rather than counted as a compiler failure. Each flip was restored; the named failing tests are recorded below.
- Existing assertion change: `pr_bot_lookup_test.ts::listBotPrs - carries the maintenance PrEntry fields through` now also expects `body: ""`, because the maintenance observer needs the known markerless body to avoid a snapshot read. Every prior field remains asserted. Disabling only the body copy made this existing test fail; restoring it returned the test to green.
- Public analysis APIs are explicitly required by #3721 and #3722; they do not need an artificial runtime caller.

<!-- vibe-branch-outcomes -->
