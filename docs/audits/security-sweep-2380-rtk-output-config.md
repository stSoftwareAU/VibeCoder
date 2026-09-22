# Security sweep — the RTK output switch (`rtk_output_config.ts`)

**Issue:** [#2380](https://github.com/stSoftwareAU/VibeCoder/issues/2380) (chunk
top-up-2380) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2380:

- `worker/deno/lib/rtk_output_config.ts` — added by #2380.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2380**, and this file is the reading of it.

## `worker/deno/lib/rtk_output_config.ts`

A pure parser: it turns the raw `.config.json` `rtk_output` block into
`{ enabled: boolean }`, or returns the fault as a string the config load throws.
It spawns nothing, reads no file, opens no socket and holds no credential.

Untrusted inputs, and how each reaches the output:

| Input                     | Source                                                | How it is handled                                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the `rtk_output` block    | operator-supplied JSON, already parsed by `config.ts` | typed `unknown` and narrowed here. A non-object block, and a non-boolean `enabled`, are each refused with an error naming `rtk_output.enabled`; only `undefined` (the key absent) reads as the default |
| the rejected value's type | the same block                                        | reported as its JSON type name only (`string`, `number`, `array`, `null`) — never the value itself, so nothing from the config is echoed into the error text                                           |

| Property                       | Result                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no shell, no argv construction | none — the module spawns nothing                                                                                                                                                                                           |
| environment                    | reads none                                                                                                                                                                                                                 |
| filesystem                     | reads and writes none                                                                                                                                                                                                      |
| network                        | none                                                                                                                                                                                                                       |
| regex safety                   | no regex used                                                                                                                                                                                                              |
| secret surface                 | the only value read is a boolean; no config value is echoed into an error or a log                                                                                                                                         |
| resource bounds                | one property read on an already-parsed object; no recursion, no loop over untrusted input                                                                                                                                  |
| fail direction                 | fail-loud: a malformed block is refused with the offending field named, never repaired and never read as "off". An unknown key _inside_ the block is a warning (`config_unknown_keys.ts`), because it changes no behaviour |

No finding. The one deliberate decision is that an explicit `null` block is
refused rather than treated as absent: a host that wrote the key out asked for
something, and reading that as "off" is the silent failure this switch must not
have — the more so here, where the switch decides whether a third-party binary
is placed in front of every Bash command the agent runs.
