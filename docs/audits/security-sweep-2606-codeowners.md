# 🔎 Security sweep — CODEOWNERS parser (`codeowners.ts`)

**Issue:** [#2606](https://github.com/stSoftwareAU/VibeCoder/issues/2606)
(chunk top-up-2606) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2606:

- `worker/deno/lib/codeowners.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2606**, and this file is the reading of it.

## `worker/deno/lib/codeowners.ts`

Two pure exports, `parseCodeowners` and `ownersForPath`. No subprocess, file,
network or environment access: the caller (today only
`tests/codeowners_test.ts`) reads the file and passes the text in.

| Input | Source | Handling |
| ----- | ------ | -------- |
| CODEOWNERS text | repository-derived — branch author | split into lines and whitespace-separated tokens; each owner must match a fixed `@user`, `@org/team` or email allowlist regex, and a mismatch throws naming the line |
| path pattern | repository-derived — branch author | matched by a segment-wise glob matcher (`*`, `**`, `?`); never compiled into a `RegExp`, so a hostile pattern cannot inject regex syntax |
| path | caller | compared segment by segment; not used to touch the filesystem |

The glob matcher recurses at most once per `*` position and per `**` segment.
Its cost is polynomial in the pattern and path lengths, and both come from a
short, reviewed file. A malformed owner fails loudly rather than being dropped,
so a typo cannot silently leave a privileged path without an owner.
