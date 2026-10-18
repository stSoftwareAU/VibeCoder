## Summary

Closes #3974.

The batched timeline wrapper served the same prefetched 100-event `LABELED_EVENT`
batch for every REST page request, so any issue with 100+ label adds made
`paginateTimeline` loop to page 100 and throw, aborting the whole claim scan. The
wrapper now serves the batch only for page 1 and an empty array for later pages,
and each collector catches a label-author trust-read failure per issue and skips
it fail-closed instead of letting one bad timeline abort the scan.

## Spec

### Intent and Rationale

- A single issue with 100+ label adds must not abort the claim scan for every
  repository, and a possibly-truncated batch entry must not be mistaken for a
  complete timeline.

### Essential Design Decisions

- The wrapper serves the batch only when the request has no `?page=` or
  `page=1`, and returns `[]` for `?page=2+`. A deny-only cache stays safe: a
  grant re-confirms via REST, and `paginateTimeline` treats the empty short page
  as "done".
- Each collector wraps its `wasLabelAddedByAllowedAuthor` trust read in a
  try/catch and treats a throw as `false` (fail-closed skip), logging a warning,
  so one bad timeline cannot abort the scan for every repo.

### Undiscoverable Facts

- `last: 100` reads the 100 most-recent labeled events, so a 100-event entry is
  indistinguishable from a complete timeline for an issue with exactly 100 adds;
  truncation is only detectable via `pageInfo { hasPreviousPage }`, which the
  current GraphQL query does not request (Issue #3089).
- The idle-decision census path (PR #3963) already caught the throw, logged a
  WARNING and treated the issue as trusted; this change makes the discovery
  collectors behave consistently by skipping fail-closed instead.

## Evidence

1. `worker/deno/lib/timeline_batch.ts` — `wrapGhWithBatchedTimeline` now serves
   the cached batch only when the request has no `?page=` or `page=1`, and
   returns `[]` for `?page=2+`, so `paginateTimeline` sees a short page and
   stops instead of looping to page 100.
2. `worker/deno/lib/collect_work_on_candidates.ts`,
   `worker/deno/lib/collect_low_priority_candidates.ts`,
   `worker/deno/lib/collect_label_candidates.ts`, and
   `worker/deno/lib/collect_idle_task_candidates.ts` — each collector now catches
   a throwing `wasLabelAddedByAllowedAuthor` call, logs a warning, and skips the
   issue fail-closed (`labelAdded = false` / `labelAddedByTrusted = false`).
3. Five regression tests cover the wrapper's page-2 empty response and the four
   collectors' fail-closed throw handling (see Test Plan).
4. `./quality.sh` passed (only `config integration` skipped).

- Docs sweep — grep: "wrapGhWithBatchedTimeline", "paginateTimeline", "wasLabelAddedByAllowedAuthor"; section: DESIGN-PRINCIPLES.md, SECURITY.md, docs/INTERNALS.md, docs/GH-API-OPTIMISATION.md (all mentions checked, none describe the truncated-batch page-serving or throw-aborts-scan behaviour, so none stale); siblings: none — no existing set gained a member.

## Test Plan

1. `worker/deno/tests/timeline_batch_test.ts` — `timeline_batch - wrapped gh serves page >= 2 as empty so paginateTimeline stops (Issue #3974)` — runs `wasLabelAddedByAllowedAuthor` through `wrapGhWithBatchedTimeline` with a 100-event batched entry and expects a decision, not a throw.
2. `worker/deno/tests/collect_work_on_candidates_fail_loud_test.ts` — `collectWorkOnCandidates - label-author trust-read failure is a fail-closed skip, not a rejection (Issue #3974)`.
3. `worker/deno/tests/collect_low_priority_candidates_test.ts` — `collect_low_priority_candidates - skips issue when the label-author trust read throws (Issue #3974)`.
4. `worker/deno/tests/collect_label_candidates_test.ts` — `collect_label_candidates - a throwing timeline trust read skips the issue fail-closed (does not reject)`.
5. `worker/deno/tests/collect_idle_task_candidates_test.ts` — `collect_idle_task_candidates - Issue #3974: skips an untrusted-author issue when the label-add trust read throws`.

<!-- vibe-branch-outcomes -->
