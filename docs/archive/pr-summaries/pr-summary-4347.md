## Summary

A workflow rejected before any job starts now blocks CI approval and reaches
the CI-fix scan. The worker and reviewer gate both inspect completed GitHub
Actions suites with no check run of their own. A replaced suite that created
check runs remains governed by the latest check-run verdict. Closes #4347.

## Spec

### Intent and Rationale

- A green check-run rollup does not prove a newly added workflow ran. A
  zero-run `startup_failure` suite must make the CI verdict fail.
- The CI-fix agent needs the workflow file and run location, while retries
  need a stable check name across new suite ids and run URLs.

### Essential Design Decisions

- Read check suites alongside the batched rollup and in the REST fallback.
  Only completed `github-actions` suites with no check runs and a conclusion
  outside `success`, `skipped` and `neutral` contribute a failure. Other apps
  and unfinished suites retain their previous handling.
- Read the GraphQL workflow path from `workflowRun.file.path` and the name
  from `workflowRun.workflow.name`. GitHub's `Workflow` has no `path` field.
- Name startup failures by workflow and file path, with a stable generic
  fallback. Carry the run URL in annotations, which the processor already
  renders as failure evidence and normalises before computing its signature.
- Carry startup suites as `suite-<id>` through the CI-fix handoff so no consumer
  mistakes a suite id for an Actions job. Re-run the entire workflow by its
  suite association; normal check runs still re-run only failed jobs.
- Startup suites retain their identity across reruns and therefore bypass the
  local job retry cap. The existing fleet-wide marker cap still bounds repair
  and reaches abandon-and-restart, even when no rerun is available.
- The standalone reviewer gate retains its predicate copy. The shared-case
  test `actions_suite_predicate_4347_test.ts` checks it against the worker's
  predicate across statuses, apps, conclusions and check-run counts.

### Undiscoverable Facts

- A read-only query against GitHub on 2026-10-26 accepted
  `workflowRun { url file { path } workflow { name } }`.
- Startup suites have no check-run annotations endpoint. The scan supplies a
  diagnostic annotation with the workflow path and run URL instead of asking
  `check-runs/<suite-id>/annotations`. The agent can inspect that run for the
  policy refusal; no live startup-failure repair was executed here.
- Suite connections remain capped at 100 entries. This change does not add
  pagination for commits with more than 100 suites.

## Evidence

The latest main merge retains both Issue #4370 check-run pagination and Issue #4347 zero-run suite detection. The pagination fixtures now answer the additional suite lookup without changing their assertions. A combined regression proves that green runs on multiple pages cannot hide a startup-failed suite. After resolving the code comment and operator-guide conflicts, 124 direct-merge, batch-check and shared-predicate tests passed, as did all 857 manifest checks (one ignored).

Validation after the latest review fixes: 418 focused regression tests passed;
the manifest gate passed with 857 tests and 1 ignored; formatting and lint passed
for the 12 changed TypeScript files. GitHub accepted the exact repaired reviewer
search query. Full CI runs after the push.

Backend change; no UI. The merge contract in `docs/MERGE.md` and the matching
CI verdict principle in `DESIGN-PRINCIPLES.md` describe the zero-run rule and
stable naming.

The stricter GraphQL fake rejected the old `Workflow.path` query. The new
metadata test and the cross-run name/signature test both failed before the
production fixes. The latter uses the processor's real annotation formatter
and signature function, with different suite ids and run URLs.

## Test Plan

- `check_runs_batch_test.ts`: decode real GraphQL field ownership; reject the
  old query; keep workflow names, paths and run details; preserve failure
  signatures across pushes, including the generic-name fallback.
- `ci_infrastructure_rerun_2914_test.ts`: the actual CI-fix scan receives the
  workflow file and run URL in its encoded annotations on both GraphQL and
  REST paths. The assertions still require a startup-failure candidate.
- `direct_merge_test.ts`, `review_fleet_prs_gate_4347_test.ts` and
  `actions_suite_predicate_4347_test.ts`: zero-run failures block, replaced
  suites do not, and both predicates agree.
- `lifecycle_pr_observation_test.ts`, `pr_maintenance_test.ts`,
  `comment_batch_test.ts`, `timeline_batch_test.ts` and
  `auto_fix_attempt_tracker_test.ts`: surrounding consumers and shared fake.
- Existing test expectations changed only for the new check-suites REST call
  and stable startup-failure names. Workflow/run diagnostic assertions were
  moved to the annotations; none were removed.

### Latest review-fix validation

- The actual reviewer search now passes a validating GraphQL fake and consumes
  a zero-run failed suite response. Its regression failed on the missing-brace
  query; a live read-only GitHub query accepted the fix.
- The scan retains a startup-suite candidate after three local attempts. The
  processor's no-change path resolves suite 77 to workflow 99 and re-runs the
  whole workflow at retry counts zero and three.
- Unavailable workflow runs and rejected rerun requests never fall back to a
  job lookup. The processor still reaches the fleet-wide abandon bound after
  three markers; restoring the old local retry guard makes this regression
  fail. Startup suites always carry a diagnostic annotation, even when workflow
  metadata could not be read.
