## Summary

Run the repository’s CI `cargo deny` checks locally before a PR is raised,
catching advisory failures before CI. Intermediate push hooks run them when
cargo inputs change. Closes #4626.

The gate discovers direct workflow commands and cargo-deny-action steps. It
expands `${{ matrix.<key> }}` from the job's literal `strategy.matrix` lists and
`include` entries, in action inputs, `working-directory` values and `run:`
lines, one invocation per combination. Any other variable or expression in a
`run:` line, before or after `check`, is dropped together with the option it was
the value of (`--config ${{ env.X }}` goes whole), so the line runs a plain
`check`; an action input holding one takes that input's own default. It does not
add offline or ignore flags. A `run:` step runs from its `working-directory`,
else the job's, else the workflow's `defaults.run.working-directory`. An
invocation CI allows to fail (`continue-on-error` on the step or the job, a
literal `true` or a `matrix.<key>` test evaluated per combination) still runs,
after the others, but its failure is a `[PRE_PUSH_WARNING]` line and does not
refuse the push. A `cargo deny` line naming no `check` but holding a variable or
expression, and a working directory that cannot be reproduced, refuse the push;
for an invocation CI does not allow to fail, unavailable tools or networks are
infrastructure failures and audit diagnostics are code verdicts; for one it
allows to fail, both are warnings. Quoted multiline container scripts are not
treated as host commands.

The babysitter is not gated. Its repairs run on the host, and the governing
issue forbids host execution beside the App key until the contained path
(#4768, #4770) exists. The host-side babysitter gate, its sandbox module and its
C36 text were removed in the PR #4895 review round, and no document claims that
babysitter pushes are checked.

## Spec

### Intent and Rationale

Advisories can change without a lockfile change, so the whole-branch completion
check runs CI’s cargo-deny checks regardless of changed paths. Intermediate
hooks retain the cargo-input trigger to limit cost. The workflow is the source
for arguments, working directories, action defaults and which invocations CI
allows to fail. The parser does not resolve matrix `exclude` entries (an
excluded combination is checked too), `continue-on-error` tests other than a
literal true or one matrix key, or commands hidden in scripts. A plain `check`
covers every subset an unresolved expression could select.

### Essential Design Decisions

The shared pre-push gate serves the hook, Step 1b and completion, all of which
run in the worker container. Verdict diagnostics take precedence over network
text; unavailable tools or databases do not count as successful checks.
WIP-preservation pushes remain outside this gate. No VERSION file exists here.
ShellCheck-only repair checks also leave cargo deny to CI, even when given a
base ref; the completion gate still runs cargo deny for a whole branch.

## Evidence

A real cargo-deny 0.20.2 scratch crate produced an advisory-fetch failure with
an unreachable database and an `error[unlicensed]` diagnostic for a licence
failure. Tests inject the command runner to verify argv, cwd and failure
mapping. The action README's own "Recommended pipeline if using advisories"
workflow (matrix entries `advisories` and `bans licenses sources`, with
`continue-on-error: ${{ matrix.checks == 'advisories' }}`) expands to
`check advisories` and `check bans licenses sources`, and only the first is
allowed to fail. Source-only changes reach the gate in the whole-branch pre-PR
check, so newly published advisories are checked even when the lockfile is
unchanged; intermediate hooks still skip source-only changes. The repository’s
container-build workflow contains a scratch-crate command inside a quoted
container script, which the host gate ignores. The YAML parser uses an explicit
JSR specifier so reviewer entry points outside the worker's import map can load
the gate.

Review round (PR #4895): the babysitter files are restored to `origin/main`
(`git diff origin/main --stat` lists none of them), so the only babysitter text
that mentions cargo deny is the sentence in `docs/CONFIGURATION.md` saying it is
not run there.

## Test Plan

- `worker/deno/tests/cargo_deny_gate_test.ts` (81 tests at head) covers workflow
  parsing, matrix expansion and fallback, the actual container workflow,
  triggers, diagnostic classification and runner behaviour. This round adds the
  job- and workflow-level `defaults.run.working-directory` tests, the
  matrix-keyed `working-directory` test, the `continue-on-error` tests (step and
  job level, literal, `==`, `!=`, a bare key, a key only some `include` entries
  set, an unread test, no matrix) and the README-pipeline gate tests (advisories
  failure is a warning, bans failure is a verdict, an identical invocation CI
  does not allow still blocks, an infrastructure failure of an allowed leg is a
  warning), plus the dropped-option and environment-assignment tests and a
  hostile-input test for the `continue-on-error` pattern. The mutation round adds
  tests for an include entry that extends every combination, a matrix key with
  no value, an unsafe matrix value, a `continue-on-error` matrix test with no
  combination, an option that carries its own `=` value, the `source` of an
  unrunnable finding, and a matrix `working-directory` with no value.
- Obsolete: the permanent refusals of a variable or expression before `check`
  and of an environment assignment holding an expression. A check stays
  mandatory; the replacements are
  `cargo_deny_gate_test.ts::workflow: a shell variable or expression before check is dropped, leaving a plain check`,
  `cargo_deny_gate_test.ts::workflow: an expression that is an option's value drops the option with it`
  and
  `cargo_deny_gate_test.ts::workflow: an environment assignment holding an expression is dropped like any other`.
  What remains refused, and is still tested, is a `cargo deny` line with a
  variable and no `check` (`...is unrunnable even without check`) and an
  unreproducible working directory.
- `worker/deno/tests/pre_push_gate_cargo_deny_test.ts` (10 tests at head) covers
  exact argv, infrastructure and verdict mapping, intermediate source-only
  skips, the source-only whole-branch check, the README pipeline through
  `runPrePushGate` (the allowed leg prints `[PRE_PUSH_WARNING] cargo deny:` and
  does not block; the other leg blocks), and
  `cargo deny: shellcheck-only mode skips cargo deny even with a baseRef`.
- Red checks run on this head, each by breaking one thing and running
  `cargo_deny_gate_test.ts` or `pre_push_gate_cargo_deny_test.ts`: job default
  ignored → 4 red; workflow default ignored → 1 red; never allow failure
  → 4 red; option not dropped with its value → 1 red; `!=` read as `==` → 1
  red; literal true ignored → 2 red; bare key ignored → 1 red; allowed failure
  blocks → 2 red; dedupe allowance OR instead of AND → 1 red; allowed legs run
  before blocking ones → 1 red; matrix `working-directory` not substituted → 1
  red; a missing optional key not "" → 1 red; the stderr warning removed from
  `pre_push_gate.ts` → the pre-push README test red.
- Callers checked for the changed `runCargoDenyGate` result (it now also carries
  `warnings`): `pre_push_gate.ts` is the only production caller; the other
  callers are `cargo_deny_gate_test.ts`. The babysitter no longer calls it.
- `worker/deno/tests/review_fleet_prs_root_forwarders_3417_test.ts` exercises
  reviewer entry points without the worker import map; its three failing cases
  passed after the import fix.
- Documentation copies checked: `docs/CONFIGURATION.md` (the `cargo deny` bullet
  and the refusal sentence below it); `docs/workflows/fleet-pr-babysitter.md`
  and `docs/THREAT-MODEL.md` are back to their base text; no matching list in
  README or `docs/INTERNALS.md`.
- `worker/deno/lib/cargo_deny_gate.ts`’s `WorkDir` type alias has a `true` type
  literal that is erased at runtime and is exempt (untestable) from mutation. So are the `allowFailure?: true` type literals on
  `CargoDenyCiFinding` (`cargo_deny_gate.ts:48`), on `allowFailureFor`'s return
  type (`:484`) and on `actionVariantFindings`'s `allow` parameter (`:681`).
  The mutation round also removed two operands no input can reach: the
  `previous !== undefined` guard in `dropUnresolved` (`cargo` is always kept
  first) and `wanted.some(...)` on the unmatched-`include` push (an entry naming
  no wanted key adds a combination that reads the same as having none).

The test suite does not run cargo-deny end to end; its runner is injected. The
full local gate (`./quality.sh`) was not run in the PR #4895 review round;
Semgrep and Checkov were not run.
