# 🔎 Security sweep — the merge-conflict stage timer (`conflict_stage_timer.ts`)

**Issue:** [#2308](https://github.com/stSoftwareAU/VibeCoder/issues/2308) (chunk
top-up-2308) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2308:

- `worker/deno/lib/conflict_stage_timer.ts` — added by #2308.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2308**, and this file is the reading of it.

## `worker/deno/lib/conflict_stage_timer.ts`

Three exports: `createConflictStageTimer` (a closure over an injected
millisecond clock), `formatStageTimings` (a pure renderer) and `currentHost` (a
one-line delegation to `getHostname` in `worker_identity.ts`). The module spawns
nothing, reads no file, opens no socket and holds no credential; the only
ambient read in it is the hostname, and that is behind the single `currentHost`
seam.

| Input     | Source                                                                                 | How it is handled                                                                                                                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stage`   | a `ConflictStage` literal chosen by the calling worker code                            | a closed six-member union checked by the compiler; never parsed from a comment, an issue body, a branch name or any other attacker-influenceable text, so no value a fork PR can supply reaches it                                                                                                                                   |
| `nowMs()` | the caller's clock — `Date.now` in production, a counter in tests                      | used only for subtraction; a clock that runs backwards contributes `Math.max(0, …)` rather than a negative duration, so no stage can be rendered with a nonsense sign                                                                                                                                                                |
| `host`    | `currentHost()`, i.e. `Deno.hostname()` / `HOSTNAME` / `hostname(1)` via `getHostname` | the worker's own identity, not user input. Interpolated into one Markdown line inside a backtick span; a hostname carrying a backtick could break that span's formatting but carries no injection beyond Markdown emphasis — it cannot become a link, an image or HTML, because GitHub's renderer escapes raw HTML in comment bodies |
| `report`  | this module's own `StageTiming[]`                                                      | stage names are union members and seconds are numbers, so the rendered line is built entirely from values this module produced                                                                                                                                                                                                       |

| Property          | Result                                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spawn chokepoints | none — no `Deno.Command`, no git, no `gh`. `getHostname`'s own `hostname(1)` fallback is pre-existing and swept under its module                                                                                                          |
| filesystem        | none                                                                                                                                                                                                                                      |
| network           | none                                                                                                                                                                                                                                      |
| environment       | none of its own; `getHostname` reads `HOSTNAME`/`COMPUTERNAME`/`NAME` as its second strategy, and a failure there falls through rather than throwing                                                                                      |
| regex safety      | none — the module builds no `RegExp`                                                                                                                                                                                                      |
| secret surface    | holds none and emits none. The rendered line carries only stage names, integers and the host, so it adds no new redaction obligation to the `gh` body chokepoint it travels through                                                       |
| output sinks      | one Markdown line appended to a PR conclusion comment or a milestone sync report comment, and one structured log record. Both already redact through their existing chokepoints                                                           |
| fail direction    | a stage started and never stopped reports `null` and renders as `unfinished`; an empty report renders `no stage was timed`. Neither degrades into a plausible-looking duration, so a missing measurement is never mistaken for a fast one |

## The invariant this module exists to hold

**A stage is either measured or named as unmeasured — never dropped.** The
timings line is a diagnostic read when an attempt burned twenty minutes, so a
stage that silently vanished from it would hide exactly the run this feature
exists to explain. `report()` therefore returns an entry for every stage that
was ever started, with `seconds: null` for one that never stopped, and
`formatStageTimings` renders that as `unfinished`.

## The caller contract this module cannot enforce

The timer is a plain closure with no reentrancy guard: it assumes one attempt
owns one timer and that `start`/`stop` are called from a single logical thread
of execution. Two concurrent stages on one timer are not an error it can detect
— the second `start` closes the first as unfinished, which is the honest
degradation but not a repair. Production keeps to the contract: one timer is
created per `resolveConflict` pass and per `syncMilestoneBranchWithDefault`
call, and no other code holds a reference.

## Verdict

**Swept, no findings.** A pure closure over an injected clock plus one renderer
and one hostname seam: no subprocess, no filesystem, no network, no secret, no
attacker-controllable input, and a fail direction that names an unmeasured stage
rather than inventing a duration for it.
