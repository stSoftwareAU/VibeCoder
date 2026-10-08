# Edge cases

## Dependabot PRs

Each gate pass also looks after open Dependabot PRs into a default branch,
with no model involved (`scripts/dependabot.ts`):

- **Behind or conflicting:** comments `@dependabot rebase` once per head
  commit, so Dependabot brings its own branch up to date and resolves the
  conflict. Never push to a Dependabot branch: Dependabot stops updating a PR
  someone else has pushed to.
- **Approved at its head and not yet armed:** arms auto-merge (squash where
  the repo allows it), so it merges as soon as every required check passes.

Dependabot PRs are still reviewed like any other; this upkeep only
gets an approved one merged. The pass reports what it did in `upkeep`. A
failed upkeep action is reported there as `<repo>#<n> auto-merge failed:
<first line of the error>` (or `rebase failed: ...`), logged, and does not
stop the pass; that action is not retried until the PR's head commit changes.

## Approved fleet PRs that are behind

Each gate pass also brings up to date any **fleet** PR that is approved at its
head commit (by any host or by hand) but `BEHIND` its base
(`scripts/branch_update.ts`): it asks GitHub to merge the base in once per
head, with `expected_head_sha` set to the approved head so a push the fleet
made meanwhile makes GitHub refuse rather than update a head nobody
reviewed. The upkeep line is `<repo>#<n> branch update requested`; a refusal
is `branch update failed: ...`, logged, and not retried at that head. An
unapproved PR is left as it is: it is reviewed first, and `scripts/post.ts`
brings it up to date after the approval ([SKILL.md](../SKILL.md) rule 9).
