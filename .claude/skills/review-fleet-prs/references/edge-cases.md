# Edge cases

## Dependabot PRs

Each gate pass also looks after open Dependabot PRs into a default branch,
with no model involved (`scripts/dependabot.ts`):

- **Behind and approved by the reviewer at its head:** asks GitHub's
  `update-branch` endpoint to merge in the base, once per head, with
  `expected_head_sha` set to that reviewed head. An unapproved or draft PR
  gets no update. The post-approval path uses the same leased update and
  shares its success and refusal memory with the gate.
- **Conflicting:** posts no comment and makes no push; reports
  `<repo>#<n> conflicting, waiting on Dependabot`. Once another actor updates
  a Dependabot branch, Dependabot stops its own updates. If that branch later
  conflicts, a human must close or recreate the PR; the gate still waits.
- **Approved at its head and not yet armed:** arms auto-merge (squash where
  the repo allows it), so it merges as soon as every required check passes.

Dependabot PRs are still reviewed like any other; this upkeep only
gets an approved one merged. The pass reports what it did in `upkeep`. A
failed upkeep action is reported there as `<repo>#<n> auto-merge failed:
<first line of the error>` (or `branch update failed: ...`), logged, and does not
stop the pass; that action is not retried until the PR's head commit changes.
Successful updates report `<repo>#<n> branch update requested`. No upkeep
path posts a Dependabot command, and the old rebase-request cache is unused.

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
Both paths share `branch-update.json` and the per-action failures in
`dependabot-failed.json` through `scripts/upkeep_memory.ts`; a successful or
refused post update therefore also suppresses a same-head gate request, and
vice versa. Existing entries retain their shape and other PR/action entries
are preserved. A cross-process PR lock spans the cache check, update and
persistence; per-file locks and atomic entry merges preserve parallel posts.
A PR-lock timeout is reported without caching an unsent request, and other
PRs continue. A persistence failure after an API request still fails loud.

## Version-only re-bumps

The own-diff comparison skips a sent-back PR as `awaiting-fix` when its
patches still match after hunk-position normalisation. It also accepts a
differing modified-file patch when both versions of that patch are one
complete hunk replacing one bare version line with a higher version. This
covers a workflow bump committed separately or in a base-merge resolution.
Every other file must still match under the existing comparison rules.

The numeric core has two to four components; each replacement keeps the same
component count and increases the first differing component. A prerelease or
build suffix may accompany a numeric increase. Suffix-only changes, equal or
decreasing versions, extra lines or hunks, newline markers, renames and missing
or malformed patches get a fresh review. No prerelease precedence is inferred.

The exception also needs the logged findings from this PR's exact sent-back
head. A finding naming the version file (including a qualified path) forces a
fresh review, since the version change could address it. If those findings
are unavailable, including a review from another host absent from the local
log, the version exception does not apply. Exact unchanged patches retain
their existing skip behaviour.
