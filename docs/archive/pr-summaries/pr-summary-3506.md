# PR Summary — Issue #3506

## Summary

A healthy (non-degraded) run whose PR summary closed out a criterion as
`partial` or `missing` raised a PR that closed the issue, and nothing tracked
the rest. Before this change, only a degraded run filed a follow-up. Now the
same guard (`applyDegradedDeliveryGuard`, at both of its call sites) files one
`idle-task` follow-up for a healthy run's own `partial` or `missing` closure
entries, or reuses the existing one, keyed on the parent. The PR body then
opens with a `## ⚠️ Partial delivery — follow-up filed` section that links the
follow-up. `unassessed` items still file nothing (#2695). A later PR-body
re-sync re-derives that section. Closes #3506.

## Spec

### Intent and Rationale

- The worker already parses the closure verdict and already files a
  parent-keyed follow-up. The only gap was the degraded-only condition, so the
  fix reuses `assessScopeShortfalls`, `degradedNeedsFollowUp` and
  `fileDegradedFollowUp` rather than adding a second pipeline.
- The PR keeps its closing keyword, as the issue asks. The residue survives
  the merge in the follow-up.

### Essential Design Decisions

- A healthy and a degraded run on the same parent share one follow-up: the
  healthy path uses the same `degraded-follow-up-<N>` finding id. No persisted
  key changes, so existing follow-ups are reused rather than duplicated.
- `assessReportedGaps` keeps only `partial` and `missing` shortfalls. On a
  healthy run, `unassessed` items never file a follow-up and never appear in
  the section.
- Failing to file or update the follow-up fails the run, exactly as on the
  degraded path. Raising the PR anyway would close the issue with the
  residue recorded nowhere.
- On a run, healthy or degraded, whose issue states no criteria there is
  nothing to match entries against, so `assessScopeShortfalls` keeps each
  `partial` or `missing` entry as a shortfall named by its own subject, and
  lists each `met` entry's subject as delivered (PR #3676 review).
  `assessReportedGaps` filters that to the `partial`/`missing` ones, so a
  `met` entry alone files nothing on a healthy run. A degraded run with such an
  entry files a follow-up instead of the no-follow-up section for an issue
  that states no acceptance criteria; with no such entry it still gets that
  section. Delivered lines are therefore the issue's scope items or,
  with no scope, the agent-written `met` subjects; both are untrusted and
  neutralised by `neutraliseAgentMarkers`.
- A healthy run on an issue that is itself a partial-delivery follow-up (its
  body carries a `degraded-follow-up-<N>` marker) files no nested follow-up
  (PR #3676 review). It labels the issue `needs-human` and comments naming
  the gaps, and its PR opens with a `## ⚠️ Partial delivery — handed to a
  human` section carrying a `vibe-follow-up-chain-stop` marker, with the
  closing keyword for the issue turned into `Part of`. Both merged-PR closers
  leave such an issue open, and only when the PR body opens with the chain-stop
  heading followed by the marker: a marker quoted in a summary code span or
  mentioned under a later heading does not hold it (`hasFollowUpChainStop`). A
  degraded run on such an issue still files one, as before. Without this, an
  item no run can deliver chained `Finish #F: Finish #N: …` fleet runs without
  end. Marker authorship is not
  checked, because a planted marker only sends the gaps to a human.

### Undiscoverable Facts

- A `missing` entry still turns `Closes` into `Part of` (#3177). That rule is
  untouched, so a `missing` gap both keeps the parent open and gets a
  follow-up, as it already did on the degraded path.
- The issue's second "How to verify" bullet (the review-fleet-prs log stops
  recording this kind of finding) can only be observed after deployment, by
  later review rounds. No code in this repository can demonstrate it, so it
  is not scored above.

## Evidence

Backend/CLI change only; no UI files are touched.

```mermaid
flowchart TD
    R["Completion phase"] --> D{"Degraded?"}
    D -- yes --> G["Existing degraded guard (unchanged)"]
    D -- no --> H{"assessReportedGaps:<br/>any partial or missing entry?"}
    H -- no --> P["PR as before"]
    H -- yes --> C{"Issue is itself a<br/>partial-delivery follow-up?<br/>(PR #3676 review)"}
    C -- no --> F["fileDegradedFollowUp<br/>(same finding id, healthy body)"]
    C -- "yes (chain stop)" --> CS["No nested follow-up; label needs-human;<br/>PR body opens 'handed to a human', says 'Part of'"]
    F -- filed --> S["PR body opens with<br/>'Partial delivery — follow-up filed'"]
    F -- "gh failed" --> X["Run fails, no PR finalised"]
    S --> Y["Later re-sync:<br/>rederiveReportedGapSection"]
    Y -- "gaps changed" --> U["Section keeps the number and says the<br/>follow-up may not list every item<br/>(the follow-up is never written)"]
```

- Completion-phase behaviour is tested in
  `worker/deno/tests/completion_phase_degraded_delivery_test.ts`.
- The library is tested in `worker/deno/tests/degraded_delivery_test.ts`.
- The re-sync is tested in `worker/deno/tests/pr_body_sync_test.ts`.
- Fakes: `runCompletion` stubs `gh issue list` as `[]` and `gh issue create`
  as an issue URL. These stand in for `fileFindingOnce`'s real `gh` calls,
  which the existing degraded tests already exercise the same way.
- Cited issues:
  - #3506: A healthy run that closes out a criterion as partial or missing
    still closes the issue with no follow-up (three private fleet PRs).
  - #3177: Missing-core-deliverable rule is prose only.
  - #2695: Skip degraded-run follow-ups unless a criterion is partial or
    missing.
  - #3350: PR body sync carries a stale 'Degraded run' banner forward that no
    fix run can remove.
  - #2562: bug: a degraded (fallback-model) run can close an issue with only
    partial scope delivered.

**Docs sweep** — grep: "healthy run is untouched", "degraded-run guard",
`extractDegradedRunSection`, "Degraded run"; section:
`docs/workflows/issue-processing.md#️-a-degraded-run-never-closes-an-issue-as-complete`;
siblings: `buildDegradedNoFollowUpSection`, `buildDegradedPrSection` — the
leading-section set gained the partial-delivery section, and the re-sync docs
and `pr_body_sync.ts` module doc now name it; the PR #3676 review fix (the re-sync never writes to the follow-up) re-read the `Re-sync` bullet of the same section, the `rederiveReportedGapSection` doc comment, the `pr_body_sync.ts` module doc and the `docs/USAGE.md` re-sync sentence, and rewrote each to the conditions `rederiveReportedGapSection` checks (no gap: dropped with no follow-up call; number unreadable: live section kept; gaps changed: stale-follow-up wording); the PR #3676 stale-claim and milestone fix (grep: "claim-freshness", "abortStaleClaim", `--milestone`, "idle-task follow-up"; siblings: the `The follow-up carries the idle-task label` and `The PR is still raised` bullets of the same section) added a bullet for each to `docs/workflows/issue-processing.md` and a paragraph to the claim-freshness section of `docs/INTERNALS.md`; the PR #3676 eighth-round fix (grep: "copied from the issue body", "Delivered lines", "scope items the summary marks"; siblings: `shortfallLines`, `DegradedDeliveryVerdict.shortfalls`) reworded the `buildDegradedFollowUpIssue` comment, the `DegradedDeliveryVerdict.delivered` doc and the `issue-processing.md` follow-up bullet to name both sources; updated:
`docs/workflows/issue-processing.md`, `docs/INTERNALS.md`, `docs/USAGE.md`,
`prompts/issue/prompt.md`, plus doc comments in
`worker/deno/lib/degraded_delivery.ts`, `worker/deno/lib/pr_body_sync.ts` and
`worker/deno/lib/phases/completion_phase.ts`. Hits left in place, each still
true because it names the guard, which still runs for degraded runs:
- `CODING-STANDARDS.md:809`, `prompts/coding_guidelines/prompt.md:1466` and
  `prompts/pr_feedback/prompt.md:64` list it as an example guard.
- `docs/workflows/issue-processing.md:2617`–`:2621` (the paragraph "A degraded
  run, or a healthy run with its own `partial`/`missing` gaps … is the
  exception to `summary_incomplete`") and the outcome table below it describe
  the guard's failure handling, which now covers both cases.
- `worker/deno/lib/acceptance_criteria_gate.ts:78` and
  `worker/deno/lib/closure_criterion_match.ts:95` say the guard reads these
  values, which it still does.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — In the completion phase, apply the follow-up half of the degraded-run guard to every run whose closure verdict has a `partial` or `missing` entry, not only to degraded runs; file (or reuse, keyed on the parent issue) one `idle-task` follow-up naming each shortfall, add a PR-body section that points at it; `unassessed` items keep the #2695 rule and file nothing — evidence: `worker/deno/tests/completion_phase_degraded_delivery_test.ts::completion - a healthy run whose summary reports a missing criterion files one follow-up and says so in the PR (Issue #3506)`, `worker/deno/tests/degraded_delivery_test.ts::assessReportedGaps - unassessed items are dropped but an unassigned partial gap is kept (Issue #3506)` — reviewer: met
- **met** — Optionally, have the implementation prompt say this explicitly: a criterion closed out as `partial` or `missing` means a follow-up — evidence: `prompts/issue/prompt.md` ("Every `partial` and `missing` carries a one-line reason" bullet) — reviewer: met
- **met** — Keep the PR's closing keyword, since #520 says a PR that does not close its issue loops — evidence: `worker/deno/tests/completion_phase_degraded_delivery_test.ts::completion - a healthy run whose summary closes out one criterion as partial files exactly one idle-task follow-up (Issue #3506)` (the PR is still raised, status `continue`) — reviewer: met
- **met** — Unit test: a healthy (non-degraded) run whose summary closes out one criterion as `partial` files exactly one `idle-task` follow-up and adds the follow-up section to the PR body — evidence: `worker/deno/tests/completion_phase_degraded_delivery_test.ts::completion - a healthy run whose summary closes out one criterion as partial files exactly one idle-task follow-up (Issue #3506)` — reviewer: met
- **met** — A run where every criterion is `met` files nothing — evidence: `worker/deno/tests/completion_phase_degraded_delivery_test.ts::completion - the same run, healthy and complete, raises the PR with no follow-up`, `worker/deno/tests/degraded_delivery_test.ts::assessReportedGaps - every entry met leaves no shortfall (Issue #3506)` — reviewer: partial — reason: the reviewer saw only the diff and so missed the existing completion-phase test for a healthy all-`met` run. That test is unchanged at the head and passes with this change.
- **unrequested** — the PR-body re-sync re-derives the new section (`rederiveReportedGapSection`, `extractLeadingSection` in `worker/deno/lib/pr_body_sync.ts`) — reviewer: unrequested — reason: without it, a review-fix re-sync would silently drop the section the issue asks for, or keep it once stale (the #3350 lesson)
- **unrequested** — a healthy run fails loud when its follow-up cannot be filed — reviewer: unrequested — reason: the shared guard already does this, and raising the PR would close the issue with the residue recorded nowhere, which is the failure the issue describes
- **unrequested** — a separate healthy-run body in `buildDegradedFollowUpIssue` — reviewer: unrequested — reason: the degraded body says "the run was degraded" and names a fallback model, which would be false for a healthy run

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — `worker/deno/lib/pr_body_sync.ts` module doc still named only the degraded-run section (raised as optional; treated as a stale doc comment) — evidence: `worker/deno/lib/pr_body_sync.ts:6` — reason: fixed in this diff
- **clean** — Named tests exist. The new tests go red without their change, and negative assertions have the forbidden thing in their fixtures. The failure-reason test asserts the cause (`HTTP 502`). Fail-loud paths are kept. The follow-up number is never read from untrusted bullets. No persisted-shape change. Review-enforced rules checked: Australian English, check where you insert (#3194), prose about the PR's own change, doc comments outside the diff going stale, and behaviour another issue delivers not described as present.

## Test Plan

- `deno task test:unit` from `worker/deno` passed on an earlier head, after
  the mutation-check tests were added (before the review rounds below; the
  full gate was not re-run on the final head): 27568 passed and 969 passed in its two
  runs, 0 failed. It ran every test file that drives `workOnIssueCompletion`
  or `syncPrBodyFromSummary`, plus `worker/deno/tests/degraded_delivery_test.ts`.
- PR #3676 review push (second round, no follow-up writes from the sync):
  `deno fmt --check`, `deno lint`, `deno check` and `deno task test:unit` over
  `tests/pr_body_sync_test.ts`, `tests/degraded_delivery_test.ts`,
  `tests/completion_phase_degraded_delivery_test.ts`,
  `tests/pr_feedback_processor_test.ts` and `tests/pr_ci_processor_test.ts`
  passed (218 passed, 0 failed); `markdownlint-cli2` passed on the changed
  docs. The full gate was not re-run on this push.
- PR #3676 review push (third round, stale claim and milestone), in
  `worker/deno/tests/completion_phase_degraded_delivery_test.ts` (8 added) and
  `worker/deno/tests/degraded_delivery_test.ts` (1 added):
  - A healthy run's new follow-up is closed (`gh issue close 900 --reason
    "not planned"`) when the parent reads CLOSED at the pre-PR check and no PR
    is raised; the same for a degraded run; a reused follow-up is never closed;
    a stale claim with no gap files and closes nothing; an OPEN parent keeps
    its follow-up and raises the PR.
  - A parent with `milestoneTitle` "Q4 Launch" gets `--milestone Q4 Launch` on
    the follow-up's `gh issue create`; a parent without one carries no
    `--milestone`. `fileDegradedFollowUp` has the same pair as a unit test.
  - Red checks on the final head: disabling the close in `abortStaleClaim`
    turned 2 tests red (healthy and degraded); dropping the `--milestone`
    argument turned the milestone completion test red; changing
    `guarded.followUp && !guarded.followUp.reused` to `guarded.followUp` turned
    "a reused follow-up is never closed when the claim goes stale" red;
    changing the close-failure warning text turned the failed-close test red.
  - `deno test -A` over `tests/completion_phase_degraded_delivery_test.ts`,
    `tests/degraded_delivery_test.ts`, `tests/pr_body_sync_test.ts` and
    `tests/claim_freshness_phase_test.ts`: 152 passed, 0 failed on the head of this push; `deno lint`, `deno check` and `deno fmt --check` passed.
- PR #3676 review push (fourth round, follow-up chain): 3 tests added to
  `worker/deno/tests/completion_phase_degraded_delivery_test.ts` (a healthy
  run on a follow-up files no `idle-task` issue, labels it `needs-human`,
  comments, and its PR body opens with the chain-stop section and does not
  close it; a failed label raises no PR and posts no comment; a degraded run
  on a follow-up still files one), 2 to `worker/deno/tests/pr_body_sync_test.ts`
  (the re-sync keeps the section while a gap remains and drops it once none
  does) and the new `worker/deno/tests/follow_up_chain_stop_test.ts` (11 tests:
  the helpers, the leading-section rule (a quoted marker and a later-heading
  mention do not hold the issue), and the closers leaving a chain-stop PR's
  issue open). The
  related suites (689 tests) passed, with `deno fmt --check`, `deno lint` and
  `deno check`. Red check: forcing the chain-stop condition in the guard turned
  9 completion tests red; disabling the closer branch in `pr_issue_linking.ts`
  turned 2 closer tests red. The full gate was not re-run on this push.
- Earlier head: `./quality.sh < /dev/null` passed (`Result: PASSED (with skipped checks)`;
  `config integration` is skipped as usual). Later commits changed behaviour as
  well as docs, log messages and tests: the PR #3676 review fix adds the
  best-effort `abortStaleClaim` close of a newly filed follow-up
  (`completion_phase.ts`) and the `--milestone` argument in
  `fileDegradedFollowUp` (`degraded_delivery.ts`). The targeted fmt, lint,
  check and test runs passed after each of them. The mutation-check fix changed only
  tests and one manual sentence.
- Added to `worker/deno/tests/degraded_delivery_test.ts` (18 tests; the file
  now has 65): `assessReportedGaps`, the healthy and degraded follow-up
  bodies, `buildReportedGapPrSection`, `rederiveReportedGapSection` (empty
  when met; gaps the section was raised with stay as they are; changed gaps
  keep the number and say the follow-up may not list them; a hostile bullet
  and a 50,000-digit run are not read as a number) and
  `buildReportedGapStaleFollowUpSection` (exact layout and throw), and
  `fileDegradedFollowUp - a parent's milestone is passed to gh issue create`.
- Added to `worker/deno/tests/pr_body_sync_test.ts` (8 tests; the file now
  has 54): the section is kept while a gap remains, dropped when every
  criterion is met, logged on drop, not logged when unchanged, and the sync
  fails loud when the issue cannot be read. For the PR #3676 review, three
  tests pin that a sync never writes to the follow-up: changed gaps give the
  stale-follow-up wording and no `gh issue` call other than `view`; an issue
  retitled after approval produces no `gh issue edit` or `gh issue create`;
  and a section already in the stale-follow-up form is re-derived under the
  same number. `syncWithDegradedLive` gained an optional `logger`.
- Red checks for the review fix: restoring the previous `pr_body_sync.ts`
  (which wrote the follow-up) turned the first two review tests red. Making
  `rederiveReportedGapSection` always build the stale wording turned 3 tests
  red ("gaps the section was raised with stay as they are", and two sync
  tests). Dropping the `filed` alternative from the number regex turned
  "a section already marked as possibly stale is re-derived under the same
  follow-up number" red.
- Added to `worker/deno/tests/completion_phase_degraded_delivery_test.ts`:
  - The healthy-`partial` test (exactly one `idle-task` follow-up, with the
    section).
  - The healthy follow-up-failure test (no PR; the reason names
    "partial or missing" and `HTTP 502`).
- Edited existing tests, with the issue requirement that changes each
  expectation:
  - The test "a healthy run is unaffected even when its summary reports a gap"
    is renamed to "a healthy run whose summary reports a missing criterion
    files one follow-up and says so in the PR (Issue #3506)". Its removed
    assertion `assertEquals(outcome.issueCreates.length, 0);` is untrue under
    Proposed change 1: a healthy `missing` entry now files one follow-up. It
    becomes `1`, and every other assertion is kept.
  - "a healthy run blocked by the independent-review gate on an existing-PR
    branch carries no Degraded run section": its other assertions are kept,
    and a section assertion is added. The removed assertion is listed below.
  - "a degraded run whose follow-up cannot be filed raises no PR" gains
    `assertStringIncludes(outcome.reason ?? "", "Degraded run (");` and
    removes nothing.
- Removed from `worker/deno/tests/completion_phase_degraded_delivery_test.ts`: `assertEquals( outcome.issueCreates.length, 0, "a healthy run files no follow-up", );` — #3506 (Proposed change 1) makes a healthy run's own `missing` entry file one follow-up, so "a healthy run files no follow-up" is untrue. The test now asserts `1` with the message "a healthy run's own missing entry files the follow-up before the gate's recovery".
- Added after the mutation check, to pin changed lines no test noticed:
  - `worker/deno/tests/degraded_delivery_test.ts`: "buildDegradedFollowUpIssue
    - the healthy body is laid out exactly, blank lines and headings included
    (Issue #3506)" and "buildReportedGapPrSection - is laid out exactly, blank
    lines included (Issue #3506)" compare the whole string.
  - `worker/deno/tests/pr_body_sync_test.ts`: "sync - logs the dropped
    partial-delivery section with the PR it belongs to (Issue #3506)" and
    "sync - logs no re-derivation when the partial-delivery section is
    unchanged (Issue #3506)". `syncWithDegradedLive` gained an optional
    `logger`.
  - `worker/deno/tests/completion_phase_degraded_delivery_test.ts`:
    "completion - the follow-up log names whether the run was degraded, its
    reason and its shortfall count (Issue #3506)". `runCompletion` now records
    `logger.warn` calls.
  - Each of the 22 listed mutants was applied in turn and its test file run:
    all 22 went red (the healthy follow-up body in `buildDegradedFollowUpIssue`
    and `buildReportedGapPrSection` in `degraded_delivery.ts`, the
    reported-gap branch of `applyDegradedDeliveryGuard` in
    `completion_phase.ts`, and the re-derivation log call in
    `syncPrBodyFromSummary`; named by function because their line numbers
    moved when main was merged in).
    The three test files then passed in full: 127 passed, 0 failed.
- Red checks (each break applied, the tests run, then the code restored):
  - Healthy wiring in `applyDegradedDeliveryGuard`: replacing
    `assessReportedGaps(issueBody, prBody)` with `degradedDelivery` turned 4
    tests red. These were both edited tests, the healthy-`partial` test and
    the healthy failure test.
  - Section choice: rendering `buildDegradedPrSection` for a healthy run
    turned 3 tests red.
  - Failure-reason ternary: forcing `false` turned the degraded failure test
    red, and forcing `true` turned the healthy failure test red.
  - `assessReportedGaps` filter: dropping it turned 2 tests red.
  - `rederiveReportedGapSection`: removing the no-gap early return turned 2
    tests red ("empty when everything is now met" and "sync - drops the
    partial-delivery section …"). Reading the number from the whole section
    turned the hostile-bullet test red.
  - `buildReportedGapPrSection`: removing the throw turned its throw test red.
  - Healthy follow-up body: disabling it turned the healthy-body test red.
  - The reported-gap branch in `pr_body_sync.ts`: removing it turned 2 sync
    tests red.
- Guards kept on the new healthy path: it is the same function at the same
  two call sites, so it keeps the summary-gate ordering, the existing-PR
  naming on failure and the no-finalise-on-failure rule. The existing-PR
  ordering for a healthy run is covered by the edited independent-review-gate
  test.
- Callers checked (re-grepped at the final head): `assessReportedGaps` is
  called by `applyDegradedDeliveryGuard` (`completion_phase.ts:894`),
  `rederiveReportedGapSection` (`degraded_delivery.ts:594`) and
  `rederiveFollowUpChainStopSection` (`degraded_delivery.ts:746`).
  `buildReportedGapPrSection` is called by `applyDegradedDeliveryGuard`
  (`completion_phase.ts:989`) and `rederiveReportedGapSection`
  (`degraded_delivery.ts:602`). `syncPrBodyFromSummary` reaches
  `assessReportedGaps` through whichever of `rederiveReportedGapSection` or
  `rederiveFollowUpChainStopSection` matches the live leading section
  (`pr_body_sync.ts:679`–`:689`); only the chain-stop path then calls
  `withholdIssueClose` (`pr_body_sync.ts:709`), which rewrites the closing
  keyword to `Part of`.
  `REPORTED_GAP_SECTION_HEADING` is used by `buildReportedGapPrSection`
  (`degraded_delivery.ts:535`), `buildReportedGapStaleFollowUpSection`
  (`degraded_delivery.ts:563`) and `syncPrBodyFromSummary`
  (`pr_body_sync.ts:635`). All are production readers.
- Applied the new prompt sentence to this PR's own diff and summary: each
  `partial` or `missing` entry above carries a reason that says what is left.
  Nothing else was found.

- PR #3676 review push (fifth round, chain-stop scope): the prompt's chain-stop
  exception now says it applies to a healthy run only; the `degraded_delivery.ts`
  module doc and mermaid, the `completionBody` comment in
  `completion_phase.ts` and the `issue-processing.md` diagram gained the same
  branch. Tests: `deno test` over `follow_up_chain_stop_test.ts` and
  `degraded_delivery_test.ts` (76 passed), and over
  `completion_phase_degraded_delivery_test.ts`, `pr_body_sync_test.ts` and
  `claim_freshness_phase_test.ts` (97 passed), 0 failed; `deno fmt --check`
  passed on the changed files. The full gate was not re-run on this push.
- PR #3676 review push (sixth round): the `isPartialDeliveryFollowUp` doc, the
  `pr_body_sync.ts` comment and `docs/USAGE.md` now scope the chain stop to a
  healthy run and say a degraded run still files one. The Evidence diagram has
  the chain-stop branch. The Test Plan's first bullet names the head it ran on,
  the `pr_body_sync_test.ts` count is 54, and this entry sits in the Test Plan.
  No behaviour changed in this round, so no suite was re-run.
- PR #3676 review push (seventh round, issue with no criteria): a healthy run
  keeps each `partial` or `missing` closure entry, named by its own subject,
  when the issue states no scope; the `issue-processing.md` Trigger bullet and
  the design bullet above say so. The eighth round below moved this into
  `assessScopeShortfalls`.
  Tests: `deno task test:unit` over `degraded_delivery_test.ts`,
  `completion_phase_degraded_delivery_test.ts`, `follow_up_chain_stop_test.ts`
  and `pr_body_sync_test.ts`: 167 passed, 0 failed (re-run on the head);
  `deno fmt --check` and `deno lint` passed on the changed files. With only `lib/degraded_delivery.ts`
  stashed, the new unit test and the new completion test went red. The full gate
  was not re-run on this push.
- PR #3676 review push (eighth round, degraded run on an issue with no
  criteria): `assessScopeShortfalls` (`degraded_delivery.ts:158`) now keeps each
  `partial`/`missing` entry and lists each `met` subject as delivered for
  degraded runs too, so a degraded run on such an issue files a follow-up
  rather than the no-follow-up section. This push fixes the stale sentences:
  the `buildDegradedFollowUpIssue` safety comment, the
  `DegradedDeliveryVerdict.delivered` doc and the `issue-processing.md`
  follow-up bullet now name both sources of delivered lines, and the summary is
  rewritten for the head. Tests: `deno task test:unit` over
  `degraded_delivery_test.ts`, `completion_phase_degraded_delivery_test.ts`,
  `pr_body_sync_test.ts` and `follow_up_chain_stop_test.ts`: 167 passed, 0
  failed; `deno fmt --check` and `deno lint` passed on
  `lib/degraded_delivery.ts`. Red checks: with `degraded_delivery.ts` from
  the previous commit, 3 tests went red (the `assessScopeShortfalls` unit test
  and both completion tests for an issue with no criteria). The full gate was
  not re-run on this push.

**Branch outcomes:**

- `worker/deno/lib/phases/completion_phase.ts` `abortStaleClaim` `newFollowUp !== undefined` — closed: "a healthy run's follow-up is closed when the parent closes mid-run and no PR is raised (PR #3676 review)" and the degraded twin; absent: "a stale claim with no gap files and closes no follow-up (PR #3676 review)". Disabling the close went red.
- `worker/deno/lib/phases/completion_phase.ts` stale branch `guarded.followUp && !guarded.followUp.reused` — `followUp` operand: the no-gap test above (no follow-up, nothing closed); `!reused` operand: "a reused follow-up is never closed when the claim goes stale (PR #3676 review)". Dropping `!reused` went red.
- `worker/deno/lib/phases/completion_phase.ts` `abortStaleClaim` close failure (`catch`) — "completion - a follow-up that cannot be closed warns and the stale-claim abort stands (PR #3676 review)": the abort result stays `early_exit` and the warning carries the cause (`HTTP 403 close`). Changing the warning text went red.
- `worker/deno/lib/degraded_delivery.ts` `args.milestoneTitle ? ["--milestone", …] : []` — set: "completion - a milestone child's follow-up is filed into the parent's milestone (PR #3676 review)" and "fileDegradedFollowUp - a parent's milestone is passed to gh issue create"; unset: "completion - a follow-up for a parent with no milestone carries no --milestone". Dropping the argument went red.

- `worker/deno/lib/phases/completion_phase.ts` `verdict = degradedDelivery.degraded ? …` — degraded arm: the existing degraded tests (for example "a degraded run delivering one of two criteria files the residue and says so in the PR"). Healthy arm: "a healthy run whose summary closes out one criterion as partial files exactly one idle-task follow-up (Issue #3506)". Flipping it to always use `degradedDelivery` went red.
- `worker/deno/lib/phases/completion_phase.ts` failure `reason: verdict.degraded ? …` — degraded arm: "a degraded run whose follow-up cannot be filed raises no PR". Healthy arm: "a healthy run whose gap follow-up cannot be filed raises no PR (Issue #3506)". Each forced flip went red.
- `worker/deno/lib/phases/completion_phase.ts` section `verdict.degraded ? buildDegradedPrSection : buildReportedGapPrSection` — the degraded arm is covered by "a degraded run delivering one of two criteria …", and the healthy arm by both edited healthy tests. The flip went red.
- `worker/deno/lib/degraded_delivery.ts:158` `assessScopeShortfalls` `stated.length === 0` — no scope: "assessScopeShortfalls - an issue stating no criteria lists its met entries as delivered and keeps its partial gap (PR #3676 review)", "completion - a healthy run on an issue stating no criteria files one idle-task follow-up for its partial entry (PR #3676 review)" and, for a degraded run, "completion - a degraded run on an issue stating no criteria still files one idle-task follow-up for its partial entry (PR #3676 review)"; scope stated: the existing criteria tests. Making the condition `false` turned 6 tests red, including the first two; restoring the previous commit's file turned the first three red.
- `worker/deno/lib/degraded_delivery.ts:166` `assessScopeShortfalls` no-scope `entry.status === "met"` filter — `met` kept: the unit test above (delivered holds the `met` subject); `partial` dropped: the same test and "assessReportedGaps - an issue stating no criteria keeps each partial or missing entry, named by its subject (PR #3676 review)". Replacing the filter with `() => true` turned those two red.
- `worker/deno/lib/degraded_delivery.ts` `assessReportedGaps` filter `partial || missing` — kept: "assessReportedGaps - a partial entry is a shortfall …"; dropped: "assessReportedGaps - unassessed items are dropped …". Dropping the filter went red.
- `worker/deno/lib/degraded_delivery.ts` `buildDegradedFollowUpIssue` `!verdict.degraded ? healthy : degraded` — "buildDegradedFollowUpIssue - a healthy verdict gets the reported-gap body …" and "… a degraded verdict keeps the degraded body …". The flip went red.
- `worker/deno/lib/degraded_delivery.ts` `buildReportedGapPrSection` throw: `verdict.degraded` operand and `!degradedNeedsFollowUp` operand — "buildReportedGapPrSection - throws on a degraded verdict or one without a gap" asserts both. Removing the throw went red. The healthy arm is "buildReportedGapPrSection - names the follow-up and the shortfall".
- `worker/deno/lib/degraded_delivery.ts` `rederiveReportedGapSection`:
  - No gap → `""`: "rederiveReportedGapSection - empty when everything is now met". Removing it went red.
  - Number not found → live section kept: "… never reads the number from a hostile shortfall bullet" and "… a long run of digits is not read as a number". Reading from the whole section went red.
  - Number found, live section equals the section built from the current gaps → kept: "… gaps the section was raised with stay as they are". Forcing the stale wording went red.
  - Number found, live section differs → stale-follow-up wording: "… changed gaps keep the number but do not claim the follow-up holds them". Always keeping the live section goes red here.
  - Number read from a stale-wording section (`filed` alternative): "sync - a section already marked as possibly stale is re-derived under the same follow-up number". Dropping the alternative went red.
- `worker/deno/lib/degraded_delivery.ts` `buildReportedGapStaleFollowUpSection` throw (`verdict.degraded` and `!degradedNeedsFollowUp` operands): "buildReportedGapStaleFollowUpSection - throws on a degraded verdict or one without a gap" asserts both; the healthy arm is "… is laid out exactly". Removing the throw went red.
- `worker/deno/lib/pr_body_sync.ts` `liveReportedGap = liveDegraded ? "" : …`, and the re-derive and section-name ternaries:
  - Degraded arm: the existing #3350 sync tests.
  - Reported-gap arm: "sync - re-derives a live partial-delivery section …" and "sync - fails loudly when the issue cannot be read to re-derive the partial-delivery section (Issue #3506)".
  - Removing the reported-gap branch went red.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
