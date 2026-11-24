## Summary

`commandIndex` now skips the words that an assignment's unclosed `$( … )`,
`$(( … ))` or backtick value spans. `shellCommands` splits words at the blanks
inside such a value. Before this change,
`X=$(cat v) aws-emulator-run -- ./test.sh` read `v)` as the command word, and
the best-practices scan reported missing AWS Emulator wiring for a repository
that was wired correctly. Closes #5378.

## Spec

### Intent and Rationale

- The issue offered two fixes. This one is in `commandIndex`, not in the
  `shellCommands` tokeniser, because many existing fixtures rely on
  `shellCommands` still exposing the commands inside a `$( … )`. Those fixtures
  include the round-11 and round-12 subshell and substitution tests in
  `worker/deno/tests/aws_emulator_in_ci_check_test.ts`.
- The skip reuses the existing quote-aware `parenBalance` and `backtickCount`
  helpers, so a quoted `)` does not close the substitution.

### Essential Design Decisions

- `env` assignment operands get the same skip (`env X=$(cat v) cmd`), because
  they are the same defect on the `env` path.
- The words inside a substitution are no longer prefix words. The new
  `commandPrefixWords` leaves them out, and the prefix checks that look for a
  standalone `!` or `exec` use it: `statusPreservingCommandIndex`,
  `staticStatus`, the `! cmd || exit 1` check in `failureExits`, and `viaExec`
  in `keptCommands`. Without this, `X=$(test ! v) runner` would read the inner
  `!` as inverting the runner's status. The `openAtCommand` parenthesis balance
  in `reachableCommands` still slices every word up to `commandIndex`, because
  it needs the closing word to balance.
- An assignment whose substitution never closes leaves no command word
  (`words.length`). This fails closed. The skip follows the words only when the
  unbalanced `(` opens a real substitution (`$(`, `$((`, `<(`, `>(`, or an array
  `(` right after `=`). Any other unquoted `(` in the assignment word, such as
  the one in `X=${Y:-(}`, also leaves no command word, so
  `X=${Y:-(} echo ${Z:-)} aws-emulator-run …` earns no credit (pre-PR verifier
  finding).
- Known limit, documented in the `commandIndex` doc comment and in
  `docs/BEST-PRACTICES-SCAN.md`: a substitution holding `;`, `|`, `&` or a line
  break is still split into separate commands by `shellCommands`, so
  `X=$(cat v | tr -d x) aws-emulator-run …` still earns no credit. A test row
  pins that outcome.

### Undiscoverable Facts

- On this milestone branch, `./t.sh` from the issue's example is not recognised
  as a test command, so the fixtures use `./test.sh`. The plain
  `aws-emulator-run -- ./t.sh` is false on the base branch too.

## Evidence

This is a backend change with no UI. Reproduction on the base branch
(`origin/milestone/aws-emulator-validator-hardening`) ran
`workflowRunsAwsEmulator` on a `pull_request` step:

- **False on the base branch:**
  - `X=$(cat v) aws-emulator-run -- ./test.sh`
  - `AWS_REGION=$(aws configure get region) aws-emulator-run -- ./test.sh`
  - ``X=`cat v` …``
  - `env X=$(cat v) …`
  - `X=$((1 + 2)) …`
- **True on the base branch:** `X="$(cat v)" …` and `X=$(date) …`.

Red/green: the new `--filter 5378` tests in
`worker/deno/tests/aws_emulator_in_ci_check_test.ts` and
`worker/deno/tests/issue_5110_aws_emulator_workflow_test.ts` were run in a
detached checkout of the base branch. That checkout had the base production
files, plus a `commandPrefixWords` export stub
(`words.slice(0, commandIndex(words))`) so the test file compiles. Result: 15
failed and 7 passed. The 7 that passed are the controls and the false rows. At
the head, all 22 pass.

Corpus run: `commandIndex` and `commandPrefixWords` were compared between base
and head on every `shellSegments` segment of the `run:` bodies in
`.github/workflows/*.yml` and of the `*.sh` files in `container/`,
`container/toolchains/` and `infra/cloudformation/`. That was 104 bodies and
3222 segments:

- **`commandIndex`:** 39 results changed. Each change is a pure assignment with
  no command, which now finds no command word where the base branch returned a
  word from inside the value. Examples: `i=$((i + 1))` returned `+`, and
  `COMMAND=(bash "$0" --smoke-client)` returned `"$0"`. That makes 0 false
  positives and 39 false negatives removed.
- **`commandPrefixWords`:** 0 changes.

Issue numbers cited: #5378: shell_command_words: an assignment whose unquoted
`$( ... )` value holds a space hides the command after it, so
`VAR=$(cmd arg) aws-emulator-run -- ...` is not recognised.

```mermaid
flowchart LR
    W["words: X=$(cat · v) · aws-emulator-run · …"] --> A{"assignment word?"}
    A -- yes --> B["skipAssignment: add parenBalance / backticks until closed"]
    B --> C["command word = aws-emulator-run"]
    B -. "inner words" .-> P["left out of commandPrefixWords"]
```

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Changing what a shared helper returns changes every caller: no
  test went through another existing caller — evidence:
  `worker/deno/lib/shell_command_words.ts` — reason: fixed in this diff
- **violation** — Every changed call site needs a test that goes red without it,
  for the prefix sites in `staticStatus` and `failureExits` — evidence:
  `worker/deno/lib/shell_command_words.ts` — reason: fixed in this diff
- **violation** — Prose about the PR's own change left out the
  `;`/`|`/line-break limit — evidence: `docs/BEST-PRACTICES-SCAN.md` — reason:
  fixed in this diff
- **violation** — The gate-over-text evasion table had no separator row and no
  nested row — evidence: `worker/deno/tests/aws_emulator_in_ci_check_test.ts` —
  reason: fixed in this diff
- **clean** — Checked "Check where you insert" (review-enforced), dummy and
  "how" tests, nothing test-only (`commandPrefixWords` has production callers),
  negative tests that hold the forbidden input, host-state isolation, no regex
  added, fail-closed on an unclosed substitution, no twinned copy of the
  command-word rule, Australian English, commit safety

## Test Plan

- Added the Issue #5378 tests to
  `worker/deno/tests/aws_emulator_in_ci_check_test.ts`. No existing test was
  edited.
  - A `workflowRunsAwsEmulator` table:
    - assignment, backtick, `env`, arithmetic, quoted-`)`, inner-`!` and
      nested-substitution rows that must be true;
    - controls that were already true;
    - false rows: `… echo aws-emulator-run`, a runner inside the substitution,
      an unclosed substitution, and the pinned `|` limit.
  - Direct `commandIndex` and `commandPrefixWords` tests with literal expected
    values.
  - A `checkAwsEmulatorInCI` test for a workflow step and a repository script,
    with an `echo $(cat v)` control.
  - Tests through other callers: the `cargo test` embedded route, the
    `staticStatus` prefix and the `failureExits` prefix.
  - One `checkAwsEmulatorInCI` test through each remaining caller, each with an
    `echo` control: the step script path (`X=$(cat v) ./ci/t.sh`), a runner
    COMMAND script and a runner COMMAND holding `X=$(cat v) npm test`, the self
    re-exec behind `env X=$(cat v)`, a trap handler's `exit 0`, `set +e` and
    `trap` behind the assignment, `exit 0` before the runner, and a Floci job
    test step.
  - A `workflowRunsAwsEmulator` false row for
    `X=${Y:-(} echo ${Z:-)} aws-emulator-run -- ./test.sh`, and `commandIndex`
    rows for it, an array value and `<( … )`.
  - A test that an `exec` inside `X=$( … )` does not count as `exec`-ing the
    runner, with the plain `exec` and no-`exec` controls.
- Added a test to `worker/deno/tests/issue_5110_aws_emulator_workflow_test.ts`:
  the toolchain step is still recognised after `X=$(cat v)`, and the control
  `X=$(cat v) echo …` is refused with `[pinned-install]`. Two more tests there
  cover the runner install (`[runner-install]`) and the image's `docker build`
  (`[container-agent-run]`) behind `X=$(cat v)`, each with an `echo` control.
- Red check for the caller tests: with `skipAssignment` forced back to the base
  behaviour (skip only the assignment word), all 9 non-control rows of the new
  `checkAwsEmulatorInCI` caller test and both new workflow tests fail; the head
  passes them.
- At head, the four test files
  `worker/deno/tests/aws_emulator_in_ci_check_test.ts`,
  `worker/deno/tests/issue_5110_aws_emulator_workflow_test.ts`,
  `worker/deno/tests/aws_emulator_run_5109_test.ts` and
  `worker/deno/tests/aws_emulator_cloudformation_5110_test.ts` passed with
  `deno task test:unit … < /dev/null`: 586 passed, 0 failed. Every test file
  importing `shell_command_words` or an AWS Emulator module: 740 passed.
- `./quality.sh < /dev/null` at head: passed. `config integration` and `checkov`
  were skipped by the gate itself.
- Docs: I read the "AWS emulator in CI" command-word paragraph in
  `docs/BEST-PRACTICES-SCAN.md` and the `commandIndex` doc comment, and amended
  both.
- Twinned-rule search: no second copy of the command-word rule was found.

Not checked: the corpus run did not cover `docs/archive/pr-summaries/` or the
test files, because the matcher reads shell bodies, not Markdown. The
`;`/`|`/line-break limit above remains.
