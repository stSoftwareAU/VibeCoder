# 🔎 Security sweep — the top-level shell entry points, delta since #1221

**Issue:** [#2181](https://github.com/stSoftwareAU/VibeCoder/issues/2181)
(chunk 3) · **Parent:** #2170 `security-scan-overflow: 2 chunks not reached`

**Base record:**
[`security-sweep-1221-shell-entry-points.md`](security-sweep-1221-shell-entry-points.md)
— the end-to-end read of `run.sh`, `setup.sh` and `loop.sh`. This record is a
**delta** on it, not a replacement: the base record keeps its own `git log -1`
date and is untouched here, and the categories, the reasoning and the
`shellcheck` triage below are all stated against it.

Per `docs/SECURITY-SCAN.md` — _"a recorded chunk with a non-zero count needs
only its changed modules re-swept"_ — the scope is the diff, not the files.

## Scope

|                 |                                                                                     |
| --------------- | ----------------------------------------------------------------------------------- |
| **Base commit** | `2370a7de55bc85893dff3b342d862ab714f7795b` (the commit the #1221 record landed on)  |
| **Head commit** | `f09445b4` on `milestone/2170-security-scan-overflow-2-chunks-not-reached`          |
| **Command**     | `git diff 2370a7de55bc85893dff3b342d862ab714f7795b HEAD -- run.sh setup.sh loop.sh` |
| **Size**        | +680 / −191 across 15 commits                                                       |

Every hunk below was read in full and each newly interpolated value followed
into its surrounding function until it reached a constant, a validated value or
a named untrusted source. The unchanged remainder of the three files was not
re-read — that is what the base record covers.

### Hunk ranges read, per file

**`loop.sh`** (+26 / −18), 6 hunks:

`@@ -32,10 +32,16 @@` · `@@ -60,9 +66,9 @@` · `@@ -74,7 +80,7 @@` ·
`@@ -126,14 +132,16 @@` · `@@ -148,18 +156,18 @@` · `@@ -447,7 +455,7 @@`

**`setup.sh`** (+227 / −22), 17 hunks:

`@@ -265,6 +265,26 @@` · `@@ -344,7 +364,21 @@` · `@@ -392,7 +426,7 @@` ·
`@@ -491,7 +525,7 @@` · `@@ -756,8 +790,46 @@` · `@@ -776,13 +848,20 @@` ·
`@@ -801,6 +880,30 @@` · `@@ -811,8 +914,18 @@` · `@@ -828,7 +941,8 @@` ·
`@@ -1049,11 +1163,12 @@` · `@@ -1077,7 +1192,9 @@` · `@@ -1093,10 +1210,6 @@` ·
`@@ -1117,7 +1230,31 @@` · `@@ -1209,6 +1346,24 @@` · `@@ -1245,13 +1400,41 @@`
· `@@ -1262,6 +1445,16 @@` · `@@ -1335,7 +1528,19 @@`

**`run.sh`** (+427 / −151), 21 hunks:

`@@ -243,7 +243,8 @@` · `@@ -251,11 +252,11 @@` · `@@ -413,14 +414,16 @@` ·
`@@ -582,10 +585,12 @@` · `@@ -687,6 +692,7 @@` · `@@ -712,6 +718,7 @@` ·
`@@ -733,6 +740,7 @@` · `@@ -766,6 +774,62 @@` · `@@ -778,6 +842,8 @@` ·
`@@ -871,6 +937,191 @@` · `@@ -909,6 +1160,7 @@` · `@@ -1029,7 +1281,6 @@` ·
`@@ -1131,48 +1382,6 @@` · `@@ -1250,83 +1459,6 @@` · `@@ -1347,20 +1479,11 @@`
· `@@ -1368,12 +1491,34 @@` · `@@ -1441,6 +1586,9 @@` · `@@ -1448,6 +1596,33 @@`
· `@@ -1533,7 +1708,14 @@` · `@@ -1554,12 +1736,16 @@` ·
`@@ -1606,6 +1792,96 @@`

Two of those `run.sh` hunks (`@@ -1131,48 +1382,6 @@`, `@@ -1250,83 +1459,6 @@`)
are pure deletions: `recreate_volume`, `disk_gate_path`, `HEAL_STATE_FILE`,
`host_disk_field_kb`, `claim_floor_kb`, `claim_floor_detail`, `volume_store_kb`
and `report_unrecovered` moved earlier in the file so the new pre-build reset
can share them. The moved bodies were read at their new home
(`@@ -871,6 +937,191 @@`) and diffed against the deleted text —
`heal_untrimmable_volumes`'s own bound is the only behavioural change, and it is
covered below.

## `shellcheck` triage

At the level CI enforces, all three files are still clean:

```console
$ shellcheck -e SC1091 -e SC2034 run.sh setup.sh loop.sh
$ echo $?
0
```

Same gate as the base record: a pinned, SHA-256-verified `shellcheck` 0.11.0
over `find . -name "*.sh"` in `.github/workflows/validate-scripts.yml`, on the
required `validate` job.

Turning on every optional check surfaces the same four codes the base record
triaged and **no new code at all** — the counts grew with the files, the
categories did not:

| Check  | run.sh (#1221 → now) | setup.sh  | loop.sh | Triage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | -------------------- | --------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC2250 | 0 → 0                | 205 → 228 | 0 → 0   | Style, unchanged: `setup.sh` keeps the bare `$var` dialect throughout, including every line added here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| SC2310 | 29 → 34              | 19 → 24   | 0 → 0   | Diffed note-for-note against the base commit, the ten new notes come from these call sites — `run.sh`: `if recreate_volume` and `kb="$(volume_store_kb …)"` in `reset_work_volumes_before_build`, the matching `kb="$(volume_store_kb …)"` in `heal_untrimmable_volumes`, plus `toolchain_rebuild_recorded` at `:1853` and `:1876`; `setup.sh`: `export_provider_env` at `:856` (two notes — shellcheck reports the `!` and the `if` separately) and `:864`, `run_setup_cli launchagent --status` at `:1408`, and `setup_token_transcript_prefix` inside the `mktemp` at `:917`. Every one is the `if ! helper; then <report>` or `x="$(helper)" \|\| x=""` shape the base record triaged; each was read, and none swallows a status it needed — the `volume_store_kb` pair is the exception only in that its _caller_ mishandles the empty result, which is finding 1. |
| SC2312 | 1 → 4                | 3 → 4     | 0 → 0   | The four new ones each feed a value that is then validated, defaulted, or purely cosmetic: `run.sh:824` (`$(date +%s)` inside the `host-disk.json` `printf`), `run.sh:1111` and `:1519` (`$(volume_too_small_detail …)` inside a log message), and `setup.sh:917` (`$(setup_token_transcript_prefix)`, a `printf` of `$$` that cannot fail). `run.sh:1584` (`claim_floor_detail`) is the base record's single pre-existing instance, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| SC2249 | 0 → 0                | 2 → 2     | 0 → 0   | Unchanged option parsers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**No finding in this record came from `shellcheck`.** As in the base record, the
survivor is semantic: a guard whose precondition is a measurement that is
allowed to fail.

## What the delta fixed

Four of the five root causes the base record found were fixed inside this
window. Each was re-read at its new form rather than taken on the issue's word:

| #1221 finding                                               | Issue                                                                 | Where fixed                                  | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2 — non-atomic write of a credential-bearing file (CWE-755) | [#1298](https://github.com/stSoftwareAU/VibeCoder/issues/1298) closed | `setup.sh:1233-1253`                         | `write_interactive_config` now writes to `mktemp "${CONFIG_FILE}.XXXXXX"` and `mv`s over the target; all three failure paths `rm -f` the temp, `print_error` and `exit 1`. The redirection that truncated the live config is gone.                                                                                                                                                                                                                                                                                       |
| 3 — incorrect permission on a critical resource (CWE-732)   | [#1299](https://github.com/stSoftwareAU/VibeCoder/issues/1299) closed | `run.sh:1718`                                | `mkfifo -m 600 "${RUN_ERR_FIFO}"` — the mode is set at creation, so the umask window a follow-up `chmod` would only narrow does not exist.                                                                                                                                                                                                                                                                                                                                                                               |
| 4 — incomplete cleanup of a secret temp file (CWE-459)      | [#1300](https://github.com/stSoftwareAU/VibeCoder/issues/1300) closed | `setup.sh:889-905`, `:925-928`, `:1453-1456` | The transcript is removed by a `RETURN` trap plus `INT`/`TERM`/`HUP` traps in `capture_setup_token`'s own subshell, and by `remove_setup_token_transcripts` on `EXIT`/`INT`/`TERM`/`HUP` in `main()`. The sweep globs `${TMPDIR:-/tmp}/vibe-setup-token.$$.*`, and `$$` stays the top-level PID inside the command substitution, so it cannot reach a concurrent run's transcript.                                                                                                                                       |
| 5 — code injection via an unquoted assignment (CWE-94)      | [#1301](https://github.com/stSoftwareAU/VibeCoder/issues/1301) closed | `setup.sh:793-826`, `:851-860`               | `source "$file"` is replaced by `export_provider_env`, which splits each line on the first `=`, validates the name against `^[A-Za-z_][A-Za-z0-9_]*$` and calls `export "${name}=${value}"` as a single argument — no re-parse, no command substitution. The write side refuses a value carrying `\n` or `\r` (`setup.sh:367-377`) _before_ creating the directory, so the one-line file format cannot be forged from a paste. A file the parser finds nothing in is condemned rather than read as an empty environment. |

Finding 1 (the `loop.sh` control-plane probe) was fixed in the #1221 change
itself and is untouched here.

Two further weaknesses were closed in passing and are recorded so a later sweep
does not re-derive them:

- **The repo list bypassed slug validation** (`setup.sh:1096-1099` at the base
  commit, deleted here). `write_interactive_config` used to `jq`-merge the raw
  `INTERACTIVE_REPOS` answer into `.config.json` _after_ the TypeScript writer
  had run, overwriting the validated, de-duplicated list with the operator's
  unvalidated one. The answer now goes in through `VIBE_REPOS`
  (`setup.sh:1535-1539`), so `worker/deno/lib/repo_slug.ts` validates every slug
  (Issue #1291) and the merge no longer touches the key.
- **`loop.sh` — the log directory is no longer environment-steerable.**
  `LAUNCH_LOG_DIR`/`LOG_DIR` used to move the launch-log path; the resolution is
  now `.config.json` alone through the worker's `log-dir` command (Issue #1388),
  and the local is renamed `LOOP_LOG_DIR` so no ambient variable of either old
  name is read. `prune_launch_logs` (`loop.sh:83-92`) globs the new variable
  quoted and `rm -f`s array elements, so the narrowing did not reopen a
  splitting path.

## Findings

| # | Where         | Class                                                                               | Severity | Status                                                                              |
| - | ------------- | ----------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| 1 | `run.sh:1518` | protection mechanism failure — a guard skipped when its measurement fails (CWE-693) | medium   | [#2216](https://github.com/stSoftwareAU/VibeCoder/issues/2216) — `SEC-3cc92c0a026b` |

### 1 — the content-approval tamper baseline is recreated when its size cannot be measured

Filed as [#2216](https://github.com/stSoftwareAU/VibeCoder/issues/2216), stable
id `SEC-3cc92c0a026b`, `severity:medium` / `confidence:high`, tagged `CWE-693`
so a later scan dedups against it rather than re-filing the same root cause.

`heal_untrimmable_volumes` applies the Issue #2117 minimum-size guard — the one
thing that stops the launcher wiping the content-approval store to reclaim disk
— only when `volume_store_kb` returns a number:

```bash
kb="$(volume_store_kb "${volume}" || true)"
if [[ "${kb}" =~ ^[0-9]+$ ]] && ((kb < reset_min_kb)); then
  log_run_core "$(volume_too_small_detail "${volume}" "${kb}" "${reset_min_kb}")"
  continue
fi
# falls through to recreate_volume "${volume}"
```

`volume_store_kb` (`run.sh:1055`) returns non-zero when
`${container_store}/volumes/<name>` does not exist, so an unmeasurable volume
leaves `kb` empty, the conjunct is false, and the volume is destroyed with the
size check never applied. The sibling path added in the **same** window,
`reset_work_volumes_before_build` (`run.sh:1108-1109`), fails **closed** on the
identical condition (`[[ "${kb}" =~ ^[0-9]+$ ]] || continue`). The two disagree
about what an unmeasurable volume means.

`vibe-approval-state` (`worker/deno/lib/container_launch.ts:133`) holds the
Issue #1341 work-on TOCTOU snapshots. Recreating it destroys the state file and
the Issue #4215 initialised-store marker together, so `readContentApprovalState`
(`worker/deno/lib/content_approval_tracker.ts:566-576`) finds an uninitialised
store and returns `{ ok: true, value: { snapshots: {} } }` — a genuine first
encounter. The next run re-baselines every tracked issue against whatever its
body says now, so content edited after approval verifies as unchanged. The
fail-closed machinery latches on a read _error_ or a state file missing from an
_initialised_ store; a recreated volume presents neither, and `host-disk.json`
carries no signal that a volume was recreated. The gate is disarmed silently.

**Reachability — confirmed by the repository's own tests, which encode both
outcomes.** `run_sh_launcher_test.ts:1791` creates no container-store
directories, so both volumes are unmeasurable, and asserts
`removedVolumes === [WORK_VOLUME_NAME, APPROVAL_STATE_VOLUME_NAME]`.
`run_sh_launcher_test.ts:1839` creates both store directories with sizes and
asserts the approval store is spared. Same refusal, same floor, opposite outcome
for the tamper baseline, and the only difference is whether `du` could see the
store. `run.sh:1283` records that Docker and Podman keep their stores elsewhere,
so `container_store` never exists on a non-Apple host and the guard is inert
there by construction; Issue #2077 removed the 24 h interval that used to bound
how often this path could fire.

**Not fixed here.** The remedy is to exclude the approval store by _role_ rather
than by size, which means the plan must mark which volumes may be reset for disk
— a change to `worker/deno/lib/container_launch.ts` and to the assertion at
`run_sh_launcher_test.ts:1791`, not a one-line edit. Making `run.sh:1518` fail
closed _is_ one line, but it also changes the work volume's behaviour on
unmeasurable stores, which is what Issue #478's heal exists to do. That trade is
a decision, so the finding is filed rather than guessed at.

**Severity.** Medium rather than high: the preconditions are host state, not
attacker input — the init must report the trim refused for that volume, the host
must be below its claiming floor, and the store must be unmeasurable. An agent
processing a malicious issue does control host disk consumption, which is the
one precondition that is not purely environmental.

## Refutations — candidates that did not survive triage

Each was raised from a hunk in this delta, re-read, and dropped. Recorded so a
later sweep does not spend the read again.

- **`export_provider_env` exports arbitrary variable names into the subshell
  that runs `claude` (`setup.sh:793-826`) — refuted.** A `provider.env` holding
  `PATH=…`, `LD_PRELOAD=…` or `ANTHROPIC_BASE_URL=…` would redirect the
  credential test. The file is created under `umask 077` and `chmod 600` inside
  a `chmod 700` directory beneath the operator's own `$HOME`, so writing it
  needs the operator's own privileges — the same privileges that could edit
  `setup.sh` itself. The paste vector is closed separately: the write side
  refuses a value carrying a newline, so one pasted credential cannot become a
  second `NAME=value` line. This is strictly narrower than the `source` it
  replaced, which executed the file.
- **`write_host_disk_reading` interpolates `${gate}` into JSON unescaped
  (`run.sh:823-825`) — refuted as a security finding, recorded as an
  observation.** `gate` is `${HOME}` or the Apple container store beneath it,
  never an untrusted source, and `parseHostDiskRefresh`
  (`worker/deno/lib/host_disk.ts:360`) ignores the `path` key entirely. A
  `$HOME` containing `"` or `\` would yield malformed JSON that reads as _no
  reading_, which is the pre-#1550 behaviour — a lost optimisation, not a
  crossed boundary. It is, however, the only unescaped interpolation into a
  document another component parses, and the loss is not logged.
- **The toolchain self-check failure line is container-controlled
  (`run.sh:1834-1844`) — refuted.** `failed_line` comes from the container's own
  stderr, and the container processes untrusted GitHub content. It is taken
  through `grep -F … | tail -n 1`, so it holds no newline and cannot inject a
  second log line; `read -r -a` splits on the default `IFS` and performs no
  globbing or evaluation; and `${failed_ids[*]}` reaches only `echo` and
  `log_run_core` strings, never a command position. Raw terminal escapes could
  still ride it to an operator's terminal — but the whole of that stderr already
  reaches the terminal verbatim through the `tee` at `run.sh:1719`, so this adds
  no exposure that predated it.
- **`warn_if_token_lacks_workflow_scope` captures `gh auth status 2>&1` and
  echoes it (`setup.sh:1355-1363`) — refuted.** `gh auth status` masks the token
  unless `--show-token` is passed, and the capture is narrowed to the
  `token scopes` line by `grep -i` before anything is printed, so no
  credential-bearing line survives to the console. `print_warning` uses
  `echo -e`, so a backslash escape in that line would be interpreted; the line
  is a comma-separated list of GitHub-issued scope names, and the `echo -e`
  dialect is the file's own throughout rather than anything introduced here.
- **`TOOLCHAIN_REBUILD_STATE` and `HEAL_STATE_FILE` are environment-steerable
  paths written with `printf > "$path"` (`run.sh:1866`, `:1118`) — refuted.**
  `VIBE_TOOLCHAIN_REBUILD_STATE` and `VIBE_WORK_VOLUME_HEAL_STATE` are the
  operator's own variables, in a process whose entire environment the operator
  already sets; both writes are `2>/dev/null || true` best-effort records, and
  both readers validate what they get (`== "${IMAGE}"`, `=~ ^[0-9]+$`).
- **`remove_setup_token_transcripts` globs into a shared `/tmp`
  (`setup.sh:901-905`) — refuted.** The prefix is quoted and only the trailing
  `*` expands, so a `TMPDIR` containing whitespace or a metacharacter cannot
  widen it; `rm -f` on a pre-positioned symlink removes the link, not its
  target; and `mktemp` is `O_EXCL`, so a squatted name is simply skipped.
- **`((${#trim_refused_volumes[@]})) && trim_refused=true` aborts the launcher
  under `set -e` when the array is empty (`run.sh:822`) — refuted by
  execution.**
  `bash -c 'set -euo pipefail; f() { local a=(); local x=false;
  ((${#a[@]})) && x=true; echo reached; }; f; echo after'`
  prints both lines: the failing command is not the last of an AND-OR list, so
  `set -e` is ignored and the list's own status does not re-trigger it.

## Categories the issue named that came back empty

Each was looked for across the delta and not found. Stated explicitly, because
an unstated empty category is indistinguishable from one that was skipped.

- **`eval` / unsafe substitution — empty, and one existing instance removed.**
  The delta adds no `eval`, no `. "$file"` over a computed path and no new
  indirect expansion. It _removes_ the only dynamic `source` in the three files
  (`setup.sh`'s `source "$file"` over `provider.env`, #1221 finding 5), so the
  count of dynamic-dispatch sites went down. The base record's surviving
  indirect forms — `${!provision_var}`, `printf -v "$prompt_var"`,
  `unset "$prompt_var"` — are outside the hunks and unchanged.
- **`curl | sh` — empty.** No new network fetch of any kind in the delta; the
  three files download nothing they did not already.
- **Destructive `rm` — no new unguarded recursive removal, but the _volume_
  reset was deliberately unbounded.** The only `rm -rf` in the three files
  (`setup.sh:1310`) is outside the delta and unchanged — the only other literal
  `rm -rf` in the three files, `setup.sh:1344`, sits inside a `print_info`
  string and is never executed. Every `rm` added here is a non-recursive `rm -f`
  over a path the same function created: the mktemp temporaries in
  `write_interactive_config`, the setup-token transcripts, the image-removal
  stderr capture, and `TOOLCHAIN_REBUILD_STATE`. Separately, Issue #2077 removed
  the once-per-24h state-file bound the base record cited as one of three gates
  on the _runtime volume_ recreation, and Issue #2092 added a second, pre-build
  path over **every** plan volume rather than only the trim-refused ones. That
  is a deliberate, documented availability trade — "the volume is disposable and
  the host is not" — and the two remaining gates (below the measured claiming
  floor, and above the reset minimum) still hold, with
  `[WORK_VOLUME_UNRECOVERED]` still reported rather than a claimed fix. The
  security consequence is not the frequency but the one volume that must never
  be caught by it, which is finding 1.
- **Temp files — the delta tightens them and adds no loose one.**
  `mkfifo -m 600` closes #1299; the config rewrite moves to `mktemp`
  (`O_EXCL`, 0600) plus `mv`; the setup-token transcript is `chmod 600` and
  trap-removed on every path. The one temporary added without an explicit mode
  is `image_remove_err="$(mktemp …/vibe-image-rm.XXXXXX)"` (`run.sh:1861`),
  which mktemp creates 0600 and which holds the runtime's stderr, no credential;
  it is `rm -f`'d on both branches. `recreate_volume`'s `err="$(mktemp)"`
  (`run.sh:963`) is likewise 0600 and removed on every return, though it is not
  registered with the `EXIT` trap — a SIGKILLed launcher leaks an empty-or-
  stderr-bearing file, exactly as the base record notes the plan file and wedge
  marker already do.
- **Env and secret handling — no secret reaches a command line, a log or
  stdout.** `export_provider_env` passes the credential through the child
  environment as a single `export` argument, never as argv. The credential
  directories are now owner-only _at creation_ (`make_credential_dir`,
  `setup.sh:281-286`) rather than narrowed by a following `chmod`, which closes
  the umask window on every parent `mkdir -p` creates. Nothing added here
  `echo`s a credential: the workflow-scope warning prints only the scope list,
  and the setup-token capture greps the transcript rather than displaying it.
  `run.sh` still handles no secret of its own.
- **Subprocess argv — every new invocation is a constant verb plus a validated
  or plan-supplied operand.** The one genuinely new runtime call is the image
  removal, `"${RUNTIME}" "${image_remove_args[@]}" "${IMAGE}"` (`run.sh:1862`),
  and it follows the `volume-remove` contract the base record cleared: the verb
  comes from the plan rather than being guessed, the plan is read NUL-delimited
  into named arrays, an unrecognised key is refused outright, and the
  incomplete-plan guard at `run.sh:743` was extended to refuse a plan with no
  `image-remove` arguments. Nothing in the delta constructs a mount, a flag or a
  network argument, so the #512–#516 containment controls the base record
  verified are untouched — `run_sh_launcher_test.ts` still asserts no runtime
  socket, no `--privileged`, no host networking and no published ports.
- **Word splitting and globbing — empty.** Every path, volume name, image
  reference and log line added here is quoted at every expansion. The new array
  expansion, `for volume in ${volume_names[@]+"${volume_names[@]}"}`
  (`run.sh:1107`), uses the bash-3.2 empty-array idiom whose alternate value is
  itself quoted. `for candidate in "${LOOP_LOG_DIR}"/launch-*.log`
  (`loop.sh:83`) quotes the directory and leaves only the intended glob.
- **`set -euo pipefail` — unchanged, and no new relaxation.** The delta adds no
  `set +e` window and removes none. `run.sh:2` and `setup.sh:2` keep the full
  triple; `loop.sh:5` keeps the documented `set -uo pipefail`.
- **`trap` cleanup — three new handlers, none with an unset interpolation.**
  `setup.sh` installs its transcript traps inside `main()` rather than at file
  scope, so sourcing the script for tests still has no side effect, and there
  was no earlier `trap` in that file for them to clobber. `run.sh`'s new
  background job clears its inherited traps first (`trap - EXIT TERM INT`,
  `run.sh:1617`), matching the watchdog, so it can neither record a second
  launcher outcome nor delete the evidence the launcher is about to quote.
  `run.sh`'s `on_exit` is unchanged and still returns early when
  `BASH_SUBSHELL != 0`.
- **Exit-code propagation — no swallowed guard.** The `PIPESTATUS[0]` readers
  the base record listed are untouched. The delta's own failure paths all
  report: `write_interactive_config` exits 1 with a message on each of three
  failures, `export_provider_env` returns 1 when a file yields no credential
  line and its caller condemns the file, and the toolchain-self-check branch
  reports `[TOOLCHAIN_SELFCHECK_UNRECOVERED]` rather than removing the image a
  second time.

## Observations that are not findings

- **`loop.sh:163` now reaches a bare `${HOME}` on every fallback, not only when
  two overrides are unset.** The base record noted
  `${LAUNCH_LOG_DIR:-${LOG_DIR:-${HOME}/logs}}` as reachable only with both
  overrides unset; Issue #1388 replaced it with `local fallback="${HOME}/logs"`.
  Under `set -u` an unset `HOME` still kills the command-substitution subshell
  before the stderr message two lines below it — and now does so whenever deno
  is missing rather than only in the narrower case. It stays an observation for
  the base record's reason: it is not silent (each cycle then fails to open its
  launch log and says so), and `run.sh` refuses to launch on the same unset
  variable. `run.sh:804` and `run.sh:988` add two more bare `${HOME}` reads on
  the same terms.
- **`prompt_interactive_config` creates the gh config directory with no
  following `chmod` (`setup.sh:1166`).** Every other `make_credential_dir` call
  site chmods afterwards, because a directory that already existed keeps its
  original mode. Here the call is guarded by `[[ ! -d … ]]`, so it only ever
  creates, and `umask 077` gives it 0700 — correct, but by a different argument
  from its siblings, which is worth knowing before anyone drops the guard.
- **`HOST_DISK_REFRESH_PID` is not registered with the `EXIT` trap**
  (`run.sh:1740`). A launcher that exits between the fork and the `kill` at
  `run.sh:1748` orphans the refresher, but the loop's own
  `kill -0 "${client_pid}"` ends it within one `HOST_DISK_REFRESH_SECONDS` — the
  orphan is bounded and self-terminating, unlike the unbounded background reader
  the base record's `tee` discussion is about.
- **`recreate_volume`'s `err="$(mktemp)"` is not in the `EXIT` trap**
  (`run.sh:963`). Removed on every return path, so only a SIGKILL leaks it, and
  it holds runtime stderr rather than anything sensitive.
