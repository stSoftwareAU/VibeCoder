# PR Summary — Issue #333

## Summary

The account hit its **weekly** usage limit. Claude said so, and said when it
reopens:

```text
WARNING: Claude usage limit reached — subscription window (exit 1):
  You've hit your weekly limit · resets Aug 25, 1am (UTC)
ERROR: … Pausing agent work for Ns (no reset time in the message; default hour).
```

The reset time is in the message. `parseUsageLimitReset` only matched a bare
clock after `resets`, so the **dated** form returned `null` and the log claimed
there was none.

**The hourly retry is deliberate and unchanged.** The quota may be extended
before the stated reset, so the worker re-probes rather than sleeping for two
days. What was wrong is that the reset was neither parsed nor reported, and the
log said the opposite of the truth.

### Reset and cadence, separated

- `parseDatedReset` handles `resets Aug 25, 1am (UTC)`, day suffixes, 24-hour
  times, and rolls to next year when the date has passed. An explicit `(UTC)`
  wins over the host zone — a Sydney host reading `1am (UTC)` as local is ten
  hours out.
- Tried **before** the bare clock, because the bare-clock path resolves to the
  *next* occurrence: it would have returned `2026-08-24T01:00Z` for a reset
  that is really `2026-08-25T01:00Z`. Right for the five-hour window, a day
  wrong for the weekly one.
- The pause is `min(time-until-reset, USAGE_LIMIT_MAX_WAIT_SECONDS)` (one
  hour), matching the safety cap `rate_limit_wait.ts` already applied for the
  same reason. The reset is reported, not slept on.

### The messages now say both things

`formatRemainingDuration` is minutes-and-seconds — right for a countdown, and
useless for a weekly reset, which it renders as `2547m 00s`. New
`formatCoarseDuration` gives `1d 18h`:

```text
Rate-limit wait: the window reopens in 1d 18h (2026-08-25T01:00:00Z)
  — re-probing in 26m 53s in case the quota is extended
```

The old line read `26m 53s remaining until reset at 2026-08-23T07:33:26Z`,
presenting the synthetic one-hour pause as the reset.

### A host with no quota for days is named on the FLEET report

Marking a host unhealthy was already handled (#2602). What was missing was
*which host and why*: `RateLimitSignalData` now carries `resetEpochMs` beside
the capped `waitSeconds`, and `hostNotes` (the #226 seam) adds

> `out of Claude quota for 1d 18h — the window reopens at 2026-08-25T01:00:00Z;
> this host needs a different account or a topped-up plan`

Gated at **six hours** — longer than the five-hour subscription window — so an
ordinary mid-cycle lapse never flags a host, and any weekly limit always does.

Closes #333.

## Evidence

**Before, against the real string:**

```text
"You've hit your weekly limit · resets Aug 25, 1am (UTC)"  -> NULL (falls back to 1 hour)
```

**After:** `2026-08-25T01:00:00Z`.

**5 of the 10 new parser cases fail on `origin/main`; the other 5 pass** —
that split is the point: the failures are the dated form, the passes are the
pre-existing `resets at 3pm` / `resets 1am` / `|<epoch>` forms, which must not
regress.

```text
$ deno test --allow-all tests/usage_limit_weekly_reset_test.ts \
    tests/claude_runner_usage_limit_test.ts tests/rate_limit_*
ok | 35 passed | 0 failed
```

**Full quality gate** (`./quality.sh`): every static gate PASSED. `deno tests`
reports only the 11 pre-existing `setup.ps1` failures (environmental).

Two of my own runs failed first and were real: a `deno check` on an optional
field, and `claude_runner_usage_limit_test.ts` asserting `waitSeconds > 3600`
— the old sleep-until-reset contract. That test now pins the new one
(`waitSeconds === USAGE_LIMIT_MAX_WAIT_SECONDS`, with the fixture's reset
asserted to be beyond the cap so the assertion means something).

## Test plan

`worker/deno/tests/usage_limit_weekly_reset_test.ts` — 16 cases:

| Group | Covers |
| --- | --- |
| The real message (6) | Parses to its stated reset; `(UTC)` beats the host zone; a past date rolls to next year; the dated form is tried before the bare clock (guarding the day-early bug); day suffixes and 24-hour times; `pm` |
| No regression (3) | The `\|<epoch>` form still wins; all three bare-clock forms unchanged; no reset still returns null; an unknown month is not a date |
| Reporting (2) | `1d 18h` for the real case; hours then minutes for shorter windows, and never a negative |
| Outage signal (4) | The signal carries the true reset, not the capped wait; a past reset is not an outage; an older signal without the field still parses; a missing or corrupt signal is not an outage |

## Scope

The six-hour unhealthy threshold and the one-hour cap are constants, not
config. Both are one-line changes if the fleet wants them tunable; neither
seemed worth a config key before there is a second opinion about the value.
