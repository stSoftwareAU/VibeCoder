## Summary

The milestone self-heal (Issue #3912) retargets open child PRs that sit on the
default branch onto their milestone branch. It admitted **any** PR whose issue
was milestoned: on 2026-09-12 it moved a maintainer's deliberate
commit-by-commit replay onto a rewritten milestone branch, turning a clean
four-conflict PR into ninety conflicting files. A PR the Vibe Coder did not
raise is not the fleet's to move. Closes #2022.

What changed:

- **`worker/deno/lib/milestone_branch_self_heal.ts`** — `isFleetRaisedPr()`
  (exported) admits a PR only when **both** hold: the author is a fleet login
  (the maintenance set, resolved once per repository through
  `resolveAlertDedupAuthors`) **and** the body carries the worker's own PR
  marker (`WORKER_PR_MARKER_PREFIX`). The `issue-<n>-…` branch shape is
  deliberately not evidence — the motivating PR used it — and a head ref with
  a leading dash is refused (Issue #12). The listing now requests `author` and
  `body`. A PR that fails the test is logged once and left exactly as raised:
  no base change, no comment, no label. An unresolved fleet identity retargets
  nothing and says so.
- **Merge dry run before a retarget** — new optional
  `mergeWouldConflictFn(repo, milestoneBranch, headRefName)` on the deps.
  `true` refuses the retarget with a log line; `null` (could not read) allows
  it as before and says so. Production wires it to the host's clone:
  `git fetch` both refs, then `git merge-tree --write-tree`, exit 1 meaning
  conflicts; nothing touches the working tree.
- **Docs** — `docs/workflows/milestones.md` gains "Which PRs the self-heal may
  retarget".

## Tests

`worker/deno/tests/milestone_branch_self_heal_test.ts` (45 passing, 7 new):
a human-authored PR on an `issue-<n>-` branch is never retargeted, commented on
or edited; a fleet author without the marker is not enough; the marker from a
non-fleet author is not enough; an unresolved fleet identity retargets nothing;
a conflicting dry run refuses with the reason logged; an unreadable dry run
allows and says so; `isFleetRaisedPr` unit cases. Existing retarget tests keep
passing with the harness defaulting to a fleet author and a marked body.

## Not in this PR

The merge-conflict lane's base re-read before the agent and the push, listed on
#2022 as defence in depth, belongs with the conflict-shape work in #2023 and is
tracked there. The 44-minute agent run on the same day was the **milestone
sync's** own conflict rung on a rewritten milestone branch, not the PR conflict
lane; the issue text was corrected to say so.
