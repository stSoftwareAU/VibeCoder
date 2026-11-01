## Summary

Five completion-phase WARN lines said "blocked PR creation" for gates whose
findings are advice since Issue #4234: the PR is raised and auto-merge stays
armed. They now read "... reported findings", matching the closure, independent
review and unmet-criteria messages reworded in #4513. The security-fix and
changed-workflow messages are unchanged because those gates still end the run.
Closes #4579.

## Spec

### Intent and Rationale

- An operator searching worker logs for "blocked PR creation" was counting runs
  that raised and armed a PR alongside the two gates that really stop the run.
  Rewording the five lines makes the phrase mean one thing again.

### Essential Design Decisions

- Only log message text changed in `worker/deno/lib/phases/completion_phase.ts`:
  reproduction-status, result-placeholder, mutation, coverage carry-over and
  pre-PR verifier. Structured fields and control flow are untouched.
- `docs/pre-pr-ci-audit.md` quotes the old "Pre-PR verifier blocked PR creation"
  line as a historical log count, so it is left as a record of what was logged.

### Undiscoverable Facts

- None.

## Evidence

Backend log-text change. Tests run from `worker/deno`:

- `deno task test:unit tests/completion_phase_advisory_gates_4234_test.ts` — 2
  passed, 0 failed.
- `deno task test:unit tests/completion_phase_summary_rule_retry_test.ts tests/completion_phase_pre_pr_verifier_3395_test.ts`
  — 33 passed, 0 failed.
- `deno fmt --check` and `deno lint` on the four touched source files
  (`lib/phases/completion_phase.ts` and the three test files below) — clean.
- `grep "blocked PR creation" worker/deno/lib/phases/completion_phase.ts` now
  matches only the security-fix (line 2469) and changed-workflow (line 2585)
  gates.

## Test Plan

- Extended `worker/deno/tests/completion_phase_advisory_gates_4234_test.ts`
  (first test) to capture logger warnings via `createMockDeps`, asserting no
  warning contains "blocked PR creation" and that the reproduction-status,
  result-placeholder ("Result-placeholder gate reported findings") and pre-PR
  verifier ("Pre-PR verifier reported findings (Issue #3395)") warnings are
  logged; this fixture reaches all three.
- Extended `worker/deno/tests/completion_phase_mutation_gate_test.ts` ("a
  surviving mutant is noted and the PR is still raised") to assert
  `outcome.warnings` contains "Mutation gate reported findings" and no warning
  contains "blocked PR creation".
- Extended `worker/deno/tests/completion_phase_coverage_carryover_gate_test.ts`
  ("an uncovered carried line blocks the PR and names file:line") the same way
  for "Coverage carry-over gate reported findings".
  - Red check: with `completion_phase.ts` temporarily restored to the base
    branch's version ("blocked PR creation" in the five lines), each test file
    fails at its new assertion and passes on the head:
    `worker/deno/tests/completion_phase_advisory_gates_4234_test.ts` (2 tests at
    head; 1 failed on base),
    `worker/deno/tests/completion_phase_mutation_gate_test.ts` (21 tests at
    head; 1 failed on base),
    `worker/deno/tests/completion_phase_coverage_carryover_gate_test.ts` (10
    tests at head; 1 failed on base).
- No existing assertion was removed or edited.
- Docs: grepped `README.md`, `docs/` (excluding archive) and `prompts/` for
  "blocked PR creation"; the only hit is the historical audit record named
  above.
- Not checked: the full `./quality.sh`; it exceeds the foreground limit in this
  run and is left to CI and the worker's pre-PR run.

<!-- vibe-quality-gate-skipped reason="full ./quality.sh not run within the run budget; targeted tests, fmt and lint pass; CI runs the full gate" -->
