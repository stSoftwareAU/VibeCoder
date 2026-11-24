## Summary

Corrected the low-priority handoff-label lists in the operator manual and two
source comments. A leftover `failed` label alone still suppresses idle tasks.
Closes #5406.

## Spec

### Intent and Rationale

- Align the census documentation with the existing runtime behaviour.

### Essential Design Decisions

- Preserve runtime behaviour and reuse the existing suppression fixture to pin
  the `failed` case through `collectLowPriorityCandidates`.
- Skip dependency bumps because this PR targets
  `milestone/stale-human-handoff-wording`.

### Undiscoverable Facts

None.

## Evidence

- Read and updated **Per-repo tier suppression** in
  `docs/workflows/issue-processing.md`, plus the corresponding comments in
  `worker/deno/lib/collect_low_priority_candidates.ts` and
  `worker/deno/lib/issue_priority.ts`.
- Checked the configured waiting-label list and `hasWorkableLowPriority` in
  `worker/deno/lib/collect_low_priority_candidates.ts`: the raw census precedes
  `cleanStaleLabels` and excludes no issue solely for carrying `failed`.
- Documentation, comments and a unit test only; no visual surface changed.

## Test Plan

- Added `collect_low_priority_candidates - a leftover failed label still
  suppresses idle tasks` in
  `worker/deno/tests/collect_low_priority_candidates_test.ts`, asserting
  `hasSuppressingLowPriority=true` for an unassigned low-priority issue carrying
  `failed`. This pins current behaviour: all 26 tests passed before the wording
  edits and again afterwards; no failing runtime regression is claimed.
- Existing waiting-label, human-assignee, fleet-assignee, PR-blocked, mixed and
  empty-list cases remain intact. No assertions or expectations were removed.
- Targeted `deno fmt --check`, `deno lint` and frozen `deno check` passed for the
  two source files and the test file.
- `deno task check:manifests` passed: 876 passed, 0 failed, 1 ignored.
- Searched active documentation, prompts and source comments for the stale
  handoff/census claim. Corrected its three matching declarations; no runtime
  gate copy changed. Unrelated pickup rules remain unchanged.

## Merge verification

- Required CI and code review: pending.
- Remaining implementation risks: none identified.
