## Summary

`commandIndex` in `worker/deno/lib/shell_command_words.ts` now reads the
operands after `env` the way `env` does: it skips every operand that contains
`=` once the shell has removed its quotes and does not start with `-`, then
takes the next word as the command. Before this change a quoted-name operand
(`env "X"=./pytest`) or a non-identifier one (`env ./a=./pytest`) was taken as
the command word, so `aws-emulator-run -- env "X"=./pytest` earned AWS Emulator
credit although `env` runs no command and exits 0. A shell-level `VAR=value`
still needs an unquoted name, as in bash. Closes #5351.

## Spec

### Intent and Rationale

- The fault sits in the shared helper, so the fix goes there: every caller
  (`emulatorRunnerCommand`, `looksLikeTestCommand`, `isCargoTestCommand`, the
  reachability walk, `segmentInvokes`, `segmentInstallsRunner`) reads the right
  command word after `env`.
- Quote removal applies only to `env`'s operands. Applying it to shell-level
  words as well, the issue's first suggestion, would open a new hole:
  `"X=1" ./test.sh` runs a command named `X=1` (bash: `X=1: command not found`,
  exit 127), so skipping that word would credit `./test.sh`.

### Essential Design Decisions

- After `env`, the rule is "contains `=`" rather than the `NAME=` pattern,
  because GNU and BSD `env` take any leading operand containing `=` as an
  assignment (observed below).
- A shell-level `"X=1"` stays the command word (unchanged), and
  `"X=1" aws-emulator-run -- pytest` stays uncredited. A test pins that control.
- `env` options (`-i`, `-u NAME`, `--split-string=echo`) stay unhandled, as
  before. The operand scan stops at a word that starts with `-` once quotes are
  removed, so the option becomes the command word and the invocation earns no
  credit (fails closed). Without this stop, `--split-string=echo` contains `=`
  and was skipped. But `env --split-string=echo ./pytest` runs `echo`, so the
  word after it would have been credited as the test command. The callers this
  covers are `emulatorRunnerCommand`, `segmentScriptPath`, `isCargoTestCommand`
  and `looksLikeTestCommand`.
- The stop is deliberately coarse. GNU `env -S=echo cmd` stores `=echo` as an
  assignment and runs `cmd`, but `-S=echo` is still refused. That is a
  fail-closed false negative, which a test pins.
- `removeQuotes` is a new export: plain quote removal with no `$…` expansion.
  `commandIndex` calls it; the direct tests use the export.

### Undiscoverable Facts

- Observed on GNU coreutils `env` 9.7 in the container: `env '_A=1'` exits 0 and
  runs nothing, `env ./a=b` puts `./a=b` in the environment, `env =x` exits 0,
  and `env 'X'=1 sh -c 'echo X=$X'` prints `X=1`.
- Same `env`: `env --split-string=echo ./pytest` prints `./pytest` and exits 0,
  and so does `env "--split-string"=echo ./pytest`. `env -S=echo hi` tries to
  run `hi` (exit 127), so `=echo` was an assignment.
  `env X=1 --split-string=echo hi` tries to run `--split-string=echo` (exit
  127): options are read only before the first operand.
- #5350 (closed) made the test step require an exact command line, so the
  issue's test-step scenario is already refused on this branch. The new
  test-step case pins that behaviour; the live hole was in the in-CI check.

## Evidence

Backend-only change; no UI files.

Probe through `workflowRunsAwsEmulator` on the base branch, one `run:` step
each:

| `run:`                                 | base          | head  |
| -------------------------------------- | ------------- | ----- |
| `aws-emulator-run -- env "X"=./pytest` | true (wrong)  | false |
| `aws-emulator-run -- env ./a=./pytest` | true (wrong)  | false |
| `aws-emulator-run -- env "X"=1 pytest` | false (wrong) | true  |
| `env "X"=1 aws-emulator-run -- pytest` | false (wrong) | true  |
| `env X=1 aws-emulator-run -- pytest`   | true          | true  |
| `"X=1" aws-emulator-run -- pytest`     | false         | false |

Probe through `workflowRunsAwsEmulator` with the `env` option stop, comparing
the head with and without that stop:

| `run:`                                                        | without stop              | head    |
| ------------------------------------------------------------- | ------------------------- | ------- |
| `aws-emulator-run -- env --split-string=echo pytest`          | true (wrong)              | false   |
| `env --split-string=echo aws-emulator-run -- pytest`          | true (wrong)              | false   |
| `env --split-string=echo ./ci.sh` (`./ci.sh` runs the runner) | true (wrong)              | false   |
| embedded marker + `env --split-string=echo cargo test`        | official-embedded (wrong) | missing |

Corpus run: I compared `commandIndex` between base and head on every
`shellSegments` segment of the `run:` bodies in `.github/workflows/*.yml` and
the scripts in `container/toolchains/` and `infra/cloudformation/`. That was 97
bodies and 1939 segments, with 0 changed results, so no false positives or false
negatives against the repository's own corpus.

Issue numbers cited in the diff:

- #5351: shell_command_words: `commandIndex` takes a quoted `NAME=value` word as
  the command word, so an `env` call with no command passes the AWS Emulator
  test-step check
- #5350: aws-emulator.yml validator does not pin which test script the step runs
  (path suffix, working-directory, checkout inputs)

## Test Plan

- `worker/deno/tests/aws_emulator_in_ci_check_test.ts`: eight new
  `workflowRunsAwsEmulator - … (Issue #5351)` cases, which are the six rows
  above, `env X=./pytest` and a `set -euo pipefail` block-scalar variant. Four
  more cover `env` options:
  `aws-emulator-run -- env --split-string=echo pytest`,
  `env --split-string=echo aws-emulator-run -- pytest`,
  `env "--split-string"=echo aws-emulator-run -- pytest` and
  `env -S=echo aws-emulator-run -- pytest`, all false. Seven new
  `removeQuotes - … (Issue #5351)` cases with literal expected values.
- Same file:
  `workflowRunsAwsEmulator - env --split-string=echo ./ci.sh does not
  run the script (Issue #5351)`
  covers `segmentScriptPath` through a script reader, with `./ci.sh` and
  `env X=1 ./ci.sh` as positive controls.
  `checkAwsEmulatorInCI - an
  embedded marker before env --split-string=echo cargo test is refused (Issue
  #5351)`
  covers `isCargoTestCommand`, with `env "X"=1 cargo test` as the positive
  control.
- `worker/deno/tests/issue_5110_aws_emulator_workflow_test.ts`:
  `(a) refuses env with a quoted-name assignment as the script (Issue #5351)`.
  It passes on base too, because #5350's exact match already refuses this shape;
  it pins that.
- Red run: base `shell_command_words.ts` plus a pass-through `removeQuotes`
  stub,
  `deno task test:unit tests/aws_emulator_in_ci_check_test.ts tests/issue_5110_aws_emulator_workflow_test.ts < /dev/null`:
  523 passed, 11 failed. The failures were the five wrong-on-base
  `workflowRunsAwsEmulator` cases and six `removeQuotes` cases.
- Red run for the `env` option stop: the head with `isEnvAssignment` reduced to
  "contains `=`",
  `deno task test:unit tests/aws_emulator_in_ci_check_test.ts
  < /dev/null`:
  252 passed, 6 failed. The failures were the four option cases and the two
  caller tests above.
- Green run at head: those two files plus
  `worker/deno/tests/aws_emulator_run_5109_test.ts` and
  `worker/deno/tests/aws_emulator_cloudformation_5110_test.ts` gave 540 passed,
  0 failed.
- `./quality.sh < /dev/null` at head: passed (`config integration` and `checkov`
  skipped by the gate itself).
- No existing test was edited.
- Docs: I read the "AWS emulator in CI" command-word paragraph in
  `docs/BEST-PRACTICES-SCAN.md` and amended it, including the `env` option stop.
  I also read the `commandIndex` doc comment and fixed it; the module header and
  the `SHELL_PREFIX_WORDS` comment needed no change.

Not checked: `sudo` and `exec` operands keep today's handling. `sudo "X"=1 cmd`
still takes `"X"=1` as the command word (fails closed), and `exec X=1 cmd` still
skips `X=1`. Both are outside this issue.
