# PR Summary — Issue #1064

Closes #1064.

## Summary

Locking and scheduling exist only between Vibe Coders. There is no locking or
scheduling between humans and Vibe Coders. `DESIGN-PRINCIPLES.md` already stated
that rule — and then named the wrong set as its mechanism, which is what licensed
the bug.

The work-stream occupancy guard `isMilestoneOccupied`
(`worker/deno/lib/issue_filter.ts`) resolved "the fleet" from
`config.allowedAuthors`. `allowed_authors` is a **permission** list — whose
issues and labels the worker may act on — and a human belongs in it. On this
deployment it is `["nleck", "VibeCoderST", "stservice"]`, so the human `nleck`
counted as fleet occupancy.

The two guards disagreed about who "the fleet" is:

| Guard                                                | Set used                | Correct?                  |
| ---------------------------------------------------- | ----------------------- | ------------------------- |
| Work-stream occupancy — `isMilestoneOccupied`        | `config.allowedAuthors` | **No — includes humans**  |
| PR blocking — `getBlockingPRForIssue`                | push-capable set        | Yes                       |

Guard 2 is the correct one, and DESIGN-PRINCIPLES' "A human-authored PR never
blocks issue pickup" explains exactly why. That reasoning was applied to PRs and
never carried across to assignment.

**Live impact.** #944 (no milestone, assigned to `nleck` at 2026-09-04T02:17Z)
occupied the `""` default-branch work stream, so #997 (`bug`, `top-priority`) and
#986 (`top-priority`) were filtered out of candidate selection for ~21 hours
while the fleet worked milestoned `work-on` issues in the same repo.

## What changed

### Code

`isMilestoneOccupied`'s fourth parameter is renamed `allowedAuthors` →
`pushCapableAuthors`, so the permission list cannot be handed to it by habit, and
its doc comment says plainly that the set must come from
`resolveFleetMaintenanceAuthorSet` and never from `config.allowedAuthors`.

All eight call sites now pass the fleet-identity set (host `github_user` +
`fleet_pr_authors` + `service_accounts`, which `loadConfig` already unions into
`config.fleetPrAuthors`):

| Call site                              | How the set is resolved                                   |
| -------------------------------------- | --------------------------------------------------------- |
| `collect_work_on_candidates.ts`        | existing local `pushCapableAuthors`                        |
| `collect_low_priority_candidates.ts`   | existing local `pushCapableAuthors`                        |
| `collect_idle_task_candidates.ts`      | existing local `pushCapableAuthors`                        |
| `collect_self_diagnostic_candidates.ts`| existing local `pushCapableAuthors`                        |
| `collect_label_candidates.ts`          | existing local `pushCapableAuthors`                        |
| `new_work_eligibility.ts`              | existing `ctx.pushCapableAuthors` on `NewWorkGateContext`  |
| `diagnose_issue.ts`                    | resolver hoisted above check 6 and shared with PR blocking |
| `diagnose_repo.ts`                     | switched onto the existing `pushCapableAuthors` input      |

`RepoIssueDiagnosticInput.allowedAuthors` is removed — occupancy and PR blocking
now read the one `pushCapableAuthors` field — and `commands/diagnose_repo.ts`
populates it via `resolveFleetMaintenanceAuthorSet`, which it previously left
unset.

### Documentation

- **`DESIGN-PRINCIPLES.md`** — new subsection *Locking and scheduling exist only
  between Vibe Coders*, stating the principle once and prominently, then the
  operational consequence (scheduling guards resolve the fleet-identity set,
  never a permission set). The *One PR per work stream* mechanism sentence no
  longer names `config.allowedAuthors`; it names
  `resolveFleetMaintenanceAuthorSet` and says why the permission list is wrong.
  The *Defer-to vs push-capable author sets* table gains the scheduling question.
- **`docs/CONFIGURATION.md`** — new subsection *Which list governs scheduling,
  and which governs permission*, with a table mapping each question to its list,
  and the plain statement that putting a human in `allowed_authors` does not make
  them a scheduler participant. The `service_accounts` / `fleet_pr_authors` rows
  in *Keys that stay local* and the *Fleet PR Authors* section now say they are
  the scheduling list.
- **`docs/INTERNALS.md`**, **`docs/workflows/issue-processing.md`** — the two
  places that described the match set as `config.allowedAuthors` now describe the
  fleet-identity set.
- **`docs/IDLE-TASK-FRAMEWORK.md`** — records a known divergence: the idle
  decision census still reads `allowed_authors`, so it over-counts occupancy and
  under-counts claimable work (the bounded-harm direction). Its input comes from
  `run_core_production_deps.ts` and aligning it is a follow-up.

## Out of scope

The `""`-as-a-work-stream question raised in #1064 is untouched. With human
assignments no longer occupying, it may be unnecessary.

Sibling-host occupancy is deliberately preserved: a second Vibe Coder's
assignment still occupies the stream — that is the duplicate-PR guard the rule
exists for.

## Evidence

`worker/deno/tests/human_assignment_never_occupies_test.ts`, 12 tests. Against
the unfixed `lib/` and `commands/` (code changes stashed, tests kept):

```text
FAILED | 7 passed | 5 failed
```

Failing (red) — exactly the behaviour this PR fixes:

- a human's assignment does not occupy the default-branch stream
- a human's assignment does not occupy a milestone stream
- the live #944/#997 shape selects the top-priority issue
- new-work eligibility ignores a human's assignment
- `diagnoseRepoIssue` still reports a sibling-held stream as occupied

Passing throughout (the duplicate-PR guard, unweakened): sibling and own-host
assignments occupy both the `""` and milestone streams, in the label collector,
in `filterNewWorkEligible` and in `diagnoseRepoIssue`.

With the fix applied:

```text
ok | 12 passed | 0 failed
```

## Test plan

- `worker/deno/tests/human_assignment_never_occupies_test.ts` (new, 12 tests)
- Every existing suite importing `issue_filter.ts` or a touched collector —
  33 suites, 398 tests, all passing
- `deno fmt`, `deno lint`, `deno check mod.ts`
- `markdownlint-cli2` on the changed docs
