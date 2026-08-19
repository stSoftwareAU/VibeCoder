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
# Issue #4072: A failed launcher is recorded rather than retried blindly: the
#              worker's `container-restart-backoff` command grows the wait
#              across consecutive failures, records the recovery as a self-heal
#              event and escalates a repeatedly failing host through GitHub.
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

$WorkerMod = Join-Path $ScriptDir "worker/deno/mod.ts"
$DenoCmd = Get-Command "deno" -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1

<#
.SYNOPSIS
    Record one launcher outcome and return the seconds to wait before retrying.

.DESCRIPTION
    Delegates to the worker's container-restart-backoff command, which grows
    the backoff across consecutive failures, records the recovery as a
    self-heal event and escalates a repeatedly failing host through GitHub.
    Falls back — loudly, never silently — to the base sleep when the recorder
    cannot run or does not answer with a plain integer (Issue #3234).
#>
function Get-NextSleepSeconds {
    param([Parameter(Mandatory = $true)][int] $Status)

    if (-not $DenoCmd -or -not (Test-Path $WorkerMod)) {
        [Console]::Error.WriteLine(
            "loop.ps1: cannot record launcher outcome (deno or $WorkerMod missing)" +
            " — falling back to ${LoopSleepSeconds}s")
        return [int]$LoopSleepSeconds
    }

    $answer = ""
    try {
        $answer = & $DenoCmd.Source run `
            "--frozen" "--lock=$ScriptDir/worker/deno/deno.lock" `
            "--allow-env" "--allow-read" "--allow-write" "--allow-run" "--allow-net" `
            $WorkerMod "container-restart-backoff" `
            "--exit-status" "$Status" `
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
    try {
        & "$ScriptDir/run.ps1"
        $status = $LASTEXITCODE
    } catch {
        # Continue supervising regardless of how run.ps1 failed.
        $status = 1
    }
    if ($null -eq $status) { $status = 0 }

    if ($status -ne 0) {
        Write-Host "loop.ps1: run.ps1 exited with status $status — backing off and retrying"
    }

    $sleepSeconds = Get-NextSleepSeconds -Status $status
    Write-Host "Sleeping ${sleepSeconds}s..."
    Start-Sleep -Seconds $sleepSeconds
}
