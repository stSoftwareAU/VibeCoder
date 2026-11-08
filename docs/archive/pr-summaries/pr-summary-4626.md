## Summary

Run the repository’s CI `cargo deny` checks locally before a PR is raised or a
babysitter repair is pushed, catching advisory failures before CI. Intermediate
push hooks run them when cargo inputs change. Closes #4626.

The gate discovers direct workflow commands and cargo-deny-action steps. It
expands `${{ matrix.<key> }}` from the job's literal `strategy.matrix` lists and
`include` entries, in action inputs and in `run:` lines, one invocation per
combination. An expression it cannot expand is dropped after `check` in a `run:`
line (so `check bans $X` becomes `check bans`), and an action input holding one
takes that input's own default; only an unexpandable `command` becomes a plain
`check` (every subset). It does not add offline or ignore flags. A variable
before `check`, an unreproducible working directory or a `cargo deny` line
naming no `check` but holding a variable or expression refuse the push;
unavailable tools or networks are infrastructure failures, and audit diagnostics
are code verdicts. Quoted multiline container scripts are not treated as host
commands.

The babysitter runs the check on its host, so it runs under `codex sandbox` with
the repair agent's permissions profile (the protected credential paths are
`none`), by absolute path to `cargo-deny` and `cargo` found outside the clone,
with the rustup toolchain pinned and the rustc wrapper variables emptied
(`worker/deno/lib/fleet_babysitter_cargo_deny_sandbox.ts`, recorded under C36 in
`docs/THREAT-MODEL.md`). With no isolated runner the default gate cannot start
the check and nothing is pushed. The shared sandbox builder's refusal messages
refer to building the sandbox, since it also serves checks that start no agent.

## Spec

### Intent and Rationale

Advisories can change without a lockfile change, so the whole-branch completion
check and every babysitter repair push run CI’s cargo-deny checks regardless of
changed paths. Intermediate hooks retain the cargo-input trigger to limit cost.
The workflow is the source for arguments and action defaults. The parser does
not resolve job-level working directories, matrix `exclude` entries (an excluded
combination is checked too) or commands hidden in scripts. A plain `check`
covers every subset an unresolved expression could select.

### Essential Design Decisions

The shared pre-push gate serves the hook, Step 1b and completion; the babysitter
runs the same gate before its own push. Verdict diagnostics take precedence over
network text; unavailable tools or databases do not count as successful checks.
WIP-preservation pushes remain outside this gate. No VERSION file exists here.
ShellCheck-only repair checks also leave cargo deny to CI, even when given a
base ref; the completion gate still runs cargo deny for a whole branch.

## Evidence

A real cargo-deny 0.20.2 scratch crate produced an advisory-fetch failure with
an unreachable database and an `error[unlicensed]` diagnostic for a licence
failure. Tests inject the command runner to verify argv, cwd and failure
mapping. The action README's own "Recommended pipeline if using advisories"
workflow (matrix entries `advisories` and `bans licenses sources`) expands to
`check advisories` and `check bans licenses sources`; unexpandable expressions
exercise the plain-check fallback. Source-only changes reach the gate in both
the whole-branch pre-PR check and the babysitter repair path, so newly published
advisories are checked even when the lockfile is unchanged; intermediate hooks
still skip source-only changes. The repository’s container-build workflow
contains a scratch-crate command inside a quoted container script, which the
host gate ignores. The YAML parser uses an explicit JSR specifier so reviewer
entry points outside the worker's import map can load the gate.

## Test Plan

- `worker/deno/tests/cargo_deny_gate_test.ts` (63 tests at head) covers workflow
  parsing, matrix expansion and fallback, the actual container workflow,
  triggers, diagnostic classification and runner behaviour. The seven matrix and
  expression tests added in the PR #4895 review round fail against the previous
  head's `cargo_deny_gate.ts`.
- The old permanent refusals of an unresolved action input and of a `run:` line
  with a matrix expression after `check` are obsolete; a check stays mandatory.
  The replacements are
  `cargo_deny_gate_test.ts::workflow: the action README's recommended pipeline expands per matrix entry`,
  `cargo_deny_gate_test.ts::workflow: an action input that cannot be expanded takes the action's default`
  and
  `cargo_deny_gate_test.ts::workflow: a run line's matrix expression that cannot be expanded runs a plain check`.
  A variable before `check` stays unrunnable
  (`cargo_deny_gate_test.ts::workflow: a variable before check in a run line is still unrunnable`).
- `worker/deno/tests/pre_push_gate_cargo_deny_test.ts` covers exact argv,
  infrastructure and verdict mapping, intermediate source-only skips and the
  source-only whole-branch check. The latter was observed failing before the
  fix. `cargo deny: shellcheck-only mode skips cargo deny even with a baseRef`
  covers the merge with main's ShellCheck-only repair mode.
- `worker/deno/tests/fleet_pr_babysitter_cargo_deny_test.ts` (6 tests at head)
  covers verdicts, infrastructure failures, ordering and a source-only repair
  checked before push. The default gate reads the repair’s tracked workflow and
  blocks an unreproducible invocation (a variable before `check`), runs a
  reproducible one through the supplied isolated runner before the push, and
  with no isolated runner starts nothing and pushes nothing (infrastructure).
- `worker/deno/tests/fleet_babysitter_cargo_deny_sandbox_test.ts` (10 tests at
  head) covers the sandbox runner: the `codex sandbox` argv carries the profile
  that denies the App key, only `cargo deny` runs, tools under the clone,
  scratch or a relative `PATH` entry are not used, a cwd outside the clone, an
  unsupported OS and an unpinnable toolchain do not run the check, and the
  production runner sets up lazily and passes the profile to a real process (a
  stand-in `codex` script). Breaking each of the cwd, inside-clone,
  relative-entry, only-`cargo deny` and `sandbox` subcommand guards on its own
  turned a test red.
- `worker/deno/tests/fleet_babysitter_sandbox_test.ts::buildBabysitterSandboxArgs refuses an empty protected list`
  checks the shared builder's refusal wording and retains a positive control for
  a protected path. The sandbox and cargo-deny sandbox suites passed together
  (37 tests) after this wording change.
- `worker/deno/tests/babysitter_fix_orchestration_test.ts` (48 tests at head)
  proves `fix()` hands its cargo-deny runner to the finish and that the check
  runs before the push.
- Existing babysitter and review-dismissal tests inject a passing gate and keep
  positive controls. The cargo-deny and sandbox test files, the two babysitter
  suites, the review-dismissal test and the sandbox and pre-flight tests passed
  together (311 tests).
- `worker/deno/tests/review_fleet_prs_root_forwarders_3417_test.ts` exercises
  reviewer entry points without the worker import map; its three failing cases
  passed after the import fix.
- The four reviewer checklist, claim, posting and strict-refresh test files that
  failed in CI's third shard passed together (51 tests).
- `worker/deno/tests/pre_push_hook_test.ts` passed all five tests, including the
  two hook integration cases that failed in CI's fourth shard.
- Documentation copies checked: `docs/CONFIGURATION.md`,
  `docs/workflows/fleet-pr-babysitter.md` and the C36 row of
  `docs/THREAT-MODEL.md`; no matching list in README or `docs/INTERNALS.md`. The
  action’s multi-word command and parser boundary cases remain covered by the
  cargo-deny tests.
- `worker/deno/lib/cargo_deny_gate.ts:114`’s `WorkDir` type alias has a `true`
  type literal that is erased at runtime and is exempt (untestable) from
  mutation.

The test suite does not run cargo-deny end to end; its runner is injected. The
sandbox wiring (`codex -c <profile> sandbox <macos|linux> -- cargo-deny deny`)
was written without an installed Codex to test against, like the agent's own
profile; the new "Verifying the credential boundary" step in
`docs/workflows/fleet-pr-babysitter.md` is the host check. On the final head
`deno fmt --check`, `deno lint` and markdownlint of the changed documents
passed; the full local gate (`./quality.sh`) was not run in the PR #4895 review
round, and Semgrep and Checkov were not run.
