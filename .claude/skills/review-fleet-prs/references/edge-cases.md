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
file still matches, apart from files that left the own diff (see below). A
held PR is compared the same way on its strict path, with the rules in
[Awaiting-owner](#awaiting-owner). In a
file no earlier finding names, the added and removed lines must match: the same
number of hunks, in the same order. Hunk headers
and unchanged context lines are ignored there, so a base merge that only moves
the context around a CHANGELOG entry still awaits the fix. In a file an
earlier finding names, or in any file when the findings for the exact
sent-back head are missing, the context lines must match as well (only hunk
headers are ignored), because the fix may be moving the PR's own line relative
to its context, for example a CHANGELOG entry from under a released heading to
above it. A base merge that moves context in such a file gets a fresh review.

The version exception applies when the patches differ only by a strict version
increment. Both patches have the same number of hunks. In each patch, one hunk
is a complete hunk replacing one version line with a higher version, every
other hunk matches as the file's other-lines rules say, and exactly one hunk
pair differs. The line may be a bare version, a JSON `"version": "..."` key
(with an optional trailing comma), or a TOML `version = "..."` key. The hunk
may include unchanged context, but its declared line counts must match and it
must contain exactly one removed line immediately followed by one added line.
The two lines must be identical apart from the version token, including spacing
and punctuation. This covers a workflow bump committed separately or in a
base-merge resolution. Every other file must still match under the rules
above (a file that left the own diff follows the drop rule at the end of this
section): on its added and removed lines, and also on its context lines in a
file an earlier finding names (or any file when the findings are unknown).

The numeric core has two to four components; each replacement keeps the same
component count and increases the first differing component. A prerelease or
build suffix may accompany a numeric increase. Suffix-only changes, equal or
decreasing versions, an extra hunk that differs, a second differing version
hunk, a different hunk count, extra changed lines inside the version hunk,
newline markers, renames and missing or malformed patches get a fresh review.
An extra hunk identical at both heads does not force a fresh review. A
dependency pin or a value on any key other than `version` that differs between
the heads is still reviewed: only a version hunk may use the exception. No
prerelease precedence is inferred.

The exception also needs the logged findings from this PR's exact sent-back
head. A finding naming the version file (including a qualified path) forces a
fresh review, since the version change could address it. If those findings
are unavailable, including a review from another host absent from the local
log, the version exception does not apply. Exact unchanged patches retain
their existing skip behaviour.

A file that leaves the own diff, present in the sent-back head's own diff but
absent from the new head's because a base merge absorbed an equivalent edit,
does not force a fresh review when the findings for the exact sent-back head
are known, number at least one, and none names that file (a qualified path
counts, as in the version exception). A dropped file that an earlier finding
names gets a fresh review, since the drop could be its fix. A file present only
at the new head always gets a fresh review, and so does a sent-back listing
that reaches the 300-file cap, since a truncated sent-back listing could hide or
invent a drop. A new-head listing at the cap needs no rule of its own: it
necessarily has a file the sent-back listing lacks, which gets a fresh review.
Files present at both heads are compared as before.

## Awaiting-owner

A PR held for the owner (rule 4 of [SKILL.md](../SKILL.md)) gets a
comment-only review, and the skill counts that hold as its own review. The gate
skips such a PR as `awaiting-owner`, instead of reviewing it again, only when
all three hold:

- the skill's latest counted review is that hold, at an earlier commit;
- this host's `log.jsonl` has a `held` record for that commit made under the
  current `HOLD_POLICY_VERSION` (in `scripts/review_log.ts`). A held record
  without a `holdPolicy` field counts as version 1;
- `ownDiffUnchanged` confirms the PR's own diff is unchanged since the hold.

A hold has no findings, so the comparison takes its strict path: context lines
must match, and a file that left the own diff means a fresh review. The version
exception does not apply, since it needs logged findings.

A fresh review, not a skip, follows when there is no `held` record for the hold
on this host (for example a hold posted from another host), when the record was
made under an older policy version, or when the own diff changed at all, such
as a fix commit or a conflict resolution.

The comparison covers only the PR's own diff. Unchanged own-diff text does not
prove that a base dependency did not change. The skip is the same own-diff
comparison used for send-backs. The reassessment triggers are a change to the
own diff, and a bump of `HOLD_POLICY_VERSION`, which makes each existing hold
reassessed once even when the head is unchanged.
