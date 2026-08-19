################################################################################
# Task Scheduler entrypoint - thin, trusted, host-side container launcher.
#
# The PowerShell twin of run.sh. The worker runs inside a container and nowhere
# else (Issue #4060), so this script is the containment boundary on Windows and
# is deliberately small enough to audit: it asks the Deno
# "container-launch-plan" command what to run, then runs exactly that. Every
# decision - which runtime (Docker or Podman, auto-detected), which image,
# which mounts, which privilege flags - is made in
# worker/deno/lib/container_launch.ts, so the two launchers cannot drift and
# code running inside the container cannot broaden its own mounts by editing
# PowerShell here.
#
# Steps:
#   1. Locate Deno on the host (the only host tool this script needs).
#   2. Build the launch plan (runtime detection, image reference, mounts).
#   3. Build the image when the content-derived reference is absent.
#   4. Launch the container, stop it if this launcher is terminated, and exit
#      with the container's exit status so Task Scheduler and loop.ps1 see
#      real failures.
#
# Host paths are resolved from $env:USERPROFILE in Windows spelling; the
# in-container paths are identical to the run.sh case, so the worker sees one
# environment regardless of which host started it.
#
# Issue #919:  PowerShell equivalent for cross-platform support.
# Issue #3504: Dropped the run_core.sh shadow-copy.
# Issue #4066: Cut over to a containerised launch. There is no native
#              execution path any more - no supported runtime is a loud
#              non-zero exit, never a fallback to running on the host.
# Issue #4072: Record the phase reached, so the supervisor's self-heal backoff
#              can tell a host that cannot rebuild its environment from a
#              worker that crashed inside a perfectly good container.
# Issue #4147: Windows stays container-only. The run mode is resolved through
#              the Deno "run-mode" command, and an explicit opt-in to the host
#              mode is refused with a non-zero exit and an actionable message
#              rather than silently launching a container instead.
# Issue #4173: Outer kill-and-reap watchdog, the twin of run.sh's. The wait on
#              the runtime client runs under the plan's `watchdog` deadline, a
#              stale worker container is reaped before the launch, and a reaped
#              wedge exits with the named status so the scheduler's next cycle
#              runs instead of the slot staying blocked.
################################################################################

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$BaseDir = if ($PSScriptRoot) {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Definition
}
Set-Location $BaseDir

# Phase marker for the supervisor (loop.ps1 / loop.sh read this alongside the
# exit status). Best-effort by design: an unwritable marker degrades the
# supervisor's attribution, it must not stop the worker from launching - but it
# says so on stderr rather than failing quietly (Issue #3234).
$StateDir = [Environment]::GetEnvironmentVariable("VIBE_STATE_DIR")
if (-not $StateDir) {
    $home_ = [Environment]::GetEnvironmentVariable("USERPROFILE")
    if (-not $home_) { $home_ = [Environment]::GetEnvironmentVariable("HOME") }
    if (-not $home_) { $home_ = [System.IO.Path]::GetTempPath() }
    $StateDir = Join-Path $home_ ".vibe-coder"
}
$LaunchPhaseFile = [Environment]::GetEnvironmentVariable("VIBE_LAUNCH_PHASE_FILE")
if (-not $LaunchPhaseFile) {
    $LaunchPhaseFile = Join-Path $StateDir "last-launch-phase"
}

function Write-LaunchPhase {
    param([Parameter(Mandatory = $true)][string] $Phase)

    try {
        $directory = Split-Path -Parent $LaunchPhaseFile
        if ($directory) {
            New-Item -ItemType Directory -Force -Path $directory | Out-Null
        }
        [System.IO.File]::WriteAllText($LaunchPhaseFile, "$Phase`n")
    } catch {
        [Console]::Error.WriteLine(
            "[run.ps1] warning: cannot record launch phase to $LaunchPhaseFile")
    }
}

Write-LaunchPhase "runtime_detection"

<#
.SYNOPSIS
    Run a host command to completion with the launcher's stdin detached.

.DESCRIPTION
    Mirrors run.sh's `</dev/null`: nothing the launcher starts may consume the
    scheduler's stdin. Arguments are passed through ProcessStartInfo's argument
    list, so a host path containing a space or a quote reaches the runtime
    exactly as the launch plan spelled it.

.PARAMETER FilePath
    Executable to run.

.PARAMETER ArgumentList
    Arguments, already framed by the launch plan.

.PARAMETER Capture
    Capture stdout/stderr instead of inheriting this launcher's console.

.OUTPUTS
    An object carrying ExitCode, StdOut and StdErr.
#>
function Invoke-HostCommand {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]] $ArgumentList,
        [switch] $Capture
    )

    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $FilePath
    foreach ($argument in $ArgumentList) { [void]$info.ArgumentList.Add($argument) }
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = [bool]$Capture
    $info.RedirectStandardError = [bool]$Capture

    $process = [System.Diagnostics.Process]::Start($info)
    $process.StandardInput.Close()

    $stdout = ""
    $stderr = ""
    if ($Capture) {
        # Read both streams concurrently: a child blocked on a full pipe
        # would otherwise never exit.
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $stdout = $outTask.GetAwaiter().GetResult()
        $stderr = $errTask.GetAwaiter().GetResult()
    } else {
        $process.WaitForExit()
    }

    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        StdOut   = $stdout
        StdErr   = $stderr
    }
}

# Locate Deno
$DenoCmd = $null
foreach ($candidate in @(
        "deno",
        "$env:USERPROFILE\.deno\bin\deno.exe",
        "$env:HOME/.deno/bin/deno",
        "/opt/homebrew/bin/deno",
        "/usr/local/bin/deno"
    )) {
    $found = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) {
        $DenoCmd = $found.Source
        break
    }
}

if (-not $DenoCmd) {
    [Console]::Error.WriteLine("Error: Deno not found")
    exit 1
}

<#
.SYNOPSIS
    Record this launcher's outcome for the self-heal backoff (Issue #4072).

.DESCRIPTION
    Under Task Scheduler there is no supervising process between runs, so the
    launcher records its own outcome: consecutive failures grow the backoff
    and, past the phase's threshold, escalate through GitHub. loop.ps1 (and
    loop.sh) set VIBE_SUPERVISOR_RECORDS_OUTCOME because they record the same
    outcome themselves - one failure must be counted once, not twice.
    Best-effort: a recorder that cannot run says so on stderr and never
    changes this launcher's exit status.
#>
function Write-RestartOutcome {
    param([Parameter(Mandatory = $true)][int] $Status)

    if ([Environment]::GetEnvironmentVariable("VIBE_SUPERVISOR_RECORDS_OUTCOME")) {
        return
    }
    try {
        Invoke-HostCommand -FilePath $DenoCmd -Capture -ArgumentList @(
            "run",
            "--frozen", "--lock=$BaseDir/worker/deno/deno.lock",
            "--allow-env", "--allow-read", "--allow-write", "--allow-run", "--allow-net",
            "$BaseDir/worker/deno/mod.ts", "container-restart-backoff",
            "--exit-status", "$Status"
        ) | Out-Null
    } catch {
        [Console]::Error.WriteLine(
            "[run.ps1] warning: could not record launcher outcome $Status")
    }
}

<#
.SYNOPSIS
    Exit with a status, recording the outcome on the way out.
#>
function Exit-Launcher {
    param([Parameter(Mandatory = $true)][int] $Code)

    Write-RestartOutcome -Status $Code
    # The comment-stripped Containerfile beside the plan file (Issue #4393)
    # must not outlive the launcher on any exit path.
    if ($PlanFile) {
        Remove-Item -LiteralPath "$PlanFile.Containerfile" -Force -ErrorAction SilentlyContinue
    }
    exit $Code
}

# Run mode (Issues #4146, #4). Container is the only run mode everywhere now,
# as Windows always was (Issue #4145): a configuration naming a removed mode
# (native, seatbelt) must fail loudly rather than quietly launching a
# container the operator never asked for (Issue #3234). The mode is resolved
# by the Deno "run-mode" command, so no shell parses .config.json.
$mode = Invoke-HostCommand -FilePath $DenoCmd -Capture -ArgumentList @(
    "run",
    "--frozen", "--lock=$BaseDir/worker/deno/deno.lock",
    "--allow-env", "--allow-read",
    "$BaseDir/worker/deno/mod.ts", "run-mode"
)
if ($mode.StdErr) { [Console]::Error.Write($mode.StdErr) }
if ($mode.ExitCode -ne 0) {
    [Console]::Error.WriteLine("Error: cannot resolve the run mode (see above)")
    Exit-Launcher 1
}
$RunMode = $mode.StdOut.Trim()
# Container is the only run mode (Issue #4); a removed or unrecognised value
# has already failed loud above, so this is a contract check, not a branch.
if ($RunMode -ne "container") {
    [Console]::Error.WriteLine("Error: unrecognised run mode: $RunMode")
    Exit-Launcher 1
}

$ContainerName = "vibe-coder-$PID"
$PlanFile = Join-Path ([System.IO.Path]::GetTempPath()) `
    ("vibe-launch-plan-" + [System.Guid]::NewGuid().ToString("N"))

$Runtime = ""
$Image = ""
$WatchdogSeconds = ""
$EnsureDirs = [System.Collections.Generic.List[string]]::new()
$VolumeNames = [System.Collections.Generic.List[string]]::new()
$InitArgs = [System.Collections.Generic.List[string]]::new()
$ExistsArgs = [System.Collections.Generic.List[string]]::new()
$BuildArgs = [System.Collections.Generic.List[string]]::new()
$BuilderStopArgs = [System.Collections.Generic.List[string]]::new()
$RunArgs = [System.Collections.Generic.List[string]]::new()

try {
    # The plan resolves and validates the container runtime, computes the
    # content-derived image reference, and constructs the fixed
    # least-privilege mount set. A missing runtime, config file or credential
    # directory exits non-zero here with an actionable message (Issue #3234).
    #
    # --frozen + --lock fail closed on dependency drift (Issue #2896).
    #
    # The plan is written to a file rather than stdout because the worker's
    # console secret redaction (Issue #3661) would mangle a mount value that
    # looks like a credential; --allow-write is scoped to that file plus the
    # read-only config staging directory the plan mounts (Apple container
    # cannot mount a single file, so the command stages a copy there).
    $HomeDir_ = [Environment]::GetEnvironmentVariable("USERPROFILE")
    if (-not $HomeDir_) { $HomeDir_ = [Environment]::GetEnvironmentVariable("HOME") }
    $ConfigStageDir = Join-Path $HomeDir_ ".vibe-coder/run-config"
    $plan = Invoke-HostCommand -FilePath $DenoCmd -Capture -ArgumentList @(
        "run",
        "--frozen", "--lock=$BaseDir/worker/deno/deno.lock",
        "--allow-env", "--allow-read", "--allow-run", "--allow-sys=hostname,systemMemoryInfo", "--allow-write=$PlanFile,$PlanFile.Containerfile,$ConfigStageDir",
        "$BaseDir/worker/deno/mod.ts", "container-launch-plan",
        "--base-dir", $BaseDir,
        "--container-name", $ContainerName,
        "--out", $PlanFile
    )
    # Both streams go to stderr so this launcher's stdout stays the worker's.
    if ($plan.StdOut) { [Console]::Error.Write($plan.StdOut) }
    if ($plan.StdErr) { [Console]::Error.Write($plan.StdErr) }
    if ($plan.ExitCode -ne 0) {
        [Console]::Error.WriteLine(
            "Error: cannot launch the Vibe Coder container (see above)")
        Exit-Launcher 1
    }

    # Read the NUL-delimited "key=value" plan into the argument lists it names.
    foreach ($token in [System.IO.File]::ReadAllText($PlanFile).Split([char]0)) {
        if ($token -eq "") { continue }
        $separator = $token.IndexOf("=")
        if ($separator -lt 0) {
            [Console]::Error.WriteLine("Error: malformed launch-plan token")
            Exit-Launcher 1
        }
        $key = $token.Substring(0, $separator)
        $value = $token.Substring($separator + 1)
        switch -CaseSensitive ($key) {
            "runtime" { $Runtime = $value }
            "image" { $Image = $value }
            "name" { $ContainerName = $value }
            "watchdog" { $WatchdogSeconds = $value }
            "ensure" { $EnsureDirs.Add($value) }
            "volume" { $VolumeNames.Add($value) }
            "init" { $InitArgs.Add($value) }
            "exists" { $ExistsArgs.Add($value) }
            "build" { $BuildArgs.Add($value) }
            "builder-stop" { $BuilderStopArgs.Add($value) }
            "run" { $RunArgs.Add($value) }
            default {
                [Console]::Error.WriteLine(
                    "Error: unrecognised launch-plan key: $key")
                Exit-Launcher 1
            }
        }
    }
} finally {
    Remove-Item -LiteralPath $PlanFile -Force -ErrorAction SilentlyContinue
}

if (-not $Runtime -or -not $Image -or $RunArgs.Count -eq 0 -or
    $BuildArgs.Count -eq 0 -or $ExistsArgs.Count -eq 0 -or
    $VolumeNames.Count -eq 0 -or $InitArgs.Count -eq 0) {
    [Console]::Error.WriteLine(
        "Error: incomplete container launch plan - refusing to launch")
    Exit-Launcher 1
}

# The watchdog deadline is what stops a wedged container blocking this launcher
# for ever (Issue #4173), so a plan without a usable one is a loud failure
# rather than a launch with no deadline at all.
if ($WatchdogSeconds -notmatch '^[1-9][0-9]*$') {
    [Console]::Error.WriteLine(
        "Error: launch plan carries no usable watchdog deadline (got " +
        "`"$WatchdogSeconds`") - refusing to launch")
    Exit-Launcher 1
}
# WaitForExit takes int32 milliseconds, so a deadline beyond ~24 days is
# clamped rather than overflowing into an immediate reap.
$WatchdogMs = [int][Math]::Min([double]$WatchdogSeconds * 1000, 2147483000)

# Exit status this launcher reports after reaping a wedged container - a named
# reason rather than a bare failure, and deliberately outside the runtime CLI's
# own 125/126/127 range. Kept in step with CONTAINER_WEDGED_EXIT_STATUS in
# worker/deno/lib/container_watchdog.ts by the launcher tests (Issue #4173).
$ContainerWedgedExitStatus = 87

# Only the read/write mounts are created here; a missing config file or
# credential directory already failed the plan above.
foreach ($dir in $EnsureDirs) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

# Pre-launch reaper (Issue #4173), before the image build so a leaked VM is not
# still holding the host's memory through it. Any `vibe-coder-*` container
# older than the watchdog deadline - or with no live launcher process behind it,
# which is how a wedge that outlived a host reboot is caught - is killed here.
# Best-effort by design: a reaper that cannot run says so and the launch
# continues, because a leaked container from a previous cycle must not stop
# this one.
$reaped = Invoke-HostCommand -FilePath $DenoCmd -Capture -ArgumentList @(
    "run",
    "--frozen", "--lock=$BaseDir/worker/deno/deno.lock",
    "--allow-env", "--allow-read", "--allow-write", "--allow-run",
    "$BaseDir/worker/deno/mod.ts", "container-reap",
    "--runtime", $Runtime,
    "--stale",
    "--max-age-seconds", $WatchdogSeconds,
    "--exclude", $ContainerName,
    "--refuse-live"
)
if ($reaped.StdOut) { [Console]::Error.Write($reaped.StdOut) }
if ($reaped.StdErr) { [Console]::Error.Write($reaped.StdErr) }
# One worker per host (Issue #26): the work volumes are per-host singletons,
# so a worker container somebody else is running stops this launch here,
# plainly, rather than in the runtime's storage-attachment error. Kept in
# step with ANOTHER_WORKER_RUNNING_EXIT in container_reap.ts.
if ($reaped.ExitCode -eq 4) {
    [Console]::Error.WriteLine(
        "[run.ps1] another worker is already running on this host - one worker per host; not launching (Issue #26)")
    exit 1
}
if ($reaped.ExitCode -ne 0) {
    [Console]::Error.WriteLine(
        "[run.ps1] warning: the pre-launch container reaper did not complete")
}

# Exit status container-build-heal reports for a build failure it does not
# cover, as opposed to 0 (healed - retry) or any other status (the heal itself
# failed). Kept in step with BUILD_NOT_HEALABLE_EXIT in
# worker/deno/commands/container_build_heal.ts by the launcher tests.
$BuildNotHealableExit = 3

<#
.SYNOPSIS
    Append one line to the worker's own host log, best-effort.
.DESCRIPTION
    A fleet host that keeps restarting its builder is visible in run_core.log
    without anyone reading launcher stderr (Issue #4441). An unwritable log
    must never fail a launch.
#>
function Write-RunCoreLog {
    param([Parameter(Mandatory = $true)][string] $Message)

    try {
        # The backslashes escape the literal T and Z for .NET's custom
        # date-format parser, so the stamp matches run.sh's `date -u` exactly.
        $stamp = [DateTime]::UtcNow.ToString("yyyy-MM-dd\THH:mm:ss\Z")
        Add-Content -LiteralPath (Join-Path $HomeDir_ "logs/run_core.log") `
            -Value "$stamp $Message" -ErrorAction Stop
    } catch {
        # Best-effort by design.
    }
}

<#
.SYNOPSIS
    Build the image, capturing its output for the builder heal.
.DESCRIPTION
    The output is captured rather than inherited so container-build-heal can
    classify a failure from the build's own diagnostics (Issue #4441); it is
    written straight back out to stderr, so nothing is lost from the host log.
.OUTPUTS
    The build's exit status.
#>
function Invoke-ImageBuild {
    param([Parameter(Mandatory = $true)][string] $LogPath)

    $build = Invoke-HostCommand -FilePath $Runtime -ArgumentList $BuildArgs -Capture
    $text = "$($build.StdOut)$($build.StdErr)"
    [System.IO.File]::WriteAllText($LogPath, $text)
    if ($text) { [Console]::Error.Write($text) }
    return $build.ExitCode
}

<#
.SYNOPSIS
    Classify a failed build and restart the runtime's builder when it is the
    builder's storage that failed (Issue #4441).
.OUTPUTS
    0 healed (retry the build), 3 not a healable failure, anything else the
    heal itself failed.
#>
function Invoke-BuildHeal {
    param(
        [Parameter(Mandatory = $true)][string] $LogPath,
        [Parameter(Mandatory = $true)][int] $Attempt
    )

    $healed = Invoke-HostCommand -FilePath $DenoCmd -Capture -ArgumentList @(
        "run",
        "--frozen", "--lock=$BaseDir/worker/deno/deno.lock",
        "--allow-env", "--allow-read", "--allow-run",
        "$BaseDir/worker/deno/mod.ts", "container-build-heal",
        "--runtime", $Runtime,
        "--log", $LogPath,
        "--attempt", "$Attempt"
    )
    if ($healed.StdOut) { [Console]::Error.Write($healed.StdOut) }
    if ($healed.StdErr) { [Console]::Error.Write($healed.StdErr) }
    return $healed.ExitCode
}

# Content-derived identity: a changed container definition is a different
# reference, so an absent reference is exactly the rebuild signal (#4062).
$present = Invoke-HostCommand -FilePath $Runtime -ArgumentList $ExistsArgs -Capture
if ($present.ExitCode -ne 0) {
    [Console]::Error.WriteLine("[run.ps1] building $Image")
    Write-LaunchPhase "image_build"
    $BuildLog = Join-Path ([System.IO.Path]::GetTempPath()) `
        ("vibe-build-" + [System.Guid]::NewGuid().ToString("N") + ".log")
    try {
        $buildStatus = Invoke-ImageBuild -LogPath $BuildLog

        # Builder self-heal (Issue #4441). A build that ran the builder's
        # store out of space leaves it unusable until it is restarted, and
        # every later launch then fails before it builds anything. Exactly one
        # heal and one retry per launch: a build that failed for its own
        # reasons still fails here, exactly as it always has.
        if ($buildStatus -ne 0) {
            $healStatus = Invoke-BuildHeal -LogPath $BuildLog -Attempt 1
            if ($healStatus -eq 0) {
                [Console]::Error.WriteLine(
                    "[run.ps1] retrying the build of $Image after a builder restart (Issue #4441)")
                Write-RunCoreLog "container-build-heal: builder restarted after a storage failure - retrying $Image"
                $buildStatus = Invoke-ImageBuild -LogPath $BuildLog
                if ($buildStatus -eq 0) {
                    Write-RunCoreLog "container-build-heal: retry of $Image succeeded"
                } else {
                    # A second failure in the same launch escalates to a
                    # builder recreate, so the next launch starts clean. This
                    # launch still fails - it never loops.
                    Write-RunCoreLog "container-build-heal: retry of $Image failed (status $buildStatus) - recreating the builder"
                    if ((Invoke-BuildHeal -LogPath $BuildLog -Attempt 2) -ne 0) {
                        [Console]::Error.WriteLine(
                            "[run.ps1] warning: could not recreate the $Runtime builder")
                    }
                }
            } elseif ($healStatus -eq $BuildNotHealableExit) {
                Write-RunCoreLog "container-build-heal: $Image build failed for a reason the builder heal does not cover"
            } else {
                Write-RunCoreLog "container-build-heal: could not heal the $Runtime builder (status $healStatus)"
            }
        }

        if ($buildStatus -ne 0) {
            [Console]::Error.WriteLine("Error: failed to build $Image")
            Exit-Launcher $buildStatus
        }
    } finally {
        Remove-Item -LiteralPath $BuildLog -Force -ErrorAction SilentlyContinue
    }
}

# Prune the tags this reference superseded (Issue #4162). The content-derived
# tag rebuilds on every container-definition change and nothing used to delete
# the tag it replaced, so each merged change to container/ leaked a
# multi-gigabyte image until the disk filled. $Image is the only reference a
# future launch of this checkout can use, so every other vibe-coder tag goes - a
# rollback rebuilds from the builder cache, which is deliberately left alone.
# Runs on every launch, not only after a build, so a host already carrying a
# backlog reclaims it now. Best-effort by design: a prune that cannot run says so
# and the launch continues, because reclaiming disk must never block the worker.
$pruned = Invoke-HostCommand -FilePath $DenoCmd -Capture -ArgumentList @(
    "run",
    "--frozen", "--lock=$BaseDir/worker/deno/deno.lock",
    "--allow-env", "--allow-read", "--allow-run",
    "$BaseDir/worker/deno/mod.ts", "container-image-prune",
    "--runtime", $Runtime,
    "--keep", $Image
)
if ($pruned.StdOut) { [Console]::Error.Write($pruned.StdOut) }
if ($pruned.StdErr) { [Console]::Error.Write($pruned.StdErr) }
if ($pruned.ExitCode -ne 0) {
    [Console]::Error.WriteLine(
        "[run.ps1] warning: could not prune superseded $Image tags")
}

# Stop the runtime's persistent build helper (Issue #4331). The plan carries
# the arguments only for runtimes that keep one running after a build
# (Apple container's builder VM); Docker and Podman - what run.ps1 launches -
# supply none, so this is normally a no-op here and exists for plan parity
# with run.sh. Best-effort: an idle builder is waste, not a launch failure.
if ($BuilderStopArgs.Count -gt 0) {
    $builderStop = Invoke-HostCommand -FilePath $Runtime -Capture -ArgumentList $BuilderStopArgs
    if ($builderStop.ExitCode -ne 0) {
        [Console]::Error.WriteLine(
            "[run.ps1] warning: could not stop the $Runtime builder helper")
    }
}

# Named volumes (Issue #4186): the work dir and its approval-state sibling
# live on runtime-managed volumes, not host directories. `volume inspect` /
# `volume create` are spelled identically on Docker and Podman; the plan
# supplies the names. The ownership init runs on every launch - an idempotent
# root chown of the mount roots, so a first launch that dies between create
# and chown heals on the next one.
foreach ($volume in $VolumeNames) {
    $inspected = Invoke-HostCommand -FilePath $Runtime `
        -ArgumentList @("volume", "inspect", $volume) -Capture
    if ($inspected.ExitCode -ne 0) {
        [Console]::Error.WriteLine("[run.ps1] creating volume $volume")
        $created = Invoke-HostCommand -FilePath $Runtime `
            -ArgumentList @("volume", "create", $volume) -Capture
        if ($created.ExitCode -ne 0) {
            [Console]::Error.WriteLine("Error: failed to create volume $volume")
            Exit-Launcher $created.ExitCode
        }
    }
}
$initialised = Invoke-HostCommand -FilePath $Runtime -ArgumentList $InitArgs -Capture
if ($initialised.ExitCode -ne 0) {
    [Console]::Error.WriteLine(
        "Error: the volume-ownership init failed (Issue #4186)")
    Exit-Launcher $initialised.ExitCode
}

Write-LaunchPhase "container_run"

# Start the container rather than waiting on it blindly, so this launcher
# survives to report the container's exit status.
#
# Termination: on Windows a console control event (Ctrl+C, console close) is
# delivered by the OS to every process attached to this console - the runtime
# CLI included - so the CLI proxies the stop to the container and the Deno
# driver's graceful shutdown runs. The finally block below covers the other
# path, a stopped PowerShell pipeline, by stopping the container by name. A
# hard TerminateProcess (Task Scheduler "End task") runs no cleanup anywhere,
# which is why the container is started with --rm under a per-run name.
$runInfo = [System.Diagnostics.ProcessStartInfo]::new()
$runInfo.FileName = $Runtime
foreach ($argument in $RunArgs) { [void]$runInfo.ArgumentList.Add($argument) }
foreach ($argument in $args) { [void]$runInfo.ArgumentList.Add([string]$argument) }
$runInfo.UseShellExecute = $false
$runInfo.RedirectStandardInput = $true

$container = [System.Diagnostics.Process]::Start($runInfo)
$container.StandardInput.Close()

$wedged = $false
try {
    # The outer watchdog (Issue #4173): the runtime client is waited on under
    # the plan's deadline instead of for ever, because a wedged container VM
    # leaves that client waiting on it indefinitely.
    if (-not $container.WaitForExit($WatchdogMs)) {
        $wedged = $true
        [Console]::Error.WriteLine(
            "[run.ps1] watchdog: $ContainerName is still running after " +
            "${WatchdogSeconds}s - reaping it (Issue #4173)")

        $reap = Invoke-HostCommand -FilePath $DenoCmd -Capture -ArgumentList @(
            "run",
            "--frozen", "--lock=$BaseDir/worker/deno/deno.lock",
            "--allow-env", "--allow-read", "--allow-write", "--allow-run",
            "$BaseDir/worker/deno/mod.ts", "container-reap",
            "--runtime", $Runtime,
            "--name", $ContainerName,
            "--client-pid", "$($container.Id)",
            "--reason", "the launcher's ${WatchdogSeconds}s watchdog deadline expired"
        )
        if ($reap.StdOut) { [Console]::Error.Write($reap.StdOut) }
        if ($reap.StdErr) { [Console]::Error.Write($reap.StdErr) }
        if ($reap.ExitCode -ne 0) {
            [Console]::Error.WriteLine(
                "[run.ps1] warning: the container reaper did not clear " +
                $ContainerName)
        }

        # Last resort, whatever the reaper managed: the client must not outlive
        # its own reaping, or this launcher - and the scheduler slot behind it -
        # waits for ever, which is the failure this watchdog exists to end.
        if (-not $container.WaitForExit(60000)) {
            try {
                $container.Kill($true)
            } catch {
                [Console]::Error.WriteLine(
                    "[run.ps1] warning: could not kill the runtime client " +
                    "$($container.Id): $($_.Exception.Message)")
            }
            [void]$container.WaitForExit(30000)
        }
    }
} finally {
    # Best-effort by design: this covers the case where this launcher is
    # stopped and the runtime CLI is not.
    if (-not $container.HasExited) {
        Invoke-HostCommand -FilePath $Runtime -Capture `
            -ArgumentList @("stop", $ContainerName) | Out-Null
        # Bounded: a runtime that cannot stop its own container must not wedge
        # the scheduler slot for ever.
        [void]$container.WaitForExit(60000)
    }
}

if (-not $container.HasExited) {
    [Console]::Error.WriteLine(
        "Error: $Runtime could not stop container $ContainerName")
    Exit-Launcher 1
}

if ($wedged) {
    [Console]::Error.WriteLine(
        "Error: container $ContainerName wedged past the ${WatchdogSeconds}s " +
        "watchdog deadline and was reaped - exiting " +
        "$ContainerWedgedExitStatus so the next cycle runs (Issue #4173)")
    Exit-Launcher $ContainerWedgedExitStatus
}

Exit-Launcher $container.ExitCode
