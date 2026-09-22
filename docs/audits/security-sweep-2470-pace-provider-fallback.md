# 🔎 Security sweep — the pace-aware provider fallback (`pace_provider_fallback.ts`)

**Issue:** [#2470](https://github.com/stSoftwareAU/VibeCoder/issues/2470) (chunk
top-up-2470) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2470:

- `worker/deno/lib/pace_provider_fallback.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2470**, and this file is the reading of it.

## `worker/deno/lib/pace_provider_fallback.ts`

Two pure exports, no side effects, no permissions beyond what the caller already
holds. `paceFallbackProviderId` names the provider the paced backlog runs on —
the first alternative of an `ordered` fallback policy when the week-pace guard
is engaged, `null` otherwise (a pinned policy or an empty list names nothing,
and today's behaviour is unchanged). `paceTierDrop` decides whether the claim
scan drops the `low-priority` and `idle-task` tiers: true only while the guard
holds AND no fallback took the backlog. Both feed one adjusted verdict shared by
the claim scan, the census and the idle-hooks filer, so the three cannot
disagree about what is claimable.

| Input                                             | Decision             | Handling                                                                                                       |
| ------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| guard engaged, `ordered` policy with alternatives | first alternative id | the wiring switches the active provider (the health gate's Issue #2055 shape) and keeps the low tiers eligible |
| guard engaged, pinned policy or empty list        | `null`               | tiers drop exactly as before the change                                                                        |
| guard not engaged                                 | `null` / no drop     | the pre-#2470 path, untouched                                                                                  |

The caller owns every side effect — the provider switch, the billing
classification log — never this module. Its decisions are unit-tested in
`worker/deno/tests/pace_provider_fallback_test.ts`; the wiring
(`run_core_production_deps.ts`) is exercised by the existing scan, census and
filer suites.
