# 🔎 Security sweep — phase accelerator preparation (`phase_accelerators.ts`)

**Issue:** [#2569](https://github.com/stSoftwareAU/VibeCoder/issues/2569)
(chunk top-up-2569) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2569:

- `worker/deno/lib/phase_accelerators.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2569**, and this file is the reading of it.

## `worker/deno/lib/phase_accelerators.ts`

One export with I/O, `preparePhaseAccelerators`, and its types. It adds no
subprocess, file, network or environment access of its own: it sequences the
existing Graft (`collectGraftContext`, `bindGraftRun`), CodeGraph
(`prepareCodegraphRun`) and RTK (`prepareRtkRun`) preparations, each already
claimed by an earlier slice, and composes their prompt and spawn-option
outputs.

| Input | Source | Handling |
| ----- | ------ | -------- |
| issue title and body | untrusted — issue author | joined by `graftQueryFor` into the Graft query, which the Graft collector passes as one argv element through its own spawn path; never interpolated into a shell, path or regex here |
| Graft bundle | repository-derived — branch author | appended to the prompt only through `formatGraftContextSection`, which sanitises delimiter patterns and wraps it in the run's untrusted boundary and a collision-safe code fence |
| `repo` | worker config (`owner/name`) | resolved to the checkout directory by `repoCheckoutPath` under `config.workDir`; same derivation grill-me and planning already use |
| enable flags | worker config | read only as booleans to skip a preparation |
| provider id | `rtkProviderId` seam | passed through to RTK preparation and returned; not used as a path or command |

Failure is reported, not thrown: each preparation returns a `failed` or
`unsupported` outcome that `report()` surfaces on the phase's stats comment, so
a lost accelerator is visible rather than silent. No secret is read or logged;
the one log line is `describeGraftContext`'s status summary.
