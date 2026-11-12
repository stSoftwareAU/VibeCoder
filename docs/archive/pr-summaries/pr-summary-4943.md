## Summary

Repairs merge the base only for a genuine conflict or a failed check with the
same failure on the PR merge base and a green run on a newer base. CI, feedback
and spelling enforce this policy at initial synchronisation and final
publication, including direct library callers. A substantive repair can publish
without incorporating an unrelated base advance.

Behind-only refreshes retain the shared readiness and per-base ownership path.
Separate reviewer and babysitter processes now compete against one strict base
in tests. Refusal updates share a file-locked transaction across repair and
sweep writers; a mergeability reading cannot clear a stale-parent refusal, but
an `UNKNOWN` reading still counts towards its streak, so the #4831 escalation
fires. Skipped PRs and permanent refusals end the streak. Durable counters use
explicit production directories; callers without one retain only in-memory
counts. Diagnostic fields are redacted before truncation and complete messages
are redacted before emission.

Closes #4943.

Version bump: none; the merged commit records the final version.

## Spec

### Intent and Rationale

- Prevent gratuitous base merges without losing genuine conflict repairs or
  integration of a historically proven base fix. A green current base alone is
  insufficient evidence.
- Keep required checks, approval validity, native merge queues and the existing
  shared final-refresh owner in control of behind-only updates.

### Essential Design Decisions

- Publication rechecks the policy independently of the command's initial sync.
  The CI publication path rechecks historical failure evidence.
- Repair and sweep transactions read and update the same refusal file under the
  existing file lock. The persisted v1 record shape is unchanged.
- A mergeability reading cannot clear a stale-parent refusal. Successful
  refreshes, skip paths and permanent refusals end its streak; only consecutive
  transient refusals count towards escalation.
- Stateful GitHub boundaries model published heads and ancestry. Repair tests
  additionally publish into real local bare Git repositories.

### Undiscoverable Facts

- Private fleet runtime evidence was unavailable. Synthetic tests establish
  behaviour, not a measured reduction in production churn.
- Earlier independent Spec and Standards reviews and subsequent fleet reviews
  are recorded on the PR. Review of the final redaction repair is pending.

## Evidence

Read and updated `docs/MERGE.md`, especially “Strict-base branch refresh
ownership” and “Repair merges and refresh attribution”. Updated the library
coverage record to describe historical proof and publication accurately.

The traced writers are the reviewer, babysitter, branch-update loop,
PR-maintenance, auto-merge sweep and CI/feedback/spelling processors. Prevented
classes are behind-only updates of unselected or unready PRs, and unrelated base
merges introduced during substantive repair publication. Necessary classes
remain selected-owner refreshes, genuine conflict repairs, proven base-fix
integration, eligible non-strict updates and native merge-queue operation.

Previously recorded reproduction and negative controls for the merge policy
(not repeated in the final diagnostics repair):

- The new spelling-library publication regression failed against `origin/main`
  production code in a disposable checkout: unrelated base ancestry was
  published. It passes with the publication gate.
- Concurrent production trackers originally retained only one of four PR
  records. A known mergeability read also erased a seeded stale-parent refusal.
  Removing the transaction lock or stale-parent guard makes the replacement
  persistence/recovery tests fail.
- Disabling owner exclusion, approval readiness or current-head failure
  reconciliation makes the competing production-path tests fail.
- Removing only the stale-check-head guard makes the otherwise valid historical
  proof authorise a base merge and fails the publication regression.

Diagnostics include bounded source/reason/owner/build information. All fields
are redacted before truncation, including counter names; complete decision,
fallback, counter-persistence and refusal-tracking messages are also redacted.
Cumulative `baseRefresh.*` counters permit follow-up when a counter
work directory is supplied, including the publication-time decision of the CI,
feedback and spelling libraries; in-process lanes without one are counted in the
per-cycle fault-tolerance summary only, and paths with neither retain no durable
tally.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — “Integration tests drive competing updater paths/hosts against the
  same strict base: one eligible PR receives the final refresh; an unreviewed or
  otherwise unready behind-only PR does not.” — evidence:
  `worker/deno/tests/base_refresh_production_paths_4943_test.ts::production reviewer and babysitter hosts compete: one ready PR receives the strict-base merge; an unreviewed PR never does`
  runs separate Deno hosts against one GitHub boundary and inspects published
  heads, parents and pending CI; the no-owner case also refuses unreviewed PRs —
  reviewer: met
- **met** — “Cover substantive repairs, genuine conflicts, a newer push during
  validation, owner crash/expiry, failed CI and completion advancing to the next
  PR.” — evidence: `worker/deno/tests/repair_base_merge_wiring_4943_test.ts`
  publishes substantive repairs through commands and direct libraries;
  `worker/deno/tests/babysitter_base_merge_policy_4943_test.ts::babysitter publishes a resolved genuine conflict with both parents`
  checks resolved contents and two parents; production-path tests cover a human
  push during refreshed-head validation, failure, expiry, merge and closure
  advancing the next eligible PR — reviewer: met
- **met** — “Test the production wiring of any confirmed bypass, not just the
  ownership helper. Demonstrate that the repaired scenario fails before the
  fix.” — evidence: command/direct-library and babysitter publication tests
  inspect real remote trees and ancestry; the spelling-library regression fails
  against `origin/main`, and the refusal-store/ownership negative controls above
  fail without their guards — reviewer: met
- **met** — “Required checks and approvals still decide merging, native
  merge-queue bases remain on their existing path, and no admin bypass is
  introduced.” — evidence: `worker/deno/tests/base_refresh_churn_4943_test.ts`
  refuses missing and failed checks, drafts, unarmed and unreviewed PRs and
  preserves the merge-queue exemption; the production human-push case requires
  fresh CI and approval; existing readiness/ownership remains authoritative —
  reviewer: met
- **met** — “Identify which observed update classes are prevented and which
  remain necessary. Do not assert a production improvement from synthetic tests
  alone; runtime counters permit automatic follow-up.” — evidence:
  `docs/MERGE.md` and Evidence above identify those classes;
  `worker/deno/tests/base_refresh_counter_persist_4943_test.ts` and
  `worker/deno/tests/repair_base_merge_4943_test.ts` cover cumulative counters
  and concurrent persistence; no measured production improvement is claimed —
  reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — The authorised verifier repairs and acceptance tests use
  Australian English, existing readiness/ownership mechanisms, real Git
  publication outcomes, stateful external boundaries, independent host stores
  and bounded rendezvous. Refusal storage retains its existing persisted shape.
  Replaced tests preserve their required behaviour through observable outcomes.
  Ordinary publication diagnostics use INFO.

- **violation** — Redaction previously covered reason text instead of complete
  diagnostic messages — evidence:
  `worker/deno/lib/repair_base_merge_4943.ts::formatBaseRefreshDecision`, counter
  warnings and refusal-tracking logs — reason: fixed in this diff. Every field
  is redacted before truncation and every complete diagnostic is redacted before
  emission. Regression tests cover identifiers, paths, malformed counter keys,
  truncation, a throwing sink and failed comment notifications.

The other review findings are addressed:

- A throwing diagnostic sink leaves a redacted fallback message. Structurally
  malformed counters warn with the field name and reuse `atomicWrite`.
- Refusal persistence is best effort. GitHub comments are posted outside the
  lock; recording notification success uses a second short transaction.
- Stale-parent refusals continue counting UNKNOWN readings, while skip paths
  and permanent refusals end their streak.
- CI publication and babysitter tests cover proven base fixes; refused
  publication asserts that the remote head remains unchanged.
- CI, feedback, spelling and branch-update processors accept an optional
  `baseRefreshCounterDir`. Production callers provide the work directory;
  tests without it do not write shared counter files. Reviewer branch updates
  use the separate optional `BranchUpdateAudit.counterDir`, supplied by both
  `gate.ts` and `post.ts`.

## Test Plan

- `pr_branch_update_test.ts`, `pr_branch_update_integration_test.ts` and
  `review_fleet_prs_backlog_3225_test.ts`: 93 passed after the fleet's counter
  directory repair at `662ad407`.
- The six core repair, counter, refusal-streak, auto-merge sweep and babysitter
  policy suites: 120 passed on the final production code.
- The seven selected direct-library publication tests: all passed, including
  refused publication, genuine conflicts, durable counters for all three
  processors and the CI library's proven-base-fix check.
- All four new or strengthened redaction regressions fail with the production
  module restored to `662ad407` and pass with the fix. They reproduce exposed
  identifiers, paths, malformed counter keys and a truncated token fragment.
- The initial combined run including the entire publication-wiring suite hit
  its four-minute timeout without a reported assertion failure; it is not
  counted as a pass. The focused suites above completed successfully.
- `pr-summary-check`: zero blocked gates; acceptance closure, independent
  review and reproduction-status checks were not run because issue-body and
  label inputs were not supplied.
- The derived manifest family: 866 passed, 1 existing ignore across 55 files.
  Formatting, lint and `git diff --check` pass for this repair.
- Strict local type checking reports two `noImplicitReturns` errors in the
  externally mapped standard-library dependencies (`@std/internal/format.ts`
  and `@std/yaml/_loader_state.ts`), with no project-source diagnostics. Normal
  locked-package type checking remains CI's verification; the repository's
  compiler settings and dependencies are unchanged.
- The final diagnostics repair reuses `redactSecrets`; no new redaction rules,
  dependency, persisted schema, gate exemption or suppression is introduced.
  The related rule and sink copies were checked in `CODING-STANDARDS.md`,
  `SECURITY.md` and all diagnostics in `repair_base_merge_4943.ts`.
- Local test dependencies are the locked package versions, verified against
  their checksums and loaded through an external import map because direct JSR
  package resolution failed on this host. Repository configuration is unchanged.

- PR #5059 review, fifth round. The babysitter's `fix()` no longer persists
  counters to its defaulted `stateDir` (the host's real babysitter state when a
  test passes none). A new optional `FixDeps.baseRefreshCounterDir` is passed to
  `requestReadyBranchUpdate` on the behind path and to the
  `babysitter-repair` counter; only the production entry point sets it (to
  `babysitterStateDir()`). The shared test harness sets it to its per-test
  temporary state directory, so the counter assertions in
  `babysitter_base_merge_policy_4943_test.ts` still read a real file. Running
  `fleet_pr_babysitter_test.ts`, `fleet_pr_babysitter_single_push_test.ts` and
  the two babysitter harness suites no longer creates
  `~/.local/state/vibe-coder/fleet-pr-babysitter/base_refresh_counters.json`
  (the previous head did).

## Merge verification

The targeted behavioural checks pass; required CI will run on the pushed head. Independent review of
this repair remains pending. A full local `./quality.sh` run has not been made;
the remote Quality workflow provides the complete CI gate. Private fleet
runtime measurements and macOS execution are not available in this run.
