# 🔎 Security sweep — milestone-close housekeeping (`milestone_close_housekeeping.ts`)

**Incident:** [#2338](https://github.com/stSoftwareAU/VibeCoder/issues/2338)
(chunk top-up-2338) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
with the milestone-close sweep:

- `worker/deno/lib/milestone_close_housekeeping.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2338**, and this file is the reading of it.

## `worker/deno/lib/milestone_close_housekeeping.ts`

The module runs once per scan per monitored repository. It lists the
repository's closed milestones through `gh`, matches each against this host's
lane worktrees, local branches and stream session record, and removes what it
matches. It deletes directories, local git branches and one JSON file under the
work root — so the interesting question is what an attacker-controlled
**milestone title** or **branch name** can reach.

| Input                | Source                                                                      | How it is handled                                                                                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`               | the worker's configured repository list                                     | tested against `^[^/\s]+\/[^/\s]+$` before anything is built from it; a repository that fails is refused with no filesystem or `gh` call at all                                                                                                                                               |
| milestone **title**  | GitHub, i.e. anybody who can edit a milestone                               | never executed and never joined into a path. It reaches `createMilestoneBranchName` (which reduces it to `[a-z0-9-]`, 50 chars) and `streamKey` (a single `[a-z0-9_-]` path segment). It is also a **JSON value** in the state file and a log string — never a filename component in raw form |
| milestone **number** | the same `gh` response                                                      | accepted only as a safe positive integer, then interpolated into a query string, never a path                                                                                                                                                                                                 |
| child issue numbers  | the same                                                                    | safe positive integers only; matched against `^issue-(\d+)(?:-\|$)` captured from a **local** branch name, so the removal set is the intersection of what git already has and what GitHub says                                                                                                |
| local branch names   | `git for-each-ref`, i.e. the clone itself                                   | passed to git in argv (never a shell string) through `runGitCommand`; only names git itself reported are ever deleted                                                                                                                                                                         |
| worktree paths       | `git worktree list --porcelain`, parsed by the existing `parseWorktreeList` | handed straight back to `git worktree remove`, which resolves them against its own administration. No path is constructed here from external input                                                                                                                                            |
| state file           | `<workDir>/.milestone-close-housekeeping/<repo-slug>.json`                  | the slug is `repo.replace(/[^a-zA-Z0-9]/g, "-")`, so it carries no `/`, no `..` and no leading `.`. A corrupt or unreadable file is announced and rebuilt, never trusted                                                                                                                      |

| Property       | Result                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| path safety    | builds exactly two paths — the state file above and `streamSessionPath`, whose single segment comes from the injective, filesystem-safe `streamKey`. Every other path it touches was reported by git                                                                                                         |
| spawn          | none of its own: `gh` goes through `runGhCommand` (timeout, retry, rate-limit short-circuit) and git through `runGitCommand` (timeout, audit journal). Both take argv arrays, so no title or branch name is ever shell-interpreted                                                                           |
| destructive    | yes, and deliberately bounded: it deletes only a worktree git lists, a local branch git lists, and one stream record. It never touches a remote, never force-pushes, and never deletes the default branch — a branch is removed only after git confirms every commit on it is reachable from some remote ref |
| fail direction | refuse and keep. An unreadable `git status`, an unreadable `git log`, a failed `for-each-ref` or a failed `gh` all leave the artefact in place. Losing a directory is unrecoverable; keeping one costs disk                                                                                                  |
| silent success | impossible by construction — a milestone is recorded as swept only when **both** its failure list and its error list are empty. The absence of a failure is never read as a completed sweep, and a malformed `gh` response throws rather than parsing as "no milestones"                                     |
| network        | two read-only `gh api` GETs per closed, unswept milestone; none once the swept set covers it                                                                                                                                                                                                                 |
| filesystem     | reads the state file and the stream record; writes the state file; removes worktree directories and the stream record. All under the work root, never inside a repository checkout                                                                                                                           |
| privilege      | none granted or checked here; it runs with the worker's own `gh` credential and performs no mutation on GitHub                                                                                                                                                                                               |
| secret surface | holds no credential. The log lines carry a milestone title, a branch name, a worktree path and git's own stderr — no token and no file content                                                                                                                                                               |
| regex safety   | three anchored, non-backtracking patterns (`^[^/\s]+\/[^/\s]+$`, `^issue-(\d+)(?:-\|$)`, `^refs\/heads\/`) and one page splitter (`\]\s*\[`). None nests a quantified group, so none can backtrack catastrophically                                                                                          |
| blast radius   | one repository's local clone on one host. A fault costs a worktree or branch surviving until the next scan or the existing time-based cleanups; no issue, PR or remote state is affected                                                                                                                     |
