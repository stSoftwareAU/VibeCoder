# Setup keeps a host's update mode when .config.json already exists

## Summary

Closes #4119.

Setup treated a `.config.json` with no `update_mode` key as a fresh host.
Non-interactive setup pinned such a host to the latest release, and interactive
setup defaulted the question to `frozen`. A host that was following main, and so
ran `dynamic` by the load-time default, was therefore frozen by a setup run it
did not ask for. Setup now reads a missing `update_mode` on an existing config
as `dynamic`, and keeps it unwritten. `frozen` stays the offered default only
when no `.config.json` existed before the setup run. A frozen host that is
behind the newest release now logs that at WARNING on each launch.

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
  `--config-existed=false` (`worker/deno/setup/setup_cli.ts:468`), so no caller
  can fall back to a silent default.
- Two constants carry the two defaults. `DEFAULT_UPDATE_MODE` is `dynamic`
  (`worker/deno/lib/config_defaults.ts:721`) and is the load-time default for an
  existing config with no key. `SETUP_DEFAULT_UPDATE_MODE` is `frozen`
  (`worker/deno/lib/config_defaults.ts:738`, Issue #692) and is the setup
  default for a fresh host.
- The prompt default is chosen by `configExisted`
  (`worker/deno/setup/update_mode_setup.ts:519`). The non-interactive path
  returns early when `configExisted` is true, so an existing config with no key
  is left unwritten (`worker/deno/setup/update_mode_setup.ts:660`).
- The existence check is taken before any setup step that could create the file.
  `setup.sh` takes it at `setup.sh:1471-1476`, and `setup.ps1` at
  `setup.ps1:1646-1648`, both before the prerequisites step.
- The frozen-behind notice is a WARNING. `run.sh` prints it on stderr
  (`run.sh:654`) and writes it to `run_core.log` (`run.sh:655`).

### Undiscoverable Facts

- The existence snapshot must come before prerequisites, because a file the run
  itself creates would otherwise count as existing. `setup.sh` and `setup.ps1`
  both take it first for that reason.
- `run.ps1` contains no release-notice code. The WARNING behaviour therefore
  exists on `run.sh` only, and Windows launches do not log the frozen-behind
  notice.
- The setup.ps1 tests are skipped unless `pwsh` is present. `pwsh` is installed
  at `/usr/local/bin/pwsh` on this host, so those tests ran in this session.

## Evidence

Test suites that cover the changed files, run from `worker/deno` with stdin
redirected from `/dev/null`:

- `setup_update_mode_test.ts`, `setup_update_mode_refusal_test.ts`,
  `setup_ps1_update_mode_test.ts`, `run_sh_launcher_test.ts` and
  `setup_sh_config_existed_test.ts`: `ok | 148 passed | 0 failed (3m12s)`.
- `update_mode_docs_test.ts`, which checks the docs changed for this issue:
  `ok | 19 passed | 0 failed (35ms)`.

The red claims in the Test Plan come from mutating the fixed code in scratch
copies outside the repository and watching the named test fail. They do not come
from running the tests against the pre-fix commit.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

The issue states four criteria under its `## Acceptance criteria` heading. Each
is quoted verbatim below with its assessment. The `reviewer:` verdicts are
recorded as pending because no independent Spec reviewer has been run against
this diff. The assessments are self-checks by the author.

- **met** — 1. "On a `.config.json` that already exists, a missing `update_mode`
  is read as what the host runs today (`dynamic`). Setup keeps it, interactive
  or not. `frozen` stays the offered default only when no `.config.json` existed
  before this setup run." — evidence:
  `worker/deno/setup/update_mode_setup.ts:660` (early return on
  `configExisted`), `:519` (prompt default), and the tests
  `setup_update_mode_test.ts` "a pre-existing config with no update_mode is read
  as dynamic and left unwritten" and "a pre-existing config with no update_mode
  offers dynamic, and Enter writes dynamic" — reviewer: pending

- **partial** — 2. "Tests (each fails on today's code): non-interactive setup on
  an existing config with no `update_mode` leaves it `dynamic` and writes no
  pins. Interactive setup on the same config offers `dynamic` as the default." —
  evidence: the two tests named under criterion 1 cover both halves, and
  mutations M1 and M2 turn them red on the fixed code — reason: the claim "each
  fails on today's code" was not checked by running the tests against the
  pre-fix commit, so it is unverified — reviewer: pending

- **met** — 3. "A frozen host whose pin is behind the newest release logs that
  at **WARNING** on each launch, once per launch. It is degraded but continuing,
  and an operator should see it in a log sweep." — evidence: `run.sh:654-655`
  (stderr and `log_run_core`, both with the `WARNING:` prefix), and the tests
  `run_sh_launcher_test.ts` "run.sh - the new-release notice is a WARNING line
  on stderr (Issue #4119)" and "run.sh - the new-release notice is one WARNING
  line in run_core.log per launch (Issue #4119)"; this holds for `run.sh` only,
  see Undiscoverable Facts — reviewer: pending

- **met** — 4. "`setup.ps1` gets the same behaviour." — evidence:
  `setup.ps1:1646-1648` (snapshot), `setup.ps1:1685`
  (`--config-existed=$configExisted` passed to update-mode), and the pwsh-backed
  tests `setup_ps1_update_mode_test.ts` "setup.ps1 - update-mode gets
  --config-existed=true when .config.json pre-exists (Issue #4119)" and
  "setup.ps1 - update-mode gets --config-existed=false on a fresh host, snapshot
  taken before config (Issue #4119)" — reviewer: pending

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

Violations: none found.

## Test Plan

Red check. Each row is one mutation of the fixed code, made in a scratch copy
outside the repository. Each named test was run against the mutated copy.

| #  | Mutation                                          | File:line                                    | Reaching test                                                                                                 | Result |
| -- | ------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ |
| M1 | prompt default always `SETUP_DEFAULT_UPDATE_MODE` | `worker/deno/setup/update_mode_setup.ts:519` | runUpdateModeSetup - a pre-existing config with no update_mode offers dynamic, and Enter writes dynamic       | FAILED |
| M2 | drop the `options.configExisted` operand          | `worker/deno/setup/update_mode_setup.ts:660` | runUpdateModeSetup - a pre-existing config with no update_mode is read as dynamic and left unwritten          | FAILED |
| M6 | prompt default always `DEFAULT_UPDATE_MODE`       | `worker/deno/setup/update_mode_setup.ts:519` | runUpdateModeSetup - accepting every default pins a fresh host to the latest release                          | FAILED |
| M7 | early return forced on (`if (true \|\| ...)`)     | `worker/deno/setup/update_mode_setup.ts:660` | runUpdateModeSetup - a non-interactive fresh config pins to the latest release without prompting              | FAILED |
| M4 | `--config-existed=true` returns false             | `worker/deno/setup/setup_cli.ts:449`         | parseConfigExistedFlag - --config-existed=true and =false parse to booleans                                   | FAILED |
| M8 | `--config-existed=false` returns true             | `worker/deno/setup/setup_cli.ts:450`         | parseConfigExistedFlag - --config-existed=true and =false parse to booleans                                   | FAILED |
| M9 | fall-through returns false instead of undefined   | `worker/deno/setup/setup_cli.ts:451`         | parseConfigExistedFlag - an absent flag or any other value is undefined                                       | FAILED |
| M5 | refusal guard disabled                            | `worker/deno/setup/setup_cli.ts:468`         | update-mode refusal - no --config-existed flag exits non-zero and leaves .config.json untouched (Issue #4119) | FAILED |

Call-site: `setup.sh:1542` and `setup.ps1:1685` are the only callers that pass
`--config-existed`. `setup_cli.ts:463` (`runUpdateMode`) consumes the parsed
value and refuses when it is undefined.

Not checked: the `existing.value.update_mode !== undefined` operand of
`worker/deno/setup/update_mode_setup.ts:660` has no test that reaches it.
Mutation M3 (drop that operand) left every runUpdateModeSetup test green, 30
passed and 0 failed. This outcome is therefore left out of the branch outcomes
and is open work. It needs a test with `configExisted` false, interactive false,
and `update_mode` set.

**Docs sweep** — grep: `--config-existed`, "dynamic or frozen"; section:
`docs/SETUP.md#update-mode-dynamic-or-frozen`; siblings: none — no existing set
gained a member; left alone: `docs/DEPLOYMENT.md:196`,
`docs/RELEASE-TAGGING.md:157` — still true, both link the unchanged SETUP.md
anchor

Quality gate: ./quality.sh — result pending

<!-- vibe-branch-outcomes -->
