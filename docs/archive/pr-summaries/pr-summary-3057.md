# PR Summary — Issue #3057

## Summary

Closes #3057. `run.ps1` on non-Windows pwsh created its run-scoped temporary
files under `[System.IO.Path]::GetTempPath()` with the umask default
(commonly 0644, world-readable) — SEC-2760-01, CWE-732. Each is now
pre-created owner-only (0600) before its first write; Windows behaviour is
unchanged.

## Spec

### Intent and Rationale

- Every `vibe-*` temporary file the PowerShell launcher creates in the shared
  temp directory is private to the launching account from the instant it
  exists, matching `run.sh`'s private stderr FIFO (Issue #1299).
- Windows is untouched: its temp path sits under the per-user `%TEMP%`.

### Essential Design Decisions

- New helper `New-VibePrivateTempFile` mirrors `setup.ps1`'s
  `New-VibeCredentialDirectory`: `sh -c 'umask 077; set -C; : > "$1"'`, path
  passed as `$1`, non-zero exit throws. `set -C` (noclobber) refuses a
  pre-planted file or symlink at the path.
- Pre-creation then truncating writes (Deno `writeTextFile`, .NET
  `WriteAllText`, `FileMode.Open` for the stderr capture) keeps the 0600 mode;
  no post-write `chmod` window.
- `$script:VibeIsWindows` uses `setup.ps1`'s `OSVersion.Platform` idiom
  because `$IsWindows` does not exist in Windows PowerShell 5.1 and
  StrictMode makes it fatal.
- Covered files: launch plan and its `.Containerfile` sibling, egress
  evidence log, builder-heal log, build log, run stderr capture.

### Undiscoverable Facts

None.

## Evidence

- **Regression test:**
  `worker/deno/tests/run_ps1_launcher_test.ts::run.ps1 - the run's temporary
  files are private to this account (Issue #3057)`. It runs `run.ps1` under
  `umask 022` with a private `TMPDIR` through a heal-and-retry launch; new
  opt-in stub knob `STUB_RECORD_TEMP_MODES` in
  `worker/deno/tests/fixtures/launcher_harness.ts` (reader `tempFileModes`)
  records the mode of every `vibe-*` temp file at each stub call.
- **Red on unfixed code, green after:** against `origin/main`'s `run.ps1`
  the test fails — every recorded file (plan `.Containerfile`, egress,
  build, heal, run logs) is `644` and the plan file itself is never on disk
  before Deno writes it; with the fix it passes with all six classes seen
  at `600`.
- **Original trigger closed:** no `vibe-*` file under the temp directory is
  ever created by a umask-governed writer any more; noclobber means a
  planted file or symlink makes the launch fail loud instead of being
  reused, so there is no trivial bypass.
- **Docs sweep:** grepped README.md, docs/ (excluding docs/archive/) and
  `*/README.md` for the launcher temp-file paths and permissions — no
  surface documents their modes, so no doc change was needed.
- **Quality gate:** `./quality.sh` PASSED (config integration skipped: no
  `.config.json` in this checkout).

## Test Plan

- [x] `worker/deno/tests/run_ps1_launcher_test.ts` — new Issue #3057 test,
      red on base, green after.
- [x] `worker/deno/tests/run_sh_launcher_test.ts` — Issue #1299 FIFO test
      still green with the harness change.
- [x] Full `./quality.sh` gate.

## Branch state

Branch `issue-3057-incorrect-permission-temp-file-in-run-ps1-529`: one commit
on `main` touching `run.ps1`,
`worker/deno/tests/fixtures/launcher_harness.ts`,
`worker/deno/tests/run_ps1_launcher_test.ts` and this summary.
