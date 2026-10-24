## Summary

Malformed issue rows now reject the list with the row index and field name,
instead of silently producing an empty or partial repository snapshot.
Closed-issue batches use the same parser and propagate command failures.
Neither fetcher caches a failed response; a genuine empty array remains valid.

Closes #4124

## Spec

### Intent and Rationale

- Milestone and issue-selection readers must distinguish failed reads from an
  empty repository.
- Supersede #4110's skip-and-log policy with whole-list rejection.

### Essential Design Decisions

- Reuse the existing field guards and parser for open and closed lists.
- Preserve optional-field defaults and cache payload shapes, including reads
  of legacy cache entries. No cache key change is needed.
- Reviewed all direct callers: the parser is used by the two batch fetchers;
  label and milestone filters propagate errors. Existing caller-level recovery
  remains unchanged. Milestone-health error reporting is tracked by #4106.

### Undiscoverable Facts

None.

## Evidence

- Regression tests against the previous implementation: 98 passed, 18 failed.
- Updated issue-query, all-state cache, milestone cache, health, progress and
  completion suites: 320 passed, 0 failed.
- Changed-file Deno lint and formatting passed.
- Full quality gate and manifest checks: running; results will be recorded
  before this PR is marked ready.
- Backend-only change; no visual evidence applies.

Docs sweep: grep: `parseIssueListJson`, `fetchAllIssues`,
`fetchAllClosedIssues`, `malformed`; section: `docs/GH-API-OPTIMISATION.md`
open-issue batching and limit-aware caching; updated that manual and parser,
closed-fetch and cache doc comments; siblings: none — no set gained a member.
Historical summaries remain records of their original changes. Other current
manual references describe batching and cache keys, which are unchanged.

## Test Plan

- Reject invalid JSON, non-array roots, non-object rows, invalid number/title,
  and malformed author, assignee, label and milestone values by field name.
- Assert failed open and closed fetches leave caches untouched and retry with
  a valid response; verify filtering helpers propagate malformed-list errors.
- Verify closed transport failures reject and genuine empty lists are cached.
- Retain valid-row, optional-field and legacy-cache compatibility coverage.
- Twinned rule: closed-list parsing now delegates to the open-list parser.

<!-- vibe-branch-outcomes -->

## Merge verification

CI and review pending.
