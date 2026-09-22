# 🔎 Security sweep — the callback `mode` resolver (`callback_run_mode.ts`)

**Issue:** [#2100](https://github.com/stSoftwareAU/VibeCoder/issues/2100) (chunk
top-up-2100) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2100:

- `worker/deno/lib/callback_run_mode.ts` — added by #2100.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2100**, and this file is the reading of it.

## `worker/deno/lib/callback_run_mode.ts`

A pure resolver. Given the labels on one claimed issue and the fleet's
configured implementation label, it returns the name of the workflow that run
served — the value published as `mode` in the post-run callback context. It
spawns no process, opens no file, makes no network call, holds no state between
calls, and owns no credential.

Untrusted inputs, and how each reaches the output:

| Input         | Source                                                                                                                                                                                  | How it is handled                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issueLabels` | GitHub labels on the claimed issue — attacker-influenceable in principle (anyone with triage rights can add a label; `label_security` already strips untrusted adds of reserved labels) | used **only** for membership testing. Each entry is `trim()`ed and lower-cased and compared against one fixed constant; no entry is ever returned, concatenated or interpolated |
| `workOnLabel` | the host's own `.config.json`, via `WorkerConfig`                                                                                                                                       | returned verbatim when no wrapper label matched — operator-controlled text, the same text already published in release comments and prompts                                     |

The single most important property: **the value returned is always one the host
configured** (or the fixed `IDLE_TASK_LABEL` constant), never a string taken
from the issue. An attacker who adds `work-on 🙈$(id)` as a label cannot put
that text into the callback document or the `VIBECODER_MODE` environment
variable through this module — the label either matches the wrapper constant, in
which case the _constant_ is returned, or it does not and the configured
implementation label is returned instead. A unit test pins exactly that
(`an issue label never becomes the mode verbatim`).

| Property          | Result                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| no spawn, no argv | the module spawns nothing and builds no argv                                                                                                                                                                                                                 |
| regex safety      | no regex at all — `trim()`, `toLowerCase()` and `Array.includes()` only, so no backtracking surface                                                                                                                                                          |
| filesystem        | none                                                                                                                                                                                                                                                         |
| network           | none                                                                                                                                                                                                                                                         |
| injection         | nothing it returns reaches a shell: the callback runner spawns the hook path directly with no shell and passes `mode` as one cleared-environment variable and one JSON string field. Even so, the returned value is operator-configured text, not issue text |
| secret surface    | it emits no credential and logs nothing                                                                                                                                                                                                                      |
| resource bounds   | O(number of labels on the issue) — one pass, bounded by GitHub's per-issue label cap                                                                                                                                                                         |
| fail direction    | absent, never empty. A fleet with no non-blank implementation label configured yields `undefined`, and the callers omit the field rather than publishing `""` — the same "omitted when unknown" rule the rest of the callback context holds                  |
| blast radius      | one descriptive string on the callback context. `mode` governs nothing: no dispatch, no gate and no label write reads it. A wrong value mis-attributes a row in a fleet archive; it cannot change what the worker does                                       |

No finding. The judgement worth recording is one of **scope**: the resolver
reads only the two workflows the claim scan can serve, and deliberately does not
test for `grill-me`, `quorum`, `planning`, `question`, `refine-issue` or the
custom-label prompts. Those routes dispatch through `findAndProcessByLabel`,
which fires no run callback at all, while `grill-me` and `quorum` are _not_
among the labels the claim scan filters out — so an issue carrying both
`work-on` and `grill-me` is claimed and implemented by the scan after the
grill-me route declines it. Reading those names here would archive that real
implementation run as a grill-me run, which is the exact mis-count `mode` exists
to prevent.
