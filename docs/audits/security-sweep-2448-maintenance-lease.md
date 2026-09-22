# 🔎 Security sweep — the maintenance lease decision module (`maintenance_lease.ts`)

**Issue:** [#2448](https://github.com/stSoftwareAU/VibeCoder/issues/2448)
(chunk top-up-2448) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2448:

- `worker/deno/lib/maintenance_lease.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2448**, and this file is the reading of it.

## `worker/deno/lib/maintenance_lease.ts`

The pure decision half of the maintenance lease (Decision 2 of #2443): it
formats and parses the `vibe-maintenance-lease` marker and decides, from a
recorded holder, this host's install id and the clock, whether this host runs a
repository's maintenance sweeps. **No GitHub I/O, no filesystem access, no
process spawn, no `fetch`** — the only import is `installFromMachineId` from
`stream_holder.ts`, a pure string extractor.

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `repo` | the repository the lease is for (worker config / claim repo) | sanitised by `sanitiseRepo` to `[A-Za-z0-9._/-]`, then required to match `/^[^/\s]+\/[^/\s]+$/` on parse; a marker whose `repo` is not `owner/repo` parses to `null` |
| `host` / `at` | parsed out of an HTML-comment marker body | the whole marker is matched by a character-class-anchored regex; a non-numeric `at` or a missing `host` fails the match and parses to `null` |
| `thisHost` | this host's machine id (`{hostname}-{uuid}`) | compared on the install uuid via `installFromMachineId`; the hostname is never the identity |
| `nowSeconds` | the reader's clock | a future-stamped `at` is clamped with `Math.min`, never trusted as extra time |

| Property | Result |
| -------- | ------ |
| argument injection | none — no value reaches a shell, a URL, or an argv; the module never spawns |
| can it escalate privilege? | no. It is a pure predicate returning `{ run, reason }`; the caller that acts on `run` lives in a separate module |
| can it leak a secret? | no. Nothing is logged and nothing is written |
| regex safety | one anchored character-class pattern (`LEASE_MARKER_RE`) with no nested quantifier or backtracking surface; `REPO_RE` is a fixed two-segment class. Inputs are short single-line comment bodies |
| clock-safety | the only arithmetic is `nowSeconds - Math.min(atEpoch, nowSeconds)`; a negative age cannot occur because the future stamp is clamped, so `secondsLeft` is bounded to `[0, 900]` |
| fail direction | fail-open **and loud by the caller's contract**: a malformed marker parses to `null`, which the decision reads as `no-holder`. The marker is a claim among trusted fleet accounts (the store's concern, a separate sub-issue); this module only decides what a parsed holder means |
| prompt injection | none of its input or output reaches a model |
| blast radius | a single pure function with no shared state; a wrong decision costs one duplicated sweep cycle, not a data loss or a privilege escalation |
