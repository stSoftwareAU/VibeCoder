# Security sweep — the shared clone ref sweep

**Issue:** [#2889](https://github.com/stSoftwareAU/VibeCoder/issues/2889) (chunk
top-up-2889) · **Parent:** #1209

This is the written record for the three modules that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12af) recorded their coverage:

- `worker/deno/lib/shared_clone_ref_sweep.ts` — added by #2889.
- `worker/deno/lib/shared_clone_ref_provenance.ts` — added by #2889.
- `worker/deno/lib/shared_clone_repair_history.ts` — added by #2889.

## `worker/deno/lib/shared_clone_ref_sweep.ts`

The module periodically sweeps every shared clone for broken refs: NUL-filled
loose ref files found by walking `refs/heads` and `refs/remotes` directly, and
refs `git for-each-ref` names in its stderr when it aborts on a missing object.
Each broken ref is repaired (restored from a packed-refs copy, re-fetched from
origin, or deleted) and the repair is handed to `collectProvenance` (below) and
`recordRepairAndMaybeEscalate` (below). This is a subprocess/argv (12a) and
filesystem (12b) module.

Shapes checked:

| Property                                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ref names from the directory walk cannot escape the repair paths                           | `findNulFilledRefs` never parses text: it enumerates real `Deno.readDir` entries, skips symlinks before recursing into them, and joins only the returned entry names. A directory entry cannot itself be `..` (`readDir` never yields `.` or `..`), so the resulting `ref` string cannot carry a traversal component                                                                                                                                                                                                                                                                                                                                                                          |
| the NUL-filled loose ref path is confined to the git common directory before `Deno.remove` | `repairNulFilledRef` checks `looseRefPath.startsWith(`${ctx.commonDir}/`)` before removing, but — unlike `broken_ref_repair.ts`'s realpath-against-`git rev-parse --git-common-dir` control — this is a plain string-prefix check, not a symlink-aware `realPath` check. It is not exploitable in practice, because (per the row above) the path is built purely from an enumerated, symlink-free directory walk under a git-resolved `commonDir`, not from parsed/attacker-influenced text; the check is confirmed to hold for every input this module can produce, but it is a weaker construction than 2880's and would not catch a `commonDir` itself resolved through a symlinked `.git` |
| ref names parsed from `for-each-ref` stderr are validated before reaching git argv         | broken refs come from `brokenRefsIn` (`broken_ref_repair.ts`, already swept under #2880), which runs every candidate through `assertSafeRefComponent` before returning it; this module additionally re-checks branch components with its own `isSafeBranchName` (rejects `..`, any git-unsafe character, and anything failing `assertSafeRefComponent`) before building a refspec or passing a branch as a positional                                                                                                                                                                                                                                                                         |
| every fetch/delete built from a validated branch name uses `--end-of-options`              | `git fetch --end-of-options <remote> <refspec>` and `git update-ref -d --end-of-options <ref>` place the marker before the first untrusted positional, so a validated-but-dash-leading branch (already impossible, since `isSafeBranchName` rejects a leading `-`) still could not be reinterpreted as a flag                                                                                                                                                                                                                                                                                                                                                                                 |
| failures are surfaced, not swallowed                                                       | every failure path — unresolved common dir, failed `for-each-ref`, failed removal, failed fetch, failed `update-ref`, an unrecognised `origin` check result — pushes the ref (or a fixed label) onto `outcome.failures` and calls `deps.logError`; nothing degrades to a silent no-op, and a throw from one repo in `sweepSharedClones` is caught and reported without stopping the remaining repos                                                                                                                                                                                                                                                                                           |
| a lane holding the repo lease is respected, not bypassed                                   | `acquireMaintenanceRepoLease` returning `null` short-circuits the sweep for that repo with a `skipped: "leased"` outcome and a self-heal event; the lease is always released in a `finally`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| no untrusted GitHub API data                                                               | every input is the worker's own git subprocess output (`for-each-ref` stderr, `rev-parse`, `ls-remote`, `fetch` stderr) or the local filesystem; there is no `gh` call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## `worker/deno/lib/shared_clone_ref_provenance.ts`

The module collects best-effort last-writer provenance for one repaired ref —
the loose ref file's mtime, the last reflog line, worktrees with the branch
checked out, and nearby `oom-*` log names — so an escalation has something to
point at. Every call is read-only.

Shapes checked:

| Property                                                                 | Result                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all reads are read-only and bounded                                      | `Deno.lstat`, `Deno.readTextFile` (reflog), `git worktree list --porcelain`, and `Deno.readDir`/`Deno.stat` over `logsDir` are the only operations; nothing writes or deletes                                                                                                                                                                                    |
| a missing ref file, reflog or `logsDir` is not an error                  | each read narrows the caught error to `Deno.errors.NotFound` and continues with that field left unset; any other error is logged with `deps.log` (not swallowed silently) but still does not abort provenance collection for the remaining fields                                                                                                                |
| the reflog line is bounded before it is stored                           | `lastReflogEntry` is truncated with `.slice(0, 300)`, so an unexpectedly large reflog entry cannot be carried unbounded into a self-heal event                                                                                                                                                                                                                   |
| the `oom-*` scan is bounded to a fixed directory and a fixed time window | `nearbyOomLogs` only reads `deps.logsDir` (an injected, worker-controlled path — never derived from the ref or from git output), only considers files (symlinks/directories are excluded by `entry.isFile`), only names starting with `oom-`, and only within a fixed ±15-minute window of the ref's mtime; the directory is read once per call, not recursively |
| the `git worktree list` parse does not trust arbitrary lines             | `checkedOutWorktrees` only extracts `worktree` and `branch` prefixed lines from git's own stdout and compares the branch to the exact `refs/heads/<branch>` string already validated by the caller; a non-matching or malformed line is simply ignored                                                                                                           |
| no untrusted GitHub API data                                             | every input is a local `Deno.*` filesystem call or a `git worktree list` subprocess; there is no `gh` call                                                                                                                                                                                                                                                       |

## `worker/deno/lib/shared_clone_repair_history.ts`

The module appends this sweep's repair to a small per-workDir JSON file
(`.shared-clone-ref-repairs.json`) and escalates loudly — logging and emitting a
self-heal event — when a repo has been repaired more than the threshold number
of times inside a rolling 24-hour window.

Shapes checked:

| Property                                                       | Result                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the history file read only tolerates "file does not exist yet" | `Deno.readTextFile` is caught; only `Deno.errors.NotFound` is treated as the normal first-run case (start fresh, no log). Any other read error still starts fresh but is logged with `deps.logError` naming the repair history as corrupt, rather than throwing and losing the escalation check for this sweep |
| the parsed JSON is shape-checked before use                    | after `JSON.parse`, the result must be a non-null object with a `repairs` field that is itself an object, or the code throws internally and falls into the same "start fresh" path as a read failure; a corrupt or unexpectedly-shaped file cannot crash the sweep or be trusted as-is                         |
| the write is not-in-place                                      | the new history is written to a `crypto.randomUUID()`-suffixed temp path and only `Deno.rename`d over the real path on success; a failed write is logged and the temp file is cleaned up (its own removal failure, other than not-found, is also logged) rather than left behind or silently ignored           |
| escalation is based on a bounded, time-windowed count          | only timestamps within `REPAIR_WINDOW_MS` (24h) of `now()` are kept per repo before the current repair is appended, so the count driving escalation cannot grow without bound from old history                                                                                                                 |
| failures are surfaced, not swallowed                           | a corrupt history file, a failed write, and a failed temp-file cleanup are all logged via `deps.logError`; none of them prevents the current repair timestamp from being recorded in memory or considered for escalation                                                                                       |
| no untrusted GitHub API data                                   | the only inputs are the local history file, the caller's `now()` clock and the in-memory sweep outcome; there is no `gh` call                                                                                                                                                                                  |

No exploitable finding was identified in these three modules. One control is
weaker in construction than its counterpart in `broken_ref_repair.ts` (#2880):
the NUL-filled loose ref path check in `shared_clone_ref_sweep.ts` is a
string-prefix comparison rather than a symlink-aware `realPath` check against
the git common directory. It is not exploitable today because the path is always
built from a live, symlink-free directory walk rather than from parsed
git-stderr text — but it relies on that invariant holding, so a future change
letting an attacker-influenced string reach `repairNulFilledRef` without going
through the directory walk first would not be caught by this check alone. No
code change was made; this is reported for follow-up, not fixed here.
