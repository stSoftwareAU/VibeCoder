################################################################################
# loop.ps1 — OPTIONAL convenience wrapper (PowerShell equivalent of loop.sh)
#
# The canonical production supervision model is cron/launchd/Task Scheduler
# calling run.sh (or run.ps1) every 5 minutes. run_core runs for ~1 hour then
# exits; the next invocation picks up fresh code.
#
# This script is an alternative for environments without a scheduler.
# It continuously re-invokes run.ps1, backing off between failures.
#
# Issue #919:  PowerShell equivalent for cross-platform support.
# Issue #342:  A launcher that stopped because the host is out of Claude quota
#              is a scheduled pause, not a failure: it exits $QuotaPauseExit and
#              the recorder re-probes on a fixed cadence instead of backing off.
# Issue #4072: A failed launcher is recorded rather than retried blindly: the
#              worker's `container-restart-backoff` command grows the wait
#              across consecutive failures, records the recovery as a self-heal
#              event and escalates a repeatedly failing host through GitHub.
# Issue #1401: Each cycle ends by pulling the checkout, exactly as loop.sh
#              does, so a supervised Windows host cannot run frozen code for
#              ever. A failed pull is logged and the loop continues.
# Issue #1402: The log directory is asked of the worker (`mod.ts log-dir`),
#              never spelled here, and each cycle's own record is written
#              under it — the Issue #873 defect PR #1197 fixed in run.ps1 was
#              still present in this supervisor, which resolved nothing at all.
################################################################################

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

# Base sleep between iterations, and the first failure's backoff.
$LoopSleepSeconds = [Environment]::GetEnvironmentVariable("LOOP_SLEEP_SECONDS")
if (-not $LoopSleepSeconds) { $LoopSleepSeconds = "60" }

# This supervisor records every launcher outcome itself, so run.ps1 must not
# also record it — one failure must be counted once (Issue #4072).
$env:VIBE_SUPERVISOR_RECORDS_OUTCOME = "1"

################################################################################
# No wall-clock cap here — a deliberate divergence from loop.sh (Issue #423)
#
# loop.sh wraps each run in `timeout --kill-after=<grace> <VIBE_RUN_MAX_SECONDS>`
# (default 10800 s) and exports that cap with the run's start epoch so the
# worker can stop itself first (Issues #322/#421). This script has no
# equivalent: it invokes run.ps1 in-process, so it neither sets
# VIBE_RUN_MAX_SECONDS nor bounds the call, and a wedged run.ps1 blocks this
# loop until an operator intervenes.
#
# What still bounds a run on a PowerShell host:
#   - The container watchdog. run.ps1 waits on the runtime client under the
#     launch plan's `watchdog` deadline (the worker's own maximum run duration
#     plus a 10-minute margin, VIBE_CONTAINER_WATCHDOG_SECONDS to override),
#     reaps a container that outlives it and exits 87 (Issue #4173).
#   - The worker's own run-duration limit inside the container.
# Neither covers a host-side run.ps1 that never returns.
#
# The canonical production supervision model on Windows is Task Scheduler
# invoking run.ps1 on a fixed interval — the scheduler owns the wall clock
# there — so this convenience wrapper is left unbounded rather than growing an
# untested out-of-process supervision path. Said here, plainly, so the gap is
# a documented choice rather than a silent divergence.
################################################################################

# The worker's own "I stopped because this host is out of quota" status
# (QUOTA_PAUSE_EXIT_STATUS in worker/deno/lib/quota_pause.ts, Issue #342).
$QuotaPauseExit = 75

# The launcher's "this host's one worker is already running" status
# (ANOTHER_WORKER_RUNNING_EXIT in worker/deno/commands/container_reap.ts,
# Issues #26, #1056). The design invariant holding, not a crash.
$AnotherWorkerRunningExit = 4

$WorkerMod = Join-Path $ScriptDir "worker/deno/mod.ts"
$DenoCmd = Get-Command "deno" -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1

<#
.SYNOPSIS
    Where this host's logs go, asked of the worker rather than spelled here.

.DESCRIPTION
    The worker owns the one resolution (Issues #872, #873, #1388) - the
    `.config.json` `log_dir` key, then the platform's own standard location -
    so this supervisor, run.ps1, run.sh and the container mount cannot
    disagree about it, and the default moves in one place. LAUNCH_LOG_DIR and
    LOG_DIR exported here are ignored; the command names them, and the
    one-off legacy-location notice, on stderr.

    Falls back - loudly, never silently - to the pre-#873 default when the
    worker cannot answer: a supervisor that must never exit still says what
    it did. run.ps1 exits instead, because refusing to launch is an option a
    launcher has and a supervisor does not.
#>
function Resolve-LaunchLogDir {
    $resolved = ""
    if ($DenoCmd -and (Test-Path $WorkerMod)) {
        try {
            # stderr is left alone so the notices reach the operator.
            $resolved = & $DenoCmd.Source run `
                "--frozen" "--lock=$ScriptDir/worker/deno/deno.lock" `
                "--allow-env" "--allow-read" `
                $WorkerMod "log-dir" |
                ForEach-Object { "$_".Trim() } |
                Where-Object { $_ } |
                Select-Object -Last 1
        } catch {
            # Deno missing, a broken lockfile, a non-zero exit: the fallback
            # below reports it rather than this catch.
            $resolved = ""
        }
    }
    if ($resolved) { return $resolved }

    # No environment variable is consulted here either (Issue #1388): the
    # config file cannot be read without deno, so the one thing this script
    # may spell is the pre-#873 default.
    $homeDir = [Environment]::GetEnvironmentVariable("USERPROFILE")
    if (-not $homeDir) { $homeDir = [Environment]::GetEnvironmentVariable("HOME") }
    if (-not $homeDir) { $homeDir = [System.IO.Path]::GetTempPath() }
    $fallback = Join-Path $homeDir "logs"
    [Console]::Error.WriteLine(
        "loop.ps1: cannot resolve the log directory (deno or $WorkerMod " +
        "missing, or the log-dir command failed) - falling back to $fallback")
    return $fallback
}

# Where each cycle's launch log is written, so a failed launch has evidence to
# report (Issue #633). Resolved once, before the first cycle: the directory
# does not move while the supervisor runs, and asking per cycle would spawn
# deno on every iteration.
$LoopLogDir = Resolve-LaunchLogDir

# Keep the newest 50 and no more: these are diagnostics, not an archive, and
# an unbounded directory on the host is its own incident (Issue #633).
$LaunchLogKeep = 50

<#
.SYNOPSIS
    Drop all but the newest $LaunchLogKeep launch logs (Issue #633).
#>
function Remove-OldLaunchLogs {
    try {
        # The epoch leads the filename, so name order IS chronological order -
        # no reliance on the filesystem's modification times.
        $logs = @(Get-ChildItem -LiteralPath $LoopLogDir -Filter "launch-*.log" `
                -File -ErrorAction Stop | Sort-Object -Property Name)
        for ($i = 0; $i -lt ($logs.Count - $LaunchLogKeep); $i++) {
            Remove-Item -LiteralPath $logs[$i].FullName -Force `
                -ErrorAction SilentlyContinue
        }
    } catch {
        # Best-effort - reclaiming disk must never end a cycle - but never
        # silent: a directory that stops being trimmed says so.
        [Console]::Error.WriteLine(
            "loop.ps1: cannot prune $LoopLogDir - $($_.Exception.Message)")
    }
}

<#
.SYNOPSIS
    Create this cycle's launch log, or return "" when it cannot be written.

.DESCRIPTION
    Never fail a cycle over its own diagnostics: an unwritable directory is
    reported and the cycle runs without one, exactly as loop.sh does.

    What lands in it is this supervisor's own record of the cycle - the
    launcher's exit status, the backoff it produced, the checkout refresh.
    run.ps1's own diagnostics do not: it writes them straight to the process's
    stderr handle ([Console]::Error, 65 call sites) and runs in-process here,
    so no redirection this script can apply would see them. loop.sh captures
    its launcher's output because it spawns run.sh as a child; that is the
    divergence, said plainly rather than left as a file that looks like a
    capture and holds nothing.
#>
function New-LaunchLog {
    $epoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $path = Join-Path $LoopLogDir "launch-$epoch.log"
    try {
        New-Item -ItemType Directory -Force -Path $LoopLogDir -ErrorAction Stop |
            Out-Null
        New-Item -ItemType File -Force -Path $path -ErrorAction Stop | Out-Null
        return $path
    } catch {
        [Console]::Error.WriteLine(
            "loop.ps1: cannot write $path ($($_.Exception.Message)) - this " +
            "cycle's launch log will not be written")
        return ""
    }
}

<#
.SYNOPSIS
    Say something on the console and in this cycle's launch log.

.DESCRIPTION
    The console line is what an operator watching sees; the log line is what
    survives for the operator who was not, and what the escalation quotes
    (--launch-log, below). A log that cannot be appended to never ends a
    cycle - the console still has the line.
#>
function Write-LoopLine {
    param([Parameter(Mandatory = $true)][string] $Message)

    Write-Host $Message
    if (-not $LaunchLog) { return }
    try {
        Add-Content -LiteralPath $LaunchLog -Value $Message -ErrorAction Stop
    } catch {
        [Console]::Error.WriteLine(
            "loop.ps1: cannot append to $LaunchLog - $($_.Exception.Message)")
    }
}

<#
.SYNOPSIS
    Record one launcher outcome and return the seconds to wait before retrying.

.DESCRIPTION
    Delegates to the worker's container-restart-backoff command, which grows
    the backoff across consecutive failures, records the recovery as a
    self-heal event and escalates a repeatedly failing host through GitHub.
    Falls back — loudly, never silently — to the base sleep when the recorder
    cannot run or does not answer with a plain integer (Issue #3234).

    --allow-sys=hostname: the escalation is titled for the host. Without the
    permission Deno.hostname() throws and the report is filed as
    "unknown-host" - which is also its dedup key, so every host in the fleet
    collapses onto one issue per phase (Issues #633, #709, #710). loop.sh has
    carried the flag since Issue #633.

    --launch-log: this cycle's own record, so an escalation can quote the
    supervisor's account of the failure rather than only its exit status
    (Issues #709, #1029). Omitted when the log could not be written, so the
    recorder is never handed a path to nothing (Issue #1402).
#>
function Get-NextSleepSeconds {
    param(
        [Parameter(Mandatory = $true)][int] $Status,
        [string] $LaunchLog = ""
    )

    if (-not $DenoCmd -or -not (Test-Path $WorkerMod)) {
        [Console]::Error.WriteLine(
            "loop.ps1: cannot record launcher outcome (deno or $WorkerMod missing)" +
            " — falling back to ${LoopSleepSeconds}s")
        return [int]$LoopSleepSeconds
    }

    $logArgs = @()
    if ($LaunchLog) { $logArgs = @("--launch-log", $LaunchLog) }

    $answer = ""
    try {
        $answer = & $DenoCmd.Source run `
            "--frozen" "--lock=$ScriptDir/worker/deno/deno.lock" `
            "--allow-env" "--allow-read" "--allow-write" "--allow-run" "--allow-net" `
            "--allow-sys=hostname" `
            $WorkerMod "container-restart-backoff" `
            "--exit-status" "$Status" `
            @logArgs `
            "--base-sleep-seconds" "$LoopSleepSeconds" 2>$null |
            Select-Object -Last 1
    } catch {
        $answer = ""
    }

    $seconds = 0
    if ([int]::TryParse("$answer".Trim(), [ref]$seconds) -and $seconds -gt 0) {
        return $seconds
    }

    [Console]::Error.WriteLine(
        "loop.ps1: container-restart-backoff gave no usable interval" +
        " — falling back to ${LoopSleepSeconds}s")
    return [int]$LoopSleepSeconds
}

while ($true) {
    $status = 0
    # Issue #633: this cycle's record, in the directory the worker resolved,
    # so a failed launch leaves evidence an operator can find afterwards
    # rather than only a console nobody was watching (Issue #1402).
    Remove-OldLaunchLogs
    $LaunchLog = New-LaunchLog
    try {
        & "$ScriptDir/run.ps1"
        $status = $LASTEXITCODE
    } catch {
        # Continue supervising regardless of how run.ps1 failed.
        $status = 1
    }
    if ($null -eq $status) { $status = 0 }

    if ($status -eq $QuotaPauseExit) {
        Write-LoopLine ("loop.ps1: run.ps1 paused — this host is out of quota (status $status); " +
            "re-probing on the quota cadence, not backing off (Issue #342)")
    } elseif ($status -eq $AnotherWorkerRunningExit) {
        Write-LoopLine ("loop.ps1: run.ps1 did not launch — another worker is already running " +
            "on this host (status $status); one worker per host, so this is not a failure " +
            "(Issues #26, #1056)")
    } elseif ($status -ne 0) {
        Write-LoopLine "loop.ps1: run.ps1 exited with status $status — backing off and retrying"
    }

    $sleepSeconds = Get-NextSleepSeconds -Status $status -LaunchLog $LaunchLog
    Write-LoopLine "Sleeping ${sleepSeconds}s..."
    Start-Sleep -Seconds $sleepSeconds

    # Refresh the checkout at the end of every cycle, the same point loop.sh
    # pulls at (Issue #1401). run.ps1 updates the checkout too, through
    # worker-checkout-update, but only once a cycle reaches that step: a run
    # that dies earlier - no deno on PATH, an unreadable configuration, a
    # refused run mode - never gets there, and this host would then run the
    # revision it was started with for ever, unable to pick up the very fix
    # that would repair it.
    #
    # Non-fatal and loud, as in loop.sh: a pull that fails is reported and the
    # loop keeps supervising. try/catch because PowerShell 7.4 turns a failing
    # native command into a terminating error under $ErrorActionPreference =
    # "Stop", and a missing git throws outright.
    try {
        & git pull
        if ($LASTEXITCODE -ne 0) {
            Write-LoopLine "loop.ps1: git pull exited with status $LASTEXITCODE — continuing"
        }
    } catch {
        Write-LoopLine "loop.ps1: git pull failed ($($_.Exception.Message)) — continuing"
    }
}
