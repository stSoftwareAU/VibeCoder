# 🔎 Security sweep — the agent spawn quota gate (`claude_spawn_gate.ts`)

**Issue:** [#1669](https://github.com/stSoftwareAU/VibeCoder/issues/1669)
(chunk 12o) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
_after_ the chunk-12 slices (12a–12n) recorded their coverage:

- `worker/deno/lib/claude_spawn_gate.ts` — added by #1669.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure 12f's
own record documents. The module is claimed by **12o**, and this file is the
reading of it.

## `worker/deno/lib/claude_spawn_gate.ts`

The module is a thin seam between `claude_runner.ts` and the credential pool
(#1668, swept as 12k). It asks the pool how many candidates exist, asks it to
select an eligible one, applies that selection to the run environment through
an injected `setEnv`, and records a usage-limit exhaustion against the
credential the run is carrying. It holds a module-level default gate instance
installed once by `createDefaultRunWorkerDeps`.

Shapes checked (12e's — a closing-pass module whose only sink is the run
environment):

| Property | Result |
| -------- | ------ |
| token values never reach a log | ✅ every line it logs is built from a **label** (`provider`, `provider-2`) and fixed prose. The one value it handles is passed straight to `setEnv` by `pool.applySelection`, which the pool's own sweep covers; nothing in this module reads, slices or formats a token value |
| exactly one credential in the environment | ✅ the switch goes through `ClaudeCredentialPool.applySelection`, which sets one variable and refuses a file carrying two credentials. This module adds no second write path |
| another vendor cannot be switched by this pool | ✅ `ours(providerId)` compares the invocation's provider against `pool.providerId()`; a non-matching spawn is answered `"no-pool"`, so a Codex run is neither refused because Claude's windows are spent nor handed a Claude token |
| a wrong credential cannot be marked spent | ✅ `recordUsageLimit` records only against `pool.activeLabel()` — the label the run environment's value actually matches — and when nothing matches it records nothing and says so on the log |
| no I/O of its own | ✅ no filesystem, no subprocess, no network. It reads the credential directory only indirectly, through the pool's cached discovery |
| a refusal fails loud | ✅ `"none-eligible"` is a distinct verdict the runner turns into a terminal exit-2 result carrying `noEligibleCredential`, plus a `NO_ELIGIBLE_CREDENTIAL` security-log line — never a silent skip and never a success |
| no argv / shell | ✅ none |
| blast radius of a wrong verdict | ✅ a wrong `"no-pool"` spawns on the credential already exported (today's behaviour); a wrong `"none-eligible"` refuses one call and the dispatch loop moves to the next priority. Neither writes a durable signal, so neither can idle the host |

No findings. The accepted residual: the process-wide default gate is settable
by any code in the process (`setDefaultClaudeSpawnGate`), so a caller could
install a gate that always answers `"no-pool"`. That is the same trust
boundary as the pool instance it wraps, and both are constructed in one place
at worker start.
