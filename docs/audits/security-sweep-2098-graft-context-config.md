# 🔎 Security sweep — the `graft_context` host switch (`graft_context_config.ts`)

**Issue:** [#2098](https://github.com/stSoftwareAU/VibeCoder/issues/2098) (chunk
top-up-2098) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2098:

- `worker/deno/lib/graft_context_config.ts` — added by #2098.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2098**, and this file is the reading of it.

## `worker/deno/lib/graft_context_config.ts`

A pure validator. It turns the untrusted `graft_context` block of the host
`.config.json` into `{ enabled: boolean }`, and nothing else. It spawns no
process, opens no file, makes no network call, holds no state between calls, and
owns no credential.

Untrusted inputs, and how each reaches the output:

| Input                    | Source                                              | How it is handled                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the block itself         | the host's own `.config.json`, read by `loadConfig` | type-tested (`typeof raw !== "object"`, `Array.isArray`) before any property is read; a non-object is refused by message, never coerced                                                             |
| `enabled`                | same file                                           | accepted only when `typeof === "boolean"`; every other value fails the config load naming `graft_context.enabled`                                                                                   |
| unrecognised nested keys | same file                                           | listed by `detectUnknownNestedKeys` and warned about through an injectable sink; they change no behaviour, so they are ignored rather than fatal — the same treatment an unknown top-level key gets |

| Property          | Result                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| no spawn, no argv | the module spawns nothing and builds no argv                                                                                                                                                                                                                                                                                               |
| regex safety      | no regex. The suggestion path it calls (`suggestKeyFrom` in `config_unknown_keys.ts`) is bounded Levenshtein over a one-entry key set, O(len × 1) per stray key                                                                                                                                                                            |
| filesystem        | none                                                                                                                                                                                                                                                                                                                                       |
| network           | none                                                                                                                                                                                                                                                                                                                                       |
| injection         | the only strings it produces are fixed sentences plus a `JSON.stringify` of the offending value; nothing reaches a shell, an argv or a URL. `show()` stringifies rather than concatenating raw objects, so an operator value cannot forge message structure beyond its own JSON quoting                                                    |
| secret surface    | it emits no credential. A malformed value is echoed into the error message, so an operator who pasted a secret into `graft_context.enabled` would see it in that message — the same exposure `parseCallbacksConfig` already has for `callbacks`, and the block holds one boolean by design, with no key that would ever carry a credential |
| resource bounds   | O(number of keys in the block) — one `Object.keys` pass. The block is one operator-written object; no unbounded input reaches it                                                                                                                                                                                                           |
| fail direction    | fail-loud. `assertGraftContextConfig` throws at config load, so a host whose operator wrote `"enabled": "yes"` stops with the key named rather than silently running with Graft off. Absence — and only absence — is the documented off default, never a repaired fault                                                                    |
| blast radius      | the value governs one boolean on `WorkerConfig`. Nothing in the tree reads it yet; the build and injection it will govern land with the rest of #2060                                                                                                                                                                                      |

No finding. The one deliberate asymmetry is that unknown nested keys warn while
a malformed `enabled` throws: a stray key cannot make the worker behave
differently from what the operator sees, and a mistyped switch can.
