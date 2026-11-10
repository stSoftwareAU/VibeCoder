## Summary

`withholdIssueClose` (used by `assemblePrBody` and the draft-continuation
bodies) now also rewrites the colon form (`Closes: #N`) and the full-URL form
(`Fixes https://github.com/owner/repo/issues/N`) of the governing issue's
closing reference to `Part of`, in prose only. Before, a partial or missing
closure block withheld only `Closes #N`, so a body holding `Closes: #N` still
closed the issue on merge. The #4126 "Part of still closes" gate in
`pr_summary_check.ts` now names a colon or full-URL closing phrase the same way
as a plain one. Closes #4936.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- The module already exported `COLON_CLOSE_RE` and `URL_CLOSE_RE`, but only the
  babysitter's own guard and the other-issue neutraliser used them. The core
  withhold is the shared chokepoint, so the fix lives there and every caller
  inherits it.

### Essential Design Decisions

- The colon and URL passes skip code spans and fences (Issue #4637: "Babysitter:
  publish committed PR summaries immediately and preserve partial-completion
  semantics" set that rule for these forms); the plain pass keeps rewriting
  everywhere, as before.
- `restoreIssueClose` is unchanged: it turns every `Part of` back into the plain
  `Closes #N`, so a colon or URL original round-trips to the plain form, not
  byte-for-byte.
- A URL names its repository, so with no identity a governing-number URL throws
  `MissingIssueIdentityError`, as a qualified plain reference already does. The
  #4126 gate has no repository identity, so it counts a URL for the run's number
  in any repository (fail closed) and the colon form only when unqualified, as
  `closingKeywordLine` does.
- `hasClosingKeyword` and `closingKeywordLine` in `pr_body.ts` are left as they
  are: they have many callers, and the new gate helper covers the summary check
  without changing their answers.

### Undiscoverable Facts

- None.

## Evidence

Reproduced the issue's scenario through the new test
`worker/deno/tests/missing_criterion_close_guard_3177_test.ts` (`assemblePrBody`
with a `missing` criterion and `Closes: #N`, and with
`Fixes https://github.com/o/r/issues/N`): at the base the body kept the closing
reference next to `## Not closing`; at the head it holds none.

Callers of `withholdIssueClose` checked: `assemblePrBody` (`pr_body_sync.ts`,
passes identity), `guardPrBodyProposal` (`babysitter_pr_body_guard.ts`, runs its
own code-aware colon/URL pass first, then this one; the babysitter suites pass),
`buildUnmetDraftBody` and `buildMutationHoldDraftBody`
(`draft_continuation_pr.ts`; they take an optional `IssueIdentity`, and
`convertToDraftContinuation` forwards one. `completion_phase.ts` passes
`{ prRepo: repo, issueRepo: repo }` at both mutation-hold body builds and both
`convertToDraftContinuation` calls, so a qualified colon or URL reference to the
governing issue is rewritten there instead of throwing
`MissingIssueIdentityError`; the body they receive is not always one that has
been through `assemblePrBody`, e.g. a met-criteria body),
`alignIssueCloseWithClosure`. Issues cited: #4637, #4126 and #3177 (titles
checked with `gh issue view`).

Docs: `docs/INTERNALS.md` (the closure-block paragraph under the merged-PR
closers) updated; grep of `README.md`, `docs/` (not archive),
`CODING-STANDARDS.md`, `DESIGN-PRINCIPLES.md` and `prompts/` for `withhold`,
`Part of #N`, `Closes: #`, `colon form` found no other copy.

## Acceptance Criteria

The issue states no acceptance-criteria heading; nothing it asks is left undone.

## Test Plan

- Added to `worker/deno/tests/missing_criterion_close_guard_3177_test.ts`:
  colon, spaced colon, URL, qualified colon and URL, case-insensitive,
  other-issue and other-repository untouched, identity-less throw (URL) and
  no-throw (unqualified colon), hostile-input, round-trip to `Closes #N`, a
  code/prose fixture, and two `assemblePrBody` tests (colon and URL).
- Added six tests to `worker/deno/tests/pr_summary_check_test.ts` (colon and URL
  phrases block and are named; a parsed `missing` entry passes; code-span and
  other-number phrases are not named; a long run of spaces after `close` is
  handled).
- Added to `worker/deno/tests/draft_continuation_mutation_hold_test.ts`: for
  `Closes: #N`, `Closes: o/r#N` and a full-URL `Fixes`, both
  `buildMutationHoldDraftBody` and `buildUnmetDraftBody` given the identity do
  not throw and leave only `Part of`. With `draft_continuation_pr.ts` reverted
  to base, 4 of these 6 are red (the qualified colon and URL cases).
- Red checks: lib reverted to base, 8 of the new lib tests red; URL pass
  dropped, 4 URL tests red; colon pass dropped, 6 colon tests red; code skip
  removed, the code/prose test red; gate helper removed, the colon and URL
  "names that phrase" tests red; gate colon branch only and URL branch only each
  turn their own test red.
- `deno task test:unit` over `tests/missing_criterion_close_guard_3177_test.ts`,
  `tests/babysitter_pr_body_guard_test.ts`, `tests/fleet_pr_babysitter_test.ts`,
  `tests/pr_body_sync_test.ts`, `tests/closing_keyword_neutralise_4783_test.ts`
  and `tests/pr_summary_check_test.ts`: 313 passed, 0 failed.
- `./quality.sh < /dev/null`: `Result: PASSED (with skipped checks)` (config
  integration and checkov skipped by the gate itself).
- Edited existing tests: none removed or changed; two existing tests' imports
  were extended.
