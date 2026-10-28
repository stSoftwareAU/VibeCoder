## Summary

The `markdownlint` quality check no longer fails a repository that configures no
markdownlint `globs`. markdownlint-cli2 then prints its help screen and exits 2
without linting anything; `runMarkdownlintCheck` now reports that run as
`SKIPPED` with a reason naming the missing `globs`. Closes #4438.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- A repo with no `globs` (or no config) made the baseline gate red on the
  untouched tree, stopping every run; the check must report "nothing to lint",
  not a failure.
- Detecting the help-screen run keeps the stage unconditional (as in
  `runQualityGate`) and still catches repos whose config is added later.

### Essential Design Decisions

- Detection is exit 2 + the help `Syntax: markdownlint-cli2 glob0` line + no
  `Linting:` header + no violations on stdout. A config parse error also exits 2
  but prints `Error:`, so it stays FAILED.
- Violations are now parsed from stdout and stderr: v0.24.0 (observed) writes
  violation lines to stderr, so the previous stdout-only parse reported FAILED
  with an empty violation list.
- The FAILED detail for a violation-free failure falls back to the stdout
  `Error:` line (v0.24.0 prints config errors on stdout) before the generic
  exit-code message.

### Undiscoverable Facts

- Observed with markdownlint-cli2 v0.24.0: no config and rules-only config both
  give exit 2 + help on stdout; `globs: ["**/*.nomatch"]` gives exit 0
  `Linting: 0 files`; malformed config gives exit 2 with
  `Error: Unable to use configuration file`.
- `./quality.sh --strict` still promotes this SKIPPED to FAILED, as for a
  missing binary.

## Evidence

Backend-only change; no UI files touched. Tests in
`worker/deno/tests/markdownlint_check_test.ts` (fake-runner and real
`markdownlint-cli2` temp-repo cases: no config → SKIPPED, rules-only config →
SKIPPED, `globs` → FAILED with parsed README.md violations, malformed config →
FAILED).

## Test Plan

- `deno task test:unit tests/markdownlint_check_test.ts tests/markdownlint_probe_test.ts`
  (from `worker/deno`): the two files pass (markdownlint_check_test.ts: 19 passed, 0 failed).
- Red check: with `worker/deno/lib/markdownlint_check.ts` restored to base, 6 of
  the new tests fail (help-screen SKIPPED, config-error cause text, stderr-only
  violations, both real-binary SKIPPED cases, real-binary globs FAILED).
- Existing tests: none modified. The config-error case (asserts the cause text
  `Unable to use configuration file`, required by the issue's "a config parse
  error … must still fail") is a new test; the base test "FAILED when runner
  exits non-zero even without parsed violations" is unchanged and still passes.
- Mutation check: two further new tests pin the `isNoGlobsHelpRun` lines the
  mutation check flagged. "SKIPPED when the help screen arrives only on stderr"
  fails if the `stderr` operand of the help-line test is dropped (`:173`);
  "FAILED when exit 2 shows the help line and a Linting header but no parsed
  violation" fails if the `Linting:` guard returns true (`:177`). Both mutants
  applied by hand each turn one test red; `markdownlint_check_test.ts` is
  19 passed, 0 failed with the real code.
- Callers of `runMarkdownlintCheck` (three, all in `worker/deno`):
  - `runMarkdownlintQualityCheck` in `lib/quality_gate.ts` passes
    `result.status` through unchanged, so a help-screen run is SKIPPED in the
    gate (still promoted to FAILED by `--strict`).
  - `commands/check_markdownlint.ts` returns `success: status !== "FAILED"`, so
    the new SKIPPED counts as success there and violations now parsed from
    stderr appear in its `data`.
  - `collectDiffableGateFindings` in `lib/baseline_gate.ts` only reads
    `violations`: a SKIPPED run has none (no findings, as before for a skip),
    and stderr-only violations now become baseline findings where the
    stdout-only parse produced none.
- Docs: grepped `docs/` and README for markdownlint; none describes the
  FAILED-on-no-globs behaviour. Doc comments in `markdownlint_check.ts` and
  `quality_gate.ts` updated.
- `./quality.sh`: ran to the 590s foreground cap (the tool maximum) before the
  unit-test stage finished. Every stage that completed passed, including
  `markdownlint` (the repository's own config has `globs`, so it still lints)
  and `semgrep`; the full gate was not completed locally.

<!-- vibe-quality-gate-skipped reason="full gate takes about 15m, longer than the 600s foreground tool cap; stages before the unit-test stage passed; CI and the worker re-run it" -->
