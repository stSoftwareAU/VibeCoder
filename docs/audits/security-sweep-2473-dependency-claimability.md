# 🔎 Security sweep — dependency claimability (`dependency_claimability.ts`)

**Issue:** [#2473](https://github.com/stSoftwareAU/VibeCoder/issues/2473) (chunk
top-up-2473) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2473:

- `worker/deno/lib/dependency_claimability.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2473**, and this file is the reading of it.

## `worker/deno/lib/dependency_claimability.ts`

One pure export, `findDependencyStall`, plus the types it takes. It reads a list
of blockers and a caller-supplied context (the needs-human label name, the
fleet-author allowlist, the visible open issues, an optional merged-PR
predicate) and returns the first blocker that is stalled — needs-human, assigned
to a non-fleet author, or permanently blocked by a merged PR — or `null`. No
I/O, no subprocess, no environment read, no permission beyond what the caller
already holds; the only data it touches is what the caller passes in.

| Input                                | Decision                    | Handling                                                                              |
| ------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------- |
| cross-repo blocker                   | skipped                     | cannot be escalated from this repo, so it stays an ordinary block, never a stall      |
| blocker not in the visible issue set | skipped                     | absent data is treated as claimable, not as a stall — no escalation on a partial view |
| needs-human label present            | `needs-human` stall         | the label name itself is the detail, so the caller reports what it matched            |
| merged-PR predicate true             | `merged-pr-permanent` stall | only trusted re-approval lifts it, so escalation is the correct route                 |
| assignee outside `fleetAuthors`      | `assigned` stall            | the assignee login is the detail; a fleet author never stalls                         |

Escalation is the caller's side effect — `collectWorkOnCandidates`
(`worker/deno/lib/collect_work_on_candidates.ts:601`) is the sole consumer and
owns every write. The classifier itself cannot label, comment, or claim, so a
wrong verdict here can only change which candidate the scan reports, never
mutate GitHub state directly. The `detail` string is a label name or an assignee
login taken from GitHub data the caller already fenced as untrusted; it is
reported, never interpolated into a command or a path.
