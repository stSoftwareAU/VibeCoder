# Security sweep — the subscription restart/soak status (`subscription_soak_status.ts`)

**Issue:** [#1927](https://github.com/stSoftwareAU/VibeCoder/issues/1927) (chunk
top-up-1927) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #1927:

- `worker/deno/lib/subscription_soak_status.ts` — added by #1927.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-1927**, and this file is the reading of it.

## `worker/deno/lib/subscription_soak_status.ts`

A pure observability function over the subscription-routing layer. It folds a
list of `ProviderSubscriptionStatus` records, the configured enabled-provider
set, per-provider auth evidence and an automatic-selection result into one
operator-facing `[soak]` summary line plus structured entries. It never reads a
credential, never spawns a process, and never touches the filesystem — every
input is passed in, so restart determinism is testable offline.

Untrusted inputs, and how each reaches the output:

| Input                | Source                       | How it is handled                                                                                                                                           |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `statuses`           | the quota/status probe layer | copied into entries verbatim (`billingMode`, `availability`, `confidence`, `windows`, `reason`) — never interpreted into a decision here                    |
| `enabledProviderIds` | the configured enabled set   | joined into `providers-enabled` and used to scope `auth-required`; not used to select a winner                                                              |
| `auths`              | the auth-mode resolver       | only the _kind_ and flags (`persistedDurably`, `refreshedAt`, `expiresAt`, `reason`) are folded in; the reason is a label, never a token                    |
| `selection`          | `selectAutomaticProvider`    | rendered as `chosen`/`reason`/`retryAt`; the billing guard cross-checks the winner against the same statuses, it does not trust the selection's self-report |

| Property          | Result                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no spawn, no argv | the module spawns nothing and writes nothing; it is a pure function                                                                                                                       |
| injection         | every string that reaches a log line is a provider id, a credential label, a reason code or a timestamp — no free-form shell text                                                         |
| secret surface    | `kind: "metered"` auth carries only `reason` (e.g. `OPENAI_API_KEY` as a _name_), never the value; `buildSubscriptionSoakStatus` has no parameter that accepts a secret                   |
| resource bounds   | linear in `statuses.length`; no allocation proportional to input size beyond the output entries                                                                                           |
| fail direction    | an unknown/missing status is rendered as `unknown`, never fabricated into zero or into `available`; the billing guard fails closed (`holds` only when the winner is a fixed subscription) |
| observability     | the summary line carries labels and reason codes, not credential material — the test suite asserts no `sk-…` token, `access_token`, `refresh_token` or `OPENAI_API_KEY` value appears     |

No finding. The one deliberate trust decision is that the summary line is a
label-only rendering: it trades rich diagnostic text for the guarantee that a
routing decision can be logged unattended without ever carrying a secret into a
log.
