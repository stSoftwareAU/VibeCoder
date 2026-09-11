# Security sweep — base-branch check reader (`ci_base_branch_check.ts`)

**Issue:** [#1880](https://github.com/stSoftwareAU/VibeCoder/issues/1880)
(chunk 12ad) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after chunk 12ac recorded its coverage:

- `worker/deno/lib/ci_base_branch_check.ts` — added by #1880.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**12ad**, and this file is the reading of it.

## `worker/deno/lib/ci_base_branch_check.ts`

The module answers one question for the CI-fix lane: is the base branch's own
latest completed run of a named check red? Its answer decides whether a failure
is **deferred** — the agent's diagnosis posted once, no `needs-human`, no
attempt charged — so a wrong `true` parks a pull request nobody is repairing,
and a wrong `false` charges an attempt against a failure the branch could never
fix. The inputs are a repository slug, a branch name and a check name; the check
name is chosen by whoever wrote the workflow, which on a fork's pull request is
attacker-controlled text.

| Property | Result |
| -------- | ------- |
| no spawn, no argv | no `Deno.Command`; the only I/O is the `ghCommandFn` the caller injects, which is already the run's guarded `gh` chokepoint |
| no filesystem, no network of its own | nothing is read or written; no `fetch` |
| no environment or secret sinks | no `Deno.env`; the module returns values and never logs |
| the check name never reaches a command line | the name is matched **client-side** against the parsed payload, so it is never interpolated into the API path or a query string — a name containing `/`, `&`, `?` or a quote cannot reach a URL it could alter |
| the API path is built from the caller's own values | `repos/${repo}/commits/${branch}/check-runs`; `repo` and `branch` are the worker's own scan output (`owner/repo` from the monitored-repo allowlist, `baseRefName` from the PR listing), not agent prose. The agent's `Depends on` line supplies only the issue reference, which this module never sees |
| an error is never a verdict | a `ghCommandFn` that throws, a body that is not JSON, and a body carrying no `check_runs` array each return `ok: false` with the repo and branch named. Nothing in the module can turn a failed read into `false`, which is the direction that would silently defer or silently charge |
| the payload is validated, not cast | every row is checked field by field — a non-numeric `id` or a non-string `name` is dropped rather than ordered or compared — so a malformed row cannot become the "latest" run |
| a pending re-run cannot hide a red base | only `status === "completed"` runs are considered; an in-progress re-run has no conclusion and is skipped rather than read as "not a failure" |
| the latest run wins, by id | a single pass keeps the highest id, so an old red left in the list cannot outvote a green re-run and the ordering does not depend on the API's response order |
| the conclusion test is exact | only `failure` is red; `cancelled`, `timed_out`, `skipped`, `neutral` and any value GitHub adds later are not, so a cancelled run never defers a pull request |
| no regex at all | the module has no pattern to back-track; `parseCheckRuns` and `latestCompletedRun` are single linear passes over a parsed array |
| unbounded payload size is the caller's existing exposure | the response is the same `check-runs` body `direct_merge.ts` already parses through the same `gh` client; no new fetch and no new limit is introduced here |

### Findings

None.

### Accepted residuals

- **The branch's checks are read once, without a lock.** A base branch that
  turns green between this read and the comment being posted leaves a deferral
  naming a blocker that has just been fixed. Refreshing a deferred pull request
  once its blocker lands is #1849's job, and the deferral marker is what that
  refresh reads.
- **The deferral trusts the agent for *which* issue blocks it.** This module
  verifies only that the base is red; the `owner/repo#N` reference comes from
  the agent's message and is validated for shape by
  `buildCiFixDeferralMarker` (12aa, #1877), not for accuracy. A wrong-but-open
  issue delays the pull request rather than escaping the cap. The loop guard
  in `pr_ci_processor.ts` bounds that delay: it reads the state of the
  **prior deferral's own** blocker, and once that blocker closes it refuses a
  second deferral — whatever issue the agent now names — so the ordinary path
  runs and the attempt cap escalates.
- **A check absent from the base reads as not red.** A base branch that never
  ran the check — a workflow added on the PR branch — is treated as "cannot
  verify" and the ordinary path charges an attempt. That is the safe direction:
  it costs one attempt rather than parking the pull request on an unverified
  claim.
