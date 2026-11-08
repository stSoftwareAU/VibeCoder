## Summary

The milestone gate-wedge diagnostic no longer names a private fleet repository
in the public `stSoftwareAU/VibeCoder` repo. `reportGateWedge` now checks the
milestone repository's visibility (the same check #4318 added for run-failure
issues) and files an opaque report for anything that is not positively public.
Closes #4780.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- Private repo: the title ends
  `a private fleet repo (<first 12 hex of sha256(repo + " " + milestoneBranch)>)`,
  so dedup still works per repository and branch. The body (create and repeat
  comment alike) keeps only the refusal count, timestamp, tip SHAs and the
  generic fix text.
- The full report (repo, branches, milestone title, conflict key, verdict,
  analysis) goes to the host log at `warn`, redacted.
- A public repository's title and body are byte-identical to before.

### Essential Design Decisions

- `sourceIsPublic` moved from `run_failure_issue.ts` to `repo_visibility.ts` as
  `isRepoPublic` so both filers call one implementation. Unknown (failed lookup)
  counts as private.
- The digest title is only an opaque identifier; someone who already knows
  candidate repo/branch names could check them offline. That is inherent to the
  design the issue specified.

### Undiscoverable Facts

- Cleaning up the already-filed issues and PRs (#4422, #4440, #4441, #4444,
  #4447, #4449, #4733, #4761, #4753, #4778, #3007) is the owner's job per the
  issue; GitHub keeps edit history, so only deletion removes the text.

## Evidence

Backend only. `deno task test:unit` over `tests/milestone_gate_wedge_test.ts`,
`tests/milestone_sync_conflict_analysis_escalation_test.ts`,
`tests/milestone_branch_sync_test.ts`, `tests/run_failure_issue_test.ts`,
`tests/repo_visibility_test.ts`: 159 passed, 0 failed.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — resolve visibility with the #4318 check in `reportGateWedge`; failed
  lookup is private — evidence: `worker/deno/lib/milestone_gate_wedge.ts`,
  `worker/deno/tests/milestone_gate_wedge_test.ts` — reviewer: met — reason: the
  issue states no criteria heading, so no reviewer ran; this is the author's own
  record

## Test Plan

- Added to `worker/deno/tests/milestone_gate_wedge_test.ts`: private create argv
  has opaque title and no repo/branch/milestone title/verdict/conflict
  key/analysis; failed lookup behaves as private; second refusal on the same
  private repo+branch appends one comment and files no second issue; full report
  reaches the host log at `warn`; public form unchanged; opaque title is stable
  and distinct per branch/repo.
- Red check: forcing `isPublic = true` turned 6 tests red (the private-path
  tests and the positive controls); restored afterwards.
- Existing gh mocks in `milestone_gate_wedge_test.ts`,
  `milestone_sync_conflict_analysis_escalation_test.ts` and
  `milestone_branch_sync_test.ts` now answer the visibility call with "public"
  so they keep asserting the public form; no assertion removed.
  `milestone_branch_sync_test.ts` opts in only for its wedge test because its
  merge-fallback test relies on a private repo.
- `./quality.sh`: every stage passed except `deno tests`, which failed 6 tests
  in `tests/pr_maintenance_command_test.ts` and
  `tests/merge_fast_checks_credentials_4705_test.ts`.
  `pr_maintenance_command_test.ts` fails identically on an untouched checkout of
  the base commit; neither file imports a module this change touches.
- Not checked: the `merge_fast_checks_credentials_4705_test.ts` failure was not
  re-run on the base.
