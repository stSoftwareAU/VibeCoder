## Summary

- New `worker/deno/lib/json_array_pages.ts`: `parseJsonArrayPages(raw)` scans
  `gh api --paginate` output (concatenated `[...]` pages) while tracking JSON
  string and escape state. A `][` inside a string value no longer reads as a
  page boundary. Truncated, malformed or non-array input throws with the
  offset, so an unreadable response stays distinguishable from an empty one.
- Callers that split on `/\]\s*\[/` now use the shared parser:
  `milestone_close_housekeeping.ts` (local copy removed),
  `milestone_children_gate.ts`, `collaborator_permissions.ts` (errors →
  `malformed-json`) and `trust_exclusions.ts` (errors → `malformed-json`).
- `docs/audits/lib-sweep-coverage.json`: `top-up-2895` claims the new module.

Closes #2895.

## Evidence

```text
RED (new caller regression tests against origin/main's lib code):
FAILED | 80 passed | 4 failed
  sweepClosedMilestones - a child issue body containing bracket-like text across pages does not break the children lookup
  fetchOpenMilestoneChildren - a child body containing bracket-like text across pages does not break the boundary scan
  fetchRepoCollaborators - a string field containing ][ does not break page splitting
  fetchTeamMembers - a string field containing ][ does not break page splitting

GREEN (after the fix):
deno test tests/json_array_pages_test.ts tests/milestone_close_housekeeping_test.ts \
  tests/milestone_children_gate_test.ts tests/collaborator_permissions_test.ts \
  tests/trust_exclusions_test.ts
ok | 101 passed | 0 failed

Completeness family (deno task check:manifests equivalent): ok | 685 passed | 0 failed | 1 ignored
Quality gate: QUALITY_GATE_RESULT
```

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- Bodies containing `][` and `]` + newline + `[` parse into the correct issue
  numbers — `json_array_pages_test.ts` and the housekeeping and children-gate
  regression tests. reviewer: met
- Malformed output still throws, so unreadable ≠ empty — truncation, garbage
  and non-array page tests in `json_array_pages_test.ts`; the housekeeping test
  for a truncated response reports an error and leaves the milestone unswept.
  reviewer: met
- The other callers that used the same split are fixed — the children gate,
  collaborator permissions and trust exclusions, each with a caller-level test.
  reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

No material departures: the change fails loud on bad input, one parser
replaces four copies (DRY), tests call real functions, and no documented
behaviour changed.

## Test Plan

- [x] RED/GREEN for the four caller regression tests (above)
- [x] `json_array_pages_test.ts`: 17 unit tests (strings, escapes, whitespace,
      empty pages, truncation, garbage)
- [x] Completeness family green after the ledger slice
- [ ] Full `./quality.sh < /dev/null`
