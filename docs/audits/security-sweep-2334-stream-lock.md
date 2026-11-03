# 🔎 Security sweep — the milestone stream lock (`stream_lock.ts`)

**Incident:** [#2334](https://github.com/stSoftwareAU/VibeCoder/issues/2334)
(chunk top-up-2334) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
with the fleet-wide milestone stream lock:

- `worker/deno/lib/stream_lock.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2334**, and this file is the reading of it.

## `worker/deno/lib/stream_lock.ts`

The module answers one question before a claim is taken: is another **open**
issue of this issue's milestone already being run somewhere in the fleet? It
reads the milestone's open issues with one `gh issue list`, parses the heartbeat
markers and `CLAIM_LOCK` comments the listing carries, and reports
`{ busy: true, holderIssue, holderHost }` or `{ busy: false }`. It writes
nothing, spawns nothing directly, and touches no file.

| Input              | Source                                                                     | How it is handled                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repo`             | the worker's own configured repository slug                                | passed to `resolveStreamId`, which throws unless it is exactly `owner/name`, then supplied to `gh` as one argv element — never interpolated into a shell string                |
| `milestoneTitle`   | fetched back from GitHub — **untrusted**: anyone with write access sets it | supplied to `gh` as a single `--milestone` argv value (no shell), and rendered into a log line only through `streamLabel`; never used to build a path, a command or Markdown   |
| comment bodies     | fetched back from GitHub — **untrusted**: any GitHub user can comment      | parsed only by `parseHeartbeatMarker` and a literal `CLAIM_MARKER_PREFIX` substring test; a body that matches neither is ignored, and a body is never executed or interpolated |
| comment authors    | `gh` (`author.login`) — the only authenticated part of a marker            | `isFleetAuthor` filters every comment against the caller's fleet union, so a forged heartbeat or `CLAIM_LOCK` from outside the fleet holds no stream                           |
| `createdAt`        | `gh`                                                                       | `Date.parse`; a non-finite result is skipped rather than treated as fresh, and a negative age (clock skew, a future timestamp) does not count as recent                        |
| the listing itself | `gh` stdout                                                                | `JSON.parse` inside a `try`; a non-array or unparseable payload is a loud warning and a fail-open, never a silent "the stream is free"                                         |

| Property                   | Result                                                                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| injection surface          | one `gh` invocation through the caller's injected runner, built as an argv array. No shell, no string concatenation of untrusted values into a command                                                                                                                             |
| denial of service          | a forged marker cannot hold a stream (author filter), and a genuine one holds it only inside `LIVE_HEARTBEAT_WINDOW_SECONDS` / `RECENT_CLAIM_WINDOW_MS` — a crashed run's stale marker releases the stream rather than shutting it                                                 |
| regex safety               | two patterns: the claim-host capture `/on host \`([^\`]+)\`/u`(unanchored, one negated character class under a single quantifier) and`hostFromMachineId`'s anchored UUID suffix. Neither nests a quantifier, so neither has a backtracking surface                                 |
| cost                       | bounded at one `gh issue list` per candidate, capped at `STREAM_LOCK_ISSUE_LIMIT` (100) issues. The blank stream makes no call at all                                                                                                                                              |
| cache                      | deliberately not served from `IssueCache`: its 600 s TTL outlives the liveness window, so a cached snapshot would report a finished run as live and a live one as free                                                                                                             |
| fail direction             | fail open, loudly — a `gh` outage or a malformed payload logs `stream_check_failed` and lets the claim proceed, matching every other pre-claim check, and a listing that filled the page logs `stream_listing_truncated`. Absence of a listing is never reported as a clean "free" |
| spawn, network, filesystem | none of its own; every API call goes through the caller's injected `gh` runner                                                                                                                                                                                                     |
| secret surface             | holds no credential; the warning it logs quotes the repository, the issue number, the stream label and the error message                                                                                                                                                           |
| blast radius               | one caller — `preClaimFreshnessCheck` in `claim_issue.ts`, and only when the caller sets `streamLockEnabled` (the standard pipeline's setup phase, with `enable_session_resume` on)                                                                                                |

## Findings

None. No input reaches a shell, a path or a filesystem call; every untrusted
value is either filtered by author, parsed by a marker parser that returns
`null` on anything unrecognised, or passed to `gh` as a single argv element.
