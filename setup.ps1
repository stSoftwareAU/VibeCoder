################################################################################
# setup.ps1
#
# The PowerShell twin of setup.sh (Issue #4185), so a Windows host can join the
# fleet without WSL or Git Bash.
#
# Like setup.sh this is a thin orchestrator: everything platform-neutral lives
# in the Deno setup CLI (worker/deno/setup/setup_cli.ts) and is delegated to it
# unchanged. What is implemented here is only the part that cannot be: the
# interactive terminal layer — prompts, the credential flow, and the offer to
# register the scheduled task.
#
# The Vibe Coder is designed to run on unattended machines. All interactions
# happen via GitHub issues and PRs. Nothing on the runtime path may wait on a
# UI, which is exactly why credentials are minted once, here, at setup time.
#
# Usage:
#   $env:VIBE_ALLOWED_AUTHOR = "myuser"
#   $env:VIBE_REPOS = "org/repo1,org/repo2"
#   .\setup.ps1
#
# Differences from setup.sh, all deliberate:
#   - Windows is container-only (Issue #4145), so the worker image supplies jq,
#     the coding-agent CLI and coreutils `timeout`; none is needed on the host.
#   - The interactive config merge uses PowerShell's own JSON support instead of
#     jq, so the host needs no jq at all.
#   - `claude setup-token` is captured through a redirected transcript, because
#     PowerShell has no script(1) to give the CLI a pty. When no token can be
#     read back, setup falls back to the paste prompt rather than pretending.
#   - Task Scheduler replaces the macOS LaunchAgent, and its definition embeds
#     no secrets — the worker reads credentials from the credential directory.
#
# Environment variables: identical to setup.sh (VIBE_ALLOWED_AUTHOR,
# VIBE_REPOS, VIBE_CREDENTIAL_DIR, VIBE_LAUNCHAGENT_GH_TOKEN, ...). See the
# header of setup.sh for the full list; the ones specific to this script are:
#   VIBE_SKIP_SCHTASKS - Set to "true" to write the task definition without
#                        registering it (testing).
#   VIBE_TASK_USER     - Principal the scheduled task runs as.
#                        Defaults to the account running setup.
################################################################################

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = if ($PSScriptRoot) {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Definition
}

$ConfigFile = if ($env:CONFIG_FILE) {
    $env:CONFIG_FILE
} else {
    Join-Path $ScriptDir ".config.json"
}

# `$IsWindows` only exists in PowerShell Core, and Set-StrictMode makes reading
# an undefined variable a hard error — so the platform is resolved once, here,
# in a way Windows PowerShell 5.1 answers too.
$script:VibeIsWindows =
    ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)

$SetupCli = Join-Path $ScriptDir "worker/deno/setup/setup_cli.ts"
$DenoLock = Join-Path $ScriptDir "worker/deno/deno.lock"

# Set when this run provisioned (or found) usable gh material — consumed by
# the interactive prompts to default gh_config_dir and skip the login offer.
$script:VibeProvisionedGhConfigDir = ""

################################################################################
# Shared utility functions
################################################################################

function Write-VibeInfo {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Message)
    Write-Host "[i]  $Message"
}

function Write-VibeSuccess {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Message)
    Write-Host "[ok] $Message"
}

function Write-VibeWarning {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Message)
    Write-Host "[!]  $Message"
}

function Write-VibeError {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Message)
    [Console]::Error.WriteLine("[x]  $Message")
}

<#
.SYNOPSIS
    The operator's home directory, in Windows spelling where there is one.
#>
function Get-VibeHomeDirectory {
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    if ($env:HOME) { return $env:HOME }
    return [System.IO.Path]::GetTempPath()
}

<#
.SYNOPSIS
    Is setup attached to a terminal?

.DESCRIPTION
    The twin of setup.sh's `[[ -t 0 ]]`. A run without a terminal — Task
    Scheduler, CI — must never block on a prompt, so every interactive step is
    gated on this.
#>
function Test-VibeInteractive {
    return (-not [Console]::IsInputRedirected)
}

<#
.SYNOPSIS
    Restrict a path to its owner.

.DESCRIPTION
    The equivalent of setup.sh's `chmod 700`/`chmod 600`. On Windows the path's
    ACL is de-inherited and reduced to the current account; elsewhere the POSIX
    mode is set, so the credential preflight sees exactly what setup.sh leaves.

.PARAMETER Path
    File or directory to restrict.

.PARAMETER Mode
    POSIX mode used off Windows: 700 for a directory, 600 for a file.
#>
function Protect-VibePath {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Mode
    )

    if ($script:VibeIsWindows) {
        $acl = Get-Acl -LiteralPath $Path
        # Drop inherited access outright: a credential directory under a
        # profile that grants Users read access would otherwise stay readable.
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) {
            [void]$acl.RemoveAccessRule($rule)
        }
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $inheritance = if (Test-Path -LiteralPath $Path -PathType Container) {
            "ContainerInherit,ObjectInherit"
        } else {
            "None"
        }
        $acl.AddAccessRule(
            [System.Security.AccessControl.FileSystemAccessRule]::new(
                $identity, "FullControl", $inheritance, "None", "Allow"))
        Set-Acl -LiteralPath $Path -AclObject $acl
        return
    }

    & chmod $Mode $Path
    if ($LASTEXITCODE -ne 0) {
        throw "chmod $Mode $Path failed with exit code $LASTEXITCODE"
    }
}

<#
.SYNOPSIS
    Write a file with LF endings and no byte-order mark.

.DESCRIPTION
    Credential and config files are read by Deno inside a Linux container, so a
    CRLF or a BOM PowerShell would add by default is a real defect, not a
    formatting preference.
#>
function Write-VibeTextFile {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Content
    )
    [System.IO.File]::WriteAllText(
        $Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

################################################################################
# Vibe credential provisioning (Issue #4064, parent #4060)
#
# The layout, permissions and precedence are setup.sh's:
#
#   <credential dir>/            owner only
#   |- gh/hosts.yml              the worker's GH_CONFIG_DIR material
#   \- <provider>/provider.env   one credential per agent vendor
################################################################################

<#
.SYNOPSIS
    Absolute path of the credential directory (VIBE_CREDENTIAL_DIR overrides).
#>
function Get-VibeCredentialDir {
    if ($env:VIBE_CREDENTIAL_DIR) { return $env:VIBE_CREDENTIAL_DIR }
    return (Join-Path (Get-VibeHomeDirectory) ".vibe-coder/credentials")
}

<#
.SYNOPSIS
    The credential facets of every registered coding-agent provider.

.DESCRIPTION
    Mirrors `vibe_provider_credential_table` in setup.sh, which in turn mirrors
    the descriptors in worker/deno/lib/agent_provider.ts. Those descriptors stay
    the single source of truth; worker/deno/tests/setup_ps1_test.ts calls this
    function and fails the quality gate when the three drift.
#>
function Get-VibeProviderCredentialTable {
    return @(
        [pscustomobject]@{
            Subdir       = "claude"
            ProvisionVar = "VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY"
            Vars         = @(
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN")
        },
        [pscustomobject]@{
            Subdir       = "codex"
            ProvisionVar = "VIBE_LAUNCHAGENT_OPENAI_API_KEY"
            Vars         = @("OPENAI_API_KEY", "CODEX_API_KEY")
        },
        [pscustomobject]@{
            Subdir       = "gemini"
            ProvisionVar = "VIBE_LAUNCHAGENT_GEMINI_API_KEY"
            Vars         = @("GEMINI_API_KEY", "GOOGLE_API_KEY")
        }
    )
}

<#
.SYNOPSIS
    Write a self-contained hosts.yml with the token inline.

.DESCRIPTION
    Never a keychain or Credential Manager reference, which the container
    cannot reach (Issue #4064). The login lookup completes the host entry; a
    failure there is not fatal, the token alone authenticates.
#>
function Write-VibeGhHostsFile {
    param(
        [Parameter(Mandatory = $true)][string] $GhDir,
        [Parameter(Mandatory = $true)][string] $Token
    )

    $login = ""
    if (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue) {
        try {
            $previous = $env:GH_TOKEN
            $env:GH_TOKEN = $Token
            $login = (& gh api user --jq .login 2>$null | Select-Object -First 1)
            if ($LASTEXITCODE -ne 0) { $login = "" }
            $env:GH_TOKEN = $previous
        } catch {
            $login = ""
        }
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("github.com:")
    $lines.Add("    oauth_token: $Token")
    $lines.Add("    git_protocol: ssh")
    if ($login) {
        $lines.Add("    user: $login")
        $lines.Add("    users:")
        $lines.Add("        ${login}:")
        $lines.Add("            oauth_token: $Token")
    }

    $path = Join-Path $GhDir "hosts.yml"
    Write-VibeTextFile -Path $path -Content (($lines -join "`n") + "`n")
    Protect-VibePath -Path $path -Mode "600"
}

<#
.SYNOPSIS
    Provision one provider's credential file from the environment.

.DESCRIPTION
    The provisioning variable wins; failing that, the provider's own credential
    variables are read in the order the descriptor lists them. Setting neither
    leaves that provider unprovisioned and never touches an existing file, so
    provisioning one vendor cannot wipe another's credential.

.OUTPUTS
    True when a credential was written, false when there was nothing to write.
#>
function Set-VibeProviderCredential {
    param(
        [Parameter(Mandatory = $true)][string] $Dir,
        [Parameter(Mandatory = $true)][pscustomobject] $Provider
    )

    $name = ""
    $value = ""
    $provisioned = [Environment]::GetEnvironmentVariable($Provider.ProvisionVar)
    if ($provisioned) {
        $name = $Provider.Vars[0]
        $value = $provisioned
    } else {
        foreach ($candidate in $Provider.Vars) {
            $candidateValue = [Environment]::GetEnvironmentVariable($candidate)
            if ($candidateValue) {
                $name = $candidate
                $value = $candidateValue
                break
            }
        }
    }

    if (-not $value) { return $false }

    $providerDir = Join-Path $Dir $Provider.Subdir
    New-Item -ItemType Directory -Force -Path $providerDir | Out-Null
    Protect-VibePath -Path $Dir -Mode "700"
    Protect-VibePath -Path $providerDir -Mode "700"

    $file = Join-Path $providerDir "provider.env"
    Write-VibeTextFile -Path $file -Content "$name=$value`n"
    Protect-VibePath -Path $file -Mode "600"
    Write-VibeSuccess ("Provisioned $($Provider.Subdir) credential " +
        "(owner-only) in $file")
    return $true
}

<#
.SYNOPSIS
    Provision the credential directory non-interactively from the environment.
#>
function Invoke-VibeCredentialProvisioning {
    $dir = Get-VibeCredentialDir
    $ghDir = Join-Path $dir "gh"

    $ghToken = if ($env:VIBE_LAUNCHAGENT_GH_TOKEN) {
        $env:VIBE_LAUNCHAGENT_GH_TOKEN
    } elseif ($env:GH_TOKEN) {
        $env:GH_TOKEN
    } else {
        ""
    }

    # One credential per enabled vendor (Issue #4108): every registered
    # provider is offered its own variables, and each writes only its own file.
    $wroteAny = $false
    $provisionVars = @()
    foreach ($provider in Get-VibeProviderCredentialTable) {
        $provisionVars += $provider.ProvisionVar
        if (Set-VibeProviderCredential -Dir $dir -Provider $provider) {
            $wroteAny = $true
        }
    }

    if (-not $ghToken -and -not $wroteAny) {
        if (Test-Path -LiteralPath (Join-Path $ghDir "hosts.yml")) {
            $script:VibeProvisionedGhConfigDir = $ghDir
            Write-VibeInfo ("Credential directory $dir left unchanged " +
                "(no credential variables set)")
        } else {
            Write-VibeWarning ("No credential variables set - set " +
                "VIBE_LAUNCHAGENT_GH_TOKEN and one of " +
                "$($provisionVars -join ' / ') to provision $dir " +
                "non-interactively")
        }
        return
    }

    if ($ghToken) {
        New-Item -ItemType Directory -Force -Path $ghDir | Out-Null
        Protect-VibePath -Path $dir -Mode "700"
        Protect-VibePath -Path $ghDir -Mode "700"
        Write-VibeGhHostsFile -GhDir $ghDir -Token $ghToken
        $script:VibeProvisionedGhConfigDir = $ghDir
        Write-VibeSuccess ("Provisioned GitHub credential (owner-only) in " +
            "$ghDir/hosts.yml")
    }
}

<#
.SYNOPSIS
    Prove a provisioned claude credential works.

.DESCRIPTION
    The twin of setup.sh's `claude_credential_is_valid` (Issue #4161). The
    stored credential is exercised with a real completion, with any
    ANTHROPIC_*/CLAUDE_* material in the operator's own environment removed
    first so only the stored credential is tested.

    Only a DEFINITIVE authentication failure condemns the credential. A
    rate-limited answer proves the token authenticated, and a network failure
    proves nothing about it, so both keep the credential with a warning.
#>
function Test-VibeClaudeCredential {
    param([Parameter(Mandatory = $true)][string] $Path)

    if (-not (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue)) {
        return $true
    }

    $overridden = @(
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")
    $saved = @{}
    foreach ($name in $overridden) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name, $null)
    }

    try {
        foreach ($line in Get-Content -LiteralPath $Path) {
            $separator = $line.IndexOf("=")
            if ($separator -lt 1) { continue }
            [Environment]::SetEnvironmentVariable(
                $line.Substring(0, $separator), $line.Substring($separator + 1))
        }

        $output = (& claude -p "Say hello" 2>&1 | Out-String)
        $status = $LASTEXITCODE
    } catch {
        $output = $_.Exception.Message
        $status = 1
    } finally {
        foreach ($name in $overridden) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name])
        }
    }

    if ($status -eq 0 -and $output.Trim()) { return $true }

    if ($output -match '(?i)invalid api key|run /login|oauth.*(expired|revoked|invalid)|authentication[_ ]?error|401 unauthorized') {
        return $false
    }
    if ($output -match '(?i)limit reached|rate.?limit|overloaded|529') {
        Write-VibeWarning ("claude is rate-limited right now - the credential " +
            "authenticated, keeping it (usage window resets on its own)")
        return $true
    }
    $detail = $output.Trim()
    if ($detail.Length -gt 160) { $detail = $detail.Substring(0, 160) }
    Write-VibeWarning ("Could not confirm the claude credential (claude said: " +
        "$detail) - keeping it")
    return $true
}

<#
.SYNOPSIS
    Extract the OAuth token from a `claude setup-token` transcript.

.DESCRIPTION
    Split out from the capture below so the extraction is testable without
    running the CLI: the token is whatever last matches the sk-ant-oat01 shape.
#>
function Get-VibeSetupTokenFromTranscript {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Transcript)

    $matched = [regex]::Matches($Transcript, 'sk-ant-oat01-[A-Za-z0-9_-]+')
    if ($matched.Count -eq 0) { return "" }
    return $matched[$matched.Count - 1].Value
}

<#
.SYNOPSIS
    Run `claude setup-token` and capture the token it prints.

.DESCRIPTION
    setup.sh gives the CLI a pty with script(1); PowerShell has no equivalent,
    so the session is teed to an owner-only transcript instead — the operator
    still sees the sign-in instructions, and the token is read back from the
    transcript. The transcript is deleted immediately: the token lives only in
    the credential file the caller writes.

    Returns an empty string when nothing could be captured, so the caller falls
    back to the paste prompt rather than reporting a success it did not have.
#>
function Get-VibeSetupToken {
    if (-not (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue)) {
        return ""
    }

    $transcript = Join-Path ([System.IO.Path]::GetTempPath()) `
        ("vibe-setup-token-" + [System.Guid]::NewGuid().ToString("N") + ".log")
    try {
        Write-VibeTextFile -Path $transcript -Content ""
        Protect-VibePath -Path $transcript -Mode "600"
        # Tee, not redirect: the operator must still see the URL and the code
        # prompt while the session is being recorded.
        & claude setup-token 2>&1 | Tee-Object -FilePath $transcript
        return (Get-VibeSetupTokenFromTranscript `
            -Transcript (Get-Content -Raw -LiteralPath $transcript))
    } catch {
        Write-VibeWarning "claude setup-token could not be run: $($_.Exception.Message)"
        return ""
    } finally {
        Remove-Item -LiteralPath $transcript -Force -ErrorAction SilentlyContinue
    }
}

<#
.SYNOPSIS
    Read a secret from the terminal without echoing it.
#>
function Read-VibeSecret {
    param([Parameter(Mandatory = $true)][string] $Prompt)

    $secure = Read-Host -Prompt $Prompt -AsSecureString
    if (-not $secure -or $secure.Length -eq 0) { return "" }
    $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

<#
.SYNOPSIS
    Fill remaining credential gaps interactively (Issue #4161).

.PARAMETER GhSource
    The gh config directory to offer as the copy source ("" for none).
#>
function Invoke-VibeInteractiveCredentials {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $GhSource)

    $dir = Get-VibeCredentialDir
    $ghHosts = Join-Path $dir "gh/hosts.yml"

    if (-not (Test-Path -LiteralPath $ghHosts)) {
        $expandedSource = if ($GhSource) {
            $GhSource -replace '^~', (Get-VibeHomeDirectory)
        } else {
            ""
        }
        if ($expandedSource -and
            (Test-Path -LiteralPath (Join-Path $expandedSource "hosts.yml"))) {
            $answer = Read-Host ("  Copy the worker gh identity from " +
                "$GhSource into $dir/gh? [Y/n]")
            if ($answer -notmatch '^[nN]') {
                $ghDir = Join-Path $dir "gh"
                New-Item -ItemType Directory -Force -Path $ghDir | Out-Null
                Protect-VibePath -Path $dir -Mode "700"
                Protect-VibePath -Path $ghDir -Mode "700"
                # The host login usually keeps its token in Windows Credential
                # Manager, which the container cannot reach — extract it and
                # write a self-contained hosts.yml (Issue #4064).
                $sourceToken = ""
                if (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue) {
                    $previous = $env:GH_CONFIG_DIR
                    $env:GH_CONFIG_DIR = $expandedSource
                    $sourceToken = (& gh auth token 2>$null | Select-Object -First 1)
                    if ($LASTEXITCODE -ne 0) { $sourceToken = "" }
                    $env:GH_CONFIG_DIR = $previous
                }
                if ($sourceToken) {
                    Write-VibeGhHostsFile -GhDir $ghDir -Token $sourceToken
                    $script:VibeProvisionedGhConfigDir = $ghDir
                    Write-VibeSuccess ("Copied gh identity (token " +
                        "materialised, owner-only) into $ghDir/hosts.yml")
                } elseif ((Get-Content -Raw -LiteralPath (Join-Path $expandedSource "hosts.yml")) -match '(?m)^\s*oauth_token:') {
                    Copy-Item -LiteralPath (Join-Path $expandedSource "hosts.yml") `
                        -Destination $ghHosts -Force
                    Protect-VibePath -Path $ghHosts -Mode "600"
                    $script:VibeProvisionedGhConfigDir = $ghDir
                    Write-VibeSuccess ("Copied gh identity (owner-only) into " +
                        "$ghHosts")
                } else {
                    Write-VibeWarning ("The gh login keeps its token in " +
                        "Windows Credential Manager and none could be " +
                        "extracted - set VIBE_LAUNCHAGENT_GH_TOKEN and re-run " +
                        "setup")
                }
            } else {
                Write-VibeWarning ("No gh credential - set " +
                    "VIBE_LAUNCHAGENT_GH_TOKEN and re-run setup to provision it")
            }
        } else {
            Write-VibeWarning ("No gh credential and nothing to copy - set " +
                "VIBE_LAUNCHAGENT_GH_TOKEN and re-run setup")
        }
    }

    $claudeEnv = Join-Path $dir "claude/provider.env"

    # An existing credential is exercised for real before it is trusted: an
    # expired or revoked token is discarded here so the acquisition below
    # replaces it, instead of the worker discovering the problem at 3am.
    if ((Test-Path -LiteralPath $claudeEnv) -and
        -not (Test-VibeClaudeCredential -Path $claudeEnv)) {
        Write-VibeWarning ("Stored claude credential failed validation " +
            "(expired token?) - replacing it")
        Remove-Item -LiteralPath $claudeEnv -Force
    }

    # Rotation path for a still-valid credential: offer to replace, default keep.
    if (Test-Path -LiteralPath $claudeEnv) {
        $replace = Read-Host ("  Claude credential already provisioned - " +
            "replace it (e.g. expired token)? [y/N]")
        if ($replace -match '^[yY]') { Remove-Item -LiteralPath $claudeEnv -Force }
    }

    # Two acquisition attempts: a token that fails its validation call is
    # removed and the offer repeats once before setup gives up loudly.
    foreach ($attempt in 1, 2) {
        if (Test-Path -LiteralPath $claudeEnv) { break }
        $oauthToken = ""

        if (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue) {
            Write-VibeInfo "The containerised worker cannot reach Windows Credential Manager,"
            Write-VibeInfo "so the claude CLI needs a long-lived OAuth token. Setup can run"
            Write-VibeInfo "``claude setup-token`` for you: a browser opens, you sign in with the"
            Write-VibeInfo "Claude account that holds your subscription, and the token is"
            Write-VibeInfo "captured automatically. (The token bills that subscription and can"
            Write-VibeInfo "only ever rate-limit - never run up per-token API charges. It lasts"
            Write-VibeInfo "about a year; re-run .\setup.ps1 to replace it when it expires.)"
            $runSetupToken = Read-Host "  Run ``claude setup-token`` now? [Y/n]"
            if ($runSetupToken -notmatch '^[nN]') {
                $oauthToken = Get-VibeSetupToken
                if (-not $oauthToken) {
                    Write-VibeWarning ("No token captured from claude " +
                        "setup-token - paste one instead")
                }
            }
        }

        if (-not $oauthToken) {
            Write-VibeInfo "To generate the token by hand:"
            Write-Host ""
            Write-Host "    1. Open a second terminal (leave this prompt waiting)."
            Write-Host "    2. Run:  claude setup-token"
            Write-Host "    3. A browser opens - sign in with the Claude account that holds"
            Write-Host "       your subscription. This token bills that subscription and can"
            Write-Host "       only ever rate-limit, never run up per-token API charges."
            Write-Host "    4. Copy the printed token (starts with sk-ant-oat01-...)."
            Write-Host "    5. Paste it below and press Enter. Nothing appears as you paste -"
            Write-Host "       input is hidden so the token stays out of your scrollback."
            Write-Host ""
            $oauthToken = Read-VibeSecret `
                -Prompt "  CLAUDE_CODE_OAUTH_TOKEN (input hidden; Enter to skip)"
        }

        # Enter alone skips — leave the loop rather than re-asking.
        if (-not $oauthToken) { break }

        $claudeDir = Join-Path $dir "claude"
        New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
        Protect-VibePath -Path $dir -Mode "700"
        Protect-VibePath -Path $claudeDir -Mode "700"
        Write-VibeTextFile -Path $claudeEnv `
            -Content "CLAUDE_CODE_OAUTH_TOKEN=$oauthToken`n"
        Protect-VibePath -Path $claudeEnv -Mode "600"

        # The proof is a real completion, not the write (Issue #3234).
        if (Test-VibeClaudeCredential -Path $claudeEnv) {
            Write-VibeSuccess ("Provisioned claude credential (owner-only) in " +
                "$claudeEnv - validated with a live claude call")
        } else {
            Remove-Item -LiteralPath $claudeEnv -Force
            Write-VibeWarning ("The new claude credential failed validation " +
                "(claude could not authenticate with it)")
        }
    }

    if (-not (Test-Path -LiteralPath $claudeEnv)) {
        Write-VibeWarning ("No claude credential - the containerised worker " +
            "fails its credential preflight until one is provisioned")
    }
}

<#
.SYNOPSIS
    TTY gate + config lookup for the credential flow.
#>
function Invoke-VibeInteractiveCredentialsPrompt {
    if (-not (Test-VibeInteractive)) { return }

    $ghSource = ""
    if (Test-Path -LiteralPath $ConfigFile) {
        $config = Read-VibeConfigFile
        if ($config -and $config.PSObject.Properties.Name -contains "gh_config_dir") {
            $ghSource = [string]$config.gh_config_dir
        }
    }
    Invoke-VibeInteractiveCredentials -GhSource $ghSource
}

################################################################################
# Deno setup CLI helper
#
# All platform-neutral setup logic lives in worker/deno/setup/setup_cli.ts
# (Issue #923). This script is a thin orchestrator that handles interactive
# prompting and delegates everything else to that CLI.
################################################################################

<#
.SYNOPSIS
    Locate Deno on the host, the way run.ps1 does.
#>
function Get-VibeDenoCommand {
    foreach ($candidate in @(
            "deno",
            "$env:USERPROFILE\.deno\bin\deno.exe",
            "$env:HOME/.deno/bin/deno",
            "/opt/homebrew/bin/deno",
            "/usr/local/bin/deno"
        )) {
        if (-not $candidate) { continue }
        $found = Get-Command $candidate -CommandType Application `
            -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { return $found.Source }
    }
    return $null
}

<#
.SYNOPSIS
    Run one setup CLI subcommand.

.DESCRIPTION
    --frozen + --lock fail closed on dependency drift (Issues #2896, #3653),
    mirroring setup.sh, run.ps1 and worker/shared/deno_bridge.sh: a stale or
    missing lockfile is a hard error rather than a silent re-resolve that could
    pull unreviewed transitive code into this credential-handling process.

.OUTPUTS
    True when the subcommand exited zero.
#>
function Invoke-VibeSetupCli {
    param([Parameter(Mandatory = $true)][string[]] $Arguments)

    $deno = Get-VibeDenoCommand
    if (-not $deno) {
        Write-VibeError "deno is required but not installed."
        Write-VibeInfo "Deno is core to Vibe Coder for TypeScript business logic."
        Write-VibeInfo "Install it with: winget install --exact --id DenoLand.Deno --source winget"
        exit 1
    }

    $argv = @("run", "--frozen", "--lock=$DenoLock", "--allow-all", $SetupCli) +
        $Arguments +
        @("--script-dir", $ScriptDir, "--config-path", $ConfigFile)
    & $deno @argv
    return ($LASTEXITCODE -eq 0)
}

<#
.SYNOPSIS
    Run a setup CLI subcommand that setup cannot continue without.
#>
function Invoke-VibeSetupCliOrExit {
    param([Parameter(Mandatory = $true)][string[]] $Arguments)

    if (-not (Invoke-VibeSetupCli -Arguments $Arguments)) {
        Write-VibeError "setup step '$($Arguments[0])' failed - stopping"
        exit 1
    }
}

################################################################################
# Interactive prompts (Issue #583)
################################################################################

<#
.SYNOPSIS
    Read .config.json, or $null when it is absent or unreadable.

.DESCRIPTION
    PowerShell parses JSON natively, so — unlike setup.sh — no jq is needed on
    the host to read or merge the config (Windows is container-only, and jq
    lives in the image).
#>
function Read-VibeConfigFile {
    if (-not (Test-Path -LiteralPath $ConfigFile)) { return $null }
    try {
        $raw = Get-Content -Raw -LiteralPath $ConfigFile
        if (-not $raw.Trim()) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch {
        Write-VibeWarning "Could not parse $ConfigFile : $($_.Exception.Message)"
        return $null
    }
}

<#
.SYNOPSIS
    Split a comma-separated answer into a trimmed, non-empty array.
#>
function ConvertTo-VibeList {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Value)

    return @($Value -split ',' |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -ne "" })
}

<#
.SYNOPSIS
    Read one config property as a string, or "" when it is absent.
#>
function Get-VibeConfigValue {
    param(
        [Parameter(Mandatory = $true)][AllowNull()] $Config,
        [Parameter(Mandatory = $true)][string] $Name
    )

    if (-not $Config) { return "" }
    if ($Config.PSObject.Properties.Name -notcontains $Name) { return "" }
    $value = $Config.$Name
    if ($null -eq $value) { return "" }
    if ($value -is [System.Array]) { return ($value -join ",") }
    return [string]$value
}

<#
.SYNOPSIS
    Prompt for the key configuration values, defaulting to what is already set.

.OUTPUTS
    An ordered hashtable of the answers to merge into .config.json.
#>
function Read-VibeInteractiveConfig {
    $answers = [ordered]@{}
    if (-not (Test-VibeInteractive)) { return $answers }

    Write-Host ""
    Write-VibeInfo "Interactive configuration (press Enter to keep existing values)"
    Write-Host ""

    $config = Read-VibeConfigFile
    $existing = [ordered]@{
        repos            = Get-VibeConfigValue -Config $config -Name "repos"
        allowed_authors  = Get-VibeConfigValue -Config $config -Name "allowed_authors"
        service_accounts = Get-VibeConfigValue -Config $config -Name "service_accounts"
        ssh_key_path     = Get-VibeConfigValue -Config $config -Name "ssh_key_path"
        gh_config_dir    = Get-VibeConfigValue -Config $config -Name "gh_config_dir"
        imgbb_api_key    = Get-VibeConfigValue -Config $config -Name "imgbb_api_key"
    }

    <# Ask one question, falling back to the existing value on a bare Enter. #>
    function Read-Answer {
        param([string] $Prompt, [string] $Existing, [string[]] $Notes = @())

        $suffix = if ($Existing) { " [$Existing]" } else { "" }
        Write-Host "  $Prompt$suffix"
        foreach ($note in $Notes) { Write-Host "  $note" }
        $answer = Read-Host "  >"
        Write-Host ""
        if ($answer) { return $answer }
        return $Existing
    }

    $repos = Read-Answer `
        -Prompt "Repositories to monitor (comma-separated, e.g. org/repo1,org/repo2)" `
        -Existing $existing.repos
    if ($repos) { $answers.repos = ConvertTo-VibeList -Value $repos }

    $authors = Read-Answer `
        -Prompt "GitHub username(s) to process issues from (comma-separated)" `
        -Existing $existing.allowed_authors
    if ($authors) { $answers.allowed_authors = ConvertTo-VibeList -Value $authors }

    $serviceAccounts = Read-Answer `
        -Prompt "Service account login(s) this fleet runs as (comma-separated)" `
        -Existing $existing.service_accounts `
        -Notes @(
            "The worker refuses to run as any account not on this list.",
            "Leave blank to default to the account you are authenticated as.")
    if ($serviceAccounts) {
        $answers.service_accounts = ConvertTo-VibeList -Value $serviceAccounts
    }

    $sshKey = Read-Answer `
        -Prompt "SSH key path for service account (optional)" `
        -Existing $existing.ssh_key_path `
        -Notes @(
            "Used for all git clone/push/fetch operations.",
            "Leave blank to use your default SSH identity.")
    if ($sshKey) {
        $expanded = $sshKey -replace '^~', (Get-VibeHomeDirectory)
        if (-not (Test-Path -LiteralPath $expanded)) {
            Write-VibeWarning ("SSH key not found at $sshKey - saving anyway " +
                "(create it before running the worker)")
        }
        $answers.ssh_key_path = $sshKey
    }

    $ghDefault = if ($script:VibeProvisionedGhConfigDir) {
        $script:VibeProvisionedGhConfigDir
    } else {
        Join-Path (Get-VibeHomeDirectory) ".config/gh-vibe"
    }
    $ghConfigDir = Read-Answer `
        -Prompt "gh config directory for service account (optional)" `
        -Existing (if ($existing.gh_config_dir) { $existing.gh_config_dir } else { $ghDefault }) `
        -Notes @("Used for all gh CLI operations (separate from personal gh auth).")
    if ($ghConfigDir) { $answers.gh_config_dir = $ghConfigDir }

    $imgbb = Read-Answer `
        -Prompt "ImgBB API key for automatic screenshot uploads (optional)" `
        -Existing $existing.imgbb_api_key `
        -Notes @(
            "Get a free key from https://api.imgbb.com/",
            "Without this, screenshots are saved locally only.")
    if ($imgbb) { $answers.imgbb_api_key = $imgbb }

    # FLEET health tracking (optional, Issue #535). A fleet of workers can
    # report into a shared health repository; a single host does not need one.
    # Setup asks where that repository is and stores the answer in
    # .config.json (fleet_health_repo + fleet_health_dir) — a one-off, no
    # environment variables. Nothing is cloned unless the operator named the
    # repository: an assumed URL on a host without access to it only ever
    # produced "Could not read from remote repository ... repository exists".
    $fleetRepo = Read-Answer `
        -Prompt "FLEET health repository (optional): git URL of the fleet's health repository" `
        -Existing $existing.fleet_health_repo `
        -Notes @(
            "e.g. git@github.com:your-org/your-health-repo.git",
            "Leave blank to keep the current value, or '-' to turn health tracking off.")
    if ($fleetRepo -eq "-") {
        $answers.fleet_health_repo = $null
        $answers.fleet_health_dir = $null
        Write-VibeInfo "FLEET health tracking turned off."
    } elseif ($fleetRepo) {
        # Checkout directory: the configured one, else a sibling of VibeCoder
        # named after the repository (git@host:org/GRQ-health.git -> ..\GRQ-health).
        $fleetRepoName = ($fleetRepo -split "/")[-1] -replace "\.git$", ""
        $fleetDefaultDir = if ($existing.fleet_health_dir) {
            $existing.fleet_health_dir
        } else {
            Join-Path (Split-Path -Parent $ScriptDir) $fleetRepoName
        }
        $fleetDir = Read-Answer `
            -Prompt "FLEET health checkout directory" `
            -Existing $fleetDefaultDir
        $answers.fleet_health_repo = $fleetRepo
        # The directory is recorded either way: the worker clones
        # fleet_health_repo there itself when it is missing, so a clone that
        # failed here (network, key not yet authorised) self-heals on the
        # first run instead of leaving tracking silently off.
        $answers.fleet_health_dir = $fleetDir
        if (Test-Path -LiteralPath $fleetDir -PathType Container) {
            Write-VibeSuccess "FLEET health directory found at $fleetDir"
        } else {
            Write-VibeInfo "Cloning FLEET health repository to $fleetDir..."
            & git clone $fleetRepo $fleetDir
            if ($LASTEXITCODE -eq 0) {
                Write-VibeSuccess "FLEET health repository cloned"
            } else {
                Write-VibeWarning ("Failed to clone FLEET health repository from $fleetRepo " +
                    "(non-fatal; the worker retries the clone on its first run)")
            }
        }
    } else {
        Write-VibeInfo "FLEET health tracking not configured (optional) - re-run setup and give the repository's git URL to enable it."
    }

    return $answers
}

<#
.SYNOPSIS
    Merge the interactive answers into .config.json.

.DESCRIPTION
    setup.sh needs jq here and exits when it is missing rather than dropping the
    answers silently (Issue #3234). PowerShell parses and writes JSON itself, so
    the same honesty costs no host dependency — but a config file that cannot be
    read is still a loud failure, never a silent overwrite.
#>
function Write-VibeInteractiveConfig {
    param([Parameter(Mandatory = $true)] $Answers)

    if ($Answers.Count -eq 0) { return }

    $config = Read-VibeConfigFile
    if (-not $config) {
        Write-VibeError ("$ConfigFile could not be read, so the interactive " +
            "answers cannot be merged into it")
        exit 1
    }

    foreach ($name in $Answers.Keys) {
        # A $null answer means "drop this key" (the '-' reply at an optional
        # prompt), not "store null".
        if ($null -eq $Answers[$name]) {
            $config.PSObject.Properties.Remove($name)
            continue
        }
        $config | Add-Member -NotePropertyName $name `
            -NotePropertyValue $Answers[$name] -Force
    }

    Write-VibeTextFile -Path $ConfigFile `
        -Content (($config | ConvertTo-Json -Depth 20) + "`n")
    Write-VibeSuccess "Merged the interactive answers into $ConfigFile"
}

<#
.SYNOPSIS
    Remind about host work directories the named volumes made obsolete.

.DESCRIPTION
    In container mode the workspace lives on the `vibe-work` /
    `vibe-approval-state` runtime volumes (Issue #4186), so a leftover
    auto-issue-work directory on the host is never mounted again and only
    wastes disk. Reminder only — deleting operator data is never setup's call.
#>
function Show-VibeObsoleteWorkDirs {
    $deno = Get-VibeDenoCommand
    if (-not $deno) { return }

    $argv = @(
        "run", "--frozen", "--lock=$DenoLock",
        "--allow-env", "--allow-read",
        (Join-Path $ScriptDir "worker/deno/mod.ts"), "run-mode")
    $mode = (& $deno @argv 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $mode -eq "native") { return }

    $workDir = if ($env:WORK_DIR) {
        $env:WORK_DIR
    } else {
        Join-Path (Get-VibeHomeDirectory) "auto-issue-work"
    }

    $found = $false
    foreach ($dir in @($workDir, "$workDir-approval-state")) {
        # Setup's own host-side steps (the workflow and best-practice audits)
        # keep a small lookup cache at `$WORK_DIR/.vibe-cache`, so that entry
        # is setup's doing, not a leftover workspace: only repository checkouts
        # and other worker data count as wasted disk.
        if ((Test-Path -LiteralPath $dir -PathType Container) -and
            (Get-ChildItem -LiteralPath $dir -Force |
                Where-Object { $_.Name -ne ".vibe-cache" } |
                Select-Object -First 1)) {
            Write-VibeWarning ("$dir is wasting disk: container mode keeps the " +
                "workspace on named volumes (Issue #4186), so this host " +
                "directory is never mounted again.")
            $found = $true
        }
    }
    if ($found) {
        Write-VibeInfo "Reclaim the space once you are happy with the containerised worker."
        Write-VibeInfo "(Content-approval snapshots re-baseline on the new volume; repositories re-clone on first use.)"
    }
}

<#
.SYNOPSIS
    Offer to register the Windows scheduled task.

.DESCRIPTION
    The twin of setup.sh's LaunchAgent offer: most machines run unattended and
    should register the task (Task Scheduler invokes run.ps1 every five
    minutes — the canonical supervision model on Windows); answer "n" on a
    machine where the worker is started by hand via loop.ps1.

    The task runs the same PowerShell host setup is running under, so a
    checkout set up from pwsh 7 is not later run by Windows PowerShell 5.1.
#>
function Invoke-VibeScheduledTaskPrompt {
    if (-not $script:VibeIsWindows) { return }
    if (-not (Test-VibeInteractive)) { return }

    Write-Host ""
    Write-VibeInfo "The Windows scheduled task runs the worker automatically via Task"
    Write-VibeInfo "Scheduler (run.ps1 every 5 minutes, and again at logon). It runs in"
    Write-VibeInfo "your interactive session, so it keeps desktop access while you are"
    Write-VibeInfo "logged in."
    Write-VibeInfo "Answer 'n' on a machine where you start the worker manually via loop.ps1."
    $install = Read-Host "  Register the scheduled task now? [Y/n]"
    if ($install -match '^[nN]') {
        Write-VibeInfo "Skipping the scheduled task - continue starting the worker manually (e.g. .\loop.ps1)."
        return
    }

    if (-not $env:VIBE_TASK_USER) {
        $env:VIBE_TASK_USER =
            [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    }
    # The task runs the PowerShell host setup itself is running under, so a
    # checkout onboarded from pwsh 7 is not later run by Windows PowerShell 5.1.
    $powershellHost = (Get-Process -Id $PID).Path
    if (-not $powershellHost) { $powershellHost = "powershell.exe" }
    if (-not (Invoke-VibeSetupCli -Arguments @(
                "scheduled-task", "--powershell", $powershellHost))) {
        Write-VibeWarning ("The scheduled task was not registered - see the " +
            "message above and register it by hand, or re-run .\setup.ps1")
    }
}

################################################################################
# Main
################################################################################

function Invoke-VibeSetupMain {
    # Prerequisites check via Deno — a gap here stops setup (Issue #3234).
    Invoke-VibeSetupCliOrExit -Arguments @("prerequisites")

    # Provision the dedicated credential directory non-interactively from
    # environment variables (Issue #4064). Runs before the prompts so the gh
    # config directory defaults to it and no login prompt is offered for it.
    Invoke-VibeCredentialProvisioning

    # Fill remaining credential gaps interactively (Issue #4161).
    Invoke-VibeInteractiveCredentialsPrompt

    # Prompt interactively when running in a terminal (Issue #583).
    $answers = Read-VibeInteractiveConfig

    # Write config from VIBE_* env vars, then merge the interactive answers.
    Invoke-VibeSetupCliOrExit -Arguments @("config")
    Write-VibeInteractiveConfig -Answers $answers

    # Standardise labels across all monitored repos (Issue #864).
    if (-not (Invoke-VibeSetupCli -Arguments @("label-sync"))) {
        Write-VibeWarning "Some labels could not be synced (non-fatal)"
    }

    # Audit workflows and raise issues for missing CI protections (Issue #1444).
    if (-not (Invoke-VibeSetupCli -Arguments @("workflow-sync"))) {
        Write-VibeWarning "Workflow sync had issues (non-fatal)"
    }

    # Audit workflows for best-practice findings (Issue #2102).
    if (-not (Invoke-VibeSetupCli -Arguments @("best-practices-sync"))) {
        Write-VibeWarning "Best-practice sync had issues (non-fatal)"
    }

    # Apply canonical .gitignore safety block to monitored repos (Issue #1774).
    if (-not (Invoke-VibeSetupCli -Arguments @("gitignore-sync"))) {
        Write-VibeWarning "Gitignore sync had issues (non-fatal)"
    }

    # Precheck the worker is a collaborator on every monitored repo (#2326).
    if (-not (Invoke-VibeSetupCli -Arguments @("verify-monitored-collaborator"))) {
        Write-VibeWarning "Collaborator precheck found misconfigured repo(s) - see filed issue"
    }

    # Apply the default-branch ruleset to every monitored repo (Issue #2588).
    if (-not (Invoke-VibeSetupCli -Arguments @("branch-protection-sync"))) {
        Write-VibeWarning "Ruleset sync had issues (non-fatal)"
    }

    # Back-fill `idle-task` label on existing security-scan wrappers (#2131).
    if (-not (Invoke-VibeSetupCli -Arguments @("backfill-idle-task-labels"))) {
        Write-VibeWarning "idle-task label back-fill had issues (non-fatal)"
    }

    # Install security hooks (Issue #34) and clean up retired hooks.
    Invoke-VibeSetupCliOrExit -Arguments @("hooks")

    # Remind about host work directories the named volumes made obsolete.
    Show-VibeObsoleteWorkDirs

    # Offer to register the scheduled task (interactive, Windows only).
    Invoke-VibeScheduledTaskPrompt

    # Setup screenshot support if requested.
    if ($env:VIBE_SETUP_SCREENSHOT_SUPPORT -eq "true") {
        if (-not (Invoke-VibeSetupCli -Arguments @("screenshot"))) {
            Write-VibeWarning "Screenshot setup had issues (non-fatal)"
        }
    }
}

# Only run when executed, not when dot-sourced — the tests dot-source this
# script to exercise individual functions (mirroring setup.sh's guard).
if ($MyInvocation.InvocationName -ne ".") {
    Invoke-VibeSetupMain
}
