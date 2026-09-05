# PR Summary — Issue #1020

Closes #1020

## Summary

`~/logs/run_core.log` on GRQ-23 recorded `release-notice: failed (status 1) -
no explanation given` three times on 2026-09-04. That was not a mystery: it was
the launcher saying it had thrown the explanation away. `run.sh` captured the
check's **stdout** only, and the command's account of a failure goes to
**stderr** — `mod.ts` writes a configuration error, an unresolvable GitHub, an
unknown command or an uncaught throw through the logger, which is
`console.error`. So `${release_notice}` was empty on every failure and the
`${...:-no explanation given}` fallback fired every time. The warning could
never explain itself, by construction.

Both streams are now captured, separately, so a successful check still prints
only the notice on stdout and a failed one quotes its own words. A check the
launcher's 120 s bound killed is logged as a timeout — a different fact from a
check that ran and failed, and one whose silence is expected rather than
missing. The fallback survives for the genuinely silent case, where it now
means something.

The design intent is untouched: the check is notify-only, a failure is a
warning and never a refused launch, and an unreachable GitHub still costs
seconds.

## Audit of the same pattern

The issue asked for `builder-stop` and the shared fallback to be audited for
the same discard. Both already capture stderr and neither discards it:

- `builder-stop` redirects stderr to its own temp file and renders it into the
  log line (it also feeds the `builder-absent` match).
- `runtime_error_detail` — the shared `no explanation given` renderer used by
  the volume recreation — reads a captured stderr file. It was moved above its
  new first caller so the release check shares one rendering of "what the
  failing command said" rather than growing a second.

`run.ps1` carries **no** release-notice step at all, so there is no twin of
this failure to mirror there; adding the step would be Issue #690's scope, not
this one's. Every other PowerShell path that reports a failed command already
captures stderr through `Invoke-HostCommand -Capture`.

## Evidence

No UI change, so no screenshots. The evidence is the first test below, whose
assertion is exactly the bug: it fails against the unfixed launcher, where the
stub's stderr reaches nothing and the log says `no explanation given`.

## Test Plan

- `tests/fixtures/launcher_harness.ts` — the `release-notice` stub gains
  `STUB_RELEASE_NOTICE_STDERR`, so a test can make the check fail *loudly*, the
  way the real command does.
- `tests/run_sh_launcher_test.ts`
  - `a failed release check quotes the reason the check gave (Issue #1020)` —
    the stub's stderr reaches both stderr and `run_core.log`, and
    `no explanation given` does not appear.
  - `a release check that says nothing at all still falls back (Issue #1020)` —
    so the fix is not "always print stderr", which would leave a warning
    trailing off into nothing.
  - `a release check the bound killed is logged as a timeout (Issue #1020)` —
    status 124 is reported as `timed out after 120s` and the check's own
    partial output is not offered as the reason. The assertion is conditional
    on the host actually having `timeout`/`gtimeout`, because without one the
    launcher applies no bound and 124 is the command's own status.
  - The existing Issue #690 tests (notice printed once, silence when there is
    nothing to say, a failed check never blocking the launch) are unchanged and
    still pass.
