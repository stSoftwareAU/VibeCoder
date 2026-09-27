# 🔎 Security sweep — worker `work-on` → `planning` hand-off (`planning_handoff.ts`, `planning_handoff_trust.ts`)

**Issue:** [#2688](https://github.com/stSoftwareAU/VibeCoder/issues/2688)
(chunk top-up-2688) · **Parent:** #1209

This is the written record for the two modules that entered
`worker/deno/lib/` under #2688:

- `worker/deno/lib/planning_handoff.ts`
- `worker/deno/lib/planning_handoff_trust.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. Both modules are claimed by
**top-up-2688**, and this file is the reading of them.

## `worker/deno/lib/planning_handoff.ts`

Turns a run's `vibe-needs-planning` request into the worker's `planning` label,
a hand-off comment and a claim release. Every label write goes through the
`assertWorkerCanHandOffToPlanning` guard first, and every GitHub call uses the
injected `GitHubClient`.

| Input | Source | Handling |
| ----- | ------ | -------- |
| `vibe-needs-planning` marker | agent output | parsed by a fixed regex with a word-boundary lookahead, so a similarly named marker does not match; a missing or blank `reason` means no hand-off, so the run falls through to `needs-human` |
| `reason` attribute | agent output | truncated to 500 characters, passed through `redactSecrets`, then `neutraliseAgentMarkers`, and posted as a blockquote |
| output snippet | agent output (`publishableSnippet`, already redacted) | passed through `neutraliseAgentMarkers` and posted inside a code fence, so it cannot forge a fleet marker in a worker-authored comment |
| prior hand-off check | issue comments | a raw search for `<!-- vibe-planning-handoff -->`; a forged marker can only force the `needs-human` fallback, which is the safe direction |

## `worker/deno/lib/planning_handoff_trust.ts`

A pure predicate over the issue timeline. It does no I/O.

| Input | Source | Handling |
| ----- | ------ | -------- |
| label name | the label being verified | case-insensitive; anything other than `planning` returns `false` |
| event actors | GitHub timeline | case-insensitive compare against the allowlist and the worker logins; a `null` actor never matches |
| `work-on` anchor | GitHub timeline | must be the latest `work-on` add, come before the latest `planning` add, be made by a trusted **non-worker** author, and not be removed afterwards |

Three guarantees hold whatever the inputs:

- The guard allows `planning` alone. Every other label is refused with
  `[WORKER_LABEL_REFUSED]`.
- A refused guard or a failed label add returns `applied: false` without
  releasing the claim, so the caller escalates to `needs-human`.
- An outsider who adds `planning`, or re-adds `work-on`, gets no trust from
  the exception.
