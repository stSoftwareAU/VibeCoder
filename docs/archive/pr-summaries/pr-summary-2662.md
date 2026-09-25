# PR Summary — Issue #2662 (part 1)

## Summary

The claim scan no longer reads issues one at a time for data its own listing
already returned. Part of #2662: this PR covers acceptance criteria 1, 2 and 7.
Criteria 3–6 (the `updatedAt` cache, moving reads to REST, skipping the scan
when the host cannot claim, and prefetch back-off) are left for follow-up PRs.

On GRQ-23 on 2026-09-25, 72% of 33,237 GraphQL calls were
`priority:issue-scanning`. Most of them were per-candidate `gh issue view`
reads: `--json=title,body` alone was 15,336 calls, 46% of the total. The
open-issue listing that found each candidate (`fetchAllIssues`) already asks
for `number,title,assignees,url,labels,createdAt,updatedAt,author,milestone,body`.

- **Content integrity** (`work_on_content_integrity.ts`). The scan-time check
  now takes the title and body from the listed issue for every tier: configured
  label, low-priority and idle-task. Before, only `work-on` did this (#1818).
  The hashed bytes are the listing's `body` field, the same GraphQL field
  `issue view --json body` returned. A listing row without a body is still read
  live. The claimed issue is still re-verified against a live read at pickup
  (#3647), so the TOCTOU guard is unchanged.
- **Dependency reads** (`issue_finder_common.ts`,
  `seedIssueFetcherFromListing`). The fetcher behind the dependency gate is
  seeded from the listing:
  - A listed issue's body comes from the listing.
  - A listed issue's state is OPEN, since the listing contains open issues
    only.
  - Dependencies the listing does not cover (closed issues, merged PRs) are
    read in one aliased `issueOrPullRequest(number:)` GraphQL query per
    repository, at most 50 per query (`fetchIssueStatesBatch`). The query
    covers every uncovered same-repository reference in the listing's bodies.
    Results go into the iteration cache under the key the per-issue path
    already uses.
  - A failed batch (gh error, GraphQL `errors`, bad JSON, bad slug) falls back
    to the per-issue read. That changes the cost, never the verdict.
  - The claim scan (`find_oldest_issue.ts`) and the idle census
    (`new_work_eligibility.ts`) both use it.
- **`ignore-open-prs` check** (`hasIgnoreOpenPRsLabel`). All five callers pass
  the listed labels, so `issue view --json labels` is gone from the scan. Who
  added the label is still verified against the timeline. The per-issue label
  read was already cached for the iteration, so the label is about as fresh as
  before: a newly added `ignore-open-prs` is seen when the listing next
  refreshes, which takes at most 600 s. One fixture in
  `find_issues_by_label_gating_test.ts` had a listing without the label that
  its per-issue view reported. It now lists the label, as GitHub would, and its
  assertion is unchanged.
- **Timeline batches** (`find_oldest_issue.ts`). One label-event batch per
  repository covers every tier's issues. Before, each of the four collectors
  batched only its own tier. The collectors' `getBatchedGh` calls then find
  every number already in the iteration registry.

All `gh` calls still go through the existing `ghCommandFn` seam. Untrusted-text
handling of bodies and fleet-author verification are unchanged.

## Evidence

`worker/deno/tests/scan_graphql_budget_2662_test.ts` runs one scan cycle over a
20-repository fixture through a counting `gh` stub. A cycle is five
`findOldestIssue` scans: one cached listing serves about five two-minute idle
scans. The stub classifies calls with the production `isQuotaExemptGhCall`.
Every repository has top-priority, work-on, low-priority and idle-task issues
and a closed dependency, and every third repository has an open fleet PR.

| Call shape                                      | Before | After |
| ----------------------------------------------- | -----: | ----: |
| `issue list`                                    |     20 |    20 |
| `pr list`                                       |     80 |    80 |
| `api graphql` (timeline batches)                |    400 |   100 |
| `issue view --json=title,body`                  |    600 |     0 |
| `issue view --json=body`                        |    117 |     0 |
| `issue view --json=labels`                      |     63 |     0 |
| `issue view --json=number,state,title,milestone` |     13 |     0 |
| `api graphql` (dependency-state batches)        |      0 |    13 |
| **GraphQL total**                               | **1,293** | **213** |

That is an **83.5% reduction**, above the 60% target. The "before" figure was
measured by running the new test against the unchanged `lib/`. On that code the
three budget assertions fail and the claim assertion passes.

The same test asserts that every scan claims exactly what the pre-change finder
claimed (`fleet/repo-02#1`). `tests/listing_seeded_fetcher_2662_test.ts` covers
the seeded fetcher and the batch:

- listed reads make no call;
- one batch per repository;
- `MERGED` normalises to CLOSED;
- each failure shape falls back to the per-issue read;
- a repository without a listing is unchanged;
- the batch splits at 50 aliases;
- a bad slug is refused.

Local targeted runs (`--parallel --reporter=dot`, integration files excluded)
passed 2,087 and 792 tests. These were every test touching the finder,
collectors, content integrity, the idle census, filers, `issue_query`, timeline
batching and call metrics. `deno check`, `deno lint`, `deno fmt` and
`check:manifests` also passed.

## Acceptance Criteria

| # | Criterion | Status | Evidence |
| - | --------- | ------ | -------- |
| 1 | Scanning makes no per-candidate `gh issue view` for data the listing returned; a test asserts zero | **Met** | `scan cycle over 20 repos makes no issue view for a candidate the listing covered`. Uncovered dependency states are batched as well (`… batches the dependency states the listing did not cover`) |
| 2 | ~20-repo counting-stub test; GraphQL calls fall ≥ 60%; both numbers recorded | **Met** | 1,293 → 213 (−83.5%), pinned as `BASELINE_GRAPHQL_CALLS` and in the table above |
| 3 | Unchanged issue (same `updatedAt`) not re-read; edited issue re-read | Missing (follow-up) | Out of scope for this PR |
| 4 | Reads moved to REST counted against the core limit | Missing (follow-up) | Out of scope for this PR |
| 5 | No new-work scan below disk floor / failing health / no free slot | Missing (follow-up) | Out of scope for this PR |
| 6 | Failed cross-repo PR prefetch reuses last good result | Missing (follow-up) | Out of scope for this PR |
| 7 | No behaviour change in what gets claimed | **Met** | `… claims exactly what it claimed before`, checked on both old and new code. The existing claim-scan, idle-census and filer tests pass unchanged |

## Part 2 — criterion 6 (prefetch under rate limits)

Criterion 6 of the acceptance list (the brief's "criterion 5", the fifth
proposed change): the cross-repo open-PR prefetch keeps serving when its
search fails, instead of falling back to
`gh pr list --repo --author --state open` for every repo and author. On
GRQ-23 that listing shape alone was 3,281 calls on 2026-09-25.

- **Last good result** (`fleet_pr_prefetch.ts`). Every successful search is
  kept as the owner's last good result. A failed search inside
  `PREFETCH_REUSE_WINDOW_SECONDS` (3,600 s, the primary GraphQL quota window)
  fills the missing guard and maintenance entries from it. A live entry is
  never overwritten. The invitation listing is not served from it, so it fails
  closed. The window is longer than the 600 s listing cache on purpose: the
  search only runs after that cache has expired.
- **Rate limit: wait, don't fall back.** Rate-limited with nothing to reuse,
  the owner is reported in `ownersRateLimited`. The production dep throws the
  primary rate limit and `run_core` re-throws it into the existing pause
  (Issue #1780). Any other failure with nothing to reuse still falls back per
  repo, at most once per repo and author per 600 s cache window.
- **Refreshed where it is read** (`run_core.ts`). The prefetch now also runs
  before every issue scan and before the post-scan auto-merge pass. Inside the
  TTL this is a marker read. After a run that outlived the cache it is one
  search per owner. Concurrent slots share one pass.
- **Post-scan pass** (`EnsureAutoMergeOptions.refreshRepos`). Only the repos
  the cycle claimed from are listed live. Before, every repo was listed live
  for every fleet author.
- **`isDraft`**. The prefetched `prs_<login>` entry now carries it. The
  auto-merge sweep reads it to skip drafts (Issue #1800), and without it a
  draft served from the prefetch looked ready to arm.
- **Closed-PR listing** (869 calls): no new cache added. It is already a
  settled listing (Issue #2409), served for up to 3,600 s while every open PR
  seen since caching is still open. It reads that open set from `prs_<login>`,
  so a reused prefetch keeps it warm too.
- **Not routed.** The all-authors listing (`prs_open_all`, the 541-call
  `pr list --json --state=open` shape) is not routed through the prefetch. It
  needs PRs by any author, including bots and people outside the fleet, while
  the search covers only fleet and trusted logins. Widening the search would
  change its 1,000-result truncation risk for every consumer.

### Evidence

`worker/deno/tests/fleet_pr_prefetch_budget_2662_test.ts` runs the real
prefetch and the real consumers (`fetchOpenPRsForFleet`, `listOpenPrs`) over
a 20-repo fixture. The duplicate guard covers 4 authors and maintenance covers
2. Calls go through a counting `gh` stub, and the cache and prefetch share an
injected clock (no sleeps). `pr list` calls per cycle:

| Cycle | Before | After |
| ----- | -----: | ----: |
| Healthy search | 0 | 0 |
| Search failed, last good 11–30 min old | 120 | 0 |
| Search rate-limited, last good 11 min old | 120 | 0 |
| Search rate-limited, no last good | 120 | 0 (cycle waits) |
| Search failed, last good older than 1 h | 120 | 120, then 0 next cycle |
| Post-scan auto-merge pass, 1 claimed repo | 40 | 2 |

The "before" figure of 120 is the per-repo path the old code took on any
failed search (20 repos × 6 author listings). The test measures it on the
same fixture as its reference. Every path produces the same guard view, and
the scan claims the same repo on each (`fleet/repo-03`). With `lib/` reverted
to `main`, the new `run_core` and production-deps tests fail and the budget
test cannot load: the reuse API, `refreshesRepoLive` and the clock seam are
missing.

Other tests added:

- `run_core_fleet_prefetch_test.ts`: a re-scan after a run is preceded by a
  prefetch, and a rate-limited prefetch pauses the cycle with no scan.
- `run_core_post_scan_auto_merge_test.ts`: the post-scan pass names only the
  claimed repo, after a prefetch.
- `fleet_pr_prefetch_wiring_test.ts`: the production dep surfaces the rate
  limit, reuses the last good result, and shares one search across concurrent
  callers.

Local targeted runs passed 446 and 352 tests (`--parallel --reporter=dot`,
integration files excluded). These covered the prefetch, the claim scan
(`find_oldest_issue*`, `claim_issue`), the idle census and filer, the
`run_core*` suites, `issue_query*`, the auto-merge sweep and the #2662 scan
budget test.

| # | Criterion | Status | Evidence |
| - | --------- | ------ | -------- |
| 6 | Failed cross-repo PR prefetch reuses last good result | **Met** | `#2662 - a rate-limited search reuses the last good prefetch: zero per-repo listings` and the table above |
| 7 | No behaviour change in what gets claimed | **Met** | Same claim on every path in the budget test; existing claim-scan, idle-census and filer tests unchanged and passing |
