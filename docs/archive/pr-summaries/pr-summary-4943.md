## Summary

Repairs merge the base only for a genuine conflict or a failed check with the
same failure on the PR merge base and a green run on a newer base. CI, feedback
and spelling enforce this policy at initial synchronisation and final
publication, including direct library callers. A substantive repair can publish
without incorporating an unrelated base advance.

Behind-only refreshes retain the shared readiness and per-base ownership path.
Separate reviewer and babysitter processes now compete against one strict base
in tests. Refusal updates share a file-locked transaction across repair and
sweep writers; a mergeability reading cannot clear a stale-parent refusal.

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
- Repair and sweep transactions read and update the same refusal file under
  the existing file lock. The persisted v1 record shape is unchanged.
- Stale-parent recovery requires successful parent validation; known
  mergeability and an unready PR do not establish recovery.
- Stateful GitHub boundaries model published heads and ancestry. Repair tests
  additionally publish into real local bare Git repositories.

### Undiscoverable Facts

- Private fleet runtime evidence was unavailable. Synthetic tests establish
  behaviour, not a measured reduction in production churn.
- Independent Spec and Standards sub-agents reviewed the final issue/diff and
  standards/diff respectively. Their verdicts are recorded below.

## Evidence

Read and updated `docs/MERGE.md`, especially “Strict-base branch refresh
ownership” and “Repair merges and refresh attribution”. Updated the library
coverage record to describe historical proof and publication accurately.

The traced writers are the reviewer, babysitter, branch-update loop,
PR-maintenance, auto-merge sweep and CI/feedback/spelling processors. Prevented
classes are behind-only updates of unselected or unready PRs, and unrelated
base merges introduced during substantive repair publication. Necessary classes
remain selected-owner refreshes, genuine conflict repairs, proven base-fix
integration, eligible non-strict updates and native merge-queue operation.

Reproduction and negative controls:

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

Diagnostics include bounded source/reason/owner/build information and redacted
reason text. Cumulative `baseRefresh.*` counters permit follow-up when a counter
work directory is supplied; paths without one retain no durable tally.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — “Integration tests drive competing updater paths/hosts against the
  same strict base: one eligible PR receives the final refresh; an unreviewed or
  otherwise unready behind-only PR does not.” — evidence:
  `worker/deno/tests/base_refresh_production_paths_4943_test.ts::production reviewer and babysitter hosts compete: one ready PR receives the strict-base merge; an unreviewed PR never does`
  runs separate Deno hosts against one GitHub boundary and inspects published
  heads, parents and pending CI; the no-owner case also refuses unreviewed PRs
  — reviewer: met
- **met** — “Cover substantive repairs, genuine conflicts, a newer push during
  validation, owner crash/expiry, failed CI and completion advancing to the next
  PR.” — evidence:
  `worker/deno/tests/repair_base_merge_wiring_4943_test.ts` publishes substantive
  repairs through commands and direct libraries;
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
  introduced.” — evidence:
  `worker/deno/tests/base_refresh_churn_4943_test.ts` refuses missing and failed
  checks, drafts, unarmed and unreviewed PRs and preserves the merge-queue
  exemption; the production human-push case requires fresh CI and approval;
  existing readiness/ownership remains authoritative — reviewer: met
- **met** — “Identify which observed update classes are prevented and which
  remain necessary. Do not assert a production improvement from synthetic tests
  alone; runtime counters permit automatic follow-up.” — evidence:
  `docs/MERGE.md` and Evidence above identify those classes;
  `worker/deno/tests/base_refresh_counter_persist_4943_test.ts` and
  `worker/deno/tests/repair_base_merge_4943_test.ts` cover cumulative counters
  and concurrent persistence; no measured production improvement is claimed — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — The authorised verifier repairs and acceptance tests use
  Australian English, existing readiness/ownership mechanisms, real Git
  publication outcomes, stateful external boundaries, independent host stores
  and bounded rendezvous. Refusal storage retains its existing persisted shape.
  Replaced tests preserve their required behaviour through observable outcomes.
  Ordinary publication diagnostics use INFO.

The Standards reviewer also identified four findings inherited from earlier
commits on this branch. They are unchanged by this recovery and remain outside
its authorised production scope; this is not a full-branch clean verdict.

- **violation** — Structurally malformed counter JSON silently resets totals —
  evidence: `worker/deno/lib/repair_base_merge_4943.ts::persistNamedCounter` —
  reason: unchanged in this recovery; structural validation and a warning remain outstanding.
- **violation** — A throwing diagnostic sink is caught and ignored — evidence:
  `worker/deno/lib/repair_base_merge_4943.ts::logBaseRefreshDecision` — reason:
  unchanged in this recovery; a visible fallback remains outstanding.
- **violation** — Counter persistence duplicates the existing atomic-write
  helper — evidence:
  `worker/deno/lib/repair_base_merge_4943.ts::persistNamedCounter` — reason:
  unchanged in this recovery; reuse of `atomicWrite` remains outstanding.
- **violation** — Redaction covers reason text rather than complete diagnostic
  messages — evidence: `worker/deno/lib/repair_base_merge_4943.ts::formatBaseRefreshDecision`
  and persistence warnings — reason: unchanged in this recovery; complete
  outbound-message redaction remains outstanding.

## Test Plan

- All 17 changed test suites passed: 384 tests, with stdin from `/dev/null`.
  This includes 43 real-Git publication/policy tests and 58 churn, production-host
  and production tracker tests. Another 207 existing processor and babysitter
  orchestration tests passed. The strengthened stale-head case also passed its
  final focused rerun after the negative control.
- Type-check, lint and format checks passed for all 41 changed TypeScript
  files. `deno task check:manifests` passed.
- `pr-summary-check` reports the four disclosed Standards violations; no other
  applicable gate failed. Markdown lint passed.
- The stale mutation scratch directory was removed successfully. The final
  disposable `runMutationCheck` rerun with `mutantCap: 1` and
  `budgetSeconds: 180` returned `budget_exhausted` with `limit: mutant_cap`,
  one mutant killed, no survivors and 701 candidates. Cleanup completed without
  the reported error; the remaining candidates are unvalidated. No mutation
  exemptions or repository skip were added.

## Merge verification

The worker will rerun the full quality gate, completion checks and pre-PR
verifier. Required CI and independent PR approval remain pending.
