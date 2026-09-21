# 🔎 Security sweep — the GraphQL budget pacing (`budget_pacing.ts`)

**Issue:** [#2447](https://github.com/stSoftwareAU/VibeCoder/issues/2447)
(chunk top-up-2447) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2447:

- `worker/deno/lib/budget_pacing.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2447**, and this file is the reading of it.

## `worker/deno/lib/budget_pacing.ts`

One pure function, `computePacedSleepSeconds(input)`, plus two constants
(`BUDGET_RESERVE_FRACTION = 0.2`, `MAX_PACED_SLEEP_SECONDS = 300`) and two
interfaces. Every input is a number and every output is derived from them:
there is no I/O, no `Deno.env`, no spawn, no network, and no filesystem access
anywhere in the module. The caller (`run_core.ts`) supplies the quota numbers,
which it reads from the free GraphQL probe that is already allowlisted and
shaped upstream.

| Property | Result |
| -------- | ------ |
| argument injection | none — no string reaches a command, shell, or template; the inputs are arithmetic operands only |
| can it escalate privilege? | no. The module mutates nothing; it returns a sleep duration and a log-line reason |
| can it weaken the review that matters? | no. It has no effect on auth, claims, PRs, or the callback contract; it only lengthens an idle sleep |
| can it leak a secret? | no. The only strings it produces are a fixed reason and numbers, none derived from credentials or tokens |
| quota safety (#2409) | it *conserves* quota — the whole point is to slow the loop before the pre-flight threshold fires. It adds no API call of its own |
| regex safety | no regex is evaluated |
| fail direction | a malformed or extreme input degrades to a capped or base sleep — the caller's fixed-sleep fallback, never a throw, never a silent zero |
| network / filesystem / spawn | none |
| prompt injection | none of its input or output reaches a model |
| blast radius | bounded to the `scanHadSuccess` end-of-cycle sleep; the circuit-breaker back-off branch and the post-run callback contract are untouched |
