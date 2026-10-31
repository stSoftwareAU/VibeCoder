## Summary

The `merge-fallback` record filed by the conflict ladder's roll-back rung left
"Commits behind the base" and "Behind since" as `not recorded`, because that
rung passed an empty fallback context. The rung now fills both, through the same
builder the spent-budget hand-off uses. Closes #4521.

Version bump: not applicable; no `VERSION` file is touched.

## Spec

### Intent and Rationale

- #4521 is a worker-filed fallback record ("the conflict resolver declined"). The
  decline and the roll-back are the designed ladder (Issue #4328); the defect in
  the record is the two `not recorded` fields, which the roll-back rung left
  empty (`fallback: {}`) while the hand-off path filled them.
- The pass measures how far behind a branch is only for a repository with two or
  more milestone branches (`orderRepoMilestones`), so a lone branch reached the
  filing unmeasured on both paths.

### Essential Design Decisions

- One `buildFallbackContext` now serves `applyResolverRecovery` and
  `handOffSpentBudget`; an unmeasured branch is measured at the fallback with the
  injected `behindCountFn` (rare path, best-effort, a failure is logged).
- A branch that never synced has no `lastSyncedDefaultSha`, so the behind-since
  compare is bounded by the branch itself: its first listed commit is the oldest
  one the branch lacks.
- Assumption: the conflicted-file list is passed only where the failing error is
  in hand (the same-cycle site); the cycle-start rung has no error to read.

### Undiscoverable Facts

- The source repository is private, so the issue names nothing; the cause was
  found from the `not recorded` fields and the code that fills them. The agent's
  692s decline itself is not diagnosed here.

## Evidence

Backend only; no UI files touched.

```mermaid
flowchart TD
    A[Resolver declined] --> B{Rung}
    B -- roll-back rung --> C[buildFallbackContext]
    B -- spent-budget hand-off --> C
    C --> D[behindBy: given, else measured]
    C --> E[behindSince: compare from last synced tip, else the branch]
    C --> F[conflictedFiles when the error is in hand]
    D & E & F --> G[merge-fallback record]
```

Issue numbers cited: #4521: this issue; #4328: the recovery ladder; #2311: the
fallback flag; #2309: the behind-by ordering; #4456: the record is filed in
VibeCoder.

## Reproduction

- **symptom** — the roll-back rung's `merge-fallback` record read "Commits behind
  the base: not recorded" and "Behind since: not recorded".
- **status** — `verified` — both new tests failed against the base-branch
  `milestone_branch_sync.ts` and pass after the fix.
- **regression test** — `worker/deno/tests/milestone_branch_sync_test.ts::syncMilestoneBranches - the ladder's roll-back of a lone branch files how far behind the base it was and since when (Issue #4521)`

## Test Plan

Added to `worker/deno/tests/milestone_branch_sync_test.ts` (helper
`ladderRollbackFiling`, a lone milestone, injected filer and `gh`):

- `syncMilestoneBranches - the ladder's roll-back of a lone branch files how far behind the base it was and since when (Issue #4521)`:
  behind-by 7 and the date are filed, compare from the last synced tip.
- `syncMilestoneBranches - a branch that never synced bounds the behind-since compare with the branch itself (Issue #4521)`.

Red checks: base-branch production file restored → both fail; only
`?? milestone.milestoneBranch` removed → the second fails.

Not covered by a dedicated test: the `behindCountFn` failure/throw log branches
of `measureBehind`, and the `conflictedFiles` argument at the same-cycle site
(that site is unchanged in effect, it already passed them). No existing test was
edited.

Results on the final head: `deno task test:unit tests/milestone_branch_sync_test.ts tests/milestone_fallback_flag_test.ts`: 90 passed, 0 failed.

`./quality.sh`: every stage passed except `deno tests` (31306 passed, 3 failed),
all three failing on the base branch too and not touching this change:
`tests/completion_phase_repo_formatters_test.ts` lines 480 and 567 (no default
rustup toolchain on this host) and `tests/pr_maintenance_command_test.ts` line
344 (`expected a merge-queue rules read`; re-run on a clean `origin/main`
checkout, same failure). The serial pass did not run. `config integration` and
`checkov` were skipped (local prerequisites).

Docs read and updated: `docs/workflows/milestones.md` (the spent-budget bullet).
`docs/workflows/merge-conflicts.md` lines 900-910 already say the record carries
how far behind and since when; they are true now for the roll-back rung.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
