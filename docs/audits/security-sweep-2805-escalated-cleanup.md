# 🔎 Security sweep — escalated clean-up sweep (`escalated_cleanup.ts`)

**Issue:** [#2805](https://github.com/stSoftwareAU/VibeCoder/issues/2805) (chunk
top-up-2805) · **Parent:** #2788

This is the written record for the one module that entered `worker/deno/lib/`
under #2805:

- `worker/deno/lib/escalated_cleanup.ts`

The same change deleted `worker/deno/lib/escalate_as_work.ts`, so its path left
slice 12c.

## `worker/deno/lib/escalated_cleanup.ts`

Each stall-repair pass sweeps every monitored repository: it removes the
`escalated` label from open PRs and closes open `PR #N cannot land: …` issues a
fleet account filed. Every `gh` call goes through the injected `ghCommandFn` as
an argument vector — no shell, no string-built command.

| Input            | Source                                   | Handling                                                                                                                                                                                            |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escalated` PRs  | `gh pr list --label escalated`           | applying a label needs triage permission; the only write is removing that same label, which cannot harm a PR                                                                                        |
| issue title      | `gh issue list --search` (anyone writes) | must match `^PR #(\d+) cannot land:` exactly; the PR number is parsed as digits only and rendered as `#N` in the worker's own comment                                                               |
| issue author     | `gh issue list --json author` (verified) | the close is a destructive write, so it runs only on rows `selectFleetAuthoredMatches` keeps. A human-filed issue with the same title is untouched, and an unresolved fleet identity closes nothing |
| payload shape    | `gh` JSON output                         | parsed as `unknown`; an unparseable or non-array listing is logged and counted as a failure, and a row without an integer `number` is dropped                                                       |
| repository lease | `acquireMaintenanceRepoLease`            | every write runs under the lease, released in `finally`; a held lease defers the sweep with a warning                                                                                               |

Every `gh` failure is logged at error level with the repository and the PR or
issue number, and counted in the returned `failures`, so a failed listing is
never read as a clean repository.
