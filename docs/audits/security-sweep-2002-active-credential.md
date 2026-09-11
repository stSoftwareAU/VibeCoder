# Security sweep — the active credential label

**Issue:** [#2002](https://github.com/stSoftwareAU/VibeCoder/issues/2002)
(chunk 12ah) · **Parent:** #1209

The written record for the one module that entered `worker/deno/lib/` with
credential-scoped usage signals:

- `worker/deno/lib/active_credential.ts` — the label of the credential this
  run exported, per provider, so a usage signal can name the subscription that
  ran out.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record. This module is
claimed by **12ah**, and this file is the reading of it.

## `worker/deno/lib/active_credential.ts`

Eighty lines holding one `Map<string, string>` and three functions over it.
It has no imports and makes no `Deno.*` call of any kind — verified with
`grep -n "Deno\.\|import" worker/deno/lib/active_credential.ts`, which returns
nothing.

| Property | Result |
| -------- | ------ |
| no spawn, argv, filesystem, network or `gh` | no imports and no `Deno.*` — every input is a parameter |
| no secret is stored or logged | only the token file's **stem** (`provider-2`) is held. The token value is never passed in, so it cannot reach the map, a signal file, a log line or an error message — the same identify-by-label rule `claude_token_selection.ts` and `claude_credential_pool.ts` already follow |
| no regex, so no catastrophic backtracking | the only string work is `trim()` |
| an empty or blank label cannot be recorded | `recordActiveCredentialLabel` refuses a blank provider or label rather than storing one, so `usageSignalScope` never emits `credentialLabel: ""` for a reader to misread as "some credential" |
| an unrecorded label degrades to today's behaviour | `activeCredentialLabel` returns `undefined`, and every consumer (the pre-flight, the host pause, the pool filter, the restart question) treats that as the legacy host-wide signal — so a fault here can only restore the old behaviour, never widen it |
| the label's provenance is operator-provisioned | labels are file stems discovered under the 0700 credential directory that `setup.sh` provisions and the container mounts read-only. They are not attacker-supplied, and the one place they reach a log is the pool's exclusion line, beside the labels selection already logs |

### Process-wide state

The map is a module-level singleton, which the standards call out as a shape
to justify rather than reach for. It is justified here: what it describes —
which credential is in this process's environment — is itself process-wide,
set by `applyProviderCredentialEnv` and replaced by
`ClaudeCredentialPool.applySelection`, the same two places that write the
environment. It mirrors `setConfiguredAgentProviderId` in `agent_provider.ts`,
which records the process-wide provider the same way.

Residual risk: a test that records a label and does not clear it would leak
into a later test in the same worker. Both suites that write it clear it in a
`finally` (`tests/usage_signal_credential_scope_test.ts`,
`tests/claude_runner_usage_limit_test.ts`), and `clearActiveCredentialLabels`
exists for exactly that.

### Findings

None.
