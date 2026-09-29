# 🔎 Security sweep — blocking-PR stall repair (`stall_repair.ts`)

**Issue:** [#2802](https://github.com/stSoftwareAU/VibeCoder/issues/2802) (chunk
top-up-2802) · **Parent:** #2788

This is the written record for the one module that entered `worker/deno/lib/`
under #2802:

- `worker/deno/lib/stall_repair.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2802**, and this file is the reading of it.

## `worker/deno/lib/stall_repair.ts`

The module repairs a PR that blocks a `work-on` issue: on the first trip it
posts a hidden trip marker, syncs the branch and reruns the owning lane once; on
the second trip it abandons the PR through `abandonAndRestart`. Every `gh` call
goes through the injected `ghCommandFn` as an argument vector — no shell, no
string-built command.

| Input              | Source                                        | Handling                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR author          | `gh pr view` (GitHub-verified login)          | only a fleet author (`isFleetAuthor`) is repaired; anyone else is logged and left alone                                                                                                                                                                                                                                                              |
| PR thread comments | `fetchIssueCommentPages` (anyone can comment) | parsed defensively as `unknown`; a trip or cap marker counts only when a fleet login posted it (Issue #1247), so an outsider cannot fast-forward the ladder to an abandon                                                                                                                                                                            |
| stall detail       | `blocking_pr_stall_detector.ts`               | carries failing check names, which a fork chooses. **Finding, fixed here:** the detail was echoed raw into the worker's own trip comment, so a check name holding the auto-fix cap marker forged a fleet-authored cap and forced an abandon on the next pass. The detail now passes through `neutraliseAgentMarkers`; `stall_repair_test.ts` pins it |
| branch names       | the PR's `headRefName` / `baseRefName`        | passed to the injected `syncBranch` and `abandonAndRestart`, which own their own ref validation; a missing branch fails loudly as `failed`                                                                                                                                                                                                           |
| repository lease   | `acquireMaintenanceRepoLease`                 | every write runs under the lease and is released in `finally`; a held lease defers the repair with a warning rather than racing another host                                                                                                                                                                                                         |

Every failure — an unreadable thread, a failed marker post, a failed sync, lane
rerun or abandon — is logged at warn or error level and returned as a named
action, so nothing is recorded as a silent success.
