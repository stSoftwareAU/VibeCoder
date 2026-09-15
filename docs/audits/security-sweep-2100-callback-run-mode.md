# 🔎 Security sweep — the callback `mode` resolver (`callback_run_mode.ts`)

**Issue:** [#2100](https://github.com/stSoftwareAU/VibeCoder/issues/2100)
(chunk top-up-2100) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2100:

- `worker/deno/lib/callback_run_mode.ts` — added by #2100.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record. The module is
claimed by **top-up-2100**, and this file is the reading of it.

## `worker/deno/lib/callback_run_mode.ts`

A pure resolver. Given the labels on one issue and the fleet's configured
`*Label` names, it returns the name of the workflow the dispatch matched — the
value published as `mode` in the post-run callback context. It spawns no
process, opens no file, makes no network call, holds no state between calls,
and owns no credential.

Untrusted inputs, and how each reaches the output:

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `issueLabels` | GitHub labels on the claimed issue — attacker-influenceable in principle (anyone with triage rights can add a label; `label_security` already strips untrusted adds of reserved labels) | used **only** for membership testing. Each entry is `trim()`ed and lower-cased into a `Set` and compared; no entry is ever returned, concatenated or interpolated |
| the configured `*Label` names | the host's own `.config.json`, via `WorkerConfig` | returned verbatim when matched — operator-controlled text, the same text already published in the release comments and prompts |
| `customLabels` | same file, via the already-validated `customLabelPrompts` list | treated exactly like the built-in names |

The single most important property: **the value returned is always one the
host configured** (or the fixed `IDLE_TASK_LABEL` constant), never a string
taken from the issue. An attacker who adds `grill-me 🙈$(id)` as a label
cannot put that text into the callback document or the `VIBECODER_MODE`
environment variable through this module — the label either matches a
configured name, in which case the *configured* spelling is returned, or it
does not match and is discarded.

| Property | Result |
| -------- | ------ |
| no spawn, no argv | the module spawns nothing and builds no argv |
| regex safety | no regex at all — `trim()`, `toLowerCase()` and `Set.has()` only, so no backtracking surface |
| filesystem | none |
| network | none |
| injection | nothing it returns reaches a shell: the callback runner spawns the hook path directly with no shell and passes `mode` as one cleared-environment variable and one JSON string field. Even so, the returned value is operator-configured text, not issue text |
| secret surface | it emits no credential and logs nothing |
| resource bounds | O(number of labels on the issue + number of configured candidates) — one pass to build the set, one pass over at most six built-in names plus the configured custom list. Both are bounded by GitHub's per-issue label cap and the operator's own config |
| fail direction | absent, never empty. A fleet with no non-blank implementation label configured yields `undefined`, and the callers omit the field rather than publishing `""` — the same "omitted when unknown" rule the rest of the callback context holds |
| blast radius | one descriptive string on the callback context. `mode` governs nothing: no dispatch, no gate and no label write reads it. A wrong value mis-attributes a row in a fleet archive; it cannot change what the worker does |

No finding. The one judgement worth stating is the precedence order: the
label routes (priorities 1.75–1.86) are tested before the issue scan's own
labels, so a doubly-labelled issue is attributed to the route that would
actually have served it. That order is a reporting decision, not a control —
the dispatcher's own priority ladder remains the only thing that decides which
route runs.
