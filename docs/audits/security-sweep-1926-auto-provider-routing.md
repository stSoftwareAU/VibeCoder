# Security sweep — automatic provider routing

**Issue:** [#1926](https://github.com/stSoftwareAU/VibeCoder/issues/1926)
(chunk 12aa) · **Parent:** #1694

This is the written record for the three modules that entered
`worker/deno/lib/` after chunks 12a–12z recorded their coverage:

- `worker/deno/lib/provider_auto_selection.ts`
- `worker/deno/lib/provider_auto_runtime.ts`
- `worker/deno/lib/provider_auto_state.ts`

## Why a new slice

The modules did not exist when earlier slices were swept. Adding their paths to
an older record would claim a review that could not have happened; chunk
**12aa** records the code read at commit
`acaba2ae8675ed02a00cd2c50875e1f820736faf`.

## `provider_auto_selection.ts`

Pure ranking over the provider-neutral subscription-status contract. It has no
filesystem, environment, network or process access. Billing eligibility is
fail-closed: only the exact `fixed-subscription` value can win, while `metered`
and `unknown` are excluded before quota ranking. Non-finite clock, reset and
quota values cannot create an eligible score. The formatted decision contains
provider/credential labels, policy state, numeric score and reset epoch only;
it never accepts credential values or raw provider output.

No findings.

## `provider_auto_runtime.ts`

This is the I/O boundary. It reads the existing config path and named
credential environment variables, asks the already-swept Claude/Codex budget
adapters for normalised status, and changes only the process-wide default
provider between work items.

| Boundary | Result |
| -------- | ------ |
| opt-in | absent config and absent/`pinned` mode perform no status probes and preserve historical routing |
| config failure | malformed or unreadable config fails closed; only `NotFound` is the legitimate optional-file case |
| explicit selection | per-invocation provider selection bypasses the mutable default; an environment pin must already be in the enabled/mounted set |
| billing | Claude API keys are `metered`; ambiguous bearer tokens and missing credentials are `unknown`; Codex API-key-only or missing-home states cannot win |
| authentication | authoritative 401/403 or auth-rejection status is unavailable, never unknown quota |
| provider faults | rejected/thrown status probes become unavailable `unknown` billing and the error text is discarded rather than logged |
| shared signals | GitHub remains host-wide; usage signals affect only their named provider (legacy unnamed usage remains Claude) |
| filesystem | the only write is the existing provider-aware health-cache invalidation after a switch; no provider controls the path |
| process/network | no command is spawned; network access remains inside the existing subscription-status adapters |

No findings.

## `provider_auto_state.ts`

Process-local memory stores only a trimmed provider id, the two allowed outage
categories, observation time and optional quota retry time. It stores no
credential, output or exception text. Recording is inert unless auto routing
has explicitly been activated. Disabling auto clears the map; authentication
state lasts only for the worker process, and quota state expires at the
provider's reset or a bounded five-minute recheck cooldown.

No findings.

## Accepted residuals

- Codex quota evidence is a local rollout snapshot rather than a free live
  endpoint. A new fixed-subscription login can therefore enter the
  fixed-subscription/unknown-quota last-resort band until its first snapshot;
  this is explicit uncertainty, not fabricated capacity.
- Authentication outage memory is process-local. A fresh process rechecks the
  credential, which permits operator repair without a separate state-clearing
  command while a bad credential is still suppressed for all subsequent work
  in the current process.
- Quota exhaustion without a stated reset is rechecked after five minutes.
  This bounds repeated refusals without inventing a billing-window timestamp.
