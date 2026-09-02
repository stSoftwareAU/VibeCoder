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

# -AutoInstall consents in advance to every offered install (Issue #33), so a
# scripted `.\setup.ps1 -AutoInstall` installs what it can without a terminal
# to prompt on. Deliberately a per-invocation switch, never an environment
# variable.
# Issue #672: adding or removing ONE repository must not mean sitting through
# the whole wizard. Named parameters rather than bare flags, because that is
# what a PowerShell caller expects — `-AddRepo owner/repo`, not `--add-repo`.
param(
    [switch] $AutoInstall,
    [string] $AddRepo,
    [string] $RemoveRepo,
    [switch] $ListRepos
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = if ($PSScriptRoot) {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Definition
}

# The one .config.json this host uses (Issue #750).
#
# CONFIG_FILE is canonical; CONFIG_PATH is the launcher's older spelling, kept
# as an alias so hosts configured against it keep working. A relative value in
# either resolves against the checkout, never the working directory, so setup
# and .\run.ps1 name the same file. Both set to different files is a deployment
# fault — setup would read one while the launcher stages the other — so it is
# reported rather than silently answered differently on each side. The rule is
# worker/deno/lib/host_config_path.ts, and host_config_path_test.ts drives this
# function through the same matrix to prove the two agree.
function Resolve-VibeConfigFile {
    param([Parameter(Mandatory = $true)][string]$BaseDir)

    $resolveOne = {
        param([string]$Value)
        if ([System.IO.Path]::IsPathRooted($Value)) { return $Value }
        return (Join-Path $BaseDir ($Value -replace '^\.[\\/]', ''))
    }

    $canonical = if ($env:CONFIG_FILE -and $env:CONFIG_FILE.Trim()) {
        & $resolveOne $env:CONFIG_FILE.Trim()
    } else { $null }
    $aliasPath = if ($env:CONFIG_PATH -and $env:CONFIG_PATH.Trim()) {
        & $resolveOne $env:CONFIG_PATH.Trim()
    } else { $null }

    if ($canonical -and $aliasPath -and ($canonical -ne $aliasPath)) {
        throw ("CONFIG_FILE and CONFIG_PATH are both set and name different " +
            "files: CONFIG_FILE=$canonical, CONFIG_PATH=$aliasPath. Setup " +
            "would read one and the launcher stage the other - set one, or " +
            "set both to the same file.")
    }

    if ($canonical) { return $canonical }
    if ($aliasPath) { return $aliasPath }
    return (Join-Path $BaseDir ".config.json")
}

$ConfigFile = Resolve-VibeConfigFile -BaseDir $ScriptDir

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
        },
        [pscustomobject]@{
            Subdir       = "deepseek"
            ProvisionVar = "VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY"
            Vars         = @("DEEPSEEK_API_KEY")
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
    An explicit -VarName/-Secret pair wins — that is the interactive flow handing
    over the secret it was just given. Failing that the provisioning variable
    wins, and failing that the provider's own credential variables are read in
    the order the descriptor lists them. Setting none of them leaves that
    provider unprovisioned and never touches an existing file, so provisioning
    one vendor cannot wipe another's credential.

.OUTPUTS
    True when a credential was written, false when there was nothing to write.
#>
function Set-VibeProviderCredential {
    param(
        [Parameter(Mandatory = $true)][string] $Dir,
        [Parameter(Mandatory = $true)][pscustomobject] $Provider,
        [string] $VarName = "",
        [string] $Secret = "",
        [switch] $Quiet
    )

    $name = ""
    $value = ""
    $provisioned = [Environment]::GetEnvironmentVariable($Provider.ProvisionVar)
    # PowerShell variable names are case-insensitive, so the parameters cannot
    # be $Name/$Value: they would be the same variables as the locals below.
    if ($VarName -and $Secret) {
        # A secret the operator just pasted: stored under the name the prompt
        # asked for, never round-tripped through this process's environment
        # (Issue #745).
        $name = $VarName
        $value = $Secret
    } elseif ($provisioned) {
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
    if (-not $Quiet) {
        Write-VibeSuccess ("Provisioned $($Provider.Subdir) credential " +
            "(owner-only) in $file")
    }
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
            # DeepSeek authenticates with an API key and has no login of its
            # own (Issue #416), so the interactive Claude fallback cannot
            # help it — name the key source instead.
            Write-VibeInfo ("DeepSeek has no interactive login - set " +
                "VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY from a key issued at " +
                "https://platform.deepseek.com/api_keys")
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
    One provider's row from the credential table.

.DESCRIPTION
    Returns $null when the provider has no row, which the caller reports
    loudly rather than guessing at a directory name or a variable — the
    setup.sh twin of this is `vibe_provider_credential_row` (Issue #745).
#>
function Get-VibeProviderCredentialRow {
    param([Parameter(Mandatory = $true)][string] $Id)

    foreach ($row in Get-VibeProviderCredentialTable) {
        if ($row.Subdir -eq $Id) { return $row }
    }
    return $null
}

<#
.SYNOPSIS
    The credential variable one provider's interactive prompt fills.

.DESCRIPTION
    Defaults to the first name in that provider's row, so a newly registered
    provider is prompted for with no edit here. Claude overrides it: its row
    leads with ANTHROPIC_API_KEY (metered, per-token billing), while the
    credential setup must ask for is the subscription OAuth token
    `claude setup-token` mints — rate-limiting is a far better failure mode
    than a surprise bill.
#>
function Get-VibeProviderPromptVariable {
    param(
        [Parameter(Mandatory = $true)][string] $Id,
        [Parameter(Mandatory = $true)][string[]] $Vars
    )

    if ($Id -eq "claude") { return "CLAUDE_CODE_OAUTH_TOKEN" }
    return $Vars[0]
}

<#
.SYNOPSIS
    Where an operator gets one provider's credential, when we can say.

.DESCRIPTION
    A provider with no entry simply gets no hint line — the prompt still names
    the variable and the provisioning variable, so it stays usable. Claude has
    no entry either: its paste prompt spells the whole `claude setup-token`
    recipe out instead.
#>
function Get-VibeProviderCredentialSourceHint {
    param([Parameter(Mandatory = $true)][string] $Id)

    switch ($Id) {
        "codex" { return "an OpenAI API key from https://platform.openai.com/api-keys" }
        "gemini" { return "a Google AI Studio key from https://aistudio.google.com/apikey" }
        "deepseek" { return "a key issued at https://platform.deepseek.com/api_keys" }
        default { return "" }
    }
}

<#
.SYNOPSIS
    Validate a stored credential where the provider supports it.

.DESCRIPTION
    Claude's CLI can prove a token authenticates with a live call (Issue
    #4161). No other vendor ships a comparably cheap, non-billing check, so
    their stored credentials are taken at face value here — the worker's own
    credential preflight still requires the file to be present and owner-only,
    and the provider's auth-error detection still reports a bad key loudly at
    run time.
#>
function Test-VibeProviderCredential {
    param(
        [Parameter(Mandatory = $true)][string] $Id,
        [Parameter(Mandatory = $true)][string] $Path
    )

    if ($Id -eq "claude") { return (Test-VibeClaudeCredential -Path $Path) }
    return $true
}

<#
.SYNOPSIS
    Acquire a credential without a paste, where the provider's CLI can mint one.

.DESCRIPTION
    Returns the captured secret, or "" when this provider has no paste-free
    path, its CLI is absent, or the operator declined. Claude is the only
    provider with one today; the generic paste prompt covers every other.
#>
function Get-VibeMintedProviderCredential {
    param([Parameter(Mandatory = $true)][string] $Id)

    if ($Id -ne "claude") { return "" }
    if (-not (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue)) {
        return ""
    }

    Write-VibeInfo "The containerised worker cannot reach Windows Credential Manager,"
    Write-VibeInfo "so the claude CLI needs a long-lived OAuth token. Setup can run"
    Write-VibeInfo "``claude setup-token`` for you: a browser opens, you sign in with the"
    Write-VibeInfo "Claude account that holds your subscription, and the token is"
    Write-VibeInfo "captured automatically. (The token bills that subscription and can"
    Write-VibeInfo "only ever rate-limit - never run up per-token API charges. It lasts"
    Write-VibeInfo "about a year; re-run .\setup.ps1 to replace it when it expires.)"
    $runSetupToken = Read-Host "  Run ``claude setup-token`` now? [Y/n]"
    if ($runSetupToken -match '^[nN]') { return "" }

    $token = Get-VibeSetupToken
    if (-not $token) {
        Write-VibeWarning ("No token captured from claude setup-token - " +
            "paste one instead")
    }
    return $token
}

<#
.SYNOPSIS
    Print the paste instructions for one provider.

.DESCRIPTION
    Claude's recipe is spelled out in full because minting its token is a
    multi-step browser flow; every other provider gets the generic
    instructions built from its own table row, which is what makes a new
    provider work here without an edit.
#>
function Write-VibeProviderCredentialInstructions {
    param(
        [Parameter(Mandatory = $true)][string] $Id,
        [Parameter(Mandatory = $true)][string] $PromptVar,
        [Parameter(Mandatory = $true)][string] $ProvisionVar,
        [Parameter(Mandatory = $true)][string] $EnvFile
    )

    if ($Id -eq "claude") {
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
        return
    }

    $hint = Get-VibeProviderCredentialSourceHint -Id $Id
    Write-VibeInfo "The containerised worker authenticates $Id from $EnvFile."
    if ($hint) {
        Write-VibeInfo "Paste $PromptVar below - $hint."
    } else {
        Write-VibeInfo "Paste $PromptVar below."
    }
    Write-VibeInfo "Nothing appears as you paste - input is hidden so the secret stays"
    Write-VibeInfo "out of your scrollback. Set $ProvisionVar instead to provision it"
    Write-VibeInfo "non-interactively on the next run."
    Write-Host ""
}

<#
.SYNOPSIS
    Fill one provider's credential gap interactively (Issue #745).

.DESCRIPTION
    Every step comes from that provider's row in
    `Get-VibeProviderCredentialTable`, and the write goes through
    `Set-VibeProviderCredential` — the same owner-only path the
    non-interactive flow uses — so there is exactly one place that decides
    where a credential lands and how it is protected. The bash twin is
    `provider_credential_flow` in setup.sh (Issue #730).
#>
function Invoke-VibeProviderCredentialFlow {
    param(
        [Parameter(Mandatory = $true)][string] $Dir,
        [Parameter(Mandatory = $true)][string] $Id
    )

    $row = Get-VibeProviderCredentialRow -Id $Id
    if (-not $row) {
        Write-VibeError ("No credential row for coding-agent provider '$Id' " +
            "- add one to Get-VibeProviderCredentialTable in setup.ps1 before " +
            "enabling it")
        return
    }

    $envFile = Join-Path (Join-Path $Dir $row.Subdir) "provider.env"
    $promptVar = Get-VibeProviderPromptVariable -Id $Id -Vars $row.Vars

    # An existing credential is exercised for real before it is trusted: an
    # expired or revoked token is discarded here so the acquisition below
    # replaces it, instead of the worker discovering the problem at 3am.
    if ((Test-Path -LiteralPath $envFile) -and
        -not (Test-VibeProviderCredential -Id $Id -Path $envFile)) {
        Write-VibeWarning ("Stored $Id credential failed validation " +
            "(expired token?) - replacing it")
        Remove-Item -LiteralPath $envFile -Force
    }

    # Rotation path for a still-valid credential: offer to replace, default keep.
    if (Test-Path -LiteralPath $envFile) {
        $replace = Read-Host ("  $Id credential already provisioned - " +
            "replace it (e.g. expired token)? [y/N]")
        if ($replace -match '^[yY]') { Remove-Item -LiteralPath $envFile -Force }
    }

    # Two acquisition attempts: a credential that fails its validation call is
    # removed and the offer repeats once before setup gives up loudly.
    foreach ($attempt in 1, 2) {
        if (Test-Path -LiteralPath $envFile) { break }

        # Preferred path where one exists: let the provider's own CLI mint the
        # credential, so the operator only does the browser sign-in.
        $secret = Get-VibeMintedProviderCredential -Id $Id

        # Fallback: manual paste, with the recipe spelled out so the operator
        # needs nothing beyond this prompt.
        if (-not $secret) {
            Write-VibeProviderCredentialInstructions -Id $Id `
                -PromptVar $promptVar -ProvisionVar $row.ProvisionVar `
                -EnvFile $envFile
            $secret = Read-VibeSecret `
                -Prompt "  $promptVar (input hidden; Enter to skip)"
        }

        # Enter alone skips — leave the loop rather than re-asking.
        if (-not $secret) { break }

        # Hand the secret to the shared writer under the name it must be
        # stored as: one owner-only write path for both credential flows, and
        # the name is the one the prompt asked for, so a value the operator
        # happens to have exported cannot be written instead.
        $written = Set-VibeProviderCredential -Dir $Dir -Provider $row `
            -VarName $promptVar -Secret $secret -Quiet
        if (-not $written) {
            Write-VibeWarning "Could not store the $Id credential"
            break
        }

        # The proof is a real completion, not the write (Issue #3234).
        if (Test-VibeProviderCredential -Id $Id -Path $envFile) {
            $validated = if ($Id -eq "claude") {
                " - validated with a live claude call"
            } else {
                ""
            }
            Write-VibeSuccess ("Provisioned $Id credential (owner-only) in " +
                "$envFile$validated")
        } else {
            Remove-Item -LiteralPath $envFile -Force
            Write-VibeWarning ("The new $Id credential failed validation " +
                "($Id could not authenticate with it)")
        }
    }

    if (-not (Test-Path -LiteralPath $envFile)) {
        Write-VibeWarning ("No $Id credential - the containerised worker " +
            "fails its credential preflight until one is provisioned")
    }
}

<#
.SYNOPSIS
    Fill remaining credential gaps interactively (Issues #4161, #730, #745).

.DESCRIPTION
    Two steps, mirroring setup.sh's `interactive_credentials_flow`:

      1. gh: when <dir>/gh/hosts.yml is missing and the configured
         gh_config_dir already holds one, offer to copy it in.
      2. one credential flow per *configured* coding-agent provider, in the
         order .config.json enables them. A Codex-only host is asked for the
         Codex credential and never sees a Claude prompt (Issue #745); a host
         running both is asked for both.

    The provider list drives the loop and the credential table drives each
    flow, so a provider registered in worker/deno/lib/agent_provider.ts and
    listed in `Get-VibeProviderCredentialTable` is handled here with no
    further edit.
#>
function Invoke-VibeInteractiveCredentials {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $GhSource,
        [Parameter(Mandatory = $true)][string[]] $Providers
    )

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

    # Say which flows this run will drive before driving them (Issue #745):
    # a misconfigured provider set must be visible, not silent.
    Write-VibeInfo ("Coding-agent credential flows for this host: " +
        ($Providers -join " "))

    foreach ($provider in $Providers) {
        Invoke-VibeProviderCredentialFlow -Dir $dir -Id $provider
    }
}

<#
.SYNOPSIS
    The coding-agent providers this host is configured to run (Issue #745).

.DESCRIPTION
    Resolved by the Deno seam (worker/deno/setup/agent_providers.ts) through
    the `agent-providers` subcommand rather than parsed out of .config.json
    here: `agent_provider`, `agent_providers`, the VIBE_AGENT_PROVIDER(S)
    overrides and the default all live there, and setup.sh reads the selection
    the same way, so the two platforms cannot disagree about which host this
    is.

.OUTPUTS
    The provider ids, or an empty array when the selection cannot be resolved
    — which the caller treats as fatal. Prompting for the wrong vendor's
    credential, or silently falling back to Claude on a Codex host, is exactly
    the failure this gating exists to remove (Issue #3234).
#>
function Get-VibeConfiguredAgentProviders {
    $output = Invoke-VibeSetupCliCapture -Arguments @("agent-providers")
    if (-not $output) { return @() }
    return @(
        $output -split "`r?`n" |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ }
    )
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

    # Which coding agents this host runs decides which credentials it is asked
    # for (Issue #745). An empty set is a fault in the resolution, not a
    # licence to guess: the default provider here would prompt a Codex host
    # for a Claude token.
    $providers = Get-VibeConfiguredAgentProviders
    if ($providers.Count -eq 0) {
        Write-VibeError ("No coding-agent provider resolved from $ConfigFile " +
            "- fix agent_provider/agent_providers and re-run setup")
        exit 1
    }

    Invoke-VibeInteractiveCredentials -GhSource $ghSource -Providers $providers
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
    Run a setup CLI subcommand and return its standard output as one string.

.DESCRIPTION
    For the query forms (`scheduled-task --status`) whose one-line answer
    setup branches on. A CLI that cannot run yields an empty string, which no
    query answer equals, so the caller takes the "not registered" path.
#>
function Invoke-VibeSetupCliCapture {
    param([Parameter(Mandatory = $true)][string[]] $Arguments)

    $deno = Get-VibeDenoCommand
    if (-not $deno) { return "" }
    $argv = @("run", "--frozen", "--lock=$DenoLock", "--allow-all", $SetupCli) +
        $Arguments +
        @("--script-dir", $ScriptDir, "--config-path", $ConfigFile)
    $output = (& $deno @argv 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0) { return "" }
    return $output
}

<#
.SYNOPSIS
    Run a setup CLI subcommand, letting its output reach the console.

.DESCRIPTION
    Issue #672. `Invoke-VibeSetupCli` returns a boolean on the same stream the
    CLI writes to, so `if (-not (Invoke-VibeSetupCli ...))` captures the output
    into the condition and the operator sees nothing. That is harmless for a
    step whose output is progress chatter; it is fatal for a query like
    `repos`, whose output IS the answer.

    This form writes nothing itself and returns only the exit status, so the
    caller can branch without swallowing what the operator asked for.
#>
function Invoke-VibeSetupCliPassthrough {
    param([Parameter(Mandatory = $true)][string[]] $Arguments)

    $deno = Get-VibeDenoCommand
    if (-not $deno) {
        Write-VibeError "deno is required but not installed."
        Write-VibeInfo "Install it with: winget install --exact --id DenoLand.Deno --source winget"
        return 1
    }

    $argv = @("run", "--frozen", "--lock=$DenoLock", "--allow-all", $SetupCli) +
        $Arguments +
        @("--script-dir", $ScriptDir, "--config-path", $ConfigFile)
    & $deno @argv | Out-Host
    return $LASTEXITCODE
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
            "They also count as fleet PR authors (unioned into fleet_pr_authors),",
            "so a sibling's open PR blocks this host from duplicating the work.",
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
    # Setup asks only where that repository is and stores it in .config.json
    # (fleet_health_repo). The worker clones it itself on its first run -
    # natively beside VibeCoder, in container mode inside its own work volume
    # - so no directory is asked for and nothing is cloned here. Nothing is
    # ever cloned from an assumed URL.
    $fleetRepo = Read-Answer `
        -Prompt "FLEET health repository (optional): git URL of the fleet's health repository" `
        -Existing $existing.fleet_health_repo `
        -Notes @(
            "e.g. git@github.com:your-org/your-health-repo.git",
            "The worker clones it on first run. Leave blank to keep the current value,",
            "or '-' to turn health tracking off.")
    if ($fleetRepo -eq "-") {
        $answers.fleet_health_repo = $null
        $answers.fleet_health_dir = $null
        Write-VibeInfo "FLEET health tracking turned off."
    } elseif ($fleetRepo) {
        $answers.fleet_health_repo = $fleetRepo
        Write-VibeSuccess "FLEET health repository: $fleetRepo"
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
    Remove a host work dir that holds only a stale .vibe-cache entry.

.DESCRIPTION
    Setup caches nothing on the host any more (Issue #132), so a .vibe-cache
    is only a leftover an earlier setup version wrote. Callers have already
    established the directory exists and holds no worker data (Issue #134);
    this deletes the cache subtree and the then-empty directory, reporting
    what went — silent deletion is worse than none.

    Guarded: an empty path, a filesystem root, or the home directory itself is
    refused outright. A recursive delete built from an unset variable is the
    failure mode this guard exists for, so it stays even though today's
    callers cannot pass those.
#>
function Remove-VibeCacheOnlyWorkDir {
    param([string]$Dir)

    $homeDir = Get-VibeHomeDirectory
    if ([string]::IsNullOrEmpty($Dir) -or
        $Dir -eq [System.IO.Path]::GetPathRoot($Dir) -or
        $Dir -eq $homeDir) {
        Write-VibeWarning "Refusing to remove '$Dir': not a disposable host work directory."
        return
    }
    Remove-Item -LiteralPath (Join-Path $Dir ".vibe-cache") -Recurse -Force -ErrorAction SilentlyContinue
    if ((Test-Path -LiteralPath $Dir -PathType Container) -and
        -not (Get-ChildItem -LiteralPath $Dir -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $Dir -Force
        Write-VibeInfo ("Removed ${Dir}: it held nothing but a stale " +
            ".vibe-cache from an earlier setup (Issue #134); container " +
            "mode keeps the workspace on named volumes.")
    }
}

<#
.SYNOPSIS
    Remind about host work directories the named volumes made obsolete.

.DESCRIPTION
    In container mode the workspace lives on the `vibe-work` /
    `vibe-approval-state` runtime volumes (Issue #4186), so a leftover
    auto-issue-work directory on the host is never mounted again and only
    wastes disk. A directory holding worker data gets a reminder only —
    deleting operator data is never setup's call — but one that holds nothing
    beyond a .vibe-cache entry is setup's own leftover and is removed
    outright (Issue #134).
#>
function Show-VibeObsoleteWorkDirs {
    $deno = Get-VibeDenoCommand
    if (-not $deno) { return }

    $argv = @(
        "run", "--frozen", "--lock=$DenoLock",
        "--allow-env", "--allow-read",
        (Join-Path $ScriptDir "worker/deno/mod.ts"), "run-mode")
    $mode = (& $deno @argv 2>$null | Out-String).Trim()
    # Container is the only run mode (Issue #4); an unresolvable
    # configuration skips the reminder rather than failing setup.
    if ($LASTEXITCODE -ne 0 -or $mode -ne "container") { return }

    $workDir = if ($env:WORK_DIR) {
        $env:WORK_DIR
    } else {
        Join-Path (Get-VibeHomeDirectory) "auto-issue-work"
    }

    $found = $false
    foreach ($dir in @($workDir, "$workDir-approval-state")) {
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
        # Setup caches nothing on the host (Issue #132 — host-side runs
        # re-query the GitHub API instead), so a `.vibe-cache` here is only a
        # harmless leftover from an earlier version, not a live workspace:
        # only repository checkouts and other worker data count as wasted
        # disk.
        if (Get-ChildItem -LiteralPath $dir -Force |
                Where-Object { $_.Name -ne ".vibe-cache" } |
                Select-Object -First 1) {
            Write-VibeWarning ("$dir is wasting disk: container mode keeps the " +
                "workspace on named volumes (Issue #4186), so this host " +
                "directory is never mounted again.")
            $found = $true
        } else {
            # Cache-only (or empty) — setup's own leftover, safe to reclaim
            # (Issue #134).
            Remove-VibeCacheOnlyWorkDir -Dir $dir
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
    Write-VibeInfo "Answer 'y' ONLY on a machine where nothing starts the worker by hand."
    Write-VibeInfo "If you run .\loop.ps1 yourself, answer 'n' - two workers on one host"
    Write-VibeInfo "collide on the work volumes (Issue #26)."
    # Defaults to NO, matching setup.sh. Registering starts a second worker on
    # a host that may already have one, and a bare Enter must never do that -
    # the safe answer is the one that changes nothing.
    $install = Read-Host "  Register the scheduled task now? [y/N]"
    if ($install -notmatch '^(y|Y|yes|YES)$') {
        # Declined. A task an earlier setup registered is still there, still
        # launching the worker every five minutes beside whatever the operator
        # starts by hand - and two workers on one host collide on the work
        # volumes (Issue #26). Say so, and offer to remove it; "no" here must
        # never silently mean "keep the one you have".
        $registered = (Invoke-VibeSetupCliCapture @("scheduled-task", "--status")).Trim()
        if ($registered -eq "registered") {
            Write-VibeWarning "The scheduled task is currently registered: Task Scheduler starts the worker every 5 minutes on this machine."
            Write-VibeInfo "Starting the worker by hand (.\loop.ps1) as well would run two workers on this host - one worker per host."
            $remove = Read-Host "  Unregister the scheduled task now? [Y/n]"
            if ($remove -match '^[nN]') {
                Write-VibeInfo "Keeping the scheduled task - do not also start the worker by hand on this machine."
            } else {
                Invoke-VibeSetupCli @("scheduled-task", "--uninstall")
            }
        } else {
            Write-VibeInfo "Skipping the scheduled task - continue starting the worker manually (e.g. .\loop.ps1)."
        }
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
    # Issue #672: the single-repository paths short-circuit before any prompt,
    # install or sync, and set the exit code so they can be scripted. The
    # operator's point was that they were hand-editing .config.json instead of
    # using this script, which is the one thing it exists to prevent.
    if ($AddRepo) {
        exit (Invoke-VibeSetupCliPassthrough -Arguments @("repos", "--add", $AddRepo))
    }
    if ($RemoveRepo) {
        exit (Invoke-VibeSetupCliPassthrough -Arguments @("repos", "--remove", $RemoveRepo))
    }
    if ($ListRepos) {
        exit (Invoke-VibeSetupCliPassthrough -Arguments @("repos"))
    }

    # Prerequisites check via Deno — a gap here stops setup (Issue #3234).
    # -AutoInstall consents in advance to every offered install (Issue #33).
    if ($AutoInstall) {
        Invoke-VibeSetupCliOrExit -Arguments @("prerequisites", "--auto-install")
    } else {
        Invoke-VibeSetupCliOrExit -Arguments @("prerequisites")
    }

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
