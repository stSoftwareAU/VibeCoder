# 🔎 Security sweep — stream affinity (`stream_holder.ts`)

**Incident:** [#2336](https://github.com/stSoftwareAU/VibeCoder/issues/2336)
(chunk top-up-2336) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
with the stream-affinity head start:

- `worker/deno/lib/stream_holder.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2336**, and this file is the reading of it.

## `worker/deno/lib/stream_holder.ts`

The module records which host last ran a milestone stream, and decides whether
another host waits for it. It writes one hidden marker comment on the
milestone's tracking issue when a run finishes, reads that marker before a
claim, and answers `{ defer, holderHost, secondsLeft }`. Its only filesystem
write is the deletion of this host's own stream record on a hand-over
(`deleteStreamSession`, under the worker's `workDir`).

| Input               | Source                                                                     | How it is handled                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`              | the worker's own configured repository slug                                | passed to `resolveStreamId`/`streamKey`, which throw unless it is exactly `owner/name`, then supplied to `gh` as one argv element — never interpolated into a shell string              |
| `milestoneTitle`    | fetched back from GitHub — **untrusted**: anyone with write access sets it | matched against `^#(\d+)\b` for the tracking issue number, hashed into the stream key, and rendered into a log line only through `streamLabel`; never used to build a path or a command |
| tracking issue no.  | derived from that title                                                    | `Number.parseInt` + `Number.isSafeInteger` and `> 0`; anything else yields `null` and the write is skipped, so no API path is ever built from a non-number                              |
| comment bodies      | fetched back from GitHub — **untrusted**: any GitHub user can comment      | parsed only by `HOLDER_MARKER_RE`, a fully character-classed pattern; a body that does not match is ignored, and a body is never executed or interpolated                               |
| comment authors     | `gh` (`user.login`) — the only authenticated part of a marker              | `isFleetAuthor` filters every comment against the caller's fleet union, so a forged holder marker from outside the fleet holds no stream                                                |
| `host` (written)    | `getMachineId` on this machine                                             | `sanitiseField` reduces it to `[A-Za-z0-9._-]`, so it can carry neither whitespace nor the `-->` that would end the comment early                                                       |
| the comment listing | `gh` stdout                                                                | `parseMarkerCommentPages` throws on a malformed page; the `catch` logs and fails open, never a silent "no holder"                                                                       |

| Property                   | Result                                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| injection surface          | `gh` invocations through the caller's injected runner, each built as an argv array. No shell, no string concatenation of untrusted values into a command                                                                                                         |
| denial of service          | bounded by construction: a forged marker cannot hold a stream (author filter), and even a genuine one only ever costs `STREAM_AFFINITY_GRACE_SECONDS` (300 s) measured from **this host's own** first sighting — so no attacker-supplied timestamp can extend it |
| regex safety               | two patterns: `HOLDER_MARKER_RE` (literal separators between single-quantifier character classes, `at=` bounded to 15 digits) and `MILESTONE_PARENT_RE` (anchored, one quantifier). Neither nests a quantifier, so neither has a backtracking surface            |
| cost                       | one paginated `gh api .../comments` read per affinity check and per holder write, plus one PATCH or POST. The blank stream makes no call at all                                                                                                                  |
| cache                      | not cached: the marker changes every time a stream run ends, and a stale read would hand a stream to the wrong host                                                                                                                                              |
| fail direction             | fail open, loudly — a `gh` outage, an unresolvable repository or a milestone with no tracking issue logs and lets the claim proceed. Affinity is an optimisation, never a lock, and an unread marker is never reported as "no holder"                            |
| spawn, network, filesystem | no spawn and no network of its own; every API call goes through the caller's injected `gh` runner. One filesystem write — `deleteStreamSession` on a hand-over — under the worker's own `workDir`, path-built by `streamKey`, which yields a single safe segment |
| secret surface             | holds no credential; the marker carries only the stream key, a machine id and an epoch, and the log lines quote the repository, the issue number, the stream label and the error message                                                                         |
| blast radius               | two callers — `preClaimFreshnessCheck` in `claim_issue.ts` (only when the caller sets `streamLockEnabled`, i.e. the standard pipeline's setup phase with `enable_session_resume` on), and the execute phase's holder write                                       |

## Findings

None. No input reaches a shell or an unbounded path; the one filesystem write is
keyed by `streamKey`, which is a single `[a-z0-9_-]` segment carrying no `/`, no
`..` and no leading `.`. Every untrusted value is either filtered by author,
parsed by a pattern that returns `null` on anything unrecognised, or passed to
`gh` as a single argv element.
