# Security sweep — shared provider quota scheduler

**Issue:** [#1696](https://github.com/stSoftwareAU/VibeCoder/issues/1696)
(chunk 12o) · **Parent:** #1694

The written record for the modules that entered `worker/deno/lib/`
after 12n recorded its coverage:

- `worker/deno/lib/provider_quota.ts`
- `worker/deno/lib/provider_quota_scope.ts`
- `worker/deno/lib/provider_quota_scheduler.ts`
- `worker/deno/lib/provider_fallback_policy.ts`
- `worker/deno/lib/codex_quota.ts`

## Why a new slice

Appending a module to a slice whose sweep ran before it existed is a
false record. These five are claimed by **12o**.

## `provider_quota.ts`

Pure ranking: remaining-fraction / hours-to-reset under a declared
policy. No I/O, no spawn, no environment. Inputs are provider id,
credential **label** and already-parsed windows. Unknown budgets stay
`{ known: false, reason }` — never zero. No token value is formatted.

No findings.

## `provider_quota_scope.ts`

Decides whether a rate-limit signal blocks one provider or the whole
host. GitHub is host-wide; usage is scoped. A legacy usage signal
without `provider` reads as Claude. Reads the existing signal file
only.

No findings.

## `provider_quota_scheduler.ts`

Thin wrapper: rank, log, return the eligible winner or null. Logging
uses labels only.

No findings.

## `provider_fallback_policy.ts`

Pure policy: pinned vs ordered, outage classes, bounded switches.
Refuses an alternative that is not in the enabled set. No I/O.

No findings.

## `codex_quota.ts`

Maps a Codex budget snapshot onto a shared candidate. No I/O; no
token is opened. API-key accounts stay unknown.

No findings.
