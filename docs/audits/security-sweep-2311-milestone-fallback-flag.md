# 🔎 Security sweep — the milestone fallback flag (`milestone_fallback_flag.ts`)

**Incident:** [#2311](https://github.com/stSoftwareAU/VibeCoder/issues/2311)
(chunk top-up-2311) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
with the milestone half of the `merge-fallback` flag:

- `worker/deno/lib/milestone_fallback_flag.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2311**, and this file is the reading of it.

## `worker/deno/lib/milestone_fallback_flag.ts`

When a milestone branch spends its two-run conflict budget and the roll-back
runs, this module turns what the sync observed into one `merge-fallback` filing
and reports the issue number back so the roll-back notice can link it. It holds
no credential, spawns nothing, and writes nothing to GitHub itself — the filing
goes through the injected `fileMergeFallbackFn`
(`merge_fallback_issue.ts`, swept with Issue #2304) and the one read it makes
goes through the sync's injected `ghCommandFn`.

| Input                              | Source                                                               | How it is handled                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`, milestone and default branch | the sync's own milestone listing                                    | passed as argv elements to `gh api`; never interpolated into a shell. The flag builder sanitises them again before they reach an issue body     |
| `lastSyncedDefaultSha`             | the host-local ledger (`milestone_sync_failures.json`)                | read back through `loadSyncStreaks`, which drops any malformed field; used only as one `gh api …/compare/<sha>...<branch>` argv element         |
| each spent run's record            | the same ledger — `reason`, `host`, `timings`, `analysis`             | rendered into the filing; `parseStageTimings` drops anything it cannot read rather than inventing a duration                                     |
| the conflict's per-file reasons    | the ladder's own `MilestoneConflictEscalation`, which quotes an agent | treated as untrusted text: it is rendered by `merge_fallback_issue.ts`, which sanitises it, caps it at 20,000 characters and fences it safely |
| the roll-back outcome              | `executeRollback` in this worker                                     | only PR numbers and revert SHAs are rendered                                                                                                    |

| Property          | Result                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| spawn chokepoints | none of its own; the one GitHub read uses the caller's injected `ghCommandFn`, the filing the caller's injected filer                                                                                |
| prompt injection  | it builds no prompt and calls no model                                                                                                                                                              |
| what is written   | at most one `merge-fallback` issue (filed or appended by the shared filer) and one self-heal event. Nothing is labelled, closed or reopened here, and no `needs-human` is applied anywhere on this path |
| network           | none beyond the injected `gh` calls                                                                                                                                                                 |
| regex safety      | one anchored, linear match in `parseStageTimings` (`conflict_stage_timer.ts`); this module runs no regex of its own                                                                                  |
| filesystem        | none                                                                                                                                                                                                |
| secret surface    | holds no credential; log lines carry the repo, the branch, the flag number and an error message                                                                                                     |
| fail direction    | fail-loud, never fail-silent: a failed filing is logged `WARNING:` and reported as `undefined`, and the notice then tells the reader the record is missing instead of linking to nothing. A failed `compare` leaves `behindSince` unrecorded, which the flag renders as `not recorded` |
| blast radius      | reached only after a branch has spent its budget and the roll-back has run — never on an ordinary sync cycle                                                                                        |
