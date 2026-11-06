## Summary

The timed-out run's draft PR title now goes through `buildPrTitle`
(`worker/deno/lib/pr_title_build.ts`, Issue #1248), so issue-reference tokens in
the issue title no longer read as references to other issues. An issue titled
`Add caching [#999]` (issue #5) now yields `Add caching (Issue #5)`, not
`WIP: Add caching [#999] (#5)`. Closes #4679.

## Spec

### Intent and Rationale

- The draft path interpolated `issueTitle` raw, bypassing the #1248 fix that the
  normal `pr create` path has. Calling the existing owner closes it with no new
  scrubber.

### Essential Design Decisions

- The draft uses the final title without a `WIP:` prefix. GitHub's draft state
  and the body identify the work as incomplete; marking it ready leaves the
  title unchanged. Existing drafts are not retitled.
- The run's own suffix changes from `(#N)` to the canonical `(Issue #N)`; both
  are matched by `prTitleMatchesIssue`.

### Undiscoverable Facts

- None.

## Evidence

Backend change; no visual evidence applies. `ensureDraftContinuationPr` has one
caller (`worker/deno/lib/phases/execute_phase.ts`), which passes
`ctx.issueTitle` unchanged.

## Acceptance Criteria

Draft titles are scrubbed and omit `WIP:` so newly created drafts retain a
finished title when marked ready.

## Test Plan

- Added `worker/deno/tests/draft_continuation_4146_test.ts` test "#4679 - the
  draft title carries no issue reference from the issue title": a title with
  `[#999]`, `(Issue #998)` and a bare `#997` produces
  `Add caching and see 997 (Issue #5)`; `prTitleMatchesIssue` rejects 999,
  998 and 997 and accepts 5. Red against the unfixed code (title was
  `WIP: Add caching [#999] and (Issue #998) see #997 (#5)`), green after.
- `draft_continuation_4146_test.ts`, `draft_continuation_mutation_hold_test.ts`,
  `draft_ready_ci_4160_test.ts` and
  `completion_phase_pr_title_injection_test.ts` passed (22). No existing
  assertion was removed. The old expectation of a `WIP:` prefix is obsolete;
  the remaining title and injection checks are covered by
  `worker/deno/tests/draft_continuation_4146_test.ts::#4679 - the draft title carries no issue reference from the issue title`.
  The updated title assertion failed with the prefix before the fix and passed
  after it. No twinned title-creation rule was found.
