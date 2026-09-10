# Security sweep — bot-authored PR lookup (`pr_bot_lookup.ts`)

**Issue:** [#1846](https://github.com/stSoftwareAU/VibeCoder/issues/1846)
(chunk 12n) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12m) recorded their coverage:

- `worker/deno/lib/pr_bot_lookup.ts` — added by #1846.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12n**, and this file is
the reading of it.

## `worker/deno/lib/pr_bot_lookup.ts`

The module reads the repo's one un-filtered open-PR listing through
`fetchAllOpenPRs` and admits the entries whose author is a bot
(`isBotLogin`) **and** whose head branch lives in the target repository
(`isCrossRepository === false`). It is a decision point on untrusted GitHub
data — a PR author login and a head-ownership flag both come from the
listing — so the shapes below are 12c's untrusted-ingestion shapes.

Shapes checked (12c, untrusted GitHub-data ingestion):

| Property | Result |
| -------- | ------ |
| no spawn, no argv | the module builds no argv; `fetchAllOpenPRs` owns the `gh` call and the injected `ghCommandFn` is the only runner |
| no filesystem, no clock, no network | the only I/O is the caller's `IssueCache`, passed through untouched |
| untrusted login never reaches a log raw | every login is written through `sanitiseLogField` — control characters and quotes cannot forge a log line |
| a fork head cannot be acted on | admission requires `isCrossRepository === false`; `true` **and** unset are both excluded, with the reason logged |
| a failed listing cannot read as "no bot PRs" | the throw from `fetchAllOpenPRs` (Issue #4257) is caught, logged once, and admits nothing; nothing is cached |
| a garbled cache entry cannot be iterated | a non-array listing is logged as a failure, not read as an empty repo |
| no duplicate action on one PR | entries are de-duplicated by `number` before admission |
| an unattributable author cannot be admitted | a missing, non-string or blank `author.login` is dropped before `isBotLogin` runs |

No findings. The accepted residual, carried from the issue: `isBotLogin`'s
prefix patterns (`dependabot*`, `copilot*`, …) could match a human login with
a bot-like name. The same-repository requirement limits that to accounts that
already hold push access to the repo, which is accepted.
