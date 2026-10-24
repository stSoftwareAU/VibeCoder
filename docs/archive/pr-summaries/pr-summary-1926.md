## Summary

Automatic routing now prefers the fixed subscription with more remaining
capacity in its most constrained current window. Reset speed only breaks ties.
Codex gets a fresh, read-only account quota probe and automatic issue runs use
its own manager, executor and reviewer models through the external orchestrator.

Closes #1926 (owner-requested follow-up correction).

## Spec

### Intent and Rationale

- The owner requested that Codex win when it has more remaining quota and Claude
  win when it has more, including the selected provider's associated models.
- Passive Codex rollout evidence could become stale while Claude remained fresh;
  a free account read removes that asymmetry without spending a model turn.

### Essential Design Decisions

- Compare each provider's lowest current remaining percentage. Preserve billing
  exclusions, freshness bands, explicit pins and deterministic tie-breakers.
- Use the documented App Server account request and the existing Codex parser.
  Strip API keys and other credentials; bound time and output; clean up the child.
- Cache successful observations per subscription home. A failed probe retains the
  passive snapshot's original timestamp rather than presenting it as fresh.
- Both issue entry paths share one orchestration resolver. Automatic Codex runs
  use provider-local role defaults; explicit role pins and allocation assignments
  retain precedence. Existing model-only settings retain their Claude meaning.

### Undiscoverable Facts

- The owner's host configuration opts into automatic provider selection. This PR
  changes the implementation; it does not install or log in a subscription.
- Live host renewal, model availability and sandbox validation remain tracked by
  Issue #4166; the protocol tests here use a deterministic simulated peer.

## Evidence

- Ranking regressions failed before the correction in both directions: 80%
  remaining lost to 35% because the smaller allowance reset sooner. They pass now.
- The camelCase App Server fixture failed against the rollout-only parser before
  the change. The live protocol tests failed against an unknown-only probe stub.
- 143 focused tests passed across quota, runtime, state, parsing, role settings,
  both issue entry paths and the orchestrator gate. Completeness checks passed
  805 tests, with one ignored. Deno lint, formatting and Markdown lint pass.
- The tests also found and fixed a cache-key mismatch: Codex looked up by home but
  recorded the status under `active`. Each home now owns its own status cache.

**Docs sweep** — grep: `account/getRateLimits`, `remaining percentage`, `automatic routing`, `Codex`; section: `docs/PROVIDER-PARITY.md` (Provider selection), `docs/CODEX-BUDGET-SOURCES.md` (The verified sources); siblings: `primary`, `secondary`, `used_percent`, `window_minutes`, `resets_at` parser fields checked against their camelCase forms; updated: both operator manuals and source documentation. Historical Claude credential-pool remaining-per-hour rules remain true within that provider; this change concerns cross-provider selection.

## Test Plan

- `worker/deno/tests/provider_auto_selection_test.ts`: capacity comparisons in
  both directions, constrained windows, missing resets, expired windows, billing,
  staleness and tie-breaks. The old rate-order assertion is replaced to implement
  the owner's explicitly changed selection rule.
- `worker/deno/tests/provider_auto_runtime_test.ts`: fresh Codex quota with no
  previous model run, caching, API-key exclusion and existing pin/outage behaviour.
- `worker/deno/tests/codex_budget_source_test.ts` and
  `worker/deno/tests/codex_quota_isolation_test.ts`: current response fields, bucket
  selection, credential stripping, exhaustion, timeout/RPC/size failures and cleanup.
- Role configuration, external phase, assignment and executor-split suites verify
  both issue entry paths and retain the existing Claude and explicit-role cases.
- `worker/deno/tests/orchestration_3642_gate_test.ts` retains the existing dispatch,
  billing, retry and bounds checks. No UI or persisted schema changes.

**Branch outcomes:**

- `worker/deno/lib/provider_auto_selection.ts:111` — Claude has more remaining capacity — test `worker/deno/tests/provider_auto_selection_test.ts` (`auto selector prefers more remaining capacity regardless of reset speed`) — flip: before the fix it selected Codex at 35% instead of Claude at 80%.
- `worker/deno/lib/provider_auto_selection.ts:111` — Codex has more remaining capacity — test `worker/deno/tests/provider_auto_selection_test.ts` (`auto selector also prefers Codex when it has more remaining capacity`) — flip: before the fix it selected Claude at 35% instead of Codex at 80%.
- `worker/deno/lib/codex_quota.ts:200` — quota read succeeds — test `worker/deno/tests/codex_quota_isolation_test.ts` (`Codex live quota reads the codex bucket, strips credentials and cleans up its child`) — flip: the initial unknown-only stub failed the known-budget assertion.
- `worker/deno/lib/codex_quota.ts:200` — quota read cannot complete safely — test `worker/deno/tests/codex_quota_isolation_test.ts` (`Codex live quota errors, timeouts and oversized responses remain unknown and close the child`) — flip: the initial stub failed the child-cleanup assertion.

## Merge verification

Required CI and independent review are pending. Not checked: live subscription
renewal, live model availability or deployed fleet behaviour (Issue #4166).
