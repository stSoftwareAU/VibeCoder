## Summary

`isDockerInfraFailure` now matches only the Docker CLI's own error line, so a
failing test whose name or log quotes `docker:` and `not found` is repaired as
`failed_fixable` instead of being parked as `failed_docker_infra`. Closes #4891.

## Spec

### Intent and Rationale

- The old regex `/docker:.*(not found|Cannot connect|permission denied)/i` ran
  unanchored over the whole gate output, so Deno's own
  `docker: reports not found ... FAILED (2ms)` line looked like an
  infrastructure fault and the real failure was never handed back for repair.
- The fix reuses the structure of the #4829 missing-command matcher: whole,
  unindented lines only, outside Deno's captured `output` blocks.

### Essential Design Decisions

- The line-walking logic (ANSI strip, trim, skip captured blocks) moved into one
  private generator, `uncapturedLines`, now shared by `isDockerInfraFailure` and
  `isMissingCommandFailure`, so the two cannot drift.
- A line is also skipped when it ends in Deno's per-test decoration
  (`... ok|FAILED|ignored (Nms)` or `=> file:line:col`), because a test name is
  unindented and starts the line. An optional `<shell>: [line N: ]` prefix is
  kept so `bash: docker: command not found` still counts.
- Accepted limitation: a passing test that prints an unindented
  `docker: ... not found` line outside a captured block still matches. Deno only
  brackets output of failing tests, and the classifier runs only on non-zero
  exits.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI. Tests:
`worker/deno/tests/quality_gate_phase_test.ts`.

## Test Plan

- Added in `worker/deno/tests/quality_gate_phase_test.ts`: five
  `isDockerInfraFailure` tests (failing test named for docker and not found;
  ANSI-coloured result line; text inside a Deno output block; indented
  quotation; genuine lines among test output), a hostile long-line case for both
  regex shapes, and
  `runQualityGateCheck - a failing Docker run whose test name quotes docker and not found is fixable`.
- Red check: with `lib/quality_gate_phase.ts` restored to the base version, the
  four negative `isDockerInfraFailure` tests and the `runQualityGateCheck` test
  fail; the genuine-line and hostile-input tests pass on both. With the fix, the
  file passes (82 tests).
- No existing assertion was removed or edited; the existing Docker infra tests
  (`docker: command not found`, `Cannot connect`, `permission denied`, and the
  `runQualityGateCheck` infra case) still pass.
- `deno fmt` and `deno lint` clean on both files.
- Full `./quality.sh` on this head: failed only at `deno tests`, in
  `worker/deno/tests/pr_maintenance_command_test.ts` (5 tests, "expected a
  merge-queue rules read"). That file does not import the changed module and
  fails the same way when run alone; it is not touched by this change. The rest
  of the gate (lint, type check, fmt, semgrep, markdownlint) passed, and the
  serial test pass did not run because the parallel pass failed.
- Docs: no non-archive doc mentions this classifier (grepped `README.md`,
  `docs/*.md`, `prompts/`).
- Mutation check: its report said the baseline tests failed before any mutation
  (seven test files: `fence_coverage_verifier`, `quality_gate_credentials_4705`,
  `quality_gate_phase`, `repo_formatters_4113`,
  `tool_output_treat_as_data_3046`, `untrusted_command_env`,
  `untrusted_gate_spawn`), so it judged no mutants. They pass at the head here:
  `deno task test:unit` with stdin from `/dev/null` over those seven files (153
  passed, 0 failed), and each file alone under `deno test -A`. The failure did
  not reproduce, so it is an environment fault of the mutation runner's
  baseline, not a surviving mutant. The changed lines are pinned by the red
  checks above (base `quality_gate_phase.ts` turns the four negative
  `isDockerInfraFailure` tests and the `runQualityGateCheck` test red).
