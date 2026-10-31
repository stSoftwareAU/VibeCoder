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

The own-diff comparison skips a sent-back PR as `awaiting-fix` when each
file still matches. In a file no earlier finding names, the added and removed
lines must match: the same number of hunks, in the same order. Hunk headers
and unchanged context lines are ignored there, so a base merge that only moves
the context around a CHANGELOG entry still awaits the fix. In a file an
earlier finding names, or in any file when the findings for the exact
sent-back head are missing, the context lines must match as well (only hunk
headers are ignored), because the fix may be moving the PR's own line relative
to its context, for example a CHANGELOG entry from under a released heading to
above it. A base merge that moves context in such a file gets a fresh review.

The version exception applies when the patches differ
only by a strict version increment: both versions of that modified-file patch
are one complete hunk replacing one version line with a higher version. The
line may be a bare version, a JSON `"version": "..."` key (with an optional
trailing comma), or a TOML `version = "..."` key. The hunk may include
unchanged context, but its declared line counts must match and it must
contain exactly one removed line immediately followed by one added line. The
two lines must be identical apart from the version token, including spacing
and punctuation. This covers a workflow bump committed separately or in a
base-merge resolution. Every other file must still match under the rules
above: on its added and removed lines, and also on its context lines in a file
an earlier finding names (or any file when the findings are unknown).

The numeric core has two to four components; each replacement keeps the same
component count and increases the first differing component. A prerelease or
build suffix may accompany a numeric increase. Suffix-only changes, equal or
decreasing versions, extra changed lines or hunks, newline markers, renames and
missing or malformed patches get a fresh review. A dependency pin or a value on
any key other than `version` is still reviewed. No prerelease precedence is
inferred.

The exception also needs the logged findings from this PR's exact sent-back
head. A finding naming the version file (including a qualified path) forces a
fresh review, since the version change could address it. If those findings
are unavailable, including a review from another host absent from the local
log, the version exception does not apply. Exact unchanged patches retain
their existing skip behaviour.
