# 🔎 Security sweep — the top-level shell entry points

**Issue:** [#1221](https://github.com/stSoftwareAU/VibeCoder/issues/1221) (chunk
15) · **Parent:** #1209 `security-scan-overflow: 4 chunks not reached`

This record exists so a later run can tell a **swept** path from an unswept one.
The parent scan spot-checked these three files for `curl | sh`, `eval` and
unquoted destructive-`rm` patterns (no hits) and did not read them. This slice
read all three end to end.

Siblings:
[`security-sweep-1214-subprocess-argv.md`](security-sweep-1214-subprocess-argv.md)
(chunk 12a),
[`filesystem-path-temp-sweep-1215.md`](filesystem-path-temp-sweep-1215.md)
(chunk 12b),
[`security-sweep-1216-untrusted-github-ingestion.md`](security-sweep-1216-untrusted-github-ingestion.md)
(chunk 12c),
[`security-sweep-1217-env-config-secrets.md`](security-sweep-1217-env-config-secrets.md)
(chunk 12d),
[`security-sweep-1218-commands-cli.md`](security-sweep-1218-commands-cli.md)
(chunk 13) and
[`security-sweep-1220-setup-cli.md`](security-sweep-1220-setup-cli.md)
(chunk 14).

> **This is not an empty result.** The issue asks that an empty result be stated
> explicitly; it was not empty. **Five** root causes survived triage: one is
> fixed in this change and four are filed as `security` issues. Several
> categories the issue named *were* empty, and each is stated as such below —
> an empty category is a result, not an omission.

## The line-count correction

The parent issue describes these files as "tens of thousands of lines
combined". They are not, and the correction is recorded on that issue so the
next scan does not re-defer the chunk on the same estimate:

| File | Lines (as read) |
| ---- | --------------- |
| `run.sh` | 1,636 |
| `setup.sh` | 1,412 |
| `loop.sh` | 475 |
| **Total** | **3,523** |

Counted at the commit this sweep read — the base of this change, before the 24
lines it adds to `loop.sh`. That is a single-session exhaustive read, roughly an
order of magnitude smaller than the estimate the chunk was deferred on.

## Scope and method

`run.sh`, `setup.sh` and `loop.sh` at the repository root, read end to end at the
commit this record lands on. Nothing they `source` — they source nothing — and
nothing under `worker/deno/`, which the sibling chunks above cover.

Two passes:

1. **`shellcheck` first**, so the read was not spent on findings a linter already
   has (below).
2. **A semantic read** against the categories the issue names, tracing each
   interpolated value to a constant, a validated value, or a named untrusted
   source.

## `shellcheck` triage — and what it did *not* find

At the level CI enforces, all three files are clean:

```console
$ shellcheck -e SC1091 -e SC2034 run.sh setup.sh loop.sh
$ echo $?
0
```

**That gate already exists and already covers these files.** The issue's
Failure-Detection section asks whether `shellcheck` is enforced on them in the
quality gate; it is, in `.github/workflows/validate-scripts.yml` — a pinned,
SHA-256-verified `shellcheck` 0.11.0 binary run over
`find . -name "*.sh" -type f`, on a `validate` job that is a required status
check for `Develop`, `main` and `milestone/*`. No new gate was needed, and none
was added. (The Deno-side `quality.ts` deliberately does *not* re-run
`shellcheck` — see `worker/deno/lib/quality_gate.ts:1438-1443`, Issue #3129:
shell linting is owned by each repo's own CI, so hosts without the binary do not
fail every `.sh`-containing repo.)

Turning on every optional check surfaces style noise and nothing else:

| Check | run.sh | setup.sh | loop.sh | Triage |
| ----- | ------ | -------- | ------- | ------ |
| SC2250 (braces around every variable) | 0 | 205 | 0 | Style. `setup.sh` uses the bare `$var` form throughout; `run.sh` and `loop.sh` use `${var}`. Not a defect in either dialect. |
| SC2310 (function in a condition disables `set -e`) | 29 | 19 | 0 | Deliberate in every instance: these are the `if ! helper; then <report>` shapes the launcher uses to turn a helper failure into a message rather than an abort. Each was read; none swallows a status it needed. |
| SC2312 (masked return value in a substitution) | 1 | 3 | 0 | All four feed a value that is then validated or defaulted (`claim_floor_detail`, the credential-table reads). |
| SC2249 (no default `case` arm) | 0 | 2 | 0 | Both are option parsers where an unmatched argument is legitimately ignored. |

### Cross-reference: the bash-syntax audit (template #12)

The issue asks that this review add semantic coverage rather than repeat a scan
that already runs. It does not repeat it. `docs/BASH-SYNTAX-AUDIT-SCAN.md` and
`worker/deno/lib/idle_task_templates/bash_syntax_audit_template.ts` describe a
weekly idle task that answers a **presence** question — does each monitored
repository commit its own `bash -n` + `shellcheck` CI gate — and files an issue
in a repo that lacks one. It never reads a script. For this repository the
answer is already yes (the `validate` job above), so that audit has nothing to
say about these three files and never would.

**No finding in this record came from `shellcheck`.** All five came from the
read. That is the point of the chunk: the defects below are semantic — a bound
that resolves to a missing binary, a truncation window, a file mode, a quoting
contract between a writer and a reader — and none of them has a lint signature.

## Findings

| # | Where | Class | Severity | Status |
| - | ----- | ----- | -------- | ------ |
| 1 | `loop.sh` control-plane probe | a guard that cannot run | medium | **Fixed here** |
| 2 | `setup.sh:1120` | non-atomic write of a credential-bearing file (CWE-755) | medium | [#1298](https://github.com/stSoftwareAU/VibeCoder/issues/1298) |
| 3 | `run.sh:1536` | incorrect permission on a critical resource (CWE-732) | low | [#1299](https://github.com/stSoftwareAU/VibeCoder/issues/1299) |
| 4 | `setup.sh:811-833` | incomplete cleanup of a secret temp file (CWE-459) | low | [#1300](https://github.com/stSoftwareAU/VibeCoder/issues/1300) |
| 5 | `setup.sh:351`, `:784` | code injection via an unquoted assignment (CWE-94) | low | [#1301](https://github.com/stSoftwareAU/VibeCoder/issues/1301) |

### 1 — the Issue #323 control-plane probe was inert on the platform it was written for (fixed here)

`loop.sh` resolves `gtimeout`/`timeout` once at startup and uses it
for the recorder and the supervisor deadline — but the control-plane probe and
its recovery spelled the bound literally:

```bash
timeout 30 container ls   …   timeout 30 container exec   …   timeout 30 container kill
```

macOS ships neither binary. `setup.sh:33-34` says so explicitly: `timeout` is
**container-owned**, "reported for information only, never required on the
host". And Apple `container` — the runtime this probe exists for, the one whose
`vminitd` stopped answering on 2026-08-22 — is macOS-only. So on a stock fleet
host every one of those calls was a `command not found` whose stderr went to
`/dev/null`:

- `running_vibe_container` produced no output, so the probe concluded there was
  no container to probe;
- `failures` reset to `0` on every cycle, so `VIBE_PROBE_FAILURES` was never
  reached;
- the recovery in `force_stop_container` could not fire, and if it had been
  reached its own `container kill` and its verification `container ls` would
  have failed the same way.

The whole of Issue #323 was therefore a no-op on the hosts it was written for,
and silently — the exact "absence of a failure marker is not success" shape the
coding standards name.

**Fix.** All four calls go through a `bounded <seconds> <command>` helper
matching the one `run.sh:196-204` already carries: bounded where the host has a
timeout, unbounded where it has not, never silently not run at all.

**Regression test.**
`worker/deno/tests/loop_supervisor_test.ts::loop.sh #1221 - the control-plane probe recovers a wedged container on a host with no timeout binary`
builds a `PATH` holding only the tools `loop.sh` needs — and neither `timeout`
nor `gtimeout`, which is what a stock macOS host looks like — runs the real
`loop.sh` against a `container` stub whose `exec` always fails, and asserts the
stub recorded `kill vibe-coder-999`. Against the unfixed script the stub records
nothing at all.

It has to spawn the real `loop.sh`, so it lives in `loop_supervisor_test.ts` —
listed in `worker/deno/lib/integration_test_manifest.ts:64` and therefore run by
the `integration tests (not a required check)` job, alongside every other
launcher test. That is the existing classification for this whole surface, not a
choice made here; the merge-gating counterpart is `shellcheck` in `validate`,
which this change keeps clean.

## Categories the issue named that came back empty

Each of these was looked for and not found. Stated explicitly, because an
unstated empty category is indistinguishable from one that was skipped.

- **Word splitting and globbing — empty.** Every path, repo slug, branch name,
  container name, image reference and volume name is quoted at every expansion
  in all three files. The two unquoted array expansions in `run.sh`
  (`ensure_dirs`, `volume_names` at `:752`, `:1128`, `:1181`) use the bash-3.2
  empty-array idiom `${arr[@]+"${arr[@]}"}`, whose alternate value is itself
  quoted, so elements with spaces survive intact. `setup.sh:336`
  (`for candidate in ${var_list//,/ }`) is the one deliberate split, over a
  comma-separated list that is a literal heredoc inside the script
  (`vibe_provider_credential_table`) and can contain neither a space nor a glob.
- **`set -euo pipefail` — present, early, and relaxed only where documented.**
  `run.sh:2` and `setup.sh:2` carry the full triple on line 2. `loop.sh:5` is
  deliberately `set -uo pipefail`: a supervisor that must never exit cannot take
  `-e`, and the header says so and cites Issue #1836. `-u` is on in all three, so
  the unset-variable→empty-string→`rm -rf /` path does not exist. The three
  `set +e` windows in `run.sh` (`run_build`, `heal_builder`, `wait_for_child`)
  each re-enable it on the next line and read `PIPESTATUS[0]`, not `$?`, so no
  status is lost to a `tee`.
- **`trap` cleanup handlers — no unset interpolation.** `run.sh`'s `on_exit`
  removes only variables initialised to `""` at `:132-156`, and every removal is
  guarded by `[[ -n … ]]`, so the trap firing before a path is known removes
  nothing. It also returns immediately when `BASH_SUBSHELL != 0` (`:300-302`), so
  a background job cannot record a second launcher outcome or delete the evidence
  the launcher is about to quote. The ordering — record the outcome, *then*
  remove the logs it quotes — is correct and commented. `loop.sh`'s traps are
  no-op signal handlers with no cleanup at all.
- **Destructive `rm` — no unguarded recursive removal.** The only `rm -rf` in the
  three files is `setup.sh:1173`, and its caller refuses an empty path, `/` and
  `$HOME` outright (`:1167-1172`) before removing a fixed `.vibe-cache` child.
  `run.sh`'s volume recreation is destructive but gated on a measured free-disk
  floor, a minimum volume size, and a once-per-24h state file, and reports
  `[WORK_VOLUME_UNRECOVERED]` rather than claiming a fix it did not achieve.
- **Secrets on command lines — empty.** No token, key or credential is passed as
  argv anywhere in the three files. `setup.sh` hands `gh` its token through the
  child environment (`GH_TOKEN="$gh_token" gh api user`, `:420`;
  `GH_CONFIG_DIR="$expanded_source" gh auth token`, `:502`), never as a flag.
  The credential files it writes are created under `umask 077` inside a
  subshell and `chmod 600`-ed, in a directory `chmod 700`-ed first
  (`:347-353`, `:429-443`). Nothing is echoed: the paste prompt uses
  `read -rs`. `run.sh` handles no secret at all — the launch plan is written to
  a `mktemp` file precisely so credential-shaped mount values never cross
  stdout (`:660-665`).
- **`eval` — empty. Dynamic dispatch — present, and closed.** There is no `eval`,
  no `. "$file"` over a computed path, and no dynamic `source` of anything
  outside the credential directory in any of the three files. The indirect forms
  the parent run's literal `eval` grep would have missed do exist, all in
  `setup.sh`: `${!provision_var}` / `${!candidate}` (`:332-341`),
  `printf -v "$prompt_var"` (`:729`, `:734`) and `unset "$prompt_var"` (`:736`).
  Every one of those names comes from `vibe_provider_credential_table`, a
  quoted heredoc literal in the script, or from `provider_prompt_credential_var`,
  a `case` over a closed set — never from argv, the environment, a config file or
  GitHub. The one `source` (`:784`, over `provider.env`) is finding 5 above: the
  path is safe, the *contents* are evaluated when they should be parsed.
- **Container invocation — nothing constructed here, and #512–#516 hold.**
  `run.sh` builds no mount, flag or network argument of its own. It reads a
  NUL-delimited plan into named arrays (`:702-729`), rejects an unrecognised key
  outright, refuses an incomplete plan (`:731-739`), refuses a plan with no
  usable watchdog deadline (`:744-748`), and then replays the arrays verbatim.
  The controls the issue asks about are enforced on the Deno side and are still
  in force: `FORBIDDEN_RUN_FLAGS` in `worker/deno/lib/container_launch.ts:487`
  bars `--privileged` and `--network=host`; `--read-only` is required and refused
  without its scratch tmpfs (`:774-789`, Issue #516); `/workspace` is mounted
  read-only (`:26`, Issue #514). `run_sh_launcher_test.ts` asserts the
  constructed invocation carries no runtime socket, no `--privileged`, no host
  networking and no published ports, so a future edit that broadens them fails
  that test. It is *not* a required check: the file is listed in
  `worker/deno/lib/integration_test_manifest.ts:66`, so it runs in the
  `integration tests (not a required check)` job
  (`.github/workflows/validate-scripts.yml:504-505`) rather than in `validate`.
  The containment assertions are covered, but a red result there does not block
  a merge on its own.
- **`"$@"` pass-through is not a flag-injection sink.** `run.sh:1547` appends the
  launcher's own argv to the runtime invocation, but it lands *after* the plan's
  image and command, so extra arguments become the container's command
  arguments — they cannot become runtime flags. `upgrade` (`:233`) is matched
  before the EXIT trap is installed and takes no operand.
- **Exit-code propagation — no swallowed guard.** Every pipeline whose left-hand
  side matters reads `PIPESTATUS[0]`: `run_build` (`:880`), the extension build
  (`:995`), `heal_builder` (`:902`) and `loop.sh:464`. The comment at
  `loop.sh:458-462` is the reason a `|| true` is *absent* there — appending one
  would replace `PIPESTATUS` with `true`'s own 0 and report every crash as a
  clean run. `bounded_timed_out` (`run.sh:218-221`) distinguishes a command the
  bound killed from one that ran and failed, and only claims the distinction
  where a bound was actually applied.
- **Signal handling and the run loop — no unbacked-off spin, no skipped guard.**
  `loop.sh` sleeps between every iteration; the interval comes from the worker's
  `container-restart-backoff`, which grows across consecutive failures, and falls
  back **loudly** to `LOOP_SLEEP_SECONDS` when the recorder cannot run or does not
  answer with a plain integer (`loop.sh:167-199`). A quota pause and an
  already-running-worker exit are distinguished from a crash so neither climbs
  the escalation ladder. The supervisor's own deadline is a `timeout` with
  `--kill-after`, and disabling it (`VIBE_RUN_MAX_SECONDS=0`) is carried through
  as "disabled" and never as "cap at zero". `run.sh`'s signal path holds a signal
  that arrives in the window between forking the child and learning its PID and
  delivers it once the PID is known (`:354-395`), rather than dropping it.

## Observations that are not findings

- **`loop.sh:155` resolves the log directory with a bare `${HOME}`** where the
  rest of the file uses `${HOME:-/tmp}`. Reached only when `LAUNCH_LOG_DIR` and
  `LOG_DIR` are both unset as well. Under `set -u` the unbound expansion kills
  the command-substitution subshell *before* the stderr message two lines below
  it, so that message is not what reports the fault; and because the directory
  is resolved once at startup, the effect is every cycle rather than one.
  It is still not silent — each cycle then fails to open its launch log and
  says so on stderr — and `run.sh` refuses to launch on the same unset variable,
  so it stays an observation rather than a finding.
- **`run.sh:1032` builds the container-store path from `${HOME:-}`**, which on an
  unset `HOME` would read `/Library/Application Support/com.apple.container`.
  Unreachable for the same reason.
- **`setup.sh:1094` reads the config with `config=$(cat "$CONFIG_FILE")`** before
  the merge. Command substitution strips trailing newlines, which is harmless for
  JSON, and `run_setup_cli config` has created the file by then.
