## Summary

Classify worker-authored host-disk floor reasons as `disk-full` and
`not_code_fixable`, so the run-failure filer suppresses them instead of filing
a worker-crash issue. Closes #4526.

## Spec

### Intent and Rationale

- The floor-only reason describes the same deliberate stop as the park note; sharing one narrow matcher keeps host-fault and run-failure classification aligned.

### Essential Design Decisions

- The protective-stop matcher recognises the worker's park note and floor sentence. The classifier uses it only for `internal_error` and only on `splitAgentNarration(...).worker`.
- Actual ENOSPC and read-only filesystem evidence stays code-fixable through the existing disk-exhaustion path.

### Undiscoverable Facts

- Graft was unavailable in this session; code paths and callers were inspected with repository searches and direct file reads.

## Evidence

Backend-only change. The tests call `classifyRunFailure` and `fileRunFailureIssue`, including the GitHub-write recording fake.

## Test Plan

- `worker/deno/tests/run_outcome_classifier_test.ts`: floor-only `internal_error` reasons classify as `disk-full` / `not_code_fixable` for declared and inferred category modes; the same sentence inside formatted agent output remains `worker-crash` / `code_fixable`; a different category remains `killed-unknown`.
- `worker/deno/tests/run_failure_issue_test.ts`: a floor-only failure is suppressed as `not_code_fixable` / `disk-full` with zero GitHub writes.
- `worker/deno/tests/host_disk_inflight_4360_test.ts`: the shared matcher still recognises floor-only host faults; existing ENOSPC and read-only cases remain covered.
- Regression red check: with only the new classifier and filer tests added, the unfixed code failed both (the filer attempted to create a `worker-crash` issue); the fixed code passed.
- Guard mutation checks: removing the `internal_error` gate made the category controls fail; removing the `splitAgentNarration(...).worker` boundary made the formatted-agent-output checks fail.
- `deno task test:unit tests/run_outcome_classifier_test.ts tests/run_failure_issue_test.ts tests/host_disk_inflight_4360_test.ts` — passed, 83 passed and 0 failed.
- Targeted `deno fmt --check`, `deno lint`, and `deno check` on the changed TypeScript files — passed.
- `deno task check:manifests` — passed, 846 passed, 0 failed, 1 ignored, after adding the `top-up-4526` coverage entry for `host_disk_protective_stop.ts`.
- The last `./quality.sh < /dev/null` run failed because the new helper lacked that library-sweep entry. The entry is now present and `check:manifests` passes. The full gate was not rerun after this correction because the three full-gate attempts were exhausted; no PR was raised.
