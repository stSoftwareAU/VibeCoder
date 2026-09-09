# 🔎 Security sweep — the milestone roll-back marker (`milestone_rollback_marker.ts`)

**Issue:** [#1770](https://github.com/stSoftwareAU/VibeCoder/issues/1770)
(chunk 12n) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
_after_ the chunk-12 slices (12a–12m) recorded their coverage:

- `worker/deno/lib/milestone_rollback_marker.ts` — added by #1770.

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12n**, and this file is
the reading of it.

## `worker/deno/lib/milestone_rollback_marker.ts`

The module owns the roll-back marker vocabulary: it renders the marker a
milestone roll-back posts on each reverted child issue, and reads it back for
the two merged-PR closers so a reverted child is not closed again. It is
therefore a **suppression** marker parsed out of comment bodies — the highest
injection-risk shape in this subsystem (12c).

Shapes checked (12c's — a module ingesting untrusted GitHub text — and 12e's):

| Property | Result |
| -------- | ------ |
| a comment body cannot suppress on its own | ✅ `findRollbackAfter` counts a marker only when its author is a configured fleet login (`isFleetAuthor`, the `alert_dedup_authors.ts` control). A marker from any other account is ignored and the close proceeds, which `milestone_rollback_marker_test.ts` and both closers' tests assert |
| an unresolved fleet identity cannot be exploited | ✅ an empty `fleetAuthors` trusts nothing and suppresses nothing — the same fail direction `issueCommentsContainMarker` takes. `findRollbackAfterMerge` also skips the fetch entirely in that case, so no call is spent |
| a stale marker cannot suppress for ever | ✅ only a marker strictly newer than the merge counts; one at or before the merge, or with no readable timestamp, is ignored |
| a marker cannot be forged into the grammar | ✅ `buildRollbackMarker` throws on a value carrying a quote, an angle bracket or a newline, and on a non-positive PR number or a non-hex sha, so no worker-authored marker can close its own comment early and open a second one. The reader is bounded to the attributes between the marker and the first `-->` |
| no shell, no argv construction | ✅ the module spawns nothing. Its only I/O is `fetchIssueCommentPages`, whose argv is the bounded, page-numbered REST path that module builds |
| ReDoS on an attacker-chosen body | ✅ the three patterns are linear: an anchored `^[0-9a-f]{7,40}$`, a character-class test, and a `([a-z]+)="([^"]*)"` scan over the bounded attribute slice — no nested quantifier, no backtracking pair |
| filesystem, environment and secrets | ✅ none: no `Deno.env`, no file access, no credential handling |
| a failure cannot read as success | ✅ `findRollbackAfterMerge` propagates an unreadable thread rather than returning "no roll-back"; both closers treat the throw as "cannot prove it was not rolled back" and leave the issue open, naming the cause |
| blast radius of a wrong answer | ✅ the module closes nothing, comments nothing and labels nothing. A false positive leaves an issue open for a human or the next cycle; a false negative is the pre-#1770 behaviour |

No findings.
