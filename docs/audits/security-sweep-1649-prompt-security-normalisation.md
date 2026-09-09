# Security sweep — prompt security ignorables (`prompt_security_normalisation.ts`)

**Issue:** [#1649](https://github.com/stSoftwareAU/VibeCoder/issues/1649)
(chunk 12m) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12l) recorded their coverage:

- `worker/deno/lib/prompt_security_normalisation.ts` — added by #1649.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12m**, and this file is
the reading of it.

## `worker/deno/lib/prompt_security_normalisation.ts`

The module is a single pure function: walk a string by code point and drop
Unicode format / line / paragraph separators (`Cf`, `Zl`, `Zp`) plus C0/C1
controls other than TAB, LF and CR. It is the shared pre-match step for
`prompt_delimiter.ts` and `prompt_leak_redaction.ts`, so a zero-width
interleave cannot hide `BOUNDARY_`, `[TRUSTED]` or `author=`.

Shapes checked (12e's untrusted-ingestion slice, because the callers feed
GitHub text and model output through this function):

| Property | Result |
| -------- | ------ |
| no spawn, no argv, no filesystem | the function reads its argument and returns a new string |
| no network, no clock, no `Deno.*` | the module imports nothing |
| control characters cannot split a marker | C0/C1 except TAB/LF/CR are dropped; `Cf`/`Zl`/`Zp` are dropped |
| document structure survives | TAB, CR and LF are kept so Markdown line structure is unchanged |
| a wrong strip cannot invent a trust marker | the function only deletes characters; it never inserts trust vocabulary |
| regex source stays free of control bytes | format/separator classes use `\p{…}`; C0/C1 are code-point checks |

No findings. The accepted residual: a host that renders a format character as
visible ink will show a shorter string after stripping, which is the intended
defence — the marker match must see the canonical ASCII form.
