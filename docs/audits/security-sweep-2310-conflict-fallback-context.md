# 🔎 Security sweep — the conflict fallback context readers (`conflict_fallback_context.ts`)

**Issue:** [#2310](https://github.com/stSoftwareAU/VibeCoder/issues/2310)
(chunk top-up-2310) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2310:

- `worker/deno/lib/conflict_fallback_context.ts` — added by #2310.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2310**, and this file is the reading of it.

## `worker/deno/lib/conflict_fallback_context.ts`

Three exports — `parseStageTimingsLine` (pure), `readPrDivergence` and
`readPrDiffSummary` (both over an injected `gh` seam) — plus the
`MAX_DIFF_SUMMARY_PATHS` bound. The module spawns nothing itself, writes no
file, holds no credential, and reads no environment variable; every GitHub call
goes through the `gh` function its caller supplies, which in production is the
worker's own `gh` chokepoint.

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| a PR comment body | **attacker-writable** — any GitHub account may comment, and the callers filter the thread through `conflict_marker_trust.ts` first | matched against three line-anchored patterns with bounded groups (`TIMINGS_LINE`, `STAGE_SECONDS`, `STAGE_UNFINISHED`). No group is nested or unbounded, so a body of any size costs one linear pass — no ReDoS surface. A segment that matches neither stage shape records no timing rather than a guessed one |
| `baseBranch` / `headBranch` | GitHub's own PR listing | validated against `SAFE_REF` (`[A-Za-z0-9._\-/]{1,255}`) **and** rejected when it contains `..`, before either is interpolated into the compare path. A ref that fails the check makes no call at all and is warned about: a redirected API read is worse than an unrecorded field |
| `repo`, `prNumber` | the caller's own scan state | interpolated into an API path only; `prNumber` is a number by type |
| `gh` stdout — `behind_by` | GitHub | `Number(...)`, then `Number.isSafeInteger(...) && >= 0`. Anything else leaves the field unrecorded and warns; the flag body then renders `not recorded` rather than a plausible `0` |
| `gh` stdout — `--json files` | GitHub | `JSON.parse` inside a `try`, then shape-checked entry by entry (`path` must be a non-empty string; `additions`/`deletions` default to `0` only when they are not numbers). Capped at `MAX_DIFF_SUMMARY_PATHS`, with the excess **counted** in `omitted` |
| the label timeline | GitHub | delegated to `getLabelLastAddInfoComplete` in `issue_query.ts`, already swept under its own module |

| Property | Result |
| -------- | ------ |
| spawn chokepoints | none of its own — every call is the injected `gh`, which is the caller's chokepoint function |
| filesystem | none |
| network | only through the injected `gh` |
| environment | none |
| regex safety | three line-anchored patterns, every group bounded, no interpolation into a `RegExp` |
| secret surface | holds none. What it returns (integers, an ISO timestamp, paths and stage names) travels to the flag issue through `merge_fallback_issue.ts`, which sanitises every rendered field |
| output sinks | none. It only returns values; its own only side effect is a WARN log line |
| fail direction | towards `not recorded`. Every read is wrapped, a failure warns and yields nothing, and no failure propagates — the fallback that called it is closing a PR, and a failed read must never become a failed close |

## The invariant this module exists to hold

**An unread field is unrecorded, never invented.** Each value it returns is
quoted as fact on a permanent public issue, so "the fleet could not measure
this" and "the measurement was zero" must not render the same way. Every reader
therefore returns `undefined`/an absent field on failure and says so at WARN,
and the flag body prints `not recorded` for it.

## The caller contract this module cannot enforce

The comment bodies it parses must already have been reduced to the fleet's own
by `partitionConflictComments`; the module is author-blind by construction, as
`summariseFailedAttempts` beside it is. Both callers (`pr_merge_conflict_scan.ts`
and `conflict_abandon_restart.ts`) filter first, and the timings it parses reach
only an issue body that the same filter governs — but a future caller that
passed an unfiltered thread would publish an outsider's `Timings (host …)` line
as the fleet's own. That is the existing contract of this family, not a new one.

## Verdict

**Swept, no findings.** Three bounded, linear-time patterns over already-filtered
text; refs validated before they reach an API path; every parsed number and shape
checked; a hard cap on the listed paths with the remainder counted; and a fail
direction that records nothing rather than inventing a value.
