# Security sweep — the provider billing classifier (`provider_billing.ts`)

**Issue:** [#1923](https://github.com/stSoftwareAU/VibeCoder/issues/1923) (chunk
top-up-1923) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #1923:

- `worker/deno/lib/provider_billing.ts` — added by #1923.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-1923**, and this file is the reading of it.

## `worker/deno/lib/provider_billing.ts`

One classifier answering "is this provider's credential a fixed-price
subscription or metered spend?" for every routing path. It reads the provider's
declared `AgentProviderBilling` capability off its descriptor, tests the
declared variables for a non-blank value, and — for a provider that keeps its
billing state outside the environment — calls that provider's own
`resolveStoredBilling` hook. Codex's hook is the only one today, and it reads
`$CODEX_HOME/auth.json` through the existing `resolveCodexAuthMode`.

Untrusted inputs, and how each reaches the output:

| Input                   | Source                                                 | How it is handled                                                                                                                               |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `providerId`            | `.config.json`, `agent_provider_fallback`, a repo pin  | used only as a `Map` key for descriptor lookup; an unregistered id returns `provider-not-registered` rather than throwing or matching by prefix |
| `context.env`           | the caller's injected lookup, never ambient by default | values are tested for non-blank length only; no value is parsed, compared or copied into the result                                             |
| `context.workDir`       | worker configuration                                   | passed through to the descriptor hook, which composes the Codex home path via the existing `resolveAgentStateDir`                               |
| `$CODEX_HOME/auth.json` | the Codex CLI's own persisted state                    | read by `resolveCodexAuthMode`, already swept under top-up-1697; only the presence/shape of fields is inspected, never a token value            |

| Property          | Result                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no spawn, no argv | the module spawns nothing and builds no argv                                                                                                                                                                                                                                                                                                                         |
| filesystem        | no direct access; the one read is the Codex auth-mode probe reached through the descriptor hook, which is bounded to a single JSON file and already swept                                                                                                                                                                                                            |
| injection         | every string that reaches the result is a provider id, a declared variable **name** or a fixed reason code — no free-form text and no shell surface                                                                                                                                                                                                                  |
| secret surface    | `reason` carries a variable NAME (`ANTHROPIC_API_KEY`) or a state label (`codex-chatgpt-login`), never a value; `provider_billing_test.ts` asserts a token placed in the environment does not appear anywhere in the serialised evidence                                                                                                                             |
| resource bounds   | linear in the number of declared variables per provider — a fixed, small list; no input-proportional allocation                                                                                                                                                                                                                                                      |
| fail direction    | fail-closed by construction: an unregistered provider, a blank credential and a probe that proves nothing all return `unknown`, and `isFixedPriceSubscription` answers true only for a positively proved subscription, so no failure path can report metered or unknown billing as fixed-price                                                                       |
| fault visibility  | a probe that _looked and failed_ — an unreadable or malformed `auth.json` — returns `unknown` carrying its own reason (`codex-auth-json-unreadable (…)`) rather than the `subscription-credential-missing` label a never-configured host produces, and does not short-circuit the declared metered variables, so a key that will actually be spent is still reported |
| observability     | the evidence is designed to be logged unattended — the health-gate fallback prints `billing=<mode> (<reason>)` on a provider switch                                                                                                                                                                                                                                  |

No finding. The one deliberate trust decision is that a provider's own
`resolveStoredBilling` hook is believed about its vendor: the classifier does
not second-guess `resolveCodexAuthMode`'s precedence rule (an environment API
key beats a persisted ChatGPT login, exactly as the CLI resolves it), because
duplicating that precedence here is how the two would drift apart and report a
subscription the run will not actually use.

The classification is deliberately tied to how the child environment is actually
built. `buildIsolatedCodexChildEnv` withholds `OPENAI_API_KEY` and
`CODEX_API_KEY` whenever an explicit `CODEX_HOME` is selected, so the probe
ignores the environment in exactly that case and consults `auth.json` alone;
without an explicit `CODEX_HOME` the keys do reach the child and keep their
precedence here. Reporting a mode the run will not spend is the failure this
alignment removes — in the unsafe direction it would under-report metered spend,
and in the safe direction it raised a false alarm on every legitimate
subscription fallback.
