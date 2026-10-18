# Diff-scoped mutation check

The mutation check runs at two call points. At PR raise it is a gate
(Issue #3393) that blocks the PR. In every review-fix (PR feedback) run it is
part of the post-agent drift check (Issue #3750) and reports survivors in the
PR reply without blocking the push; see
[Review-fix runs](#review-fix-runs-issue-3750). At both it mutates only the
lines the change adds or changes, re-runs the tests that cover them, and
treats a survivor as a mutation the suite stays green through although the
behaviour was changed on purpose.

## Why line coverage is not enough

A test can execute a line without asserting on it. Line coverage and the
`Branch outcomes:` list in the Test Plan both rest on the agent's own
account of which test reaches which line. A mutation check measures the
outcome instead: flip the line, run the tests, and see whether anything goes
red. A survivor is concrete evidence that no test pins that behaviour.

## Flow

At PR raise, the gate runs in the issue-run completion phase, after the PR
summary is final and before the PR is raised. It joins the other late summary gates (docs
sweep, removed assertions, placeholders, branch outcomes, [coverage carry-over](coverage-carryover-check.md), claim check, pre-PR verifier) and
feeds the same single recovery turn.

```mermaid
flowchart TD
    A["PR summary final"] --> B{"skip_mutation_check?"}
    B -- yes --> Z["Raise PR"]
    B -- no --> D["Compute diff origin/base...HEAD"]
    D -- "diff unavailable" --> X["Block (fail closed)"]
    D --> C["Detect language: Deno config above a changed file, else Cargo.toml"]
    C -- "neither Deno nor Cargo" --> N["Not applicable: log the reason"]
    N --> Z
    C --> E["Mutate added lines, run covering tests"]
    E -- "runner error" --> X
    E --> F{"Unexempted survivor?"}
    F -- yes --> X
    F -- no --> G{"Budget exhausted or mutant cap hit?"}
    G -- yes --> W["Warn: remaining mutants untested"]
    G -- no --> Z
    W --> Z
    X --> R["Recovery turn: add tests that kill each file:line mutation"]
    R --> A
```

The recovery turn is told each surviving `file:line` and the mutation applied,
so the agent adds the assertion that kills it, or records an exemption. Unlike
the documentation gates, whose recovery prompt says the code is final, a
blocked mutation item makes the prompt allow test changes (the quality gate and
completion re-run afterwards); an exemption is reserved for a line no test can
reach.

## Review-fix runs (Issue #3750)

Every review-fix (PR feedback) run runs the same check. It is part of the
post-agent drift check (`runPrFeedbackDriftCheck`): after the agent's turn and
before the worker's final commit-and-push and the PR reply. Nothing blocks the
push on this path.

**Scope.** Only lines this run itself added are mutated. The diff is the
working tree (uncommitted edits included) plus untracked files, compared with
the branch head captured before the agent ran (`beforeSha`). When the run
merged another branch (for example `git merge origin/main`), the baseline is
instead `git merge-tree --write-tree <beforeSha> <merged parent>`, the
before-run head plus the merged branch, so lines that came in from the merge
are not mutated. A conflict resolution counts as the run's own lines. If the
run merged more than one unrelated history (an earlier merged parent not
contained in the newest one), its lines cannot be separated and the check is
reported as unable to run.

The runner, mutator and mutant cap (40) are the PR-raise ones. So are
`skip_mutation_check`, `mutation_check_budget_seconds`, the `quality_credentials`
handling and the `exempt (untestable)` exemptions, which are read from the PR
summary. The skip, runner, budget and credential sequence is shared with the
PR-raise gate (`invokeMutationCheck`).

**Recovery.** An unexempted survivor is a drift-check hit. It goes into the
drift check's one recovery turn, with the same survivor wording as the PR-raise
gate. That turn may add or change tests and docs, but no production code (the
other drift items still say change no code). When survivors were found and the
turn ran, the mutation check is re-run once.

**Report.** Survivors still left after that are appended to
`.pr_response_message` in the drift-check residual, under their own heading
`#### Mutation check (Issue #3750)`. A review-fix push is not blocked by
survivors; they are reported in the PR reply and the push still happens.

A budget-exhausted or mutant-cap run is reported under that heading as such,
as not passed, never as a pass, and does not trigger a recovery turn by itself. A runner error or an uncollectable diff is reported
there as `mutation check failed to run (…)`. A check that is not applicable (no
Deno project and no `Cargo.toml`, skipped, runner not wired, credentials
unresolved, empty diff) is logged with its reason and is not reported.

**CI-fix runs are out of scope.** A CI-fix run does not run the mutation check.

```mermaid
flowchart TD
    A["Review-fix agent turn"] --> B{"Mutation check on lines this run added"}
    B -- "not applicable, skipped or no survivor" --> D["Drift check continues"]
    B -- "budget, cap or runner error" --> N["Reported under<br/>Mutation check heading"]
    B -- "unexempted survivor" --> R["Drift recovery turn:<br/>tests and docs, no production code"]
    R --> C["Re-run mutation check once"]
    C -- "survivors left" --> N
    C -- "none left" --> D
    N --> D
    D --> P["Commit and push, then PR reply"]
```

## Languages

Deno is detected first, then Cargo. A Deno project is the nearest ancestor
directory (the file's own directory up to the repository root) of a changed
source file that holds `deno.json`, `deno.jsonc` or `deno.lock`, so a nested
project such as VibeCoder's `worker/deno/` counts. Each module's tests run from
that directory, so the project's own `deno.json` applies, and only tests inside
it are run.

| Found                                                          | Mutator                                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `deno.json`, `deno.jsonc` or `deno.lock` above a changed file  | Built-in Deno mutator (below)                                                                |
| `Cargo.toml` at the repository root                            | `cargo mutants --in-diff <diff> --output <temp dir> --no-shuffle --jobs N`, with N = min(4, CPUs) |
| neither                                                        | Not applicable: the gate passes without running and logs the reason                          |

For Cargo `--output` points at a fresh temporary directory outside the
repository; the outcomes are read from its `mutants.out/outcomes.json` and the
directory is removed afterwards, so nothing of cargo-mutants' output reaches
the working tree (a recovery commit stages it with `git add -A`). The worker
image ships `cargo-mutants` 27.1.0 (amd64 from the release tarball,
checksum-verified; arm64 built with `cargo install --locked`).

The run is limited to the packages the diff touches: for each changed `.rs`
file the nearest ancestor `Cargo.toml` with a `[package]` section supplies a
`--package <name>` argument (names failing `^[A-Za-z0-9_-]+$` are skipped; none
found means no package arguments). A `mutants.out` already in the repository is
neither read nor touched. cargo-mutants writes `outcomes.json` only after its
clean build and baseline test run, so a run killed at the budget before then
leaves none; that is reported as budget exhausted (nothing tried, a warning),
as a Deno baseline timeout is, not as an error. A normal exit that leaves no
parseable `outcomes.json`, or exit code 3 (some mutants timed out) with none,
is an error, except in one case: when the diff touches no mutant at all,
cargo-mutants logs "No mutants to filter" on stderr and exits 0 without writing
`outcomes.json`, and that is "Not applicable".

At the budget the runner sends `SIGTERM` to cargo-mutants and `SIGKILL` only
after a 5 second grace period, so cargo-mutants can stop its cargo process
groups and delete its scratch copy of the tree. That scratch copy is created
under `TMPDIR`, which the runner sets to the run's own `--output` directory, so
removing that directory clears any copy a killed run leaves behind.

Every path the runner writes (mutated Deno files, the Rust diff under
`target/`) is resolved through symlinks and must stay inside the repository;
a file that escapes is skipped, and an escaping `target/` is an error.

## The diff

At PR raise the diff is `origin/<base>...HEAD`, falling back to
`<base>...HEAD`. Only added or changed lines are mutated. When no diff can be
computed the gate fails closed and blocks, rather than passing an unmeasured
change. A review-fix run uses its own diff instead; see
[Review-fix runs](#review-fix-runs-issue-3750).

## Built-in Deno mutations

The mutator works on added lines of non-test source files.

| Mutation                   | Effect                                                   |
| -------------------------- | -------------------------------------------------------- |
| Negate an `if` condition   | `if (c)` becomes `if (!(c))`                             |
| Negate a ternary condition | `c ? a : b` becomes `!(c) ? a : b`, `c` being the whole condition; none is made when the condition holds a statement keyword or an unbalanced bracket (`if (x) return a ? b : c;`) |
| Swap booleans              | `true` becomes `false` and the reverse                   |
| Replace a return value     | `return x` becomes `return undefined;`; `true`/`false`, numbers and plain strings flip to `false`/`true`, `0`/`1` and `""` |
| Delete a call statement    | A single call statement is removed                       |
| Delete an object property  | A property line (`repo,`, `key: value,`, `...rest,`) directly inside an object literal is removed, or one entry of a single-line `f({ repo, ...rest })` argument (Issue #3601) |
| Delete an array element    | A string or identifier element alone on its line in an array literal is removed, such as one name in a `--json` field list (Issue #3601) |
| Revert a property value    | `key: otherName,` becomes `key,` when `key` is a name used just above, undoing a renamed value at a call site (Issue #3601) |

The last three perform the revert the call-site rule asks for ("drop the new
argument and watch a test go red"), so a surviving one means a caller's new
wiring has no test that notices it is gone. They apply only to lines that a scan
of the whole file places directly inside an object or array literal, never to a
type, an interface, an annotation or a generic argument: mutants run with
`--no-check`, so a mutant of a type-only line could never be caught and would
block the PR. A file whose brackets the scan cannot balance gets none of these
three, only the kinds above. They count towards the same mutant cap, after the
other kinds on each line.

Each mutant runs only the test files that import the mutated module
(`deno test --no-check -A <those files>`). `--no-check` is deliberate: a mutant
such as `return undefined;` in a `: boolean` function fails type-checking, and
that exit code would otherwise count as a test going red. Before any mutant, the unmutated baseline run
must pass; if it does not, the gate reports an error. The file is restored
after every mutant, even when the run fails. A changed module that no test
imports has its mutants counted as survivors. A mutant that does not parse
(`deno test` fails with `error: SyntaxError:` on stderr, before any test
runs; the colour codes Deno adds to `error` are stripped first) ran no test, so it is counted as neither killed nor survived. A run is capped at 40 mutants.
Candidates past the cap, and added lines over 400 characters (never mutated),
are counted as untested: the run is reported as capped, with the number
untested, never as a clean pass.

## Budget

`mutation_check_budget_seconds` bounds the whole run: a positive integer,
default 300, maximum 3600. On exhaustion the gate reports:

```text
mutation budget exhausted after T of N mutants — remaining mutants untested, not passed
```

A run that hit the mutant cap instead reports:

```text
mutation cap reached: T of N candidate mutants tried — U untested (past the mutant cap or on lines over 400 characters), not passed
```

Both are warnings and are never reported as a pass. Survivors found before the
budget ran out or the cap was hit still block.

## Child environment

`deno test -A` and `cargo mutants` run repository code (tests, build scripts)
after the agent has written tests. Every child process therefore starts from the
allowlisted environment built by `buildUntrustedCommandEnv` with `clearEnv`,
never the worker's own, so `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and cloud
credentials are not inherited by it (Issue #572, the same control as the quality
gate). The only additions are the declared credentials described below and, for
`cargo mutants`, `TMPDIR` (the run's `--output` directory, see above).

The credentials the repository declared in `quality_credentials` (Issues #573
and #574) are resolved once per run, in the completion phase at PR raise and in
the drift check on a review-fix run, and added to each child's environment, the
same way the quality gate does, so tests that need them (for example minted AWS
credentials) pass their baseline here too. Apart from `TMPDIR` for
`cargo mutants`, only the declared variables are added. If the mint fails, the
check is not applicable with a warning instead of running without them. At PR
raise that is reported; on a review-fix run it is logged and not reported.

## Exemptions

A survivor that no test can reasonably kill may be exempted by a PR-summary
line naming the location and giving a non-empty reason:

```text
- `worker/deno/lib/example.ts:42` — exempt (untestable): <reason>
```

This is the same `exempt (untestable): <reason>` convention the Branch
outcomes gate uses; an empty reason does not exempt. Every other survivor
blocks.

## Configuration

Both keys are per-repo options, set operator-side under
`repo_config["owner/repo"]` in `.config.json`, beside `skip_security_fix_check`
(see [Configuration](CONFIGURATION.md)).

| Key                               | Type    | Default | Effect                                              |
| --------------------------------- | ------- | ------- | --------------------------------------------------- |
| `skip_mutation_check`             | boolean | `false` | `true` disables the gate for the repository         |
| `mutation_check_budget_seconds`   | integer | `300`   | Time budget for one run; positive, at most `3600`   |

```json
"repo_config": {
  "owner/repo": {
    "skip_mutation_check": true
  }
}
```

## Outcomes

| Outcome                | Meaning                                                | Blocks the PR?            |
| ---------------------- | ------------------------------------------------------ | ------------------------- |
| Not applicable         | No Deno config above a changed file and no root `Cargo.toml`, check disabled, the repository's `quality_credentials` could not be resolved, or cargo-mutants finds no mutants on the changed lines ("No mutants to filter") | No                        |
| Completed, no survivor | Every mutant was killed, or the survivor is exempted   | No                        |
| Completed, survivors   | At least one unexempted survivor                       | Yes                       |
| Budget exhausted or capped | Remaining mutants untested (time budget or mutant cap); warning, not a pass | Only if a survivor found  |
| Error                  | Runner failed (for example `cargo-mutants` missing, baseline tests fail), or diff unavailable | Yes, with a remedy |

In a review-fix run nothing blocks the push. Survivors, budget exhaustion, the
mutant cap and runner errors are reported in the PR reply instead, under the
`#### Mutation check (Issue #3750)` heading (see
[Review-fix runs](#review-fix-runs-issue-3750)).

A Rust run killed at the budget before cargo-mutants finishes its baseline is
"Budget exhausted", not "Error".

## Troubleshooting

- **Baseline tests fail.** The gate runs the unmutated tests first. Fix the
  failing test; a mutant result is meaningless over a red baseline.
- **`cargo-mutants` missing.** The worker image ships 27.1.0. Outside the image,
  install it with `cargo install --locked cargo-mutants`, or set
  `skip_mutation_check: true`.
- **Survivor in an untested module.** No test imports the changed module, so
  every mutant survives. Add a test that imports it and asserts on the
  behaviour.
- **Budget exhausted too often.** Raise `mutation_check_budget_seconds` (up to
  3600), or narrow the PR.
- **Diff unavailable.** Make sure the base branch is fetched so
  `origin/<base>` resolves.
