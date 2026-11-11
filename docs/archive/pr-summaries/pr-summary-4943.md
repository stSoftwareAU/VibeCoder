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
- Repair and sweep transactions read and update the same refusal file under the
  existing file lock. The persisted v1 record shape is unchanged.
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
classes are behind-only updates of unselected or unready PRs, and unrelated base
merges introduced during substantive repair publication. Necessary classes
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

The Standards reviewer also identified four findings inherited from earlier
commits on this branch. PR #5059 review fixed three of them; the fourth is
unchanged and remains outside the authorised production scope, so this is not a
full-branch clean verdict.

- **violation** — Redaction covers reason text rather than complete diagnostic
  messages — evidence:
  `worker/deno/lib/repair_base_merge_4943.ts::formatBaseRefreshDecision` and
  persistence warnings — reason: unchanged; complete outbound-message redaction
  remains outstanding.

Fixed after the PR #5059 review (tests are under `worker/deno/tests/`):

- `logBaseRefreshDecision` no longer swallows a failure: a throwing sink or
  counter leaves one redacted fallback line on stderr naming the source, repo,
  PR and error (`repair_base_merge_4943_test.ts`, “a throwing sink leaves one
  redacted fallback line”).
- `persistNamedCounter` treats a non-object root, a missing or non-object
  `counters` and a non-finite entry as malformed: it warns once, naming the
  field, before the tally restarts, and writes through `atomicWrite`
  (`repair_base_merge_4943_test.ts`, five “warns once, naming the field” cases).
- The auto-merge sweep's refusal persistence is best effort again: a lock or
  filesystem failure is logged and the pass carries on. The diagnostic comment
  is posted after the lock is released and `notified` is recorded in a second
  short transaction (`updateRefusalsThenNotify`; `auto_merge_sweep_test.ts`, “a
  refusal-state lock failure never aborts the pass” and “the refusal lock is not
  held while the diagnostic comment is posted”;
  `repair_base_merge_4943_test.ts`, “a repair tracker posts its comments with
  the refusal lock released”).
- The `<lane>-publication` decision of the CI, feedback and spelling libraries
  is tallied in the command's work directory (`counterDir` through
  `repairBaseForPublication`; `repair_base_merge_wiring_4943_test.ts`, “counts a
  publication-time base merge durably”).
- The babysitter's proven-base-fix merge is covered
  (`babysitter_base_merge_policy_4943_test.ts`, “merges the base into a
  MERGEABLE failed-CI repair once the same failure is proven fixed”), and the
  refused-publication library test now asserts the remote head is unchanged.

## Test Plan

- At the head after the PR #5059 review fixes, the 4943, auto-merge sweep,
  refusal-streak, `pr_push_base_sync` and babysitter orchestration test files
  (`deno test -A`, stdin from `/dev/null`, 14 files) passed: 256 tests, 0
  failed. The CI, feedback and spelling processor test files (32 files) passed:
  364 tests, 0 failed.
- Red checks run on the fix (each reverted alone, the named test went red):
  dropping the `provenBaseFixChecks = [check.name]` assignment in
  `commands/fleet_pr_babysitter.ts` fails the new babysitter proven-fix test;
  re-throwing in the sweep's `updateRefusals` catch fails the lock-failure test;
  posting the comment inside the lock fails both lock-released tests; dropping
  `counterDir` from `pr_ci_processor.ts` fails the publication-counter test; a
  `null` root treated as well-formed fails its “warns once, naming the field”
  case; replacing the `console.error` fallback fails the throwing-sink test. The
  malformed-counters cases for `[]`, `{}` and a non-numeric entry were not
  separately flipped; they share `malformedCountersField` with the `null` case.
- `worker/deno/tests/pr_push_base_sync_test.ts` (5 tests) passes. Its spelling
  case now seeds a `CONFLICTING` mergeability reading, because the shared
  mergeability policy merges the base before a spelling push only for a genuine
  conflict; the behind-only case no longer qualifies.
- At the head, `deno fmt`, `deno lint` and `deno check` pass for the files
  changed in the PR #5059 review fixes. The full `./quality.sh` gate was not run
  in this fix run (about 15 minutes against the run budget).
- `deno task pr-summary-check --base main` at the head: 0 gates blocked; 3 not
  checked (acceptance-criteria closure, two-axis review and reproduction status
  need an issue body or labels this run did not supply).
- The disposable mutation run recorded earlier on this branch predates the PR
  #5059 review fixes; it was not re-run at this head, and no mutation exemptions
  or repository skip were added.

## Merge verification

The worker will rerun the full quality gate, completion checks and pre-PR
verifier. Required CI and independent PR approval remain pending.
