## Summary

Run the repository’s CI `cargo deny` checks locally before a PR is raised or a
babysitter repair is pushed, catching advisory failures before CI. Intermediate
push hooks run them when cargo inputs change. Closes #4626.

The gate discovers direct workflow commands and cargo-deny-action steps. It
expands literal action input matrices and falls back to a full `check` when a
command expression cannot be resolved. It does not add offline or ignore flags.
Unreproducible paths and direct shell expressions refuse the push; unavailable
tools or networks are infrastructure failures, and audit diagnostics are code
verdicts. Quoted multiline container scripts are not treated as host commands.

## Spec

### Intent and Rationale

Advisories can change without a lockfile change, so the whole-branch completion
check and every babysitter repair push run CI’s cargo-deny checks regardless of
changed paths. Intermediate hooks retain the cargo-input trigger to limit cost.
The workflow is the source for arguments and action defaults. The parser does
not resolve job-level working directories, non-action matrices or commands
hidden in scripts. A full action check covers an unresolved command subset.

### Essential Design Decisions

The shared pre-push gate serves the hook, Step 1b and completion; the babysitter
runs the same gate before its own push. Verdict diagnostics take precedence over
network text; unavailable tools or databases do not count as successful checks.
WIP-preservation pushes remain outside this gate. No VERSION file exists here.

## Evidence

A real cargo-deny 0.20.2 scratch crate produced an advisory-fetch failure with
an unreachable database and an `error[unlicensed]` diagnostic for a licence
failure. Tests inject the command runner to verify argv, cwd and failure mapping.
The recommended action matrix fixture exercises all four check subsets, and an
unknown command expression exercises the full-check fallback. Source-only
changes reach the gate in both the whole-branch pre-PR check and the babysitter
repair path, so newly published advisories are checked even when the lockfile is
unchanged; intermediate hooks still skip source-only changes. The repository’s
container-build workflow contains a scratch-crate command inside a quoted
container script, which the host gate ignores. The YAML parser uses an explicit
JSR specifier so reviewer entry points outside the worker's import map can load
the gate. CI passed on head `572f8208` with these fixes.

## Test Plan

- `worker/deno/tests/cargo_deny_gate_test.ts` covers workflow parsing, matrix
  expansion and fallback, the actual container workflow, triggers, diagnostic
  classification and runner behaviour. The matrix and quoted-script tests were
  observed failing before the fix.
- The old permanent refusal of unresolved action command expressions is
  obsolete; a full check remains mandatory. The replacement is covered by
  `cargo_deny_gate_test.ts::workflow: action matrix expands and unknown command checks all`.
- `worker/deno/tests/pre_push_gate_cargo_deny_test.ts` covers exact argv,
  infrastructure and verdict mapping, intermediate source-only skips and the
  source-only whole-branch check. The latter was observed failing before the fix.
- `worker/deno/tests/fleet_pr_babysitter_cargo_deny_test.ts` covers verdicts,
  infrastructure failures, ordering and a source-only repair checked before
  push. Its changed fixture replaces a cargo-input repair with a source-only
  repair; the remaining requirement is that the default gate reads the repair’s
  tracked workflow and blocks an unreproducible invocation, covered by
  `fleet_pr_babysitter_cargo_deny_test.ts::cargo deny gate: the default gate checks a source-only repair and refuses an unreproducible CI invocation`.
- Existing babysitter and review-dismissal tests inject a passing gate and keep
  positive controls. The three cargo-deny test files passed (68 tests); those
  and the two babysitter suites passed together (206 tests).
- `worker/deno/tests/review_fleet_prs_root_forwarders_3417_test.ts` exercises
  reviewer entry points without the worker import map; its three failing cases
  passed after the import fix, alongside 56 cargo-deny tests.
- The four reviewer checklist, claim, posting and strict-refresh test files
  that failed in CI's third shard passed together (51 tests).
- `worker/deno/tests/pre_push_hook_test.ts` passed all five tests, including
  the two hook integration cases that failed in CI's fourth shard.
- Documentation copies checked: `docs/CONFIGURATION.md` and
  `docs/workflows/fleet-pr-babysitter.md`; no matching list in README or
  `docs/INTERNALS.md`. The action’s multi-word command and parser boundary cases
  remain covered by the cargo-deny tests.
- `worker/deno/lib/cargo_deny_gate.ts:108`’s `WorkDir` type alias has a `true` type
  literal that is erased at runtime and is exempt (untestable) from mutation.

The test suite does not run cargo-deny end to end; its runner is injected.
Repository-wide formatting, lint and type checking, completeness checks and
the local gate's markdownlint passed. The full local gate's parallel test pass
ended in a Deno permission-pledge panic, so its serial pass did not run; CI
passed the test shards on the PR head and on the base. Semgrep and Checkov were
skipped locally because Semgrep and the pinned Checkov version were unavailable.
