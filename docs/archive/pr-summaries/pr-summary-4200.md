# Drop malformed checklist verdicts instead of discarding the whole pre-PR verifier reply

## Summary

Closes #4200. `parseChecklistVerdicts` threw on one out-of-vocabulary verdict
(for example `partial` or `n/a`), so `parseReviewReply` rethrew, the pre-PR
verifier caught it in `verifyInCheckout` and returned `not_checked` ("verifier
reply was not usable"), and the completion phase does not block on that. The
verifier's findings were lost with it. The parser now drops each malformed
checklist entry and keeps the valid ones. A dropped item then falls into the
existing "no verdict was reported" gap finding, which blocks, so a dropped
verdict is never read as `met`. Verdicts are trimmed and lower-cased before the
vocabulary check, as the closure parser does. A non-array `checklist` returns
`[]`.

## Spec

Required by the issue body (`Issue #4200`, "What Needs to Be Done"):

> Trim and lower-case the verdict before checking it against `met` / `missing` / `not applicable`, as the closure parser does.

Mirrors `parseClosureEntryVerdicts` (`worker/deno/lib/closure_met_check.ts:110`).
`checklistGapFindings` is unchanged, so a dropped item still produces the
blocking "no verdict was reported" finding.

## Evidence

**Docs sweep** — grep: `parseChecklistVerdicts`, `retried next pass`, `verifier reply was not usable`, `posts nothing`, `parseClosureEntryVerdicts`, `parseFableReview`; section: `docs/review-checklists.md` (reply without a verdict is a blocking finding, line 135, already accurate, no change); siblings: `parseClosureEntryVerdicts` (`worker/deno/lib/closure_met_check.ts:110`) and `parseFableReview` (`.claude/skills/review-fleet-prs/scripts/review_log.ts:211`); updated: the `parseFableReview` comment at `.claude/skills/review-fleet-prs/scripts/review_log.ts:205-210` (a bad checklist verdict is dropped and sent back, not a reply throw); the `parseChecklistVerdicts` doc comment at `worker/deno/lib/review_checklists.ts:515-523`.

Grep results (the other hits are unrelated):
- `parseChecklistVerdicts`: `worker/deno/lib/pre_pr_verifier.ts:197` (caller), `worker/deno/lib/review_checklists.ts:524` (definition), `worker/deno/tests/review_checklists_3594_test.ts:308,322` (tests).
- `retried next pass`: `.claude/skills/review-fleet-prs/scripts/review_log.ts:206` (reply that is not JSON, still retried), `.claude/skills/review-fleet-prs/scripts/gate.ts:113,932` (fetch failure, unchanged), `docs/review-checklists.md:136` (fetch failure, unchanged).
- `verifier reply was not usable`: `worker/deno/lib/pre_pr_verifier.ts:847` (catch for any other `parseReviewReply` throw, unchanged), `worker/deno/tests/pre_pr_verifier_3395_test.ts:297,1898`.
- `posts nothing`: no hit describes a checklist verdict; the `parseFableReview` comment at `review_log.ts:205-206` is the only fleet-reply reference and is updated above.

**Reproduction** — before the fix, a reply with `{checklist, item, verdict: "partial"}` made `parseChecklistVerdicts` throw. `parseReviewReply` rethrew, and `verifyInCheckout` (`worker/deno/lib/pre_pr_verifier.ts:847`) returned `not_checked`, so the findings were not reviewed. This is the reproduction from the issue body; it was not re-run this session.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — `parseChecklistVerdicts` never throws: a non-array returns `[]`, and each malformed shape is dropped while a valid neighbour is kept — evidence: `worker/deno/lib/review_checklists.ts:525-535`, `worker/deno/tests/review_checklists_3594_test.ts::parseChecklistVerdicts drops each bad shape and keeps valid neighbours`, `worker/deno/tests/review_checklists_3594_test.ts::parseChecklistVerdicts accepts valid entries and defaults` — reviewer: met
- **met** — `parseChecklistVerdicts([{checklist, item, verdict: " Met "}])` returns verdict `met` — evidence: `worker/deno/tests/review_checklists_3594_test.ts:350` (`{ ...ok, verdict: " Met " }`), `worker/deno/lib/review_checklists.ts:533` (`verdict.trim().toLowerCase()`) — reviewer: met
- **met** — `runPrePrVerifier` with one finding plus a `partial` verdict for an expected item is `checked`, blocked, keeps the finding and adds a gap finding naming the item — evidence: `worker/deno/tests/pre_pr_verifier_3395_test.ts::runPrePrVerifier: a partial verdict keeps the model's finding and adds a gap finding naming the item` — reviewer: met
- **met** — `runPrePrVerifier` with no findings and only a `partial` verdict is still `checked` and blocked — evidence: `worker/deno/tests/pre_pr_verifier_3395_test.ts::runPrePrVerifier: only a partial verdict and no findings still blocks, naming the item` — reviewer: met
- **met** — Fleet review: an out-of-vocabulary verdict for an expected item gives `changes_requested` from `decideOutcome`, and `met` for the same item approves — evidence: `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts::a reply with an out-of-vocabulary verdict for an expected item is sent back naming that item; a met verdict for it is approved` — reviewer: met
- **met** — The throw assertions are replaced, and each removed assertion is named in the Test Plan — evidence: `worker/deno/tests/pre_pr_verifier_3395_test.ts::parseReviewReply parses a checklist array, defaults to [] and drops a bad verdict` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Compound-condition rule: the `typeof` operands of `review_checklists.ts:530`, `:531` and `:535` had not been flipped on their own; the first pass only flipped the trim and empty-string operands — fixed in this run: each operand is now flipped on its own and turns a test red (see Test Plan) — reason: fixed in this diff
- **clean** — Australian English, KISS and DRY (the closure parser's shape is reused, no new helper), TDD (each test was red-checked against a broken parser), no new dependency, and the valid-entry default `note: ""` is unchanged

## Test Plan

Removed or replaced assertions (named as required):
- `worker/deno/tests/pre_pr_verifier_3395_test.ts`, "parseReviewReply parses a checklist array, defaults to [] and drops a bad verdict": `assertThrows` for `verdict: "probably"` replaced by `dropped.checklist.map((c) => c.item)` equal to `["i"]`; `assertThrows` for `checklist: "nope"` replaced by `checklist` equal to `[]`. These are committed in `ef6934bd`.
- `worker/deno/tests/review_checklists_3594_test.ts`, "parseChecklistVerdicts rejects each bad shape naming the problem": the `assertThrows` per bad shape is replaced by "parseChecklistVerdicts drops each bad shape and keeps valid neighbours", which also adds `{ ...ok, item: "" }` and `{ ...ok, item: "   " }` (`:322-336`).

Added: the `runPrePrVerifier` partial-verdict tests (`pre_pr_verifier_3395_test.ts:1188`, `:1231`), and the fleet out-of-vocabulary test (`review_fleet_prs_checklists_3594_test.ts:457`).

Red-checks (each flip applied to `worker/deno/lib/review_checklists.ts`, the file then restored and confirmed identical to a backup):
- **A** — throw on a malformed entry instead of `continue`: 5 failed (brief run, not re-run this session).
- **B** — no trim or lower-case: 2 failed (brief run, not re-run this session).
- **C** — out-of-vocabulary verdict pushed through as `met`: 5 failed (brief run, not re-run this session).
- **D** — no note check: 1 failed, the drop test (brief run, not re-run this session).
- **E** — `item.trim() === ""` forced to `false` (line 531): the drop test went red at `review_checklists_3594_test.ts:322:6`.
- **Checklist operand** — `checklist.trim() === ""` forced to `false` (line 530): the drop test went red at `:322:6`.

Per-operand flips (this session, scripted, each restored):
- `:525` non-array forced to throw: 2 failed (`:308:6` "accepts valid entries and defaults" and `:322:6`).
- `:528` non-object forced to throw: 1 failed (`:322:6`).
- `:530` `typeof checklist !== "string"` forced to pass: 1 failed (`:322:6`).
- `:531` `typeof item !== "string"` forced to pass: 1 failed (`:322:6`).
- `:532` `typeof verdict !== "string"` forced to pass (`if (false) continue;`): 1 failed (`:322:6`).
- `:535` `note !== undefined` operand forced to pass: 1 failed (`:322:6`).
- `:535` `typeof note !== "string"` operand forced to pass: 1 failed (`:322:6`).

The continue outcomes are listed in `docs/archive/pr-summaries/pr-summary-4200.facts.json`:

<!-- vibe-branch-outcomes -->

Test runs (stdin from `/dev/null`): results are recorded in the final results below.
