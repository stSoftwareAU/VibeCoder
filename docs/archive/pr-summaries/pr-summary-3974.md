## Summary

Closes #3974.

The batched timeline wrapper repeated its prefetched 100-event label-add tail
for every REST-shaped page request. A full batch therefore made the trust
reader reach its page cap and throw. The wrapper now serves that tail on page
1 (or without a page parameter) and returns an empty array on page 2 and later,
so the reader terminates. The four discovery collectors catch a throwing
label-author read per issue and follow their existing untrusted-result paths.

## Spec

### Intent and Rationale

- One busy issue must not abort the claim scan for every repository.
- Keep the bounded GraphQL tail distinct from exhaustive REST history, and keep
  the file-cache deny-only trust contract.

### Essential Design Decisions

- For an issue present in the batch map, the wrapper reads `page=` from the
  timeline URL and returns `[]` when the numeric page is at least 2. Unknown
  issues and non-timeline calls still reach the supplied base function.
- The GraphQL query still reads `last: 100` label adds. It does not fetch older
  GraphQL pages or the full event history. A label absent from that tail cannot
  grant label-author trust. The newest add remains in the tail.
- A file-cache entry may deny trust, never grant it alone. A grant requires
  API-backed data, which can be the current iteration's GraphQL batch rather
  than a new REST call. The registry resets between iterations.
- Work-on, configured-label and low-priority collectors substitute `false` on
  a throwing trust read and take their blocked/skip paths. Work-on retains its
  existing guarded hand-off for a positively confirmed untrusted adder.
  Idle-task collection substitutes `false` too, but retains its independent
  trusted-author origin exception; its regression uses an untrusted author.

### Undiscoverable Facts

- A 100-event tail alone cannot distinguish exactly 100 label adds from a
  truncated history. The issue explicitly permits this page-1/empty-later-page
  adapter as a solution; it does not add `pageInfo.hasPreviousPage` handling.

## Evidence

- `worker/deno/lib/timeline_batch.ts` supplies the terminating page behaviour.
  Its regression reads a 100-event batch through the real trust reader and
  still asserts a trusted decision with no base REST calls.
- The four collector regressions cover throwing trust reads. The work-on
  regression also retains every no-label-change/no-comment assertion.
- Commit `095c80f8` removed overwritten false initialisers from those collectors.
  This follow-up rechecked the five branch citations and their named tests;
  the existing false-on-error assignments and assertions remain intact.
- The old summary's unconditional REST-confirmation claim and the API manual's
  planned-batching wording did not describe the current head. The API manual
  and internal trust explanation now distinguish a live iteration batch from
  file-backed cache data and exhaustive REST fallback.

**Docs sweep** — grep: `wrapGhWithBatchedTimeline`, `paginateTimeline`,
`wasLabelAddedByAllowedAuthor`, `Batch path`, `freshly paginated`;
section: updated `docs/GH-API-OPTIMISATION.md#batch-path-graphql` and
`docs/INTERNALS.md` label priority/cache explanation; siblings: none — no
existing registry gained a member. The remaining advisory hits are still true
for these reasons:

- `docs/audits/security-sweep-1218-commands-cli.md:306`: the seed route still
  checks the same label-author gate; this change does not remove that gate.
- `worker/deno/tests/timeline_batch_test.ts:290`: the section still exercises
  the wrapper with existing consumers.
- `worker/deno/lib/issue_query.ts:2862`: exhaustive REST pagination still
  describes the fallback; the batch adapter supplies a bounded label-add tail.
- `worker/deno/lib/collect_low_priority_candidates.ts:182` and
  `worker/deno/lib/collect_work_on_candidates.ts:256`: both still name the
  shared label-author consumer; the added catch changes error handling only.
- `worker/deno/lib/timeline_batch.ts:78`, `:124` and `:284`: tail selection,
  REST-shaped conversion and the named wrapper consumers remain unchanged.
- The API manual's former `:322` and internal manual's former `:1714` hits
  are in the corrected batch/trust explanations above.

## Test Plan

- Original regressions retained: `timeline_batch_test.ts` (100-event batch),
  `collect_work_on_candidates_fail_loud_test.ts`,
  `collect_low_priority_candidates_test.ts`, `collect_label_candidates_test.ts`
  and `collect_idle_task_candidates_test.ts` (the four throwing-read paths).
- Current follow-up validation: those five suites plus
  `timeline_cache_trust_test.ts`, `timeline_latest_event_pagination_test.ts`,
  `label_security_test.ts` and `timeline_batch_registry_test.ts` pass through
  the unit runner: 156 tests, no failures. Paths are under `worker/deno/tests/`.
  No source behaviour, test or assertion is changed by this follow-up.
- Repository Markdown lint reports no issues across 230 files; the restricted
  Mermaid command passes across 1,392 files and 1,305 blocks. Facts formatting,
  branch line references and named tests were checked against the current tree.
- The exact hosted `pr-summary-ci` command reproduced the stale-summary block
  at `095c80f8`; it is re-run on the refreshed commit. A not-checked gate is
  reported as such, and no full local quality-gate result is claimed here.

<!-- vibe-branch-outcomes -->
