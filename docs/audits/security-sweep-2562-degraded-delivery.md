# 🔎 Security sweep — degraded-run delivery guard (`degraded_delivery.ts`)

**Issue:** [#2562](https://github.com/stSoftwareAU/VibeCoder/issues/2562)
(chunk top-up-2562) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2562:

- `worker/deno/lib/degraded_delivery.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2562**, and this file is the reading of it.

## `worker/deno/lib/degraded_delivery.ts`

Three pure exports and one with I/O. `assessDegradedDelivery` judges a run's
recorded invocations with the same `buildDegradationReport` the run-stats
comment uses, then compares the issue's accepted scope with the PR summary's
closure block; `buildDegradedFollowUpIssue` and `buildDegradedPrSection` render
markdown. `fileDegradedFollowUp` is the only side effect: one `gh issue list`
(through `fileFindingOnce`) and at most one `gh issue create`, both through the
injected `gh` function that production binds to the `gh` spawn chokepoint.

| Input | Source | Handling |
| ----- | ------ | -------- |
| issue body (scope items) | untrusted — issue author | copied into the follow-up body and the PR body as markdown list text; never interpolated into a command, path or regex. `gh` receives it as one argv element, not through a shell |
| PR summary (closure statuses) | agent-written | read only for its `met` / `partial` / `missing` words; a forged `met` can only suppress a follow-up for the run that wrote it, the same trust the closure gate already extends |
| issue title | untrusted — issue author | used in the follow-up title (truncated to 250 characters) as one argv element |
| degraded reason | worker-derived (model ids) | rendered as text |
| dedup match | open issues carrying `<!-- finding-id: degraded-follow-up-<N> -->` | only a **fleet-authored** match suppresses a filing (`fileFindingOnce`, Issue #1243), so a planted issue cannot silence the follow-up |
| label | constant `idle-task` | passed through `guardedLabelArgs`, so the worker label allowlist is asserted at creation time |

Failure is loud: a `gh` error or an unparseable create result returns an error
and the completion phase raises no PR, so the parent is never closed with the
residue recorded nowhere. No environment variable, file or permission is read
beyond what `buildDegradationReport` already reads for the run-stats comment,
and that read is skipped entirely when the run recorded no invocation.
