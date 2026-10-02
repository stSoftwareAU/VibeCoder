# 🔎 Security sweep — the launcher scripts (shell and PowerShell)

**Issue:** [#2760](https://github.com/stSoftwareAU/VibeCoder/issues/2760)
(chunk 11-launchers) · **Parent:** #2722

Siblings:
[`security-sweep-1221-shell-entry-points.md`](security-sweep-1221-shell-entry-points.md)
(the base read of `run.sh`, `setup.sh`, `loop.sh`) and
[`security-sweep-2181-shell-entry-points-delta.md`](security-sweep-2181-shell-entry-points-delta.md)
(the delta this record continues from).

> **This is not an empty result.** One root cause survived triage and is filed
> as [#3057](https://github.com/stSoftwareAU/VibeCoder/issues/3057). Several of
> the issue's named categories *were* empty, and each is stated as such below —
> an empty category is a result, not an omission.

## Scope and method

Per the issue: `run.sh`, `setup.sh` and `loop.sh` were already recorded in #1221
and #2181, so this sweep covers only their **delta since #2181's landing
commit, `5e3b65ae`** — the diff against the current branch. `run.ps1`,
`setup.ps1`, `loop.ps1` and `quality.sh` have never been recorded, so each was
**read end to end**.

| File | Treatment | Size |
| ---- | --------- | ---- |
| `run.sh` | delta since `5e3b65ae` | +188 / −9 |
| `setup.sh` | delta since `5e3b65ae` | +37 / −19 |
| `loop.sh` | delta since `5e3b65ae` | no change |
| `run.ps1` | full read | 1,573 lines |
| `setup.ps1` | full read | 1,766 lines |
| `loop.ps1` | full read | 339 lines |
| `quality.sh` | full read | 73 lines |

**Delta command:**
`git diff 5e3b65ae <sweptAt> -- run.sh setup.sh loop.sh`, where `<sweptAt>` is
`3a566abe0938798bf4996ebe8a6a183f51a20d51` — `git merge-base origin/main HEAD`
at the time this slice was added. `loop.sh` carries no change in that range.
Confirmed zero drift since: `git diff <sweptAt> HEAD -- loop.ps1 loop.sh
quality.sh run.ps1 run.sh setup.ps1 setup.sh` is empty, so this record is
still current at the commit it lands on.

Every interpolated value in the delta, and every risky construct in the four
full-read files, was traced to a constant, a validated value, a named
untrusted source, or a prior sweep's finding. The categories checked, per the
issue:

- command and argument injection;
- unquoted expansion;
- credential handling and logging;
- privilege and elevation;
- unsafe downloads or `Invoke-Expression`;
- fail-open error handling (`$ErrorActionPreference`, `set -euo pipefail`,
  swallowed exit codes).

## The `.sh` delta since #2181

`run.sh` gained the disk-reset-by-role changes (Issue #2216: a plan-named
`resettable_volume_names` list, checked by a new `volume_may_reset` guard
before any volume recreate; the volume is never chosen by size alone again)
and the shortfall-aware reset gate (Issue #2313: a recreate is only attempted
when the resettable volumes can plausibly cover the measured shortfall, and a
repeat recreate against an unchanged free-space reading is refused). `setup.sh`
replaced the inline `warn_if_token_lacks_workflow_scope` check with the
`token-scope-preflight` CLI command and added two more non-fatal
`run_setup_cli` calls (`copilot-review-mode`, `repo-settings-harden`).

- **Command/argument injection — empty.** Every new `Deno.Command`-bound value
  in `worker/deno/lib/container_launch.ts` and `run_setup_cli` arrives through
  the pre-existing array-argument machinery; nothing here builds a shell
  string. No new subprocess call was added to any of the three files.
- **Unquoted expansion — empty.** Every new array iteration uses the bash 3.2
  empty-array idiom (`${resettable_volume_names[@]+"${resettable_volume_names[@]}"}`)
  and every new scalar expansion is quoted.
- **Credential handling/logging — empty.** The only credential-adjacent change
  is the *removal* of `warn_if_token_lacks_workflow_scope` from `setup.sh` in
  favour of the shared `token-scope-preflight` Deno command; nothing here logs
  a secret.
- **Privilege/elevation — empty.** No new `sudo`, `runas`, or elevated call.
- **Fail-open error handling — clean.** `set -euo pipefail` is unchanged in all
  three files. Every new helper (`volume_may_reset`, `resettable_held_kb`,
  `unrecovered_free_kb`, …) returns a real status and every caller checks it;
  the new `|| true` guards (`volume_store_kb "${volume}" || true`) exist only
  where the caller already validates the captured value with a numeric regex
  immediately after, matching the pattern the base record triaged.

### `shellcheck` triage

```console
$ shellcheck -e SC1091 -e SC2034 run.sh setup.sh loop.sh
$ echo $?
0
```

Same gate as the base and delta records: the pinned `validate` job in
`.github/workflows/validate-scripts.yml`. No new optional-check category
appeared; the counts moved with the new lines and nothing else.

## The full read: `run.ps1`, `setup.ps1`, `loop.ps1`, `quality.sh`

- **`Invoke-Expression`/`iex` — empty.** No occurrence in any of the four
  files.
- **`Invoke-WebRequest`/`WebClient`/`DownloadFile`/`DownloadString` — empty.**
  No unsafe-download surface exists; nothing in these scripts fetches content
  over the network.
- **Command/argument injection — empty.** Every native-process call goes
  through array-based argument passing: `Invoke-HostCommand`
  (`run.ps1:116-153`) builds a `ProcessStartInfo` and adds each argument via
  `.ArgumentList.Add()`, never a composed command string; the two `& $deno
  @argv` / `& claude setup-token` call sites in `setup.ps1` use PowerShell's
  own splatting, the array equivalent. `quality.sh` (bash) `exec`s the Deno CLI
  with a literal argument array.
- **Unquoted expansion — not applicable in the bash sense.** PowerShell does
  not word-split or glob unquoted variables the way `sh` does, so this
  category maps to string interpolation reaching a sink that reinterprets it;
  none does — every interpolated value here lands in a `Write-*`/`[Console]`
  message, a `Join-Path` argument, or an `ArgumentList` entry.
- **Credential handling and logging — one gap found, filed as
  [#3057](https://github.com/stSoftwareAU/VibeCoder/issues/3057).** See
  below. Otherwise clean: `Read-VibeSecret` reads via `Read-Host -AsSecureString`
  and frees the unmanaged buffer in a `finally`; `Get-VibeSetupToken`'s
  transcript is created empty, narrowed to mode 600 with `Protect-VibePath`,
  *then* the sensitive content is teed to it, and the file is removed in a
  `finally` regardless of outcome; `Test-VibeClaudeCredential` clears the three
  override variables in a `finally` even when the live `claude -p` probe
  throws.
- **Privilege and elevation — empty.** No `RunAs`, no UAC manifest, no
  elevated `Start-Process`. `Invoke-VibeScheduledTaskPrompt` registers the
  Windows Scheduled Task to run as the *current* interactive user — the same
  privilege level setup itself runs at — never `SYSTEM` or an elevated
  principal.
- **Fail-open error handling — clean.** `$ErrorActionPreference = "Stop"` is
  set at the top of all three `.ps1` files. Every native-command call site
  checks `$LASTEXITCODE` or the wrapped `ExitCode` explicitly; `loop.ps1`'s
  `git pull` and `run.ps1` invocation are wrapped in `try`/`catch` specifically
  because a terminating `$ErrorActionPreference` would otherwise end the
  supervision loop on a single failed native command, and each catch reports
  rather than swallows. `quality.sh` runs under `set -e` (no `pipefail`/`-u`,
  but it contains no pipeline whose upstream exit code matters and every
  expansion it reads is already guarded with `${VAR:-}` or `"$@"`).

### `.sh` ↔ `.ps1` control parity

The acceptance criteria ask that a control present on one side only be named.
One was found, and it mirrors an already-fixed `.sh`-side defect:

| Control | `.sh` | `.ps1` |
| ------- | ----- | ------ |
| Owner-only mode on run-scoped temp files | `run.sh`'s `PLAN_FILE`, `RUN_LOG` etc. are created with `mktemp`, which defaults to mode 0600 (the fix for [#1299](https://github.com/stSoftwareAU/VibeCoder/issues/1299): `mkfifo -m 600` for the stderr FIFO beside it) | `run.ps1`'s five counterparts (`$PlanFile`, `$EgressLog`, `$BuildLog`, `$HealLog`, `$RunCapture`) are all written to `[System.IO.Path]::GetTempPath()` with no mode narrowing — **gap, filed as [#3057](https://github.com/stSoftwareAU/VibeCoder/issues/3057)** |
| Owner-only mode on the credential-capture transcript | `setup.sh` gives `claude` a pty via `script(1)`, never touching disk | `setup.ps1`'s `Get-VibeSetupToken` tees to a transcript, but narrows it to 600 *before* anything sensitive is written — **parity held, no gap** |
| Owner-only credential directory | `setup.sh`'s `make_credential_dir` (`umask 077; mkdir -p`) | `setup.ps1`'s `New-VibeCredentialDirectory` — `umask 077` subshell off Windows, an explicit de-inherited ACL on Windows — **parity held, more thorough on Windows than the minimum** |
| Live-credential validation (Issue #4161) | `setup.sh:865`, `claude -p 'Say hello'` | `setup.ps1`'s `Test-VibeClaudeCredential`, same probe — **parity held** |
| Fleet-token scope / Copilot review / repo-settings-harden CLI delegation (the #2181-delta additions) | `setup.sh`'s three new `run_setup_cli` calls | `setup.ps1:1685-1736` calls the same three CLI verbs — **parity held, already added alongside the `.sh` change** |

No control exists on the `.ps1` side with no `.sh` counterpart that would
itself be a gap in the other direction — the Windows-only Scheduled Task
prompt and the ACL-based directory protection are platform adaptations of the
same control, not an extra one.

## Findings

| # | Where | Class | Severity | Status |
| - | ----- | ----- | -------- | ------ |
| 1 | `run.ps1:529,763,866,881,1318` | incorrect permission assignment for a critical resource (CWE-732) | low | [#3057](https://github.com/stSoftwareAU/VibeCoder/issues/3057) |

### 1 — `run.ps1`'s run-scoped temp files carry no owner-only mode

`$PlanFile`, `$EgressLog`, `$BuildLog`, `$HealLog` and `$RunCapture` are all
created under `[System.IO.Path]::GetTempPath()` and written either by a Deno
subprocess (`Deno.writeTextFile`, no `mode` option) or by
`[System.IO.File]::Open`/`WriteAllText`. None narrows the file's mode first.
On a non-Windows `pwsh` host — explicitly supported, per `setup.ps1`'s
`$script:VibeIsWindows` branches — `GetTempPath()` resolves to `/tmp`, and a
freshly created file lands at the umask default (0644 under the common 022):
**world-readable**. `$RunCapture` is the direct counterpart of the `run.sh`
stderr-capture FIFO that #1299 already had to fix for exactly this reason; the
fix never reached the PowerShell side. See the filed issue for the full
analysis, attacker model and suggested fix (mirror
`New-VibeCredentialDirectory`'s non-Windows branch: pre-create the file
owner-only via `sh -c 'umask 077; : > "$1"'` before anything writes to it).

Not fixed in this record — it needs a cross-platform regression test (a
`run.ps1` launcher harness analogous to the existing `run.sh` one) that this
sweep is not the place to design from scratch, so it is filed rather than
patched blind.
