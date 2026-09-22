# Security sweep — the cross-host milestone sync claim (`milestone_sync_claim.ts`)

**Issue:** [#2030](https://github.com/stSoftwareAU/VibeCoder/issues/2030)
(chunk top-up-2030) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2030:

- `worker/deno/lib/milestone_sync_claim.ts` — added by #2030.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2030**, and this file is the reading of it.

## `worker/deno/lib/milestone_sync_claim.ts`

Takes and releases a per-branch claim on the remote before the milestone sync
spends its agent rung, so two hosts never resolve the same sync at once. The
claim is a hidden ref `refs/vibe/sync-claims/<milestone-branch>` pointing at a
`commit-tree` object over the milestone tip (its committer date is the claim
time). Every git call goes through `runGitCommand` (`git_timeout.ts`); the
module never spawns anything itself and never touches the working tree or the
index.

Untrusted inputs, and how each reaches git:

| Input | Source | How it reaches git |
| ----- | ------ | ------------------ |
| `milestoneBranch` | derived from a GitHub milestone title | `assertSafeGitRef` before any git runs; then only inside `refs/remotes/origin/<branch>^{commit}` and `refs/vibe/sync-claims/<branch>` — never a bare positional |
| `hostLabel` | the worker's own id | inside the `-m` message of `commit-tree`, never an argv option |
| commit SHAs | git's own output (`rev-parse`, `commit-tree`, `log`) | 40-hex strings, interpolated into refspecs and `--force-with-lease=<ref>:<sha>` |

| Property | Result |
| -------- | ------ |
| no spawn, no argv | every process is `runGitCommand`; no `Deno.Command` here |
| argument injection | the branch name is validated up front; refs are built from a fixed prefix; the only free text (`hostLabel`, a timestamp) is a `-m` value |
| remote writes | two: the claim ref (create, or take over a stale one, each `--force-with-lease` against an exact expectation) and its deletion. No branch, no tag, no PR; rulesets targeting `refs/heads/**` and `refs/tags/**` are untouched |
| atomicity | a take expects the ref absent; a take-over expects the exact stale SHA; two hosts cannot both succeed |
| resource bounds | one commit object per claim; each git call carries `git_timeout.ts`'s per-operation timeout; a claim never released expires by TTL (2 h) |
| fail direction | any unreadable or unwritable claim is `unknown` and the caller proceeds as if there were no claim — duplicate work, never a stalled sync |
| secrets | nothing here reads or logs credentials |

No finding. The one deliberate trust decision is that the claim is advisory:
a host that cannot reach the claim namespace syncs anyway, because a fleet
that stops syncing when it cannot coordinate is the worse failure.
