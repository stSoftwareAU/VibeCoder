## Summary

`fetchOpenPRsByUser` asked `gh pr list` for only 10 rows, newest first, so once
a fleet account had more than 10 open PRs in a repository the open-PR duplicate
guard (the own-PR rule in `getBlockingPRForIssue`, #2663) never saw an older own
PR, and the issue could be claimed again and given a second PR. The listing now
passes `String(OPEN_PR_BY_USER_LIMIT)` to `--limit`, and `OPEN_PR_BY_USER_LIMIT`
is raised from 10 to 100. Closes #4518.

Version bump: `VERSION` is not edited by this change; the merged commit records
the final version.

## Spec

### Intent and Rationale

- The guard itself is correct; it was fed a truncated listing. Widening the
  listing lets it see the PRs it was written for, with no new check.

### Essential Design Decisions

- One constant drives both the `--limit` and the settled-listing truncation rule
  in `openPrNumbersByUser` (a full listing reads as unknown), so they stay in
  step. That rule still returns `null` at 100 open PRs, as it did at 10. The
  constant is exported so the settled-listing test uses the same boundary.
- The `prs_<login>` cache entry keeps its shape (an array of PRs), so no key
  bump is needed; an entry cached under the old limit expires with the cache.
- The claim-time re-check (`liveFleetPrRecheck`) and the prefetch share
  `fetchOpenPRsByUser`/the same entry, so they pick the fix up without edits.
  `decideCompletionPr` (point 4 of the issue) is unchanged; the issue's proposed
  fix does not touch it.

### Undiscoverable Facts

- The incident was in a private fleet repo; its timeline is in the issue, and no
  logs from it are in this repository.

## Evidence

Backend only; no UI files touched. Code: `worker/deno/lib/issue_query.ts`
(`fetchOpenPRsByUser`, `OPEN_PR_BY_USER_LIMIT`). No doc named the 10-row limit
(grepped `docs/` and the READMEs for `--limit`, `10 newest`, `first 10`). Issue
numbers cited as provenance, looked up in the existing code: #2663 (own-PR
hold).

## Test Plan

- New `worker/deno/tests/open_pr_listing_limit_4518_test.ts`: a `gh` stub that
  honours `--author` and `--limit` over 12 open PRs by one fleet author, the
  issue's own PR the oldest. Tests: the own PR is found and holds its issue (not
  the cap); an issue with no PR of its own is held only by the cap (control, cap
  50 holds nothing); the requested `--limit` exceeds 12.
- Red check: with the limit set back to 10 all three tests fail
  (`every open PR
  of the author is listed - 10 + 12`); restored, all three
  pass.
- Passed: `deno task test:unit` over the new test,
  `fleet_pr_own_issue_hold_2663`, `fleet_pr_prefetch_budget_2662`,
  `fleet_duplicate_prevention`, `recent_activity_cache` and
  `stuck_issue_detector` tests (102 passed, 0 failed). `deno fmt`, `deno lint`,
  `deno check` on the touched files: clean.
- Updated `settled_pr_listing_2409_test.ts` to derive its full-listing fixture
  from `OPEN_PR_BY_USER_LIMIT`; both merged and closed listings still verify
  that a full open listing proves nothing. Passed: `deno test` on that file
  (14 passed, 0 failed).

<!-- vibe-quality-gate-skipped reason="the full ./quality.sh takes about 15 minutes and did not fit the remaining run budget alongside the other pending PRs; targeted tests ran, CI runs the full gate" -->
