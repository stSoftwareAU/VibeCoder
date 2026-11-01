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
- `deno fmt --check` and `deno lint` on the two touched files — clean.
- `grep "blocked PR creation" worker/deno/lib/phases/completion_phase.ts` now
  matches only the security-fix (line 2469) and changed-workflow (line 2585)
  gates.

## Test Plan

- Extended `worker/deno/tests/completion_phase_advisory_gates_4234_test.ts`
  (first test) to capture logger warnings via `createMockDeps`, asserting no
  warning contains "blocked PR creation" and that "Reproduction-status gate
  reported findings" is logged.
  - Red check: against the unfixed lib it failed at the new assertion
    (`Values are not equal ... Actual: true, Expected: false`); it passes with
    the reworded messages.
  - Only the reproduction-status warn fires in this fixture. The
    result-placeholder, mutation, coverage carry-over and pre-PR verifier
    messages are reworded the same way but not driven by a test; they are one
    string each, and their reach is not staged by this fixture (exempt
    (untestable): the mutation and coverage runners are not wired in the mock
    deps, and the earlier tests that reach the verifier and placeholder gates,
    `completion_phase_pre_pr_verifier_3395_test.ts` and
    `completion_phase_summary_rule_retry_test.ts`, do not capture the logger).
- No existing assertion was removed or edited.
- Docs: grepped `README.md`, `docs/` (excluding archive) and `prompts/` for
  "blocked PR creation"; the only hit is the historical audit record named
  above.
- Not checked: the full `./quality.sh`; it exceeds the foreground limit in this
  run and is left to CI and the worker's pre-PR run.

<!-- vibe-quality-gate-skipped reason="full ./quality.sh not run within the run budget; targeted tests, fmt and lint pass; CI runs the full gate" -->
