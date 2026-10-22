# Setup keeps a host's update mode when .config.json already exists

## Summary

Closes #4119.

Setup treated a `.config.json` with no `update_mode` key as a fresh host.
Non-interactive setup pinned such a host to the latest release, and interactive
setup defaulted the question to `frozen`. A host that was following main, and so
ran `dynamic` by the load-time default, was therefore frozen by a setup run it
did not ask for. Setup now reads a missing `update_mode` on an existing config
as `dynamic`, and keeps it unwritten. With no `update_mode` key, `frozen` stays
the offered default only when no `.config.json` existed before the setup run; a config that
already holds a mode is offered that mode. A frozen host that is behind the
newest release now logs that at WARNING on each launch, from `run.sh` and from
`run.ps1`. `setup.ps1` runs the same update-mode conversation as `setup.sh`,
with the question visible and a failure fatal.

## Spec

### Intent and Rationale

A frozen host stops receiving fixes without any visible sign beyond one
INFO-style launch line. Setup must not make that change silently on a host that
was not frozen. The freeze default is still correct for a host setup is creating
for the first time, so the change is scoped to existing configs.

On GRQ-23 an agent froze the host to protect uncommitted work and never undid
it. The host ran 1.10.108 to 1.10.111 for three days while main reached
1.10.124. The freeze came from an agent rather than from setup, but it shows
what a silently frozen host costs.

### Essential Design Decisions

- `configExisted` is a required option of `runUpdateModeSetup`.
  `setup_cli.ts update-mode` refuses to run without `--config-existed=true` or
  `--config-existed=false` (`worker/deno/setup/setup_cli.ts:472`), so no caller
  can fall back to a silent default. `runUpdateMode` is exported with an
  optional deps parameter, and the help text is the exported `SETUP_CLI_USAGE`,
  so both are tested in-process.
- Two constants carry the two defaults. `DEFAULT_UPDATE_MODE` is `dynamic`
  (`worker/deno/lib/config_defaults.ts:721`) and is the load-time default for an
  existing config with no key. `SETUP_DEFAULT_UPDATE_MODE` is `frozen`
  (`worker/deno/lib/config_defaults.ts:738`, Issue #692) and is the setup
  default for a fresh host.
- The prompt default is the config's own `update_mode` when it has one, and
  otherwise is chosen by `configExisted`
  (`worker/deno/setup/update_mode_setup.ts:521-522`). The non-interactive path
  returns early when `configExisted` is true, so an existing config with no key
  is left unwritten (`worker/deno/setup/update_mode_setup.ts:663`).
- The existence check is taken before any setup step that could create the file.
  `setup.sh` takes it at `setup.sh:1471-1476`, and `setup.ps1` at
  `setup.ps1:1646-1648`, both before the prerequisites step.
- `setup.ps1` calls update-mode through `Invoke-VibeSetupCliPassthrough`, as
  `copilot-review-mode` is called, and exits 1 on a non-zero status
  (`setup.ps1:1687-1690`). `Invoke-VibeSetupCliOrExit` captured the CLI's
  stdout into its condition, so the question never reached the console.
- Questions are asked through one shared helper, `askOnConsole`
  (`worker/deno/setup/console_ask.ts:36-43`). `Out-Host` prints a line only
  once it ends, so when stdout is not a terminal the question is printed as a
  whole line and then a bare `>` prompt. This logic was inline in
  `copilot_review_setup.ts`; both `update-mode` and `copilot-review-mode` now
  use the helper (`update_mode_setup.ts:197`, `copilot_review_setup.ts:82`).
- The frozen-behind notice is a WARNING. `run.sh` prints it on stderr
  (`run.sh:654`) and writes it to `run_core.log` (`run.sh:655`). `run.ps1` runs
  the same `release-notice` command after its checkout update and does the same
  with a `[run.ps1]` prefix (`run.ps1:564-587`); a failed check warns with the
  check's stderr and the launch proceeds.

### Undiscoverable Facts

- The existence snapshot must come before prerequisites, because a file the run
  itself creates would otherwise count as existing. `setup.sh` and `setup.ps1`
  both take it first for that reason.
- `run.ps1` had no release-notice code before this change, and `setup.ps1`
  never ran update-mode, so making `setup.ps1` freeze a fresh Windows host
  without porting the notice would have produced exactly the silent freeze the
  issue describes. Both land together here.
- `run.ps1` has no outer 120 s bound on `release-notice`, unlike `run.sh`. It
  relies on the command's own bound on each `gh` call, as its unbounded
  checkout update already does.
- The notice text names `./run.sh upgrade` on every platform, and
  `run.ps1 upgrade` does not exist yet; the docs tell a Windows host to move its
  pin by hand.
- The mutation check does not follow tests that spawn `setup_cli.ts` as a
  subprocess, which is why the original refusal suite left
  `setup_cli.ts:472` unpinned. The in-process `runUpdateMode - …` tests now pin
  it.
- The setup.ps1 tests are skipped unless `pwsh` is present. `pwsh` is installed
  at `/usr/local/bin/pwsh` on this host, so those tests ran in this session.

## Evidence

Test suites that cover the changed files, run from `worker/deno` with stdin
redirected from `/dev/null`:

- `console_ask_test.ts`, `setup_update_mode_test.ts`,
  `setup_update_mode_refusal_test.ts`, `setup_ps1_update_mode_test.ts`,
  `setup_sh_config_existed_test.ts`, `run_ps1_launcher_test.ts`,
  `run_sh_launcher_test.ts`, `launcher_parity_test.ts`,
  `setup_parity_test.ts`, `setup_ps1_test.ts`, `launcher_source_test.ts`,
  `update_mode_docs_test.ts`, `release_integrity_docs_test.ts`,
  `integration_test_manifest_test.ts`, `mod_test.ts` and
  `setup_copilot_review_mode_test.ts`: `ok | 335 passed | 0 failed (7m58s)`.
- `deno task check:manifests`: `ok | 805 passed | 0 failed | 1 ignored`
  (`console_ask.ts` is claimed by
  `docs/audits/lib-sweep-coverage/top-up-4119.json`).
- A manual pty run of the real `setup_cli.ts update-mode` under
  `pwsh … | Out-Host` showed `Update mode (dynamic/frozen) [dynamic]` on the
  console before any answer was typed. A stand-in script that prints an
  unterminated question (as a bare `prompt()` does) under the same
  `| Out-Host` showed nothing until after the answer.

The red claims in the Test Plan come from mutating the fixed code and watching
the named test fail. M1–M9 were made in scratch copies outside the repository.
M10–M16 were made in place, one at a time, with the file restored from a backup
copy after each. M17 and M18 ran the new tests against the earlier head's
`setup.ps1` call and `run.ps1`. None comes from running the tests
against the pre-fix commit.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

The issue states four criteria under its `## Acceptance criteria` heading. Each
is quoted verbatim below with its assessment. The `reviewer:` verdicts come from
an independent Spec reviewer re-run against this head's diff and the issue
body, after the `setup.ps1` passthrough and `run.ps1` notice fixes. The
`askOnConsole` change came after that review and only bears on criterion 4,
where it makes the question visible under `Out-Host`.

- **met** — 1. "On a `.config.json` that already exists, a missing `update_mode`
  is read as what the host runs today (`dynamic`). Setup keeps it, interactive
  or not. `frozen` stays the offered default only when no `.config.json` existed
  before this setup run." — evidence:
  `worker/deno/setup/update_mode_setup.ts:663` (early return on
  `configExisted`), `:521-522` (prompt default), `setup.sh:1471-1476`, and the
  tests `setup_update_mode_test.ts` "a pre-existing config with no update_mode
  is read as dynamic and left unwritten", "a pre-existing config with no
  update_mode offers dynamic, and Enter writes dynamic" and "runUpdateMode -
  --config-existed=true leaves a config with no update_mode unwritten" —
  reviewer: met

- **met** — 2. "Tests (each fails on today's code): non-interactive setup on an
  existing config with no `update_mode` leaves it `dynamic` and writes no pins.
  Interactive setup on the same config offers `dynamic` as the default." —
  evidence: the first two tests named under criterion 1 cover both halves; on
  the base branch `setup_update_mode_test.ts` fails to load (it imports
  `parseConfigExistedFlag`, which base lacks), and mutations M1 and M2 restore
  the base behaviour on the fixed code and turn each test red — reviewer: met

- **met** — 3. "A frozen host whose pin is behind the newest release logs that
  at **WARNING** on each launch, once per launch. It is degraded but continuing,
  and an operator should see it in a log sweep." — evidence: `run.sh:654-655`,
  `run.ps1:564-587`, and the tests `run_sh_launcher_test.ts` "run.sh - the
  new-release notice is a WARNING line on stderr (Issue #4119)" and "run.sh -
  the new-release notice is one WARNING line in run_core.log per launch (Issue
  #4119)", and `run_ps1_launcher_test.ts` "run.ps1 - the new-release notice is
  one WARNING line on stderr and in run_core.log (Issue #4119)", "run.ps1 - says
  nothing when the release check has nothing to say (Issue #4119)" and "run.ps1
  - a failed release check warns with its reason and the launch proceeds (Issue
  #4119)" — reviewer: met

- **met** — 4. "`setup.ps1` gets the same behaviour." — evidence:
  `setup.ps1:1648` (snapshot before prerequisites), `setup.ps1:1687-1690`
  (passthrough, `exit 1` on non-zero), `worker/deno/setup/console_ask.ts`
  (question printed whole under `Out-Host`), and the pwsh-backed tests
  `setup_ps1_update_mode_test.ts` "setup.ps1 - update-mode gets
  --config-existed=true when .config.json pre-exists (Issue #4119)",
  "setup.ps1 - update-mode gets --config-existed=false on a fresh host, snapshot
  taken before config (Issue #4119)" and "setup.ps1 - update-mode output reaches
  the console and a failure stops setup (Issue #4119)" — reviewer: met

- **unrequested** — `--config-existed` is mandatory on `update-mode`, and about
  30 existing test call sites now pass `configExisted` — reviewer: unrequested —
  reason: fails loud instead of guessing a default; its only callers,
  `setup.sh` and `setup.ps1`, pass it
- **unrequested** — `runUpdateMode` and `SETUP_CLI_USAGE` exported, and
  `askOnConsole` shared with `copilot_review_setup.ts` — reviewer: unrequested
  — reason: test seams for the mutation check, and the fix for the question
  `Out-Host` held back; the copilot conversation behaves as before

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

An independent Standards reviewer ran against this head's diff and
`CODING-STANDARDS.md` twice. The first pass found the violations below; the
second pass, against the fixes, confirmed each was fixed and reported one more
(the sweep ledger), which is fixed too. The `consoleIo` parameter on both
default-deps factories and the two wiring tests in `console_ask_test.ts` came
after the second pass, in answer to its note that no test reached the two
`ask:` wiring lines.

- **violation** — A code change owes a docs change — evidence:
  `worker/deno/setup/update_mode_setup.ts:5-9` — reason: fixed in this diff
  (the header named only `setup.sh` and called Windows a follow-up)
- **violation** — A new state re-reads the screen's existing text — evidence:
  `docs/CONFIGURATION.md` New-Release Notice, `docs/SETUP.md`,
  `docs/TROUBLESHOOTING.md` — reason: fixed in this diff (the docs now say the
  notice names `./run.sh upgrade` everywhere and a Windows host moves its pin by
  hand)
- **violation** — Prose about the PR's own change must match head code —
  evidence: `docs/CONFIGURATION.md:1160-1164`, `docs/SETUP.md` "Blank answers
  keep what the host runs" — reason: fixed in this diff (Enter on a config with
  no `update_mode` writes `"update_mode": "dynamic"`)
- **violation** — A stub mirrors the real callee's contract — evidence:
  `worker/deno/setup/update_mode_setup.ts:197` — reason: fixed in this diff
  (the real `prompt()` question was unterminated and `Out-Host` held it back;
  `askOnConsole` now prints it whole)
- **violation** — Unit tests stay fast and self-contained — evidence:
  `worker/deno/tests/setup_update_mode_refusal_test.ts` — reason: fixed in this
  diff (the `=false` case that reached real git and the release lookup is gone;
  the two offline argv-wiring cases remain, and the integration manifest refuses
  a file that drives no `.sh`/`.ps1`)
- **violation** — Quality gates (`check:manifests`) — evidence:
  `worker/deno/setup/console_ask.ts` — reason: fixed in this diff
  (`docs/audits/lib-sweep-coverage/top-up-4119.json`)
- **clean** — Australian English, DRY, KISS, fail-loud refusal of a missing or
  invalid `--config-existed`, exports with production readers, test isolation,
  integration manifest registration, the `IN_GATE_SCRIPT_SUITES` cost note,
  setup.sh/setup.ps1 and run.sh/run.ps1 parity, and docs consistency across
  CONFIGURATION.md, SETUP.md, TROUBLESHOOTING.md and the code

Optional notes from the reviewer: the `>` prompt line is still unterminated
under `Out-Host`, so it appears only after the answer, though the question is
visible first; `launcher_parity_test.ts` does not compare the release-notice
contract, and each launcher's own suite pins it instead; `setup.ps1`'s
`Test-Path` is also true for a directory where `setup.sh` checks `-f`.

## Test Plan

Red check. Each row is one mutation of the fixed code, and each named test was
run against the mutated code. M1–M9 were made in scratch copies outside the
repository; M10–M16 in place, one at a time, restored from a backup after each.
M17 and M18 ran the new tests against the earlier head's `setup.ps1` call and
`run.ps1`.

| #   | Mutation                                                    | File:line                                         | Reaching test                                                                                                              | Result |
| --- | ----------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | prompt default always `SETUP_DEFAULT_UPDATE_MODE`           | `worker/deno/setup/update_mode_setup.ts:522`      | runUpdateModeSetup - a pre-existing config with no update_mode offers dynamic, and Enter writes dynamic                    | FAILED |
| M2  | drop the `options.configExisted` operand                    | `worker/deno/setup/update_mode_setup.ts:663`      | runUpdateModeSetup - a pre-existing config with no update_mode is read as dynamic and left unwritten                       | FAILED |
| M3  | drop the `existing.value.update_mode !== undefined` operand | `worker/deno/setup/update_mode_setup.ts:663`      | runUpdateModeSetup - a non-interactive run keeps an update_mode the config already holds, even when configExisted is false | FAILED |
| M6  | prompt default always `DEFAULT_UPDATE_MODE`                 | `worker/deno/setup/update_mode_setup.ts:522`      | runUpdateModeSetup - accepting every default pins a fresh host to the latest release                                       | FAILED |
| M7  | early return forced on (`if (true \|\| ...)`)               | `worker/deno/setup/update_mode_setup.ts:663`      | runUpdateModeSetup - a non-interactive fresh config pins to the latest release without prompting                           | FAILED |
| M4  | `--config-existed=true` returns false                       | `worker/deno/setup/setup_cli.ts:452`              | parseConfigExistedFlag - --config-existed=true and =false parse to booleans                                                | FAILED |
| M8  | `--config-existed=false` returns true                       | `worker/deno/setup/setup_cli.ts:453`              | parseConfigExistedFlag - --config-existed=true and =false parse to booleans                                                | FAILED |
| M9  | fall-through returns false instead of undefined             | `worker/deno/setup/setup_cli.ts:454`              | parseConfigExistedFlag - an absent flag or any other value is undefined                                                    | FAILED |
| M5  | refusal guard negated                                       | `worker/deno/setup/setup_cli.ts:472`              | runUpdateMode - no --config-existed answer is refused and .config.json is left untouched (and both flag tests)             | FAILED |
| M10 | refusal `return false` → `return true`                      | `worker/deno/setup/setup_cli.ts:477`              | runUpdateMode - no --config-existed answer is refused and .config.json is left untouched                                   | FAILED |
| M11 | `configExisted` property deleted                            | `worker/deno/setup/setup_cli.ts:482`              | runUpdateMode - --config-existed=true leaves a config with no update_mode unwritten                                        | FAILED |
| M12 | help text `=true\|false` → `=false\|false`                  | `worker/deno/setup/setup_cli.ts:1916`             | setup_cli usage - names the --config-existed=true\|false flag update-mode needs                                            | FAILED |
| M13 | terminal check negated                                      | `worker/deno/setup/console_ask.ts:40`             | askOnConsole - a pipe gets the question as a whole line, then a bare > prompt; askOnConsole - a terminal is asked the question in place | FAILED |
| M14 | whole-line `io.log(question)` deleted                       | `worker/deno/setup/console_ask.ts:41`             | askOnConsole - a pipe gets the question as a whole line, then a bare > prompt                                              | FAILED |
| M15 | `ask:` back to a bare `prompt(question)`                    | `worker/deno/setup/update_mode_setup.ts:197`      | askOnConsole - update-mode's real deps ask through it                                                                      | FAILED |
| M16 | `ask:` back to a bare `prompt(question)`                    | `worker/deno/setup/copilot_review_setup.ts:82`    | askOnConsole - copilot-review-mode's real deps ask through it                                                              | FAILED |
| M17 | update-mode back through `Invoke-VibeSetupCliOrExit`        | `setup.ps1:1687`                                  | setup.ps1 - update-mode output reaches the console and a failure stops setup (Issue #4119)                                 | FAILED |
| M18 | `run.ps1` without the release-notice step                   | `run.ps1:564-587`                                 | the three `run.ps1` release-notice tests named under criterion 3                                                           | FAILED |

M10–M12 are the five mutants the earlier mutation check reported surviving at
`setup_cli.ts:468`, `:473` (twice — "false → true" and "return value → true"
are the same edit), `:478` and `:1911`, at their current line numbers, along
with M5 at `:472`.

Call-site: `setup.sh:1542` and `setup.ps1:1687` are the only callers that pass
`--config-existed`. `setup_cli.ts:466` (`runUpdateMode`) consumes the parsed
value and refuses when it is undefined. `createDefaultUpdateModeDeps` and
`createDefaultCopilotReviewDeps` are the only callers of `askOnConsole`.

**Docs sweep** — grep: `--config-existed`, "dynamic or frozen", "does not ask
yet", "follow-up", "run.ps1", "byte-for-byte", "only when no"; section:
`docs/SETUP.md#update-mode-dynamic-or-frozen`,
`docs/CONFIGURATION.md#-update-mode`,
`docs/CONFIGURATION.md#-new-release-notice`; siblings: `setup.ps1` gained the
update-mode step and `run.ps1` the release-notice step, so the CONFIGURATION.md
lines that called each a follow-up (the update-mode paragraph, "Moving a pin by
hand", and the New-Release Notice "Windows" bullet) and the TROUBLESHOOTING.md
notice line now describe both; left alone: `docs/DEPLOYMENT.md:196`,
`docs/RELEASE-TAGGING.md:157`, `docs/INTERNALS.md:268`,
`docs/CONTAINER.md:1635-1648` — still true, each describes `run.sh` or links the
unchanged SETUP.md anchor

Quality gate: ./quality.sh — PASSED on the earlier head (with skipped checks:
config integration, skipped because no .config.json is present in the
checkout). The worker re-runs it on this head; the changed suites,
`deno task check:manifests`, `deno fmt --check`, `deno lint` and
`markdownlint-cli2` were run on this head and pass.

The setup.ps1 and run.ps1 tests need pwsh and are skipped where it is absent;
pwsh is at `/usr/local/bin/pwsh` on this host, so they ran. The script-driving
suites `worker/deno/tests/setup_sh_config_existed_test.ts` and
`worker/deno/tests/setup_ps1_update_mode_test.ts` are registered in
`INTEGRATION_TEST_FILES` (`worker/deno/lib/integration_test_manifest.ts`);
`run_ps1_launcher_test.ts` stays in `IN_GATE_SCRIPT_SUITES`, with its cost note
updated for the three new cases.

<!-- vibe-branch-outcomes -->
