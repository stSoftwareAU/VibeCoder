## Summary

The idle-decision census counted an issue whose priority label was added by an author outside the trusted set as claimable. The claim scan's label-author gate refused that same issue, so the census and the scan disagreed on `private-repo-A` and the worker raised `ALERT inversion` every cycle. The census now asks the same rule the scan asks, through a new helper, and counts a refused issue as `claim_refused`. Closes #3571.

- [x] The census counts a label-author-refused issue as `claim_refused`, not claimable
- [x] An untrusted issue does not suppress a work-on or low-priority candidate
- [x] Production wiring computes the untrusted set from the trusted-author rule
- [x] The gate coverage table marks `label-author-not-allowed` as modelled

## Spec

### Intent and Rationale

- Issue #3571: fix: idle-inversion on private-repo-A — claimable work the claim scan keeps refusing, sustained across cycles. The census is synchronous, so it cannot ask GitHub who added a priority label. The claim scan does ask, through `wasLabelAddedByAllowedAuthor` in `worker/deno/lib/issue_query.ts`, and refuses an issue whose label came from an untrusted author.
- The census now receives `untrustedLabelIssues`, a set the caller computes before the call with `censusUntrustedLabelIssues` in `worker/deno/lib/census_untrusted_label_issues.ts`. That helper calls the existing function; it does not copy the rule.
- Production builds the set in `worker/deno/lib/run_core_production_deps.ts` from the trusted-author list and the fleet worker logins, as the other precomputed holds are built.

### Essential Design Decisions

- An untrusted issue is counted as `claim_refused` and is not claimable, matching the scan's refusal.
- An untrusted issue is dropped before it can suppress a work-on candidate in its stream or the low-priority tier, because the scan drops it before PR blocking.
- A timeline read failure fails open: the issue is treated as trusted and a warning names the issue, so a transient GitHub error does not over-count refusals.
- `CENSUS_SCAN_GATE_COVERAGE` marks `label-author-not-allowed` as `modelled`, so the monotonicity test now covers that gate.

### Undiscoverable Facts

- `untrustedLabelIssues` is optional and defaults to an empty set, so callers and tests that do not pass it keep their previous behaviour.
- The idle-detect audit (`idle_detect_diagnostics`) does not take `untrustedLabelIssues`, so its line can still report such an issue as claimable. `docs/IDLE-TASK-FRAMEWORK.md` does not record a reason for this.

## Evidence

Backend-only change, verified by the three new test files and a red-check of each census, helper and production-wiring operand (see Test Plan).

**Docs sweep** — grep: `untrustedLabelIssues`, `censusUntrustedLabelIssues`, `wasLabelAddedByAllowedAuthor`, `label-author-not-allowed`, `CENSUS_SCAN_GATE_COVERAGE`, `claim_refused`; section: `docs/IDLE-TASK-FRAMEWORK.md#idle-decision-claimable-work-census` (the run-local hold and claim-refused paragraphs); siblings: `milestone-behind`, `cooldown`, `deferredHolds`, `runLocalHolds` (the caller-precomputed sets the new field follows). Updated: `docs/IDLE-TASK-FRAMEWORK.md`, `docs/audits/lib-sweep-coverage/top-up-3571.json`.

Existing doc hits left in place, each still true after this change:

- `docs/IDLE-TASK-FRAMEWORK.md:846`: the "Unblocked" definition still requires a priority label applied by a trusted author; the census enforces it through the `untrustedLabelIssues` set.
- `docs/IDLE-TASK-FRAMEWORK.md:1046`: the label-author gate is still counted as `claim_refused`.
- `docs/IDLE-TASK-FRAMEWORK.md:1051`: the census still drops `untrustedLabelIssues` before the tier-3 (`idle_decision_census.ts:1187`) and work-on (`:1207`) suppression checks.
- `docs/IDLE-TASK-FRAMEWORK.md:1136`: an untrusted-author priority label still does not suppress either, by the same mechanism.

Gate: `./quality.sh`: PASSED (config integration SKIPPED)

Load-bearing fakes: the gh timeline stub in the wiring tests stands in for `paginateTimeline`, which `wasLabelAddedByAllowedAuthor` in `worker/deno/lib/issue_query.ts` reads. It mirrors GitHub's `labeled` timeline event (`event`, `label.name`, `actor.login`). The property relied on is that the adder login is read from `actor.login`.

Call sites and siblings checked: the production caller `worker/deno/lib/run_core_production_deps.ts:5967` computes the set, and `:6067` passes it into the census. The siblings `deferredHolds` and `runLocalHolds` use the same optional precomputed-set pattern, and the existing `claim_refused` count is the one this rule feeds. The idle-detect audit does not take the set (see Undiscoverable Facts).

Rule applied to this PR's own diff: the label-author gate is modelled, so an untrusted priority issue counts as `claim_refused`. Applying that rule found four existing census test files whose fixtures had no trusted priority adder, which the new census would have counted as `claim_refused`. Their fixtures were changed to add a trusted-adder timeline stub and `resolveTrustedAuthors`.

Existing tests whose fixtures changed:

- `worker/deno/tests/idle_census_backed_off_wiring_2085_test.ts`
- `worker/deno/tests/idle_census_milestone_paced_wiring_3464_test.ts`
- `worker/deno/tests/idle_census_sub_issues_wiring_3314_test.ts`
- `worker/deno/tests/claim_path_monotonicity_test.ts`
- `worker/deno/tests/fixtures/claim_path_state.ts`

These stopped at the new label-author precondition (no trusted adder means `claim_refused`). Each now asserts a positive control `assertEquals((await deps.refreshTrustedAuthors!()).ok, true)` and `claim_refused=0` assertions.

Top-up coverage: `docs/audits/lib-sweep-coverage/top-up-3571.json` covers the new lib file `worker/deno/lib/census_untrusted_label_issues.ts`. Its `sweptAt` is main's tip `43904d6b98340ca763ee45891b5a8939ce6603b9`, because the coverage test requires `sweptAt` to be an ancestor of main.

## Test Plan

- Added `worker/deno/tests/idle_census_label_author_3571_test.ts` (6 census tests), `worker/deno/tests/census_untrusted_label_issues_3571_test.ts` (6 helper tests) and `worker/deno/tests/idle_census_label_author_wiring_3571_test.ts` (2 production wiring tests).
- Updated `worker/deno/tests/claim_path_monotonicity_test.ts` so `label-author-not-allowed` is in the modelled gates.
- Red-checks, each a one-line flip restored with `git checkout`, each turning the named test red:
  - census `lib/idle_decision_census.ts:1187` (untrusted filter removed) → "census - an untrusted work-on issue does not suppress the low-priority backlog (Issue #3571)" turns red;
  - census `:1207` (skip removed) → "census - an untrusted top-priority issue does not suppress a work-on issue in its stream (Issue #3571)" turns red;
  - census `:1253` (claim_refused branch disabled) → "census - a top-priority issue the label-author gate refuses is claim_refused, not claimable (Issue #3571)" turns red;
  - helper `lib/census_untrusted_label_issues.ts:62` → the no-priority-label test turns red;
  - helper `:76` → the allowed-author trusted test and the trusted-label test turn red;
  - helper `:81` (catch rethrows) → the read-failure test turns red;
  - helper `:90` (untrusted marking inverted) → the bot, allowed-author, trusted-label and fleet-login tests turn red.
- Production wiring red-check, re-run in this pass: `run_core_production_deps.ts:5967` replaced by an empty `new Set<number>()` with `deno task test:unit tests/idle_census_label_author_wiring_3571_test.ts < /dev/null` from `worker/deno`. The result was red: "production deps - a top-priority add by an untrusted bot is claim_refused, not claimable (Issue #3571)" failed at line 131, `FAILED | 1 passed | 1 failed`. Restored with `git checkout -- worker/deno/lib/run_core_production_deps.ts`.

<!-- vibe-branch-outcomes -->
