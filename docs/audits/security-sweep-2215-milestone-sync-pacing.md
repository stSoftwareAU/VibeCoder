# Security sweep — the milestone-sweep pacing helpers (`milestone_sync_pacing.ts`)

**Issue:** [#2215](https://github.com/stSoftwareAU/VibeCoder/issues/2215)
(chunk top-up-2215) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2215:

- `worker/deno/lib/milestone_sync_pacing.ts` — added by #2215.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2215**, and this file is the reading of it.

## `worker/deno/lib/milestone_sync_pacing.ts`

Four pure functions and two constants. It spawns nothing, reads and writes no
file, opens no socket, touches no environment variable and makes no network
call: every input is handed to it by `milestone_branch_sync.ts`, and every
output is a number or a reordered copy of the caller's own array.

Untrusted inputs, and how each reaches the output:

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `deadlineEpochMs`, `nowMs`, `unitsLeft`, `reserveMs`, `minMs` | the sweep's own dependency wiring — the handler watchdog deadline (`run_core.ts`) and the module's own constants | arithmetic only. `unitsLeft` is floored at 1 before it divides, so a zero or negative count cannot divide by zero; the result is clamped to `[floor, left]`, so neither a nonsense deadline nor a nonsense unit count can produce a budget larger than what is left |
| `SyncStreakEntry.lastVisitedAt` | `milestone_sync_failures.json`, written by this worker and re-validated by `readConflictLedger` on load | parsed with `Date.parse`; `NaN`, absent and empty all read as `0` ("never visited"), which sorts the branch **first**. No exception escapes, and no value from the file reaches a command, a path or an output sink |
| the repository and milestone lists | the sweep's configured repos and the validated GitHub milestone listing | used only as map keys and sort inputs; `orderReposByStaleness` splits a ledger key on `\|` and drops an entry with no repo part rather than trusting it |

| Property | Result |
| -------- | ------ |
| no shell, no argv construction | none — no subprocess of any kind |
| environment | untouched — no `Deno.env` read or write |
| filesystem | none — the ledger is read and written by `milestone_sync_streak.ts`, which owns that boundary and was swept under chunk 12b |
| network | none |
| regex safety | none used — no regular expression in the module |
| secret surface | no credential is read, logged or interpolated; the module logs nothing at all |
| resource bounds | `O(n log n)` in the number of repositories and milestones of one sweep, with no recursion, no retry and no unbounded loop. `stalestFirst` copies its input rather than sorting the caller's array in place |
| fail direction | fail-safe in the direction that matters. An unreadable visit stamp reads as "never visited" (visit it again) rather than "visited now" (park it for ever), and a budget that cannot cover an attempt refuses it **by name** with the reason in the returned value, which the sweep logs as a `WARNING` — never as a silent skip |

No finding. The one judgement call is reading an unparseable `lastVisitedAt` as
`0` instead of throwing: the field is an ordering hint, not a safety bound, and
a corrupt stamp that halted the sweep would turn a cosmetic ledger fault into
the fleet-wide starvation this module exists to prevent. The safety bounds the
sweep really depends on — the conflict budget, the cooldown and the attempt
marker — are all in `milestone_sync_streak.ts`, which refuses an unparseable
`deferUntil` rather than reading it permissively.
