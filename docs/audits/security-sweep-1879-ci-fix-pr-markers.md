# Security sweep — CI-fix PR marker reader (`ci_fix_pr_markers.ts`)

**Issue:** [#1879](https://github.com/stSoftwareAU/VibeCoder/issues/1879)
(chunk 12ae) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after chunk 12ad recorded its coverage:

- `worker/deno/lib/ci_fix_pr_markers.ts` — added by #1879.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**12ae**, and this file is the reading of it.

## `worker/deno/lib/ci_fix_pr_markers.ts`

The module is the reader half of the fleet-wide CI-fix record: it fetches a pull
request's comments through a caller-supplied reader, hands them to the already-
swept `collectFleetCiFixMarkers` (12ac, #1877), and renders the result as the
rows the cap summary prints and the body an in-place comment edit writes back.
Its inputs are therefore pull-request comments — the most accessible attack
surface on a public repository — with an authorisation decision (may this run
attempt a fix again?) hanging off them.

| Property | Result |
| -------- | ------- |
| no spawn, no argv | no `Deno.Command`; the only I/O is the `getComments` function the caller injects |
| no filesystem, no network of its own | nothing is read or written; the comment read is the caller's existing `getIssueComments`, so no second API call is made |
| no environment or secret sinks | no `Deno.env`; every message goes to the injected `Logger`, which is already redaction-wrapped at the entry points |
| author verification is not re-implemented | the fleet check stays in `collectFleetCiFixMarkers` — this module only passes the fleet login list through, so there is no second, weaker definition of "the fleet wrote it" |
| a failed read is never an empty budget | a `getComments` that throws returns `capEnforced: false`, `readFailed: true` and empty maps, with an error naming the consequence; the caller stands the cycle down rather than spending an attempt nothing could count. The ambiguous zero is the unsafe direction for an attempt cap |
| an unresolved fleet is reported apart from a failed read | `fleetResolved: false` is re-reported as an error naming the configuration keys (`github_user` / `fleet_pr_authors` / `service_accounts`) that restore the tally, and is **not** flagged as a read failure — a permanent misconfiguration must not stand every repair on the host down for ever, whereas a transient read failure costs one cycle |
| the discard warning is not swallowed | the collector's own log sink is wired to `logger.warn`, so markers ignored for being authored outside the fleet stay visible |
| comment prose is bounded before it is rendered | `diagnosed` is already flattened and capped at 200 characters by 12ac; `buildAutoFixCapSummary` escapes `\|` and flattens newlines for the table cell it lands in, so a hostile diagnosis cannot add a row or break the table |
| the attempt number cannot be spoofed into the summary | rows fall back to their position (`record.attempt \|\| index + 1`), so a marker claiming attempt 999 still renders in sequence and cannot reorder the table |
| the edit re-posts only what the pull request already holds | `appendAttemptToComment` concatenates an existing **fleet-authored** body with a worker-built note and a worker-built marker; no third-party text enters a comment that did not already contain it |
| the functions are pure and linear | no regex at all in this module; `buildCapAttemptRows` and `appendAttemptToComment` are single passes with no nested quantifier to back-track |
| the array the caller receives is its own | the comments are copied (`[...await getComments(...)]`) rather than aliased, so a caller mutating the result cannot reach back into a cache the client returned |

### Findings

None.

### Accepted residuals

- **A fleet account can still write a marker by hand**, and a fleet credential
  therefore spends the pull request's budget. Inherited from 12ac: author
  verification buys attribution, not intent, and a compromised fleet credential
  has strictly larger powers than exhausting a CI-fix cap.
- **The comment edit is last-writer-wins.** `updateComment` PATCHes the body
  this run read, so a concurrent edit between the read and the write is
  overwritten. The CI-fix lane already holds the PR-level cross-host lock
  (#3754) for the duration, and the only writer of these comments is the lane
  itself, so the window is the lock's and not a new one.
- **An unresolved fleet identity fails open, loudly.** With no fleet logins
  nothing is attributable, so the cap cannot bind and the repair runs anyway.
  Standing down instead would stop every CI fix on a misconfigured host
  indefinitely, which is a worse failure than an unenforced cap; the error names
  the keys that restore it. A *read* failure is treated the other way — it is
  transient, so the cycle stands down and the next scan retries.
