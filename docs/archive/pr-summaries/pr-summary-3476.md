# Milestone rollups claim sub-issues whose work is not on the branch

## Summary

Closed-PR self-healing and the milestone rollup were each reading GitHub state
too loosely and closing sub-issues whose work was never delivered on the branch.
Seven changes, all behind the one issue:

- **Stale-attempt guard reads the whole timeline.**
  `detectAssignedWithClosedPr` now fetches the complete paginated timeline via
  `fetchTimelineWithCache` and derives the latest `assigned` (and `reopened`)
  event locally, so a merge is compared against the current assignment instead
  of the unpaginated first-30-events page.
- **A merged PR counts only with the fleet's own title.** `fetchPRsForIssueByTitle`
  now drops any `in:title` hit whose title does not carry the delimited
  `(#N)` / `(Issue #N)` form, and separately drops a milestone sync PR (head
  `sync/milestone-*`) even when its title happens to carry the number.
- **Reopened issues are never closed on a pre-reopen merge.** A new guard in
  `detectAssignedWithClosedPr` treats a merge that predates the issue's latest
  reopen as not delivered: it comments, unassigns and releases the claim, but
  never closes.
- **The rollup flags instead of claims.** `buildMilestoneSummaryBody` lists only
  still-closed issues that are genuinely claimable, and reports — in a separate
  `### Flagged — not claimed` section — issues whose only merged PR is a sync PR
  or predates a later reopen, or whose timeline cannot be read, rather than
  counting them as addressed.
- **The rollup refreshes its body while its summary PR is open — and writes
  only when something changed.** `createMilestoneSummaryPr` no longer leaves an
  already-existing summary PR's body untouched, and when a listed issue reopens
  (so the milestone never reaches `createMilestoneSummaryPr`)
  `refreshOpenSummaryPrBodyWhileIncomplete` does the same at both incomplete
  early exits. Both go through `refreshExistingSummaryPr`, which first reads the
  live PR (`gh pr view --json state,body,headRefName,isCrossRepository`) and
  leaves it alone unless it is `OPEN`, same-repository and headed by the
  milestone branch. The rebuilt body ends with a
  `<!-- vibe-rollup-fingerprint value="…" -->` marker over the milestone title, default
  branch, tracker and classified closed issues; a live body that already carries
  the current marker is skipped before any dependency or not-planned read, and
  `gh pr edit --body` runs only otherwise. A closed issue's claim verdict is
  cached (`IssueCache`) under its number and `updatedAt` (now carried by the
  closed-issue batch), so an unchanged issue's timeline is not re-paged each
  scan; an unreadable timeline and a "sync-pr-only" flag are never cached. The
  incomplete path finds its candidate PRs in the cached all-state branch list
  (which now carries each PR's `state`) instead of an uncached `gh pr list
  --head` per milestone, and carries on only those the list shows `OPEN` or
  shows no state for: a milestone whose only final PR is merged or closed (the
  state after an automated roll-back) makes no closed-issue classification and
  no live `gh pr view`, and the live read stays the guard before any edit. An empty closed list
  (indistinguishable from a failed read) leaves the body alone.
- **The fleet's own tracker is not rollup content.** `getClosedIssues` removes
  the milestone's tracking issues (title + body marker + fleet author, via
  `partitionMilestoneTrackers` over the all-state milestone list) before
  classifying, so the closed tracker appears under neither `### Issues
  addressed` nor `### Flagged — not claimed`; it is referenced only by
  `Closes #T`.
- **An unreadable timeline fails closed.** `fetchTimelineWithCache` returns
  `null` on a gh/validation fault or the page cap. `detectAssignedWithClosedPr`
  now records a fault event and skips the issue that pass (no close, no
  unassign); `classifyClosedIssues` flags it `timeline-unreadable` instead of
  claiming it.

Closes #3476.

## Evidence

Backend change — no web interface to screenshot. After the PR #3640 review
fixes (the per-scan cost finding) the targeted checks were run on the head:
`deno fmt --check`, `deno lint` and `deno check` on the five lib/test files
changed by the review fixes, the unit tests for the 12 files that name
`milestone_completion`, `fetchAllClosedIssues`, `issues_closed_all`,
`fetchAllStatePRsByBranch` or `prs_all_branch` (463 passed, 0 failed), and the
`milestone_*`, `stuck_*`, `issue_lifecycle_*` and `claim_lock_integrity_214`
unit tests (1307 passed in the parallel pass, 71 in the serial pass, 0 failed).
`tests/milestone_completion_test.ts` alone: 137 passed, 0 failed;
`tests/issue_query_all_state_cache_test.ts` alone: 12 passed, 0 failed. The
second PR #3640 review round (a non-open candidate still cost a classification
and a live read) re-ran the same checks on the head. Cost reproduced from the review's example: before this fix an
open rollup's unchanged scan issued `gh pr edit` plus the timeline, dependency
and not-planned reads; the new `a second scan with unchanged GitHub state` case
asserts zero `pr edit` and zero timeline reads on scan 2 (and fewer paginated
reads than scan 1).

<!-- vibe-quality-gate-skipped reason="the ~15m ./quality.sh gate exceeds the single foreground command cap in this run; CI and the pre-raise worker gate run it" -->

## Test Plan

- **Added** `worker/deno/tests/stuck_recovery_milestone_guard_test.ts` — four
  end-to-end cases through `detectAssignedWithClosedPr` (the fourth, the
  unreadable-timeline case, is described under **Extended** below): a >30-event timeline
  whose latest `assigned` sits on page 2 is honoured as current (the stale
  attempt unassigns, not closes); a milestone sync PR that happens to carry the
  issue number does not close the issue; and a merged PR predating the issue's
  latest reopen does not close it. The reopen case additionally pins, arg for
  arg, the `gh issue comment` (its "predates the issue's latest reopen" body)
  and the `gh issue edit --remove-assignee` argv, and asserts the shared
  `issues_all` and per-issue title-search caches are invalidated.
- **Added** `worker/deno/tests/milestone_sync_branch_test.ts` — direct unit
  tests for `syncBranchFor`, `isMilestoneSyncBranch` and `SYNC_BRANCH_PREFIX`,
  importing the new dependency-free `milestone_sync_branch.ts` directly (rather
  than through the `milestone_sync_pr.ts` re-export) so each helper is pinned
  on its own.
- **Extended** `worker/deno/tests/issue_query_title_search_cache_test.ts` — two
  cases: `fetchPRsForIssueByTitle` drops a hit whose title lacks the delimited
  issue form (the number appears only in the branch name), and drops a milestone
  sync PR even when its title carries the delimited form. The existing "keeps a
  PR whose head branch is in the repository" case now also asserts the returned
  row's `title` and `headRefName`, so a dropped row property cannot pass
  silently.
- **Extended** `worker/deno/tests/timeline_latest_event_pagination_test.ts` —
  two unit tests pin `latestAssignedAtFromTimeline` (the latest `assigned`
  event for a login, `null` otherwise) and `latestReopenedAtFromTimeline` (the
  latest `reopened` event, `null` otherwise).
- **Extended** `worker/deno/tests/milestone_completion_test.ts` —
  `buildMilestoneSummaryBody - flags rather than claims issues with a
  claimProblem` asserts the new `### Flagged — not claimed` section renders the
  flag reasons and keeps flagged issues out of the claimed list;
  `classifyClosedIssues - flags sync-pr-only and predates-reopen, claims
  otherwise` drives both new classification branches directly (a clean merge is
  claimed, a no-merge issue is flagged `sync-pr-only`, a merge predating a
  reopen is flagged `predates-reopen`, and a re-merge after the reopen is
  claimed); and `checkAndHandleMilestoneCompletions - refreshes the existing
  summary PR body with freshly classified closed issues` asserts the exists
  path re-publishes a rebuilt body via `gh pr edit --body` (the reopened issue
  lands under `### Flagged — not claimed`, not `### Issues addressed`) and
  counts no newly-created summary PR. Its closed-issue mock now includes the
  closed tracker #600, asserted to be listed nowhere but `Closes #600`. PR #3640
  review added: a `classifyClosedIssues` case where the timeline read throws
  (flagged `timeline-unreadable`, rendered under `### Flagged — not claimed`);
  two cases (cached open list sees the reopen / only the authoritative GitHub
  count does) where an `OPEN` summary PR whose listed issue #21 reopened gets a
  rebuilt body with no #21 and no new PR, tracker or close; a case where a
  `CLOSED` or `MERGED` summary PR is not edited and costs no `pr view`, no
  `in:title` search and no `/timeline` read (the cached list already says it is
  not open); a case where a cached all-state row with no `state` (an entry
  written before the field existed) is still read live and refreshed; and a case where an empty closed list
  leaves the body alone. The per-scan-cost review round added (all `PR #3640
  review`): `a second scan with unchanged GitHub state does not edit the summary
  PR or re-read the timelines` (scan 1 edits once and stamps the fingerprint;
  scan 2 issues no `pr edit`, no timeline read, fewer paginated reads);
  `a changed classification rewrites the body once, then the next scan leaves
  it` (a newer `updatedAt` plus a reopen → one more edit, then none);
  `an existing summary PR that is merged / closed / a fork's / headed by another
  branch is not edited on the exists path` (merged and closed with the uncached
  final-PR classification failing, the reviewer's scenario); `an unreadable live
  summary PR is not edited and the fault is logged`; `an incomplete milestone's
  second scan with unchanged state does not edit the summary PR`; `an incomplete
  milestone with no summary PR makes no uncached PR read` (no `pr view`, no
  `pr edit`, no timeline read); and five `classifyClosedIssues` cases (verdict
  served from cache and re-read when `updatedAt` moves or is absent; a cached
  `predates-reopen` verdict; no merged PR → flagged without paging the
  timeline; a failed merged-PR read retried rather than pinned; an unreadable
  timeline never cached). The existing exists-path and incomplete-path cases
  now stub `gh pr view`, since the refresh reads the live PR first.
- **Extended** `worker/deno/tests/issue_query_all_state_cache_test.ts` —
  `fetchAllStatePRsByBranch - requests and keeps each PR's state, dropping a
  non-string one`: the `--json` fields include `state`, and a non-string value
  is dropped rather than stored.
- **Extended** `worker/deno/tests/issue_query_test.ts` — `fetchClosedIssuesByMilestone
  carries updatedAt and still reads an old-shape cache entry`: the batch asks
  for `updatedAt`, an empty timestamp is dropped, and a seeded
  `issues_closed_all` entry written before the field existed is served unchanged
  (the persisted-shape change reads the old shape rather than bumping the key,
  since `updatedAt` is optional).
- **Extended** `worker/deno/tests/stuck_recovery_milestone_guard_test.ts` with a
  fourth case (PR #3640 review): the timeline read throws for the row-3 issue
  (merged 10-05, reopened, re-assigned) and `detectAssignedWithClosedPr`
  recovers nothing, closes nothing and unassigns nothing.
- **Fixed fixtures** `worker/deno/tests/stuck_recovery_cache_test.ts` (two
  cases) and `worker/deno/tests/stuck_issue_detector_test.ts` (one case): their
  catch-all `api` stub answered the timeline URL with a bare timestamp, which
  `fetchTimelineWithCache` reads as `null` and which the old code treated as
  "no events". They now serve `[]` for `/timeline?`, a readable empty timeline
  — the real endpoint's shape.

### Branch outcomes

- `worker/deno/lib/issue_query.ts:1574` — `!prTitleMatchesIssue` drops the hit.
  Reached by `worker/deno/tests/issue_query_title_search_cache_test.ts` (the
  "lacks the delimited issue form" case). Flipping the guard (removing the
  `continue`) leaves that case green only if the drop is retained, so the test
  is the red run.
- `worker/deno/lib/issue_query.ts:1584` — `isMilestoneSyncBranch` drops the hit.
  Reached by the "drops a milestone sync PR even when its title carries the
  issue number" case in the same file.
- `worker/deno/lib/stuck_recovery.ts:1159` — `mergedAt && reopenedAt &&
  mergedAt < reopenedAt`:
  - `mergedAt` truthy is the pre-existing merged-PR gate (`mergedPrNumber > 0`);
    the `mergedAt` empty arm is reached by the milestone-sync case in
    `worker/deno/tests/stuck_recovery_milestone_guard_test.ts` (no merged PR,
    so nothing closes).
  - `reopenedAt` null (no reopen) skips the guard and falls through to the
    landing check and ordinary close path — the pre-existing close behaviour,
    reached by the close-path test in
    `worker/deno/tests/stuck_recovery_cache_test.ts` ("stuck_recovery cache -
    detectAssignedWithClosedPr merged PR closes issue and drops caches"; its
    timeline now reads as an empty array). The paginated stale-attempt case never reaches
    this arm: its mergedAt (2026-10-05) predates its latest assignment
    (2026-10-09), so the stale-assignment guard at
    `worker/deno/lib/stuck_recovery.ts:1110` unassigns and `continue`s first.
  - `mergedAt < reopenedAt` fires the guard (comment + unassign, no close) —
    reached by `worker/deno/tests/stuck_recovery_milestone_guard_test.ts::a
    merged PR predating the latest reopen does not close the issue`.
- `worker/deno/lib/milestone_completion.ts:888` — `flagged.length > 0` renders
  `### Flagged — not claimed`. Reached by the `buildMilestoneSummaryBody`
  claimProblem case; the empty arm (section omitted) is exercised by every
  existing `buildMilestoneSummaryBody` test whose fixtures carry no
  `claimProblem`.
- `worker/deno/lib/milestone_completion.ts:1481` — `existingPrNumber !== null`
  refreshes an already-existing summary PR through `refreshExistingSummaryPr`
  and returns `outcome: "exists"`. Reached by
  `worker/deno/tests/milestone_completion_test.ts::checkAndHandleMilestoneCompletions
  - refreshes the existing summary PR body with freshly classified closed
  issues`; the `null` arm creates the PR and is exercised by every existing
  `createMilestoneSummaryPr` test that raises a new PR.
- `worker/deno/lib/milestone_completion.ts:1366` — `!live.ok` (unreadable live
  PR) logs and returns without editing. Reached by `an unreadable live summary
  PR is not edited and the fault is logged`; forcing the branch off made it
  (and two existing exists-path cases) red.
- `worker/deno/lib/milestone_completion.ts:1373` — `state !== "OPEN" ||
  isCrossRepository || headRefName !== milestoneBranch`, one operand each:
  `state !== "OPEN"` by the `merged` and `closed` exists-path cases (deleting
  the operand turned both red; the incomplete path drops non-open candidates at
  the cache filter before this operand, so it does not reach it); `isCrossRepository` by the `a fork's` case, and `headRefName !==
  milestoneBranch` by the `headed by another branch` case (deleting either
  operand turned its case red).
- `worker/deno/lib/milestone_completion.ts:1385` — the live body already carries
  the current fingerprint → return before any build or edit. Reached by the
  `second scan with unchanged GitHub state` case (exists path) and the
  incomplete-path `second scan` case; deleting the line turned the first red
  (scan 2 re-read the paginated milestone issues). The fall-through arm (stale
  or marker-less body → rebuild and edit) is every first-scan case.
- `worker/deno/lib/milestone_completion.ts:1774` — `mergedPrs.length === 0`
  flags `sync-pr-only` before the timeline is read. Reached by
  `worker/deno/tests/milestone_completion_test.ts::classifyClosedIssues - flags
  sync-pr-only and predates-reopen, claims otherwise` (issue 1) and, for the
  "no timeline read" part, `an issue with no merged PR is flagged without paging
  its timeline` (moving the timeline read back above it turned that case red).
- `worker/deno/lib/milestone_completion.ts:1787` — `timeline === null` flags
  `timeline-unreadable`. Reached by `classifyClosedIssues - flags an issue whose
  timeline cannot be read rather than claiming it`; restoring the old
  claim-on-null made it red. `never caches an unreadable timeline` reaches the
  not-cached half. The readable arm is every other `classifyClosedIssues` case.
- `worker/deno/lib/milestone_completion.ts:1792` — `reopenedAt !== null &&
  mergedPrs.every(…)` flags `predates-reopen`: `reopenedAt !== null` false for
  issue 2 of the flags/claims case; `every` false for issue 4 (re-merged after
  reopen); both true only for issue 3, the flagged case.
- `worker/deno/lib/milestone_completion.ts:1746` — `if (cache)` guards the
  verdict read: the cache-less arm is every `classifyClosedIssues` case that
  passes no cache; the cache arm is `serves an unchanged issue's verdict from
  cache…`, whose two `run()` calls with no `updatedAt` must read the timeline
  each time (an absent `updatedAt` never equals a stored one). Disabling the
  read turned that case and the exists-path `second scan` case red.
- `worker/deno/lib/milestone_completion.ts:1748` — `isCachedClaimVerdict(hit) &&
  hit.updatedAt === issue.updatedAt`: operand `hit.updatedAt === issue.updatedAt`
  by the `a newer updatedAt must miss` step and `a changed classification
  rewrites the body once…` (deleting the operand turned both red); operand
  `isCachedClaimVerdict(hit)` is the shape guard for an entry written by another
  version — `exempt (untestable)`: the cache only ever holds this module's
  `CachedClaimVerdict` writes within one deploy, and the test files that already
  call `classifyClosedIssues` (`worker/deno/tests/milestone_completion_test.ts`,
  `worker/deno/tests/milestone_completion_cache_test.ts`) seed no foreign key.
- `worker/deno/lib/milestone_completion.ts:1752` — a cached verdict with
  `claimProblem === null` returns the issue as claimable, otherwise flagged.
  The flagged arm by `serves a cached predates-reopen verdict`; deleting the
  `claimProblem` spread turned it red; the claimable arm by `serves an unchanged
  issue's verdict from cache`.
- `worker/deno/lib/milestone_completion.ts:1797` — the verdict write, guarded by
  `cache && issue.updatedAt !== undefined`. Operand `cache`: every cache-less
  case. Operand `issue.updatedAt !== undefined` only narrows the type for the
  stored `updatedAt: string`; a write without it would be dropped by
  `JSON.stringify` and never read back (`isCachedClaimVerdict` rejects it), so
  it has no observable outcome of its own — `exempt (untestable)`: the test
  files that already call `classifyClosedIssues`
  (`worker/deno/tests/milestone_completion_test.ts`) cannot observe a write
  that is discarded on read. Removing the write turned the exists-path `second
  scan`, `serves an unchanged issue's verdict` and `serves a cached
  predates-reopen verdict` cases red; writing a `sync-pr-only` verdict too
  turned `a failed merged-PR read is retried` red.
- `worker/deno/lib/issue_query.ts:773` — `item.updatedAt` kept only when a
  non-empty string. Reached by `worker/deno/tests/issue_query_test.ts::
  fetchClosedIssuesByMilestone carries updatedAt and still reads an old-shape
  cache entry` (row 1 kept, row 3 with `""` dropped); dropping the `!== ""`
  operand turned it red.
- `worker/deno/lib/milestone_completion.ts:1858` — the tracker filter
  `!trackerNumbers.has(issue.number)`. Reached by the refresh case in
  `worker/deno/tests/milestone_completion_test.ts` (closed list holds tracker
  #600); passing `closed` unfiltered made it red. The keep arm is issue #20 in
  the same case.
- `worker/deno/lib/milestone_completion.ts:1902` — the candidate filter
  `pr.headRefName === milestoneBranch && (pr.state === undefined || pr.state ===
  "OPEN")`, one operand each. `pr.state === "OPEN"` by `an incomplete milestone
  with only a non-open summary PR makes no live read, title search or timeline
  read` (CLOSED and MERGED): forcing the operand to `true` turned it red
  (`AssertionError: Values are not equal: CLOSED`). `pr.state === undefined` by
  `a cached all-state row with no state is still read live before any edit`:
  replacing the pair with `pr.state === "OPEN"` alone turned it red. The
  `headRefName` operand is unchanged by this round.
- `worker/deno/lib/issue_query.ts:1688` — `typeof item.state === "string" &&
  item.state !== ""` keeps a row's state, one operand each. `typeof item.state
  === "string"` by the `fetchAllStatePRsByBranch - requests and keeps each PR's
  state` row with `state: 7`; `item.state !== ""` by its row with `state: ""`
  (deleting either operand turned the case red).
- `worker/deno/lib/milestone_completion.ts:1906` — `candidates.length === 0`
  returns before any classification. Reached by `an incomplete milestone with no
  summary PR makes no uncached PR read`; deleting the line turned it red (the
  timeline of issue #20 was read). The non-empty arm is the two `refreshes an
  open summary PR body when a listed issue reopens` cases.
- `worker/deno/lib/milestone_completion.ts:1918` — `closedIssues.length === 0`
  returns without editing. Reached by `worker/deno/tests/milestone_completion_test.ts::an
  incomplete milestone does not publish an empty body over a summary PR when the
  closed list reads empty`; deleting the guard made it red.
- `worker/deno/lib/milestone_completion.ts:2172` and `:2242` — the two
  `await refreshWhileIncomplete()` calls (cached list incomplete; authoritative
  open count > 0). Each is reached by one of the two `refreshes an open summary
  PR body when a listed issue reopens` cases; removing either call alone made
  exactly its case red.
- `worker/deno/lib/milestone_completion.ts:1935` — `tracker.ok ? tracker.value :
  null`: the `ok` arm (`Closes #600` asserted) is reached by the same two cases;
  the `null` arm is `exempt (untestable)`: `hasExistingMilestoneTrackingIssue`
  only returns `ok: false` when `partitionMilestoneTrackers` throws, which the
  tests that already call it (`worker/deno/tests/milestone_completion_test.ts`) cannot stage
  through `gh` stubs because the fetcher swallows gh faults into `[]`.

## Docs sweep

**Docs sweep** — grep: `SYNC_BRANCH_PREFIX`, `syncBranchFor`, `isMilestoneSyncBranch`
(moved out of `milestone_sync_pr.ts` into the new dependency-free
`milestone_sync_branch.ts`); section: `docs/MERGE.md` ("the milestone sync PR is
exempt") and `docs/audits/security-sweep-2182-lib-delta-12a-12c.md` name
`isMilestoneSyncBranch` by name and behaviour only, never by its home file, so
both remain accurate; siblings: none — the only importers are
`milestone_sync_pr.ts` (re-export) and `issue_query.ts`; updated: no hits.

**Docs sweep** — grep: `latestAssignedAtFromTimeline`, `latestReopenedAtFromTimeline`
(new exports in `issue_query.ts`); section: none — no user-facing doc names the
timeline helpers; siblings: `getLabelLastAddInfo`, `getLabelLastRemoveInfo`,
`fetchTimelineWithCache` are likewise undocumented; updated: no hits.

**Docs sweep** — grep: `classifyClosedIssues`, `claimProblem`, `### Flagged — not
claimed` (new in `milestone_completion.ts`); section:
`docs/workflows/milestones.md` — its "body lists addressed issues" wording stays
accurate because flagged issues are rendered in a separate section and never
counted as addressed; siblings: `### Issues addressed`, the `### Not planned`
and dependency notes already documented there; updated: no hits.

**Docs sweep** — grep: `createMilestoneSummaryPr` body refresh,
`refreshOpenSummaryPrBodyWhileIncomplete`, `getClosedIssues`,
`timeline-unreadable`; section: `docs/workflows/milestones.md` (summary PR
creation, "Final PR already exists: … create or update/find existing" at line
691 — still true, now also for an incomplete milestone's open PR) and its
`createMilestoneSummaryPr()` citations (Issue #3014, #3223); siblings:
`sync-pr-only`, `predates-reopen` (the other `ClaimProblem` members; `sync-pr-only`
and `predates-reopen` are covered by the `### Flagged — not claimed`
description, and `timeline-unreadable` is named in the "An unreadable timeline
fails closed" bullet above); updated: `docs/workflows/milestones.md` (see the later Docs sweep entry, which extends the same section).

**Docs sweep** — grep: `refreshSummaryPrBody`, `refreshExistingSummaryPr`,
`vibe-rollup-fingerprint`, `issues_closed_all`, `fetchClosedIssuesByMilestone`,
`already exists`/`Final PR already exists`; section: `docs/workflows/milestones.md`
("Final PR already exists", line 691) — extended with the open-only,
fingerprint-gated rewrite and the `updatedAt`-keyed verdict cache;
`docs/GH-API-OPTIMISATION.md:345` and `DESIGN-PRINCIPLES.md:3131` name
`issues_closed_all` only as an invalidated key, still true (the batch gained an
optional `updatedAt`; an old-shape entry is read as it is); siblings:
`issues_all`, `prs_all_branch_*` (the cached branch list now also feeds the
incomplete-path candidate lookup); updated: `docs/workflows/milestones.md`.

**Docs sweep** — grep: `fetchAllStatePRsByBranch`, `BranchPR`, `prs_all_branch`,
`refreshOpenSummaryPrBodyWhileIncomplete`, `not open`; section:
`docs/workflows/milestones.md` ("Final PR already exists", line 692) — extended
with the OPEN-only candidate filter on the incomplete path; the doc comments of
`fetchAllStatePRsByBranch`, `BranchPR` and `refreshOpenSummaryPrBodyWhileIncomplete`
were updated in the same push; `hasExistingMilestoneSummaryPr` (the other
reader of the shared `prs_all_branch_*` entry) reads only `number` and
`headRefName`, so the added optional `state` changes nothing there; siblings:
`number`, `title`, `headRefName` (the existing `BranchPR` members; `state` is
optional so an old cache entry reads as unknown); updated:
`docs/workflows/milestones.md`.
