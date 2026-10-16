# Edge cases

## Dependabot PRs

Each gate pass also looks after open Dependabot PRs into a default branch,
with no model involved (`scripts/dependabot.ts`). The gate never posts
`@dependabot rebase` or any other `@dependabot` comment: Dependabot only obeys
users with push access, and it refused the reviewer App's command (PR #3639).

- **Behind, not a draft, not conflicting, and approved at its head:** the gate
  brings the branch up to date with the `update-branch` endpoint, once per
  head, the same way as for fleet PRs (see
  [Approved PRs that are behind](#approved-prs-that-are-behind)). Dependabot
  then stops rebasing that PR itself, which is harmless because auto-merge
  lands it next.
- **Behind and not yet approved at its head:** no upkeep action; the PR is
  reviewed first.
- **Conflicting:** no comment and no push. Dependabot rebases a conflicting PR
  itself, and the upkeep line is `<repo>#<n> conflicting, waiting on
  Dependabot`. Edge case: a PR the gate already updated that later conflicts
  is not auto-rebased by Dependabot (it stops once someone else commits), so
  upkeep still says waiting on Dependabot; a human closes it or comments
  `@dependabot recreate`.
- **Approved at its head and not yet armed (behind or not):** arms auto-merge
  (squash where the repo allows it), so it merges as soon as every required
  check passes. This runs before any branch update in the same pass.

Dependabot PRs are still reviewed like any other; this upkeep only gets an
approved one merged or brought up to date. The pass reports what it did in
`upkeep`. A failed upkeep action is reported there as `<repo>#<n> auto-merge
failed: <first line of the error>` or `<repo>#<n> branch update failed: <first
line of the error>`, logged, and does not stop the pass; that action is not
retried until the PR's head commit changes.

## Approved PRs that are behind

Each gate pass also brings up to date any **fleet** or **Dependabot** PR that
is approved at its head commit (by any host or by hand) but `BEHIND` its base
(`scripts/branch_update.ts`): it asks GitHub to merge the base in once per
head, with `expected_head_sha` set to the approved head so a push made
meanwhile makes GitHub refuse rather than update a head nobody reviewed. The
upkeep line is `<repo>#<n> branch update requested`; a refusal is
`branch update failed: ...`, logged, and not retried at that head. An
unapproved PR is left as it is: it is reviewed first, and `scripts/post.ts`
brings it up to date right after the approval, for fleet and Dependabot PRs
alike ([SKILL.md](../SKILL.md) rule 9).
