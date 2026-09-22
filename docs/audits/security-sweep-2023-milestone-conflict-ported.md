# Security sweep — the milestone sync's ported rule (`milestone_conflict_ported.ts`)

**Issue:** [#2023](https://github.com/stSoftwareAU/VibeCoder/issues/2023)
(chunk top-up-2023) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2023:

- `worker/deno/lib/milestone_conflict_ported.ts` — added by #2023.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2023**, and this file is the reading of it.

## `worker/deno/lib/milestone_conflict_ported.ts`

A rung of the milestone sync's conflict ladder. It reads the conflicted index's
stage blobs, asks each branch's history whether it ever carried the other
side's exact version of a path (`git log --find-object=<blob>`), and
stages the side that provably contains the other. Every git call goes through
`runGitCommand` (`git_timeout.ts`), the timeout- and audit-guarded chokepoint;
the module never spawns anything itself and writes nothing outside the clone's
index and working tree.

Untrusted inputs, and how each reaches git:

| Input | Source | How it reaches git |
| ----- | ------ | ------------------ |
| `milestoneBranch` | derived from a GitHub milestone title | `assertSafeGitRef` before any git runs; used only in log text (the index is read at `HEAD`) |
| `defaultBranch` | the repository's default branch (GitHub API / clone metadata) | `assertSafeRefComponent` before any git runs; then positional after `--end-of-options` in `log` |
| conflicted paths | `git diff --name-only --diff-filter=U` on the clone under merge — repository-chosen names | always after `--` (`ls-files -u -- …`, `rev-list … -- path`, `checkout --ours/--theirs -- path`, `add -- path`) |
| blob ids | `git ls-files -u` output | 40-hex strings from git itself, interpolated into `--find-object=<sha>` |

| Property | Result |
| -------- | ------ |
| no spawn, no argv | every process is `runGitCommand`; no `Deno.Command` here |
| argument injection | branch names validated up front; paths always follow `--`; the default branch follows `--end-of-options`; blob ids are git's own hex |
| side effects on the shared clone | only `checkout --ours/--theirs -- path` and `add -- path` for a path the rule decided; an undecided path is untouched, and a failed stage listing leaves every path untouched |
| resource bounds | one bounded `log --max-count=1` per side per path; each git call carries `git_timeout.ts`'s per-operation timeout; no temporary files or worktrees |
| secrets | nothing here reads or logs credentials; log lines carry branch names, counts, paths and short SHAs |
| fail direction | every failure to read leaves the path undecided with the reason; the agent rung below sees the same paths it would have seen without this module |

No finding. The one deliberate trust decision is that a byte-identical
historical blob is proof the other side absorbed this side's version: that is
what makes the resolution a union rather than a side-pick, and it is why the
rule refuses to decide from anything weaker.
