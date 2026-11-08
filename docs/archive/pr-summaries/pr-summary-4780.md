## Summary

The milestone gate-wedge diagnostic no longer names a private fleet repository
in the public `stSoftwareAU/VibeCoder` repo. `reportGateWedge` now checks the
milestone repository's visibility (the same check #4318 added for run-failure
issues) and files an opaque report for anything that is not positively public.
The operator manual describes both diagnostic forms and where to find the full
private report.
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
`tests/repo_visibility_test.ts`: 149 passed, 0 failed on the review fix.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — resolve visibility with the #4318 check in `reportGateWedge`; failed
  lookup is private — evidence: `worker/deno/lib/milestone_gate_wedge.ts`,
  `worker/deno/tests/milestone_gate_wedge_test.ts` — reviewer: met — reason: the
  issue states no criteria heading, so no reviewer ran; this is the author's own
  record

## Test Plan

- Reviewed `docs/INTERNALS.md` against `reportGateWedge` and its public and
  private body builders; no other copy of the operator-manual rule was found.
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
- `./quality.sh` passed formatting, lint, type check, Markdown lint and
  completeness checks. The full Deno test run aborted in the parallel pass
  when Deno 2.9.0 panicked restoring test permissions on this host; the serial
  pass did not run. The base commit's PR #4928 passed its CI gate. Semgrep and
  Checkov were unavailable at the required versions, and config integration was
  skipped because its configuration was unavailable.
- Mutation check: `isRepoPublic` is now pinned directly in
  `tests/repo_visibility_test.ts` (public resolves true and the gh argv drops
  the leading `gh`; private, unrecognised value, `Error` rejection and
  non-`Error` rejection all give false). This kills the
  `repo_visibility.ts:144`, `:154` and `:155` mutants.
- `worker/deno/lib/repo_visibility.ts:147` exempt (untestable): `success: false`
  on the rejection path; flipping or deleting it still yields `stdout: ""`,
  which `getRepoVisibility` maps to private, so `isRepoPublic` returns false
  either way (equivalent mutant).
- `worker/deno/lib/repo_visibility.ts:148` exempt (untestable): `stdout: ""` on
  the rejection path; `getRepoVisibility` never reads it when `success` is
  false.
- `worker/deno/lib/repo_visibility.ts:149` exempt (untestable): the `stderr`
  message (and its `Error` vs non-`Error` ternary) only feeds
  `getRepoVisibility`'s error string, which `isRepoPublic` collapses to `false`.
