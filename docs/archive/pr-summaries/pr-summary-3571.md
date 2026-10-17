## Summary

The idle-decision census counted an issue whose priority label was added by an author outside the trusted set as claimable. The claim scan's label-author gate refused that same issue, so the census and the scan disagreed on `private-repo-A` and the worker raised `ALERT inversion` every cycle. The census now asks the same rule the scan asks, through a new helper, and counts a refused issue as `claim_refused`. Closes #3571.

- [x] The census counts a label-author-refused issue as `claim_refused`, not claimable
- [x] An untrusted issue does not suppress a work-on or low-priority candidate
- [x] Production wiring computes the untrusted set from the trusted-author rule
- [x] The gate coverage table marks `label-author-not-allowed` as modelled

## Spec

### Intent and Rationale

- The census is synchronous, so it cannot ask GitHub who added a priority label. The claim scan does ask, through `wasLabelAddedByAllowedAuthor` in `worker/deno/lib/issue_query.ts`, and refuses an issue whose label came from an untrusted author.
- The census now receives `untrustedLabelIssues`, a set the caller computes before the call with `censusUntrustedLabelIssues` in `worker/deno/lib/census_untrusted_label_issues.ts`. That helper calls the existing function; it does not copy the rule.
- Production builds the set in `worker/deno/lib/run_core_production_deps.ts` from the trusted-author list and the fleet worker logins, as the other precomputed holds are built.

### Essential Design Decisions

- An untrusted issue is counted as `claim_refused` and is not claimable, matching the scan's refusal.
- An untrusted issue is dropped before it can suppress a work-on candidate in its stream or the low-priority tier, because the scan drops it before PR blocking.
- A timeline read failure fails open: the issue is treated as trusted and a warning names the issue, so a transient GitHub error does not over-count refusals.
- `CENSUS_SCAN_GATE_COVERAGE` marks `label-author-not-allowed` as `modelled`, so the monotonicity test now covers that gate.

### Undiscoverable Facts

- `untrustedLabelIssues` is optional and defaults to an empty set, so callers and tests that do not pass it keep their previous behaviour.
- The idle-detect audit (`idle_detect_diagnostics`) does not take `untrustedLabelIssues`, so its line can still report such an issue as claimable. `docs/IDLE-TASK-FRAMEWORK.md` records this at the run-local hold paragraph.

## Evidence

Backend-only change, verified by the three new test files and a red-check of each census and helper operand (see Test Plan).

**Docs sweep** — grep: `untrustedLabelIssues`, `censusUntrustedLabelIssues`, `wasLabelAddedByAllowedAuthor`, `label-author-not-allowed`, `CENSUS_SCAN_GATE_COVERAGE`, `claim_refused`; section: `docs/IDLE-TASK-FRAMEWORK.md#idle-decision-claimable-work-census` (the run-local hold and claim-refused paragraphs); siblings: `milestone-behind`, `cooldown`, `deferredHolds`, `runLocalHolds` (the caller-precomputed sets the new field follows). Updated: `docs/IDLE-TASK-FRAMEWORK.md`, `docs/workflows/issue-processing.md` (the scan `human` row and the `claim_refused … reason=closed_by_this_run` line), `docs/audits/lib-sweep-coverage/top-up-3571.json`, the `withholdsFromIdleDetection` doc comment in `worker/deno/lib/processed_issue_registry.ts`, and the gate-coverage fixture in `worker/deno/tests/fixtures/claim_path_state.ts`.

## Test Plan

- Added `worker/deno/tests/idle_census_label_author_3571_test.ts` (6 census tests), `worker/deno/tests/census_untrusted_label_issues_3571_test.ts` (6 helper tests) and `worker/deno/tests/idle_census_label_author_wiring_3571_test.ts` (2 production wiring tests).
- Updated `worker/deno/tests/claim_path_monotonicity_test.ts` so `label-author-not-allowed` is in the modelled gates.
- Red-checks, each a one-line flip restored with `git checkout`, each turning the named test red:
  - census `lib/idle_decision_census.ts:1187` (untrusted filter removed) → the low-priority backlog test turns red;
  - census `:1207` (skip removed) → the top-priority suppression test turns red;
  - census `:1253` (claim_refused branch disabled) → the claim_refused test turns red;
  - helper `lib/census_untrusted_label_issues.ts:62` → the no-priority-label test turns red;
  - helper `:76` → the allowed-author trusted test and the trusted-label test turn red;
  - helper `:81` (catch rethrows) → the read-failure test turns red;
  - helper `:90` (untrusted marking inverted) → the bot, allowed-author, trusted-label and fleet-login tests turn red.
- The production wiring test turns red when the untrusted set is absent from production deps (`run_core_production_deps.ts:5967`).

<!-- vibe-branch-outcomes -->
