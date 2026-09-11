# Security sweep — the weekly Claude quota pace gate (`claude_week_pace.ts`)

**Issue:** [#1885](https://github.com/stSoftwareAU/VibeCoder/issues/1885)
(chunk top-up-1885) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12n) recorded their coverage:

- `worker/deno/lib/claude_week_pace.ts` — added by #1885.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **top-up-1885**, and this file is
the reading of it.

## `worker/deno/lib/claude_week_pace.ts`

The module turns one Claude budget probe into a verdict — engaged, off, or
unknown — and the Priority 2 scan drops the `low-priority` and `idle-task`
tiers while it is engaged. It touches a **credential** (the run's Claude OAuth
token) and consumes an **untrusted response** (Anthropic's rate-limit
headers), so the shapes below are 12b's credential-handling shapes and 12c's
untrusted-ingestion shapes together.

Shapes checked:

| Property | Result |
| -------- | ------ |
| no spawn, no argv | the module builds no argv and runs no subprocess |
| no filesystem | the only state is one in-memory snapshot, held for the life of the process |
| the clock is injectable | `now` is an option; the pure verdict takes `nowMs` as a parameter, so no rule reads a clock of its own |
| network is one bounded call | the only request is `probeClaudeTokenBudget` (#918, swept in 12j), already timeout-bounded and retry-free |
| the token value cannot reach a log | no formatter takes the token as an input — every line is built from two shares, a projection and a reset instant, and the probe is handed a fixed `week-pace` label rather than the value |
| the token is read defensively | `Deno.env.get` is wrapped, and a permission denial answers "no reading", never a fabricated one |
| a probe that throws is unknown, never assumed | the reader catches and returns `{ known: false, reason: "network-error" }`; the error's `name` only, never its message, so a message carrying the token cannot leak |
| a failed probe never refuses work | `unknown` leaves the gate off and logs one WARNING — the existing "never refuse work on a failed probe" rule |
| untrusted figures cannot engage the gate wrongly | a `NaN` or absent reset falls through every comparison to `off`; the gate can only ever be engaged by a finite projection at or above the threshold |
| no divide-by-zero | the projection divides by `elapsedShare` only after the 24 h grace check, so the divisor is at least `24/168` |
| the gate only removes work | engaged drops two tiers from the ladder; nothing here can add a candidate, elevate one, or claim anything |
| a host with no Claude subscription pays nothing | an absent or blank token makes no request and logs no line |
| a permission denial is not mistaken for "no subscription" | the `Deno.env.get` catch logs a WARNING naming the error class before answering "no reading" |
| another vendor's run is never paced by a Claude window | the gate answers `false` unless the active provider is `claude`, so a stale `CLAUDE_CODE_OAUTH_TOKEN` in a shared environment cannot gate a Codex run |
| two tokens' figures cannot mix in one verdict | the snapshot is keyed by the token it describes, so a mid-run pool switch discards it rather than reusing it |
| the reading is not an ambient dependency | production declares the token at the wiring site (`run_core_production_deps.ts`), through the factory's own env lookup |

No findings. The accepted residual: the gate holds its own snapshot rather
than the credential pool's, because the pool is built at worker start and the
scan loop cannot reach it. The cost is one extra probe per ten minutes, and
the reading is keyed by token so the two stores cannot disagree about *which*
subscription a figure describes.
