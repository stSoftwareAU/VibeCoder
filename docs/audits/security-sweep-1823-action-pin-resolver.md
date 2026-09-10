# Security sweep — action pin resolver (`action_pin_resolver.ts`)

**Issue:** [#1823](https://github.com/stSoftwareAU/VibeCoder/issues/1823)
(chunk 12o) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12n) recorded their coverage:

- `worker/deno/lib/action_pin_resolver.ts` — added by #1823.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12o**, and this file is
the reading of it.

## `worker/deno/lib/action_pin_resolver.ts`

The module turns each `PINNED_ACTIONS` entry into the commit SHA of the
highest upstream release that has cleared the supply-chain quarantine window,
falling back to the catalogue SHA with a logged reason. Two `gh api` lookups
per action, both issued as argv arrays through an **injected** runner; the
parsers (`parseGhReleaseListing`, `parseGhCommitLine`) and the window
evaluator (`evaluateReleaseAge`, `normaliseQuarantineHours`) are reused from
`tool_release_age.ts`, which is swept in slice 12e.

Shapes checked (12a's argv slice and 12c's untrusted-ingestion slice both
apply, since the module builds a `gh` argv from upstream-supplied text):

| Property | Result |
| -------- | ------ |
| no spawn, no shell | no `Deno.Command`; commands are `string[]` argv handed to `deps.runFn`, never a shell string — no interpolation reaches a shell |
| API path interpolation | the two interpolated values are validated first: the action against `ACTION_PATTERN` (`owner/repo`, no `/` beyond one, no traversal) and the release tag against `RELEASE_TAG_PATTERN` (`v?MAJOR.MINOR.PATCH`), so a hostile tag cannot redirect the request |
| no filesystem, no temp files | no `Deno.readTextFile`/`writeTextFile`/`makeTempDir` |
| environment | reads `VIBE_BUMP_QUARANTINE_HOURS` only, through `normaliseQuarantineHours`, which rejects anything that is not a positive whole number and falls back to the documented 24h floor — the embargo cannot be silently switched off; no secret is read or logged |
| no clock, no randomness | `now` is injected and sampled once per resolution, so the window is evaluated against a single instant |
| untrusted input is data, never a sink | tag names and commit output come from upstream. Tags reach the API path only after two independent filters (the parser's stable-semver rule, then `RELEASE_TAG_PATTERN`); a SHA is accepted only when it matches `^[0-9a-f]{40}$`, and `applyResolvedPins` re-checks that shape before writing a ref into a template |
| no invented pin | every emitted SHA came either from the runner's own output or from the catalogue — there is no path that synthesises one |
| no silent failure | every fallback appends to `failures` **and** emits exactly one `[workflow-sync] pin resolution failed: <action> — <reason>` line. The one `catch` in the module turns a *rejecting* runner into that same reported fallback rather than discarding it, so a throwing runner cannot abort the catalogue mid-way and leave the remaining actions unresolved and unreported |

`resolveGitHubReleaseHistory` in `tool_release_age.ts` was widened from
`Promise<ReleaseCandidate[]>` to `Promise<Result<ReleaseCandidate[]>>` so this
module can distinguish "the lookup did not run" from "upstream publishes no
stable release". The quarantine gate's own caller maps an error back to an
empty history, so its fail-closed behaviour is unchanged.

No findings. The accepted residual: the resolver trusts GitHub's release
metadata for `owner/repo`, so an attacker who can publish a release in an
upstream action's repository and wait out the quarantine window is pinned to.
That is the known limit of a time-based embargo and is unchanged by this
module — what it removes is the *stale* pin, which the Actions audit
(check 16) reports on every provisioned repository.
