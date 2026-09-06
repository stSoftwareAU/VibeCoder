# 🔎 Security sweep — subprocess and argv construction in `worker/deno/lib/`

**Issue:** [#1214](https://github.com/stSoftwareAU/VibeCoder/issues/1214) (chunk
12a) · **Parent:** #1209 `security-scan-overflow: 4 chunks not reached`

This record exists so a later run can tell a **swept** path from an unswept one.
The parent scan swept the highest-exposure trust boundaries to full depth and
then ran out of budget; `worker/deno/lib/` had received only the repo-wide grep
sweeps of item 11. This slice took the highest-risk part of that remainder —
every module that spawns a subprocess — and reviewed each **per file,
semantically**: the call site read, and the provenance of every argv element
traced to a constant, a validated value, or a documented trusted source.

## Scope and method

The file list was generated with the command the issue specifies:

```bash
cd worker/deno && grep -rl "Deno.Command" lib/
```

54 files, all reviewed. Each spawn site was assessed against seven questions:
argv built by concatenation from attacker-writable GitHub data; argument
injection via a leading `-`; chokepoint bypass; shell interpretation; binary
resolution; child environment; and missing timeouts.

Triage followed the Phase 3 discipline of `docs/SECURITY-SCAN.md`:
refute-unless-proven, then severity recalibrated by exposure band. A candidate
that could not be traced from a named attacker-controlled input to the argv or
environment was dropped rather than filed.

> **Note on re-generating the list.** The command above returns a _different_ 54
> after this sweep: five files no longer construct a `Deno.Command` at all (they
> route through `runGitCommand` now), and three new modules were added by the
> fix. The list below is the set **as swept**, which is what a coverage record
> has to name.

## Findings fixed in this sweep

### SEC-1214-01 — `git` spawned outside the timeout/audit chokepoint (7 sites)

`severity:medium` · `confidence:high` · **fixed**

`runGitCommand` (`worker/deno/lib/git_timeout.ts`) owns the `AbortController`
timeout, the audit journal for git mutations (Issue #2380) and the work-volume
fault detector (Issue #229). Seven modules spawned `git` directly and skipped
all three:

| Site (pre-fix)                        | Command                             | Why it mattered                                                                                                                                                         |
| ------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/stale_workdir.ts:381`            | `git push origin <branch>:<branch>` | **The sharp one.** A remote mutation, untimed and unjournalled — a stalled remote hangs the worker's start-up rescue outright, and the push never reaches the audit log |
| `lib/codebase_map.ts:147`             | `git ls-files -co …`                | untimed                                                                                                                                                                 |
| `lib/prompt_manager.ts:470`           | `git rev-parse --short HEAD`        | untimed                                                                                                                                                                 |
| `lib/security_sarif_upload.ts:61`     | generic `git -C <cwd> …` runner     | untimed                                                                                                                                                                 |
| `lib/semgrep_check.ts:201`            | generic `git -C <dir> …` runner     | untimed                                                                                                                                                                 |
| `lib/bash_script_refs_scanner.ts:560` | `git ls-files -z`                   | untimed                                                                                                                                                                 |
| `commands/pr_manager.ts:205`          | caller-supplied argv                | untimed                                                                                                                                                                 |

All seven now route through `runGitCommand`. Because this is a **class** — the
same mistake available at every new call site — it is held fixed by an
architectural invariant in the quality gate, `git_spawn_chokepoint_check.ts`,
exactly as `gh_spawn_chokepoint_check.ts` (Issue #3703) does for `gh`. The two
now share one scanner, `spawn_chokepoint_scan.ts`.

### SEC-1214-02 — repository-supplied code inherited the worker's credentials (3 sites)

`severity:high` · `confidence:high` · **fixed**

`untrusted_command_env.ts` (Issue #572) exists because the worker executes code
it did not write, and an inherited environment hands that code every credential
the run holds — `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`, any cloud credentials the
fleet mints. The control was wired into the quality-gate spawn only. Three
sibling spawns of **repository-supplied** code inherited the whole worker
environment:

| Site (pre-fix)                      | What it runs                                                                            | Who writes it                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `lib/phases/bump_deps_phase.ts:112` | `bash <repo>/bump-deps.sh`, env built from `Deno.env.toObject()`                        | the target repository                                                                            |
| `lib/pre_flight_gate.ts:163`        | the configured pre-flight commands, `env` undefined and no `clearEnv`                   | `docs/CONFIGURATION.md` states plainly: "The scripts themselves are supplied by the target repo" |
| `lib/dependency_lock_regen.ts:318`  | `npm install` / `deno install` / `cargo update` / `go mod tidy` and their install hooks | the repository's own manifest, over a tree that includes a merged PR branch                      |

`echo $CLAUDE_CODE_OAUTH_TOKEN` in any of them was the whole exploit — no
compromise of the model required. All three now call
`buildUntrustedCommandEnv()` with `clearEnv: true`, so the child sees only
allowlisted names.

## Findings filed, not fixed here

Recorded as their own `security` issues per `docs/SECURITY-SCAN.md`; each is a
distinct root cause from the two above and from each other.

- **SEC-1214-03**
  ([#1226](https://github.com/stSoftwareAU/VibeCoder/issues/1226)) — tooling
  that _processes_ untrusted content, rather than being it, still inherits the
  worker's environment: `lib/markdownlint_check.ts:145` and
  `lib/pages_liquid_check.ts:205,231` spawn the worker's own toolchain
  (`node_modules/.bin/markdownlint-cli2`, `bundle exec ruby`), and
  `lib/security_tree_sweep.ts:1606` spawns `semgrep`/`git ls-files` over the
  repository being swept. Same shape as SEC-1214-02, different trust source —
  the worker's own supply chain and its scanner binaries, not
  repository-supplied code — so it needs a compromised local dependency rather
  than a pull request. `severity:medium` · `confidence:medium`
- **SEC-1214-04**
  ([#1227](https://github.com/stSoftwareAU/VibeCoder/issues/1227)) — a
  **variable** binary name evades the `gh` chokepoint and the static gate that
  enforces it. `lib/language_detector.ts:87` and `lib/workflow_auditor.ts:94`
  both do `new Deno.Command(cmd[0]!, …)` and are passed `["gh", "api", …]` in
  production; because the binary is not the string literal `"gh"`,
  `gh_spawn_chokepoint_check.ts` cannot see them. Both call sites are read-only
  GETs today, so the impact is the invariant gap rather than a live
  unallowlisted write. `severity:medium` · `confidence:high`
- **SEC-1214-05**
  ([#1228](https://github.com/stSoftwareAU/VibeCoder/issues/1228)) — spawns over
  attacker-influenced content with no timeout on any layer of the call chain:
  `lib/coverage_gap_scanner.ts:211` (`deno doc --json` over the cloned,
  PR-merged repository), `lib/security_tree_sweep.ts:1602` (`semgrep` over the
  swept tree) and `lib/workflow_auditor.ts:94` (`gh api` over the network).
  Reported as a missing bound rather than a proven hang. `severity:medium` ·
  `confidence:high`
- **SEC-1214-06**
  ([#1229](https://github.com/stSoftwareAU/VibeCoder/issues/1229)) —
  `lib/gh_spawn.ts`'s `signal` is opt-in, and the dominant path
  (`runGhCommandRaw` → `runGhOrThrow(args)`) supplies none, so most `gh`
  invocations have no timeout at the chokepoint layer. `severity:medium` ·
  `confidence:medium`

## The other binaries — `deno`, `docker`/`podman`, and the shell

The issue asks for the chokepoint reasoning `gh` already has to be applied to
the other binaries. `git` earned a gate because it has a chokepoint whose
controls were being skipped. The others were reasoned about and did **not**:

- **`docker`/`podman`** — already guarded where it matters.
  `container_runtime.ts` picks the executable from a static table,
  `quality_gate_phase.ts` validates the image ref with `isSafeDockerImageRef()`
  (which rejects a leading `-`) and `buildDockerRunArgs` inserts `--` before it,
  and `container_watchdog.ts` validates every container name against a strict
  pattern. A gate would enforce a chokepoint that does not exist and is not
  needed.
- **`deno`** — every spawn resolves the binary through `detectTool("deno")` or a
  worker-owned path and passes fixed subcommands; no argv element comes from
  GitHub data. The one gap is a missing timeout on `coverage_gap_scanner.ts`,
  filed as SEC-1214-05 rather than turned into a gate.
- **shell spawns** — the three `sh -c`/`bash -c` sites all take fleet-operator
  configuration or a worker-internal path (`repo_credentials.ts`,
  `repo_config.ts`, `quality_gate.ts`), and the fourth runs the repo's own
  `quality.sh` by design. What they needed was not a chokepoint but the built
  environment, which is SEC-1214-02.

### Residual risk in the new gate

`git_spawn_chokepoint_check.ts` matches a **literal** binary name, so it
inherits the limitation SEC-1214-04
([#1227](https://github.com/stSoftwareAU/VibeCoder/issues/1227)) records for its
`gh` sibling: a spawn written as `new Deno.Command(cmd[0], …)` with `"git"`
supplied by the caller is invisible to it. That is stated here rather than left
implicit — the gate closes the class as written today, not every spelling of it.

**Closed by #1227.** Both checks now also flag a **variable** binary in any
module that names the guarded binary at the head of an argv literal and does
not import the chokepoint. Running the extended scan over `worker/deno/lib` and
`worker/deno/commands` surfaced five `gh` evasions (`language_detector.ts`,
`workflow_auditor.ts`, `repo_visibility.ts`, `recent_activity.ts`,
`software_updates.ts`) and three `git` ones (`benchmark.ts`,
`dependency_lock_regen.ts`, `security_tree_sweep.ts`) — more than the two this
sweep named — and all eight now delegate to their chokepoint. The remaining
residual risk is stated in `git_spawn_chokepoint_check.ts`: the variable-binary
half is module-level, so a module that imports the chokepoint for one path is
exempt on every other, and the two documented false positives
(`secrets_history_scan.ts`, `claude_runner.ts`, which name `git` as tool data
rather than as a binary) are allowlisted outright.

## Refuted / no finding

Named here so a later sweep does not re-litigate them.

- **PID and process arguments** (`pid_guard.ts`, `orphan_collector.ts`,
  `file_lock.ts`, `claude_tail_cleanup.ts`, `memory_pressure.ts`,
  `kill_diagnostics.ts`) — argv is `String(pid)` over a validated integer, or a
  fixed literal. No string-injection surface.
- **`repo_credentials.ts:128` (`/bin/sh -c <mint>`)** and **`repo_config.ts:226`
  (`bash -c <preSetupCommand>`)** — both commands are fleet-operator
  configuration, documented as never reachable from anything a pull request can
  influence. Trusted by design.
- **`quality_gate.ts:683` (`bash -c <script>`)** — the interpolated values are
  worker-internal paths, and each is passed through `posixSingleQuote()` before
  reaching the script.
- **`quality_gate_phase.ts`** — the reference implementation for both classes
  above: `isSafeDockerImageRef()` rejects a leading `-`, `buildDockerRunArgs`
  inserts `--` before the image ref, and the native path already used
  `buildUntrustedCommandEnv` + `clearEnv: true`.
- **`container_watchdog.ts`** — `assertContainerName` validates against
  `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/` before the name reaches argv, which
  rejects a leading `-`.
- **`recent_activity.ts`, `repo_visibility.ts`,
  `purge_stale_workflow_issues.ts`** — repo slugs and user names always sit in
  the _value_ position of an explicit flag (`--repo`, `--author`) or inside a
  composed path (`repos/<slug>`), so a leading `-` cannot be parsed as an
  option. PR titles and commit subjects reach prompt text, never argv.
- **`secrets_history_scan.ts`** — `gitleaks`/`trufflehog` argv is worker-owned
  paths and fixed flags only.
- **`benchmark.ts:83`** — the runner is generic, but every call site passes
  fixed literals (`deno check`, `git init/add/commit` against a fixture
  directory the benchmark itself creates). It inherits the environment and has
  no timeout, but it is an operator-invoked diagnostic with no
  untrusted-repository interaction in its call graph.
- **`container_runtime.ts:591`** — the binary is `candidate.executable` from the
  static `CONTAINER_RUNTIMES` table (the docker/podman/apple-container probes),
  not attacker input, and the probe is bounded by a 15s `AbortController`. This
  is the `docker`/`podman` half of the chokepoint question below.
- **`quality_helpers.ts:200`** — `which <toolName>`, where `toolName` is the
  literal `"deno"` supplied by `quality_gate.ts`.
- **`software_updates.ts:368`** — `version` is validated against
  `PINNED_VERSION_PATTERN` before it can reach the argv builder, which blocks a
  leading `-`; the timeout is a required parameter; and the installs target
  first-party tooling with `--ignore-scripts`.
- **`subprocess_timeout.ts`, `tabletop_container_runner.ts`,
  `worker_identity.ts`, `worker_log_gzip.ts`, `session_resume.ts`,
  `write_repo_allowlist.ts`** — either not spawn sites, or argv is
  caller-supplied/fixed with the timeout already enforced.
- **`claude_runner.ts`** — the agent spawn already uses `clearEnv: true` with
  `provider.buildChildEnv(...)`; for Claude and DeepSeek the prompt travels by
  stdin and never touches argv.
- **`agent_env.ts`, `claude_env.ts`, `deepseek_env.ts`,
  `untrusted_command_env.ts`, `git_branch_args.ts`, `git_conflict_args.ts`,
  `git_ref_argv_check.ts`, `interactive_login_scanner.ts`,
  `integration_test_manifest.ts`, `runner_deprecation_scanner.ts`** — controls
  and pure builders, not spawn sites.

## Swept paths

The 54 files reviewed, as listed by the command above at the time of the sweep:

- `worker/deno/lib/agent_env.ts`
- `worker/deno/lib/bash_script_refs_scanner.ts`
- `worker/deno/lib/benchmark.ts`
- `worker/deno/lib/claude_env.ts`
- `worker/deno/lib/claude_runner.ts`
- `worker/deno/lib/claude_tail_cleanup.ts`
- `worker/deno/lib/codebase_map.ts`
- `worker/deno/lib/container_runtime.ts`
- `worker/deno/lib/container_watchdog.ts`
- `worker/deno/lib/coverage_gap_scanner.ts`
- `worker/deno/lib/deepseek_env.ts`
- `worker/deno/lib/dependency_lock_regen.ts`
- `worker/deno/lib/file_lock.ts`
- `worker/deno/lib/gh_spawn.ts`
- `worker/deno/lib/gh_spawn_chokepoint_check.ts`
- `worker/deno/lib/git_branch_args.ts`
- `worker/deno/lib/git_conflict_args.ts`
- `worker/deno/lib/git_ref_argv_check.ts`
- `worker/deno/lib/git_timeout.ts`
- `worker/deno/lib/integration_test_manifest.ts`
- `worker/deno/lib/interactive_login_scanner.ts`
- `worker/deno/lib/kill_diagnostics.ts`
- `worker/deno/lib/language_detector.ts`
- `worker/deno/lib/markdownlint_check.ts`
- `worker/deno/lib/memory_pressure.ts`
- `worker/deno/lib/orphan_collector.ts`
- `worker/deno/lib/pages_liquid_check.ts`
- `worker/deno/lib/phases/bump_deps_phase.ts`
- `worker/deno/lib/pid_guard.ts`
- `worker/deno/lib/pre_flight_gate.ts`
- `worker/deno/lib/prompt_manager.ts`
- `worker/deno/lib/purge_stale_workflow_issues.ts`
- `worker/deno/lib/quality_gate.ts`
- `worker/deno/lib/quality_gate_phase.ts`
- `worker/deno/lib/quality_helpers.ts`
- `worker/deno/lib/recent_activity.ts`
- `worker/deno/lib/repo_config.ts`
- `worker/deno/lib/repo_credentials.ts`
- `worker/deno/lib/repo_visibility.ts`
- `worker/deno/lib/runner_deprecation_scanner.ts`
- `worker/deno/lib/secrets_history_scan.ts`
- `worker/deno/lib/security_sarif_upload.ts`
- `worker/deno/lib/security_tree_sweep.ts`
- `worker/deno/lib/semgrep_check.ts`
- `worker/deno/lib/session_resume.ts`
- `worker/deno/lib/software_updates.ts`
- `worker/deno/lib/stale_workdir.ts`
- `worker/deno/lib/subprocess_timeout.ts`
- `worker/deno/lib/tabletop_container_runner.ts`
- `worker/deno/lib/untrusted_command_env.ts`
- `worker/deno/lib/worker_identity.ts`
- `worker/deno/lib/worker_log_gzip.ts`
- `worker/deno/lib/workflow_auditor.ts`
- `worker/deno/lib/write_repo_allowlist.ts`
