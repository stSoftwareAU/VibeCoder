#!/bin/bash
set -euo pipefail

################################################################################
# setup.sh
#
# Non-interactive setup script for VibeCoder worker configuration.
# Creates or updates .config.json from VIBE_* environment variables.
#
# The Vibe Coder is designed to run on unattended machines. All interactions
# happen via GitHub issues and PRs (comments on these). The system must never
# wait on any UI interaction — that would just timeout.
#
# This is a thin orchestrator that delegates to the Deno setup CLI
# (worker/deno/setup/setup_cli.ts) and handles interactive terminal prompts.
#
# Usage:
#   VIBE_ALLOWED_AUTHOR=myuser \
#   VIBE_REPOS="org/repo1,org/repo2" \
#   ./setup.sh
#
# Prerequisites (checked at startup — Issue #4117; an interactive run also
# offers to install what is missing — see "Prerequisite auto-install" below):
#   Host-fatal — what setup itself and the containerised worker need:
#   - git: Required for repository operations
#   - gh CLI: Required for GitHub operations (must be authenticated)
#   - deno: Required for TypeScript setup module
#   - a container runtime (Apple container / Docker / Podman) that answers its
#     probe, plus a worker image that is built or buildable
#
#   Container-owned — reported for information only, never required on the
#   host, because the container image provides them:
#   - jq (host jq is only used by setup.sh's interactive config merge)
#   - timeout (or gtimeout on macOS)
#
#   Provider-gated (Issue #730) — demanded only of a host that runs that
#   provider, from the `agent_provider` / `agent_providers` selection in
#   .config.json:
#   - claude: host-fatal wherever Claude is configured, because setup mints
#     and validates the worker's OAuth token with `claude setup-token`. A
#     Codex-only host is never asked for it, and one credential flow runs per
#     configured provider instead of an unconditional Claude prompt.
#
# Environment variables:
#   VIBE_ALLOWED_AUTHOR     - GitHub username to process issues from
#   VIBE_PR_REVIEWER        - GitHub username for PR reviews
#   VIBE_REPOS              - Comma-separated list of repos to monitor
#   VIBE_ADD_REPOS          - Comma-separated list of repos to add to existing
#   VIBE_ISSUE_LABELS       - Comma-separated list of issue labels to watch
#   VIBE_AUTHORIZED_COMMENTERS - Comma-separated list of authorized commenters
#   VIBE_INCLUDE_BOT_COMMENTERS - Set to "true" to include common bot accounts
#                               (github-copilot[bot], cursor[bot], etc.)
#   VIBE_WORK_ON_LABEL      - Label to signal work on external issues
#   VIBE_SERVICE_ACCOUNTS   - Comma-separated service-account logins the worker
#                             identity guard permits (Issues #3528, #4030).
#                             Defaults to the login setup authenticates as.
#   CONFIG_FILE            - Path to config file (default: .config.json)
#   VIBE_CREDENTIAL_DIR    - Credential directory provisioned non-interactively
#                            (default: ~/.vibe-coder/credentials — Issue #4064)
#
# Prerequisite auto-install (Issues #4134-#4137):
#   Run in a terminal, setup offers to install each failed check that has an
#   install plan for this host — one [y/N] prompt per tool, defaulting to no,
#   naming the package manager it would use (the container-runtime prompts
#   name the exact argv, sudo included, before anything runs). Consent runs the
#   steps with their output streamed, then re-runs that tool's probe: the fresh
#   probe, never "the command exited zero", decides whether the check passes
#   (Issue #3234). A declined install, a failed install, or a tool with no plan
#   leaves its check failed and setup exits non-zero.
#
#   Run without a terminal — cron, launchd, CI — nothing is installed, and the
#   report says which failed checks *could* have been auto-installed and why
#   the offer was withheld (Issue #33). `./setup.sh --auto-install` consents to
#   every offer in advance, so a scripted run installs what it can — the one
#   sanctioned pre-consent, and deliberately a per-invocation flag rather than
#   an environment variable.
#
#   The container runtime is offered per platform: macOS gets
#   `brew install container` then `container system start` (Issue #4136);
#   Linux is offered Docker then Podman in the probe's own order, with a
#   present-but-stopped runtime started rather than reinstalled (Issue #4137).
#
#   Never installed, on any host:
#   - authentication — `gh auth login` and the coding-agent credentials are
#     always yours to run; setup only ever reports that they are missing
#   - git — a bootstrap dependency (macOS ships it with the Xcode command line
#     tools, a large separate download)
#   - anything on a host with neither Homebrew (macOS) nor apt (Debian/Ubuntu):
#     no plan resolves, so setup prints today's manual hint and fails
#
# Testing/CI environment variables:
#   VIBE_SKIP_PREREQ_CHECK  - Set to "true" to skip the prerequisite *probe*
#                             altogether (CI only — it hides real gaps).
#                             Nothing is checked, so nothing is offered either.
#   VIBE_NO_AUTO_INSTALL    - Set to "true" to skip only the install *offer*
#                             (Issue #4135). The probe still runs and still
#                             reports every gap; setup just never offers to
#                             close one. For an operator who manages packages
#                             themselves. The offer also only ever appears when
#                             stdin is a terminal, so unattended runs report
#                             and fail exactly as before with or without it.
#   VIBE_SKIP_AUTH_CHECK    - Set to "true" to skip authentication checks
#   VIBE_SETUP_SCREENSHOT_SUPPORT - Set to "true" to install screenshot support
#
# LaunchAgent setup (macOS only):
#   On macOS, setup.sh interactively offers to install the LaunchAgent — the
#   canonical launchd supervision model where launchd invokes run.sh every five
#   minutes. Answer "n" on a machine that keeps starting the worker manually via
#   loop.sh (for example a laptop in daily interactive use). Non-interactive runs
#   (no TTY) and non-macOS hosts skip the offer. The variables below only tune
#   the generated LaunchAgent; none of them gate whether it is installed:
#   VIBE_LAUNCHAGENT_DIR    - LaunchAgents directory (default: ~/Library/LaunchAgents)
#   VIBE_LAUNCHAGENT_GH_TOKEN - GitHub token for LaunchAgent environment
#   VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY - Anthropic API key for LaunchAgent environment
#   VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY - DeepSeek API key (from
#                             https://platform.deepseek.com/api_keys); DeepSeek
#                             has no interactive login, so this variable is the
#                             only way its credential is ever provisioned
#   VIBE_LAUNCHAGENT_FALLBACK_PATHS - PATH fallback for LaunchAgent (e.g., /opt/homebrew/bin)
#   VIBE_LOGS_DIR           - Logs directory (default: the platform's own
#                             location, see docs/CONFIGURATION.md)
#   VIBE_SKIP_LAUNCHCTL     - Set to "true" to skip launchctl commands (for testing)
#
# Screenshot capability setup (for UI change evidence):
#   VIBE_SETUP_SCREENSHOT_SUPPORT - Set to "true" to install screenshot dependencies
#   VIBE_SKIP_SCREENSHOT_INSTALL  - Set to "true" to skip browser installation (for testing)
#   VIBE_MCP_CONFIG_DIR     - Directory for .mcp.json (default: script directory)
#   VIBE_SCREENSHOT_DIR     - Directory name for screenshots (default: docs/evidence)
#   VIBE_PREFER_RUNTIME     - Preferred JavaScript runtime: "node" or "deno" (auto-detect if not set)
#
# Optional feature configuration (Issue #535):
#   VIBE_IMGBB_API_KEY      - ImgBB API key for automatic screenshot uploads
#                             Get a free key from https://api.imgbb.com/
#                             Without this, screenshots are saved locally and must
#                             be manually uploaded to the PR if needed.
#   VIBE_UPDATE_GH_USER_STATUS - Set to "true" (default) or "false" to control
#                             GitHub user profile status updates. Requires the
#                             `user` scope on the GitHub token.
#
# GitHub App authentication (Issue #957):
#   VIBE_GITHUB_APP_ID      - GitHub App ID (numeric string)
#   VIBE_GITHUB_APP_INSTALLATION_ID - GitHub App Installation ID (numeric string)
#   VIBE_GITHUB_APP_PRIVATE_KEY_PATH - Path to the GitHub App private key PEM file
#                             When all three are set, the worker uses GitHub App
#                             authentication instead of gh CLI token auth.
#
# Screenshot support enables Claude to capture screenshots for UI changes using
# Playwright MCP server. This requires:
#   - Deno 2 or higher (uses deno run with npm: specifier for @playwright/mcp)
#   - Playwright browsers (installed automatically)
#   - On Linux: additional system libraries for headless Chrome
################################################################################

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Resolve one path against a base, the way worker/deno/lib/host_path_style.ts
# does: an absolute value stands, a relative one hangs off the base.
absolute_config_path() {
    local value="$1" base="$2"
    case "$value" in
        /*) printf '%s' "$value" ;;
        *) printf '%s/%s' "$base" "${value#./}" ;;
    esac
}

# The one .config.json this host uses (Issue #750).
#
# CONFIG_FILE is canonical; CONFIG_PATH is the launcher's older spelling, kept
# as an alias so hosts configured against it keep working. A relative value in
# either resolves against the checkout, never the working directory, so setup
# and ./run.sh name the same file. Both set to different files is a deployment
# fault: setup would read one while the launcher stages the other, so it is
# reported rather than silently answered differently on each side. The rule is
# worker/deno/lib/host_config_path.ts, and host_config_path_test.ts drives this
# function through the same matrix to prove the two agree.
resolve_config_file() {
    local base="$1"
    local canonical="" alias_path=""
    if [[ -n "${CONFIG_FILE:-}" ]]; then
        canonical="$(absolute_config_path "$CONFIG_FILE" "$base")"
    fi
    if [[ -n "${CONFIG_PATH:-}" ]]; then
        alias_path="$(absolute_config_path "$CONFIG_PATH" "$base")"
    fi
    if [[ -n "$canonical" && -n "$alias_path" && "$canonical" != "$alias_path" ]]; then
        echo "ERROR: CONFIG_FILE and CONFIG_PATH are both set and name different files:" >&2
        echo "  CONFIG_FILE=${canonical}" >&2
        echo "  CONFIG_PATH=${alias_path}" >&2
        echo "Setup would read one and the launcher stage the other — set one, or set both to the same file." >&2
        return 1
    fi
    printf '%s\n' "${canonical:-${alias_path:-${base}/.config.json}}"
}

CONFIG_FILE="$(resolve_config_file "$SCRIPT_DIR")"

################################################################################
# Shared utility functions (used by all modules)
################################################################################

# Colours for output (if terminal supports it)
if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m' # No Colour
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    NC=''
fi

print_info() {
    echo -e "${BLUE}ℹ${NC}  $*"
}

print_success() {
    echo -e "${GREEN}✓${NC}  $*"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC}  $*"
}

print_error() {
    echo -e "${RED}✗${NC}  $*" >&2
}

# Check if we're on macOS
is_macos() {
    [[ "$(uname -s)" == "Darwin" ]]
}

################################################################################
# Vibe credential provisioning (Issue #4064, parent #4060)
#
# The worker runs unattended: no runtime step may reach a GUI prompt, a browser
# login, `gh auth login`, an interactive provider login, or a macOS Keychain
# lookup. Credentials are therefore provisioned once — here, at setup time,
# from environment variables — into one dedicated directory the worker (and the
# container, read-only) consumes:
#
#   ~/.vibe-coder/credentials/        0700
#   ├── gh/hosts.yml                  0600  the worker's GH_CONFIG_DIR material
#   └── <provider>/provider.env       0600  one credential per agent vendor
#                                           (claude, codex, gemini, deepseek —
#                                           from the provisioning variable each
#                                           row of the table below names)
#
# Each vendor gets its own sub-directory (Issue #4108) so a run can authenticate
# more than one agent CLI without any vendor seeing another's secret: only the
# providers enabled for a run are mounted into the container, one directory at
# a time.
#
# Nothing else belongs in that directory; the worker's credential preflight
# (worker/deno/lib/credential_preflight.ts) fails loudly when it holds unrelated
# material, is missing, empty, unreadable, or group/world readable.
################################################################################

# Absolute path of the credential directory (VIBE_CREDENTIAL_DIR overrides).
credential_dir() {
    printf '%s' "${VIBE_CREDENTIAL_DIR:-$HOME/.vibe-coder/credentials}"
}

# The credential facets of every registered coding-agent provider, one row per
# provider: sub-directory|provisioning variable|credential variable names.
#
# This mirrors the descriptors in worker/deno/lib/agent_provider.ts, which stay
# the single source of truth; worker/deno/tests/multi_provider_credentials_test.ts
# calls this function and fails the quality gate when a registered descriptor
# has no row here. A row may land before its descriptor is registered (Issue
# #416) so the provider is provisionable from the first deployment enabling it.
vibe_provider_credential_table() {
    cat <<'PROVIDER_TABLE'
claude|VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY|ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN,CLAUDE_CODE_OAUTH_TOKEN
codex|VIBE_LAUNCHAGENT_OPENAI_API_KEY|OPENAI_API_KEY,CODEX_API_KEY
gemini|VIBE_LAUNCHAGENT_GEMINI_API_KEY|GEMINI_API_KEY,GOOGLE_API_KEY
deepseek|VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY|DEEPSEEK_API_KEY
PROVIDER_TABLE
}

# The provider id used when nothing selects one — mirrors
# DEFAULT_AGENT_PROVIDER_ID in worker/deno/lib/agent_provider.ts.
VIBE_DEFAULT_AGENT_PROVIDER="claude"

# One provider's row from the table above.
#
# Prints `subdir|provisioning variable|credential variables`, or returns 1 when
# the provider has no row — which the caller reports loudly rather than
# silently skipping a credential the worker will then fail its preflight on.
vibe_provider_credential_row() {
    local wanted="$1" subdir provision_var var_list
    while IFS='|' read -r subdir provision_var var_list; do
        if [[ "$subdir" == "$wanted" ]]; then
            printf '%s|%s|%s\n' "$subdir" "$provision_var" "$var_list"
            return 0
        fi
    done < <(vibe_provider_credential_table)
    return 1
}

# Set when this run provisioned (or found) usable gh material — consumed by
# prompt_interactive_config to default gh_config_dir and skip the login prompt.
VIBE_PROVISIONED_GH_CONFIG_DIR=""

# Provision one provider's credential file from the environment.
#
# The provisioning variable wins; failing that, the provider's own credential
# variables are read in the order the descriptor lists them. Setting neither
# leaves that provider unprovisioned and never touches an existing file, so
# provisioning one vendor cannot wipe another's credential.
#
# Arguments: credential dir, sub-directory, provisioning variable, the
# comma-separated credential variable names, and optionally "quiet" to
# withhold the success line. The interactive flow passes "quiet" because it
# only knows the credential is good once it has been validated — announcing
# the write as a success and then deleting the file would print a ✓ for a
# credential that never authenticated (Issue #3234).
# Returns 0 when a credential was written, 1 when there was nothing to write.
provision_provider_credential() {
    local dir="$1" subdir="$2" provision_var="$3" var_list="$4"
    local announce="${5:-announce}"
    local provider_dir name value candidate

    provider_dir="${dir}/${subdir}"
    name=""
    value=""

    if [[ -n "${!provision_var:-}" ]]; then
        name="${var_list%%,*}"
        value="${!provision_var}"
    else
        for candidate in ${var_list//,/ }; do
            if [[ -n "${!candidate:-}" ]]; then
                name="$candidate"
                value="${!candidate}"
                break
            fi
        done
    fi

    [[ -n "$value" ]] || return 1

    mkdir -p "$provider_dir"
    chmod 700 "$dir" "$provider_dir"
    (
        umask 077
        printf '%s=%s\n' "$name" "$value" > "${provider_dir}/provider.env"
    )
    chmod 600 "${provider_dir}/provider.env"
    if [[ "$announce" != "quiet" ]]; then
        print_success "Provisioned ${subdir} credential (owner-only) in ${provider_dir}/provider.env"
    fi
    return 0
}

provision_vibe_credentials() {
    local dir gh_dir gh_token login subdir provision_var var_list
    local wrote_any=0 provision_vars=""

    dir="$(credential_dir)"
    gh_dir="${dir}/gh"

    gh_token="${VIBE_LAUNCHAGENT_GH_TOKEN:-${GH_TOKEN:-}}"

    # One credential per enabled vendor (Issue #4108): every registered
    # provider is offered its own variables, and each writes only its own file.
    while IFS='|' read -r subdir provision_var var_list; do
        [[ -n "$subdir" ]] || continue
        provision_vars="${provision_vars:+${provision_vars} / }${provision_var}"
        if provision_provider_credential "$dir" "$subdir" "$provision_var" "$var_list"; then
            wrote_any=1
        fi
    done < <(vibe_provider_credential_table)

    if [[ -z "$gh_token" && "$wrote_any" -eq 0 ]]; then
        if [[ -f "${gh_dir}/hosts.yml" ]]; then
            VIBE_PROVISIONED_GH_CONFIG_DIR="$gh_dir"
            print_info "Credential directory ${dir} left unchanged (no credential variables set)"
        else
            print_warning "No credential variables set — set VIBE_LAUNCHAGENT_GH_TOKEN and one of ${provision_vars} to provision ${dir} non-interactively"
            # DeepSeek authenticates with an API key and has no login of its
            # own (Issue #416): the interactive fallback below is Claude's, so
            # say where a DeepSeek key comes from rather than leaving an
            # operator with a suggestion that cannot help them.
            print_info "DeepSeek has no interactive login — set VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY from a key issued at https://platform.deepseek.com/api_keys"
        fi
        return 0
    fi

    if [[ -n "$gh_token" ]]; then
        mkdir -p "$gh_dir"
        chmod 700 "$dir" "$gh_dir"
        write_gh_hosts_file "$gh_dir" "$gh_token"
        VIBE_PROVISIONED_GH_CONFIG_DIR="$gh_dir"
        print_success "Provisioned GitHub credential (owner-only) in ${gh_dir}/hosts.yml"
    fi
}

# Write a self-contained hosts.yml with the token inline — never a keychain
# reference, which the container cannot reach (Issue #4064). The login lookup
# completes the host entry; a failure there is not fatal, the token alone
# authenticates.
write_gh_hosts_file() {
    local gh_dir="$1" gh_token="$2" login=""
    if command -v gh &>/dev/null; then
        login=$(GH_TOKEN="$gh_token" gh api user --jq .login 2>/dev/null || true)
    fi
    (
        umask 077
        {
            printf 'github.com:\n'
            printf '    oauth_token: %s\n' "$gh_token"
            printf '    git_protocol: ssh\n'
            if [[ -n "$login" ]]; then
                printf '    user: %s\n' "$login"
                printf '    users:\n'
                printf '        %s:\n' "$login"
                printf '            oauth_token: %s\n' "$gh_token"
            fi
        } > "${gh_dir}/hosts.yml"
    )
    chmod 600 "${gh_dir}/hosts.yml"
}

# Interactive credential provisioning (Issues #4161, #730).
#
# `provision_vibe_credentials` above is env-var only, which suits CI and
# unattended re-provisioning — but the operator's actual workflow is to walk
# to each worker machine once, run ./setup.sh, paste what is needed and leave.
# This flow fills the same credential directory interactively:
#
#   1. gh: when <dir>/gh/hosts.yml is missing and the configured gh_config_dir
#      already holds a hosts.yml (the worker identity from `gh auth login`),
#      offer to copy it in.
#   2. one credential flow per *configured* coding-agent provider, in the
#      order .config.json enables them. A Codex-only host is asked for the
#      Codex credential and never sees a Claude prompt (Issue #730); a host
#      running both is asked for both.
#
# The provider list drives the loop and the credential table drives each
# flow, so a provider registered in worker/deno/lib/agent_provider.ts and
# listed in `vibe_provider_credential_table` is handled here with no further
# edit. Claude keeps one refinement of its own — setup can run
# `claude setup-token` for the operator — because its subscription token has
# no paste-free equivalent elsewhere; every other provider falls through to
# the generic hidden paste.
#
# Existing files are never re-prompted or overwritten; skipping warns loudly
# that the containerised worker cannot pass its credential preflight yet.
#
# Arguments: the gh config directory to offer as the copy source ("" for
# none), then the configured provider ids. No ids means the default provider
# alone — the selection `resolveEnabledAgentProviderIds` falls back to.
interactive_credentials_flow() {
    local gh_source="$1"
    shift || true
    local -a providers=()
    if [[ $# -gt 0 ]]; then
        providers=("$@")
    else
        providers=("$VIBE_DEFAULT_AGENT_PROVIDER")
    fi
    local dir
    dir="$(credential_dir)"

    if [[ ! -f "${dir}/gh/hosts.yml" ]]; then
        local expanded_source="${gh_source/#\~/$HOME}"
        if [[ -n "$expanded_source" && -f "${expanded_source}/hosts.yml" ]]; then
            echo -n "  Copy the worker gh identity from ${gh_source} into ${dir}/gh? [Y/n] "
            local copy_gh=""
            IFS= read -r copy_gh || copy_gh=""
            if [[ "$copy_gh" != "n" && "$copy_gh" != "N" ]]; then
                mkdir -p "${dir}/gh"
                chmod 700 "$dir" "${dir}/gh"
                # The host login usually keeps its token in the OS keychain,
                # which the container cannot reach — extract it and write a
                # self-contained hosts.yml. A plain copy is only sufficient
                # when the source file itself carries the token inline.
                local source_gh_token=""
                if command -v gh &>/dev/null; then
                    source_gh_token="$(GH_CONFIG_DIR="$expanded_source" gh auth token 2>/dev/null || true)"
                fi
                if [[ -n "$source_gh_token" ]]; then
                    write_gh_hosts_file "${dir}/gh" "$source_gh_token"
                    VIBE_PROVISIONED_GH_CONFIG_DIR="${dir}/gh"
                    print_success "Copied gh identity (token materialised, owner-only) into ${dir}/gh/hosts.yml"
                elif grep -q '^[[:space:]]*oauth_token:' "${expanded_source}/hosts.yml"; then
                    cp "${expanded_source}/hosts.yml" "${dir}/gh/hosts.yml"
                    chmod 600 "${dir}/gh/hosts.yml"
                    VIBE_PROVISIONED_GH_CONFIG_DIR="${dir}/gh"
                    print_success "Copied gh identity (owner-only) into ${dir}/gh/hosts.yml"
                else
                    print_warning "The gh login keeps its token in the OS keychain and none could be extracted — set VIBE_LAUNCHAGENT_GH_TOKEN and re-run setup"
                fi
            else
                print_warning "No gh credential — set VIBE_LAUNCHAGENT_GH_TOKEN and re-run setup to provision it"
            fi
        else
            print_warning "No gh credential and nothing to copy — set VIBE_LAUNCHAGENT_GH_TOKEN and re-run setup"
        fi
    fi

    # Say which flows this run will drive before driving them (Issue #730):
    # a misconfigured provider set must be visible, not silent.
    print_info "Coding-agent credential flows for this host: ${providers[*]}"

    local provider_id
    for provider_id in "${providers[@]}"; do
        provider_credential_flow "$dir" "$provider_id"
    done
}

# The credential variable one provider's interactive prompt fills.
#
# Defaults to the first name in that provider's table row, so a newly
# registered provider is prompted for with no edit here. Claude overrides it:
# its row leads with ANTHROPIC_API_KEY (metered, per-token billing), while the
# credential setup must ask for is the subscription OAuth token
# `claude setup-token` mints — rate-limiting is a far better failure mode than
# a surprise bill.
#
# Arguments: provider id, the comma-separated credential variable names.
provider_prompt_credential_var() {
    local id="$1" var_list="$2"
    case "$id" in
        claude) printf '%s' "CLAUDE_CODE_OAUTH_TOKEN" ;;
        *) printf '%s' "${var_list%%,*}" ;;
    esac
}

# Where an operator gets one provider's credential, when we can say.
#
# A provider with no entry simply gets no hint line — the prompt still names
# the variable and the provisioning variable, so it stays usable. Claude has
# no entry either: its paste prompt spells the whole `claude setup-token`
# recipe out instead.
provider_credential_source_hint() {
    case "$1" in
        codex) printf '%s' "an OpenAI API key from https://platform.openai.com/api-keys" ;;
        gemini) printf '%s' "a Google AI Studio key from https://aistudio.google.com/apikey" ;;
        deepseek) printf '%s' "a key issued at https://platform.deepseek.com/api_keys" ;;
        *) printf '' ;;
    esac
}

# Validate a stored credential where the provider supports it.
#
# Claude's CLI can prove a token authenticates with a live call (Issue #4161).
# No other vendor ships a comparably cheap, non-billing check, so their stored
# credentials are taken at face value here — the worker's own credential
# preflight still requires the file to be present and owner-only, and the
# provider's auth-error detection still reports a bad key loudly at run time.
#
# Arguments: provider id, credential file. Returns 0 when the credential may
# be kept.
provider_credential_is_valid() {
    local id="$1" file="$2"
    case "$id" in
        claude) claude_credential_is_valid "$file" ;;
        *) return 0 ;;
    esac
}

# Acquire a credential without a paste, where the provider's CLI can mint one.
#
# Sets VIBE_MINTED_CREDENTIAL to the captured secret, or empty when this
# provider has no paste-free path, its CLI is absent, or the operator
# declined. Claude is the only provider with one today; the generic paste
# prompt covers every other.
VIBE_MINTED_CREDENTIAL=""
mint_provider_credential() {
    local id="$1"
    VIBE_MINTED_CREDENTIAL=""
    [[ "$id" == "claude" ]] || return 0
    command -v claude &>/dev/null || return 0

    print_info "The containerised worker cannot reach the macOS Keychain, so the claude"
    print_info "CLI needs a long-lived OAuth token. Setup can run \`claude setup-token\`"
    print_info "for you: a browser opens, you sign in with the Claude account that"
    print_info "holds your subscription, and the token is captured automatically."
    print_info "(The token bills that subscription and can only ever rate-limit -"
    print_info "never run up per-token API charges. It lasts about a year; re-run"
    print_info "./setup.sh to replace it when it expires.)"
    echo -n "  Run \`claude setup-token\` now? [Y/n] "
    local run_setup_token=""
    IFS= read -r run_setup_token || run_setup_token=""
    if [[ "$run_setup_token" != "n" && "$run_setup_token" != "N" ]]; then
        VIBE_MINTED_CREDENTIAL="$(capture_setup_token)"
        if [[ -z "$VIBE_MINTED_CREDENTIAL" ]]; then
            print_warning "No token captured from claude setup-token — paste one instead"
        fi
    fi
}

# Print the paste instructions for one provider.
#
# Claude's recipe is spelled out in full because minting its token is a
# multi-step browser flow; every other provider gets the generic instructions
# built from its own table row, which is what makes a new provider work here
# without an edit.
#
# Arguments: provider id, the variable being asked for, the provisioning
# variable, and the credential file it lands in.
print_provider_credential_instructions() {
    local id="$1" prompt_var="$2" provision_var="$3" env_file="$4" hint
    hint="$(provider_credential_source_hint "$id")"

    if [[ "$id" == "claude" ]]; then
        print_info "To generate the token by hand:"
        echo ""
        echo "    1. Open a second terminal (leave this prompt waiting)."
        echo "    2. Run:  claude setup-token"
        echo "    3. A browser opens - sign in with the Claude account that holds"
        echo "       your subscription. This token bills that subscription and can"
        echo "       only ever rate-limit, never run up per-token API charges."
        echo "       (Over SSH with no browser, the command prints a URL instead:"
        echo "       open it on any device and paste the code back.)"
        echo "    4. Copy the printed token (starts with sk-ant-oat01-...)."
        echo "    5. Paste it below and press Enter. Nothing appears as you paste -"
        echo "       input is hidden so the token stays out of your scrollback."
        echo ""
        return 0
    fi

    print_info "The containerised worker authenticates ${id} from ${env_file}."
    if [[ -n "$hint" ]]; then
        print_info "Paste ${prompt_var} below - ${hint}."
    else
        print_info "Paste ${prompt_var} below."
    fi
    print_info "Nothing appears as you paste - input is hidden so the secret stays"
    print_info "out of your scrollback. Set ${provision_var} instead to provision it"
    print_info "non-interactively on the next run."
    echo ""
}

# Fill one provider's credential gap interactively (Issue #730).
#
# Every step comes from that provider's row in
# `vibe_provider_credential_table`, and the write goes through
# `provision_provider_credential` — the same owner-only path the
# non-interactive flow uses — so there is exactly one place that decides where
# a credential lands and how it is protected.
#
# Arguments: the credential directory, the provider id.
provider_credential_flow() {
    local dir="$1" id="$2"
    local row="" subdir provision_var var_list prompt_var env_file

    row="$(vibe_provider_credential_row "$id")" || {
        print_error "No credential row for coding-agent provider '${id}' — add one to vibe_provider_credential_table in setup.sh before enabling it"
        return 1
    }
    IFS='|' read -r subdir provision_var var_list <<< "$row"
    env_file="${dir}/${subdir}/provider.env"
    prompt_var="$(provider_prompt_credential_var "$id" "$var_list")"

    # An existing credential is exercised for real before it is trusted
    # (Issue #4161): an expired or revoked token is discarded here so the
    # acquisition below replaces it instead of the worker discovering the
    # problem unattended at 3am.
    if [[ -f "$env_file" ]] && ! provider_credential_is_valid "$id" "$env_file"; then
        print_warning "Stored ${id} credential failed validation (expired token?) — replacing it"
        rm -f "$env_file"
    fi

    # Rotation path for a still-valid credential: offer to replace, default keep.
    if [[ -f "$env_file" ]]; then
        echo -n "  ${id} credential already provisioned - replace it (e.g. expired token)? [y/N] "
        local replace_existing=""
        IFS= read -r replace_existing || replace_existing=""
        if [[ "$replace_existing" == "y" || "$replace_existing" == "Y" ]]; then
            rm -f "$env_file"
        fi
    fi

    # Two acquisition attempts: a credential that fails its validation call is
    # removed and the offer repeats once before setup gives up loudly.
    local _attempt
    # shellcheck disable=SC2034 # loop counter, intentionally unread
    for _attempt in 1 2; do
        [[ -f "$env_file" ]] && break
        local secret=""

        # Preferred path where one exists: let the provider's own CLI mint the
        # credential, so the operator only does the browser sign-in.
        mint_provider_credential "$id"
        secret="$VIBE_MINTED_CREDENTIAL"
        VIBE_MINTED_CREDENTIAL=""

        # Fallback: manual paste, with the recipe spelled out so the operator
        # needs nothing beyond this prompt.
        if [[ -z "$secret" ]]; then
            print_provider_credential_instructions "$id" "$prompt_var" "$provision_var" "$env_file"
            echo -n "  ${prompt_var} (input hidden; Enter to skip): "
            IFS= read -rs secret || secret=""
            echo ""
        fi

        # Enter alone skips — leave the loop rather than re-asking.
        [[ -n "$secret" ]] || break

        # Hand the secret to the shared writer under the name it must be
        # stored as: one owner-only write path for both credential flows. The
        # operator's own value for that variable — they may have exported one
        # before running setup — is put back afterwards rather than dropped.
        local inherited="${!prompt_var:-}" wrote=0
        printf -v "$prompt_var" '%s' "$secret"
        if provision_provider_credential "$dir" "$subdir" "$prompt_var" "$prompt_var" quiet; then
            wrote=1
        fi
        if [[ -n "$inherited" ]]; then
            printf -v "$prompt_var" '%s' "$inherited"
        else
            unset "$prompt_var"
        fi
        if [[ "$wrote" -eq 0 ]]; then
            print_error "Could not write the ${id} credential to ${env_file}"
            return 1
        fi

        # The proof is a real completion, not the write (Issue #3234): the
        # write itself is announced only once it has survived validation, so a
        # credential that never authenticated never prints a success line.
        if provider_credential_is_valid "$id" "$env_file"; then
            print_success "Provisioned ${id} credential (owner-only) in ${env_file}"
        else
            rm -f "$env_file"
            print_warning "The new ${id} credential failed validation (${id} could not authenticate with it)"
        fi
    done

    if [[ ! -f "$env_file" ]]; then
        print_warning "No ${id} credential — the containerised worker fails its credential preflight until one is provisioned"
    fi
}

# Prove a provisioned claude credential works by asking the CLI for a trivial
# completion (Issue #4161). The provider.env is sourced in a clean subshell —
# any ANTHROPIC_*/CLAUDE_* material in the operator's own environment is
# unset first, so only the stored credential is exercised.
#
# Only a DEFINITIVE authentication failure condemns the credential. A
# rate-limited answer ("usage limit reached") proves the token authenticated
# — the operator may simply be waiting for their subscription window — and a
# network failure or an unrecognised error proves nothing about the token, so
# all of those keep the credential with a warning. Deleting a good token
# because the plan window is exhausted would be worse than not checking.
claude_credential_is_valid() {
    local file="$1"
    command -v claude &>/dev/null || return 0
    local timeout_cmd=()
    if command -v timeout &>/dev/null; then
        timeout_cmd=(timeout 120)
    elif command -v gtimeout &>/dev/null; then
        timeout_cmd=(gtimeout 120)
    fi
    local out="" status=0
    out="$(
        unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
        set -a
        # shellcheck disable=SC1090
        source "$file"
        set +a
        ${timeout_cmd[@]+"${timeout_cmd[@]}"} claude -p 'Say hello' 2>&1 </dev/null
    )" || status=$?

    if [[ "$status" -eq 0 && -n "$out" ]]; then
        return 0
    fi
    if printf '%s' "$out" |
        grep -qiE 'invalid api key|run /login|oauth.*(expired|revoked|invalid)|authentication[_ ]?error|401 unauthorized'; then
        return 1
    fi
    if printf '%s' "$out" | grep -qiE 'limit reached|rate.?limit|overloaded|529'; then
        print_warning "claude is rate-limited right now — the credential authenticated, keeping it (usage window resets on its own)"
        return 0
    fi
    print_warning "Could not confirm the claude credential (claude said: ${out:0:160}) — keeping it"
    return 0
}

# Run `claude setup-token` on the operator's behalf and capture the token it
# prints (Issue #4161). The CLI renders an interactive terminal UI, so it must
# keep a real pty: `script(1)` supplies one while logging the session to an
# owner-only transcript, from which the sk-ant-oat01-... token is extracted.
# The transcript is deleted immediately — the token lives only in the
# credential file the caller writes. Prints the token, or nothing on failure
# (declined browser, missing `script`, no token in the output).
capture_setup_token() {
    local transcript token tty_out
    command -v script &>/dev/null || return 0
    transcript="$(mktemp "${TMPDIR:-/tmp}/vibe-setup-token.XXXXXX")" || return 0
    chmod 600 "$transcript"
    # The UI still needs the terminal; stdout of this function is captured by
    # the caller, so route the display to the tty when there is one. `-w`
    # is not enough — without a controlling terminal /dev/tty passes the
    # permission test but fails to open ("Device not configured"), so probe
    # by actually opening it.
    tty_out="/dev/null"
    if ( : >/dev/tty ) 2>/dev/null; then
        tty_out="/dev/tty"
    fi
    if is_macos; then
        script -q "$transcript" claude setup-token > "$tty_out" 2>&1 || true
    else
        script -q -c "claude setup-token" "$transcript" > "$tty_out" 2>&1 || true
    fi
    token="$(grep -oE 'sk-ant-oat01-[A-Za-z0-9_-]+' "$transcript" | tail -1 || true)"
    rm -f "$transcript"
    printf '%s' "$token"
}

# TTY gate + config lookup for the flow above: resolve the configured
# gh_config_dir as the copy source, then prompt. Non-interactive runs (cron,
# launchd, CI) skip entirely and keep today's env-var-only behaviour.
#
# Arguments: the configured provider ids, passed straight through.
prompt_interactive_credentials() {
    if [[ ! -t 0 ]]; then
        return 0
    fi
    local gh_source=""
    if [[ -f "$CONFIG_FILE" ]] && command -v jq &>/dev/null; then
        gh_source=$(jq -r '.gh_config_dir // empty' "$CONFIG_FILE" 2>/dev/null)
    fi
    interactive_credentials_flow "$gh_source" "$@"
}

# The coding-agent providers this host is configured to run (Issue #730).
#
# Resolved by the Deno seam (worker/deno/setup/agent_providers.ts) rather than
# parsed out of .config.json here: `agent_provider`, `agent_providers`, the
# VIBE_AGENT_PROVIDER(S) fallbacks and the default all live there, and jq —
# which this script would otherwise need — is container-owned and may not
# exist on the host at all. Prints one id per line.
#
# A selection that cannot be resolved is fatal: prompting for the wrong
# vendor's credential, or silently falling back to Claude on a Codex host, is
# exactly the failure this gating exists to remove (Issue #3234).
configured_agent_providers() {
    local ids=""
    if ! ids="$(run_setup_cli agent-providers)"; then
        print_error "Could not resolve the configured coding-agent providers from ${CONFIG_FILE}"
        return 1
    fi
    printf '%s\n' "$ids"
}

################################################################################
# Deno setup CLI helper
#
# All setup logic now lives in worker/deno/setup/setup_cli.ts (Issue #923).
# This shell script is a thin orchestrator that handles interactive prompting
# (terminal I/O) and delegates everything else to the Deno CLI.
################################################################################

SETUP_CLI="${SCRIPT_DIR}/worker/deno/setup/setup_cli.ts"

run_setup_cli() {
    if ! command -v deno &>/dev/null; then
        print_error "deno is required but not installed."
        print_info "Deno is core to Vibe Coder for TypeScript business logic."
        print_info "Install from: https://deno.com/ or with: curl -fsSL https://deno.land/install.sh | sh"
        exit 1
    fi
    # --frozen + --lock fail closed on dependency drift (Issues #2896, #3653),
    # mirroring run.sh: a stale or missing
    # lockfile is a hard error rather than a silent re-resolve that could pull
    # unreviewed transitive code into this credential-handling process.
    deno run --frozen --lock="${SCRIPT_DIR}/worker/deno/deno.lock" \
        --allow-all "$SETUP_CLI" "$@" \
        --script-dir "$SCRIPT_DIR" --config-path "$CONFIG_FILE"
}

################################################################################
# Interactive prompts (Issue #583)
#
# When setup.sh is run from a terminal, prompt for key configuration values.
# Existing values are shown as defaults — press Enter to keep them.
# These values are written directly to .config.json (no env vars needed).
################################################################################

prompt_interactive_config() {
    # Only prompt when running in a terminal
    if [[ ! -t 0 ]]; then
        return 0
    fi

    echo ""
    print_info "Interactive configuration (press Enter to keep existing values)"
    echo ""

    # Load existing config values for display
    local existing_repos=""
    local existing_allowed_author=""
    local existing_service_accounts=""
    local existing_ssh_key_path=""
    local existing_gh_config_dir=""
    local existing_imgbb_api_key=""
    if [[ -f "$CONFIG_FILE" ]] && command -v jq &>/dev/null; then
        existing_repos=$(jq -r '(.repos // []) | join(",")' "$CONFIG_FILE" 2>/dev/null)
        existing_allowed_author=$(jq -r '(.allowed_authors // []) | join(",")' "$CONFIG_FILE" 2>/dev/null)
        existing_service_accounts=$(jq -r '(.service_accounts // []) | join(",")' "$CONFIG_FILE" 2>/dev/null)
        existing_ssh_key_path=$(jq -r '.ssh_key_path // empty' "$CONFIG_FILE" 2>/dev/null)
        existing_gh_config_dir=$(jq -r '.gh_config_dir // empty' "$CONFIG_FILE" 2>/dev/null)
        existing_imgbb_api_key=$(jq -r '.imgbb_api_key // empty' "$CONFIG_FILE" 2>/dev/null)
    fi

    # Prompt for repos to monitor (required)
    local repos_display=""
    if [[ -n "$existing_repos" ]]; then
        repos_display=" [${existing_repos}]"
    fi
    echo -e "  Repositories to monitor (comma-separated, e.g. org/repo1,org/repo2)${repos_display}"
    echo -n "  Repos: "
    read -r input_repos
    if [[ -n "$input_repos" ]]; then
        INTERACTIVE_REPOS="$input_repos"
    elif [[ -n "$existing_repos" ]]; then
        INTERACTIVE_REPOS="$existing_repos"
    fi
    echo ""

    # Prompt for allowed author(s)
    local author_display=""
    if [[ -n "$existing_allowed_author" ]]; then
        author_display=" [${existing_allowed_author}]"
    fi
    echo -e "  GitHub username(s) to process issues from (comma-separated)${author_display}"
    echo -n "  Allowed authors: "
    read -r input_allowed_author
    if [[ -n "$input_allowed_author" ]]; then
        INTERACTIVE_ALLOWED_AUTHORS="$input_allowed_author"
    elif [[ -n "$existing_allowed_author" ]]; then
        INTERACTIVE_ALLOWED_AUTHORS="$existing_allowed_author"
    fi
    echo ""

    # Prompt for the worker identity guard allowlist (Issues #3528, #4030).
    # Leaving this blank defaults it to the login setup authenticates as, so
    # the guard enforces from the first run instead of shipping inactive.
    local service_accounts_display=""
    if [[ -n "$existing_service_accounts" ]]; then
        service_accounts_display=" [${existing_service_accounts}]"
    fi
    echo -e "  Service account login(s) this fleet runs as (comma-separated)${service_accounts_display}"
    echo -e "  The worker refuses to run as any account not on this list."
    echo -e "  They also count as fleet PR authors (unioned into fleet_pr_authors),"
    echo -e "  so a sibling's open PR blocks this host from duplicating the work."
    echo -e "  Leave blank to default to the account you are authenticated as."
    echo -n "  Service accounts: "
    read -r input_service_accounts
    if [[ -n "$input_service_accounts" ]]; then
        INTERACTIVE_SERVICE_ACCOUNTS="$input_service_accounts"
    elif [[ -n "$existing_service_accounts" ]]; then
        INTERACTIVE_SERVICE_ACCOUNTS="$existing_service_accounts"
    fi
    echo ""

    # Prompt for SSH key path (service account git transport)
    local ssh_display=""
    if [[ -n "$existing_ssh_key_path" ]]; then
        ssh_display=" [${existing_ssh_key_path}]"
    fi
    echo -e "  SSH key path for service account (optional)${ssh_display}"
    echo -e "  Used for all git clone/push/fetch operations."
    echo -e "  Leave blank to use your default SSH identity."
    echo -n "  SSH key path: "
    read -r input_ssh_key_path
    if [[ -n "$input_ssh_key_path" ]]; then
        # Expand ~ for validation
        local expanded_path="${input_ssh_key_path/#\~/$HOME}"
        if [[ ! -f "$expanded_path" ]]; then
            print_warning "SSH key not found at ${input_ssh_key_path} — saving anyway (create before running worker)"
        fi
        INTERACTIVE_SSH_KEY_PATH="$input_ssh_key_path"
    elif [[ -n "$existing_ssh_key_path" ]]; then
        INTERACTIVE_SSH_KEY_PATH="$existing_ssh_key_path"
    fi
    echo ""

    # Prompt for gh config dir (separate gh CLI identity)
    local gh_display=""
    local gh_default="${VIBE_PROVISIONED_GH_CONFIG_DIR:-$HOME/.config/gh-vibe}"
    if [[ -n "$existing_gh_config_dir" ]]; then
        gh_display=" [${existing_gh_config_dir}]"
    else
        gh_display=" [${gh_default}]"
    fi
    echo -e "  gh config directory for service account (optional)${gh_display}"
    echo -e "  Used for all gh CLI operations (separate from personal gh auth)."
    echo -e "  Leave blank to use default, or enter a path."
    echo -n "  gh config dir: "
    read -r input_gh_config_dir
    if [[ -n "$input_gh_config_dir" ]]; then
        INTERACTIVE_GH_CONFIG_DIR="$input_gh_config_dir"
    elif [[ -n "$existing_gh_config_dir" ]]; then
        INTERACTIVE_GH_CONFIG_DIR="$existing_gh_config_dir"
    elif [[ -n "$VIBE_PROVISIONED_GH_CONFIG_DIR" ]]; then
        # Point the worker at the credential directory provisioned above
        # (Issue #4064) so no runtime step needs an interactive login.
        INTERACTIVE_GH_CONFIG_DIR="$VIBE_PROVISIONED_GH_CONFIG_DIR"
    fi

    echo ""

    # Prompt for ImgBB API key (automatic screenshot uploads — Issue #924)
    local imgbb_display=""
    if [[ -n "$existing_imgbb_api_key" ]]; then
        imgbb_display=" [configured]"
    fi
    echo -e "  ImgBB API key for automatic screenshot uploads (optional)${imgbb_display}"
    echo -e "  Get a free key from https://api.imgbb.com/"
    echo -e "  Without this, screenshots are saved locally only."
    echo -n "  ImgBB API key: "
    read -r input_imgbb_api_key
    if [[ -n "$input_imgbb_api_key" ]]; then
        INTERACTIVE_IMGBB_API_KEY="$input_imgbb_api_key"
    elif [[ -n "$existing_imgbb_api_key" ]]; then
        INTERACTIVE_IMGBB_API_KEY="$existing_imgbb_api_key"
    fi

    echo ""

    # If a gh config dir is set, ensure it exists and offer to run gh auth login
    if [[ -n "${INTERACTIVE_GH_CONFIG_DIR:-}" ]]; then
        local expanded_gh_dir="${INTERACTIVE_GH_CONFIG_DIR/#\~/$HOME}"
        if [[ ! -d "$expanded_gh_dir" ]]; then
            print_info "Creating gh config directory: ${INTERACTIVE_GH_CONFIG_DIR}"
            mkdir -p "$expanded_gh_dir"
        fi
        # Check if already authenticated in this config dir
        if GH_CONFIG_DIR="$expanded_gh_dir" gh auth status &>/dev/null; then
            print_success "Already authenticated in ${INTERACTIVE_GH_CONFIG_DIR}"
        elif [[ -n "$VIBE_PROVISIONED_GH_CONFIG_DIR" && "$expanded_gh_dir" == "$VIBE_PROVISIONED_GH_CONFIG_DIR" ]]; then
            # Provisioned non-interactively above — never offer a login prompt
            # for the directory the worker consumes at runtime (Issue #4064).
            print_warning "Provisioned token in ${INTERACTIVE_GH_CONFIG_DIR} did not validate — check VIBE_LAUNCHAGENT_GH_TOKEN"
        elif [[ ! -t 0 ]]; then
            print_warning "Not authenticated in ${INTERACTIVE_GH_CONFIG_DIR} — set VIBE_LAUNCHAGENT_GH_TOKEN and re-run to provision it non-interactively"
        else
            print_warning "Not authenticated in ${INTERACTIVE_GH_CONFIG_DIR}"
            echo -e "  Run gh auth login now? [Y/n] "
            read -r do_login
            if [[ "$do_login" != "n" && "$do_login" != "N" ]]; then
                GH_CONFIG_DIR="$expanded_gh_dir" gh auth login
                GH_CONFIG_DIR="$expanded_gh_dir" gh config set git_protocol ssh
                print_success "Authenticated and set git_protocol=ssh in ${INTERACTIVE_GH_CONFIG_DIR}"
            fi
        fi
    fi
    echo ""
}

# Write interactive values directly into .config.json after TS setup runs.
# This merges ssh_key_path and gh_config_dir into the config file.
write_interactive_config() {
    if [[ -z "${INTERACTIVE_REPOS:-}" && -z "${INTERACTIVE_ALLOWED_AUTHORS:-}" && -z "${INTERACTIVE_SERVICE_ACCOUNTS:-}" && -z "${INTERACTIVE_SSH_KEY_PATH:-}" && -z "${INTERACTIVE_GH_CONFIG_DIR:-}" && -z "${INTERACTIVE_IMGBB_API_KEY:-}" ]]; then
        return 0
    fi

    # jq is container-owned (Issue #4117), so it may legitimately be absent on
    # a container-only host — but interactive answers were collected here and
    # dropping them silently would look like a successful setup (Issue #3234).
    if ! command -v jq &>/dev/null; then
        print_error "jq is required to merge the interactive answers into $CONFIG_FILE"
        print_info "Install jq on the host, or set the VIBE_* variables and run setup non-interactively."
        exit 1
    fi

    local config
    config=$(cat "$CONFIG_FILE")

    if [[ -n "${INTERACTIVE_REPOS:-}" ]]; then
        config=$(echo "$config" | jq --arg v "$INTERACTIVE_REPOS" '. + {repos: ($v | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != "")))}')
    fi

    if [[ -n "${INTERACTIVE_ALLOWED_AUTHORS:-}" ]]; then
        config=$(echo "$config" | jq --arg v "$INTERACTIVE_ALLOWED_AUTHORS" '. + {allowed_authors: ($v | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != "")))}')
    fi

    if [[ -n "${INTERACTIVE_SERVICE_ACCOUNTS:-}" ]]; then
        config=$(echo "$config" | jq --arg v "$INTERACTIVE_SERVICE_ACCOUNTS" '. + {service_accounts: ($v | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != "")))}')
    fi

    if [[ -n "${INTERACTIVE_SSH_KEY_PATH:-}" ]]; then
        config=$(echo "$config" | jq --arg v "$INTERACTIVE_SSH_KEY_PATH" '. + {ssh_key_path: $v}')
    fi

    if [[ -n "${INTERACTIVE_GH_CONFIG_DIR:-}" ]]; then
        config=$(echo "$config" | jq --arg v "$INTERACTIVE_GH_CONFIG_DIR" '. + {gh_config_dir: $v}')
    fi

    if [[ -n "${INTERACTIVE_IMGBB_API_KEY:-}" ]]; then
        config=$(echo "$config" | jq --arg v "$INTERACTIVE_IMGBB_API_KEY" '. + {imgbb_api_key: $v}')
    fi

    echo "$config" | jq '.' > "$CONFIG_FILE"
}

# Offer to install the macOS LaunchAgent interactively.
#
# This replaces the old VIBE_SETUP_LAUNCHAGENT env-var gate: setup.sh is run by
# hand, so it simply asks. Most machines run unattended and should install the
# LaunchAgent (launchd invokes run.sh every five minutes — the canonical
# supervision model); answer "n" on a machine that keeps starting the worker
# manually via loop.sh (for example a laptop in daily interactive use).
#
# The LaunchAgent loads into the gui/<uid> domain, so the worker keeps full
# graphical-session access (window server, launching Chrome) while the user is
# logged in — which a system LaunchDaemon would not provide. Paths are not
# hard-coded: the Deno `launchagent` setup derives scriptDir/logsDir at runtime.
# Remind the operator about host work directories made obsolete by the named
# volumes (Issue #4186). In container mode the workspace lives on the
# `vibe-work` / `vibe-approval-state` runtime volumes, so a leftover
# ~/auto-issue-work (or its approval-state sibling) on the host is never
# mounted again and only wastes disk. A directory holding worker data gets a
# reminder only — deleting operator data is never setup's call — but one that
# holds nothing beyond a `.vibe-cache` entry is setup's own leftover and is
# removed outright (Issue #134).
# True when the directory holds anything besides a `.vibe-cache` entry.
# Setup caches nothing on the host (Issue #132 — host-side runs re-query the
# GitHub API instead), so a `.vibe-cache` here is only a harmless leftover
# from an earlier version, not a live workspace: only repository checkouts
# and other worker data count as wasted disk.
host_work_dir_holds_worker_data() {
    local entry
    for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
        [[ -e "${entry}" || -L "${entry}" ]] || continue
        [[ "${entry##*/}" == ".vibe-cache" ]] && continue
        return 0
    done
    return 1
}

# Remove a host work dir that holds nothing beyond a `.vibe-cache` entry an
# earlier setup version wrote (Issue #134; setup caches nothing on the host
# any more, Issue #132). Callers have already established the directory exists
# and holds no worker data; this deletes the cache subtree and the then-empty
# directory, reporting what went — silent deletion is worse than none.
#
# Guarded: an empty path, `/`, or `${HOME}` itself is refused outright. A
# bare `rm -rf` built from an unset variable is the failure mode this guard
# exists for, so it stays even though today's callers cannot pass those.
remove_cache_only_host_work_dir() {
    local dir="$1"
    if [[ -z "${dir}" || "${dir}" == "/" || "${dir}" == "${HOME}" ]]; then
        print_warning "Refusing to remove '${dir}': not a disposable host work directory."
        return 0
    fi
    rm -rf "${dir}/.vibe-cache"
    if rmdir "${dir}" 2>/dev/null; then
        print_info "Removed ${dir}: it held nothing but a stale .vibe-cache from an earlier setup (Issue #134); container mode keeps the workspace on named volumes."
    fi
}

remind_obsolete_host_work_dirs() {
    # Container is the only run mode (Issue #4), so the host work dir is
    # always obsolete once the worker runs; still resolved through the same
    # Deno command the launchers use, best-effort — a configuration that
    # cannot be resolved skips the reminder rather than failing setup.
    local mode
    if ! mode="$(deno run \
        --frozen --lock="${SCRIPT_DIR}/worker/deno/deno.lock" \
        --allow-env --allow-read \
        "${SCRIPT_DIR}/worker/deno/mod.ts" run-mode </dev/null 2>/dev/null)"; then
        return 0
    fi
    [[ "${mode}" == "container" ]] || return 0

    local work_dir="${WORK_DIR:-${HOME}/auto-issue-work}"
    local dir size found=false
    for dir in "${work_dir}" "${work_dir}-approval-state"; do
        [[ -d "${dir}" ]] || continue
        if host_work_dir_holds_worker_data "${dir}"; then
            size="$(du -sh "${dir}" 2>/dev/null | cut -f1)"
            print_warning "${dir} (${size:-size unknown}) is wasting disk: container mode keeps the workspace on named volumes (Issue #4186), so this host directory is never mounted again."
            found=true
        else
            # Cache-only (or empty) — setup's own doing, safe to reclaim.
            remove_cache_only_host_work_dir "${dir}"
        fi
    done
    if [[ "${found}" == "true" ]]; then
        print_info "Reclaim the space once you are happy with the containerised worker: rm -rf '${work_dir}' '${work_dir}-approval-state'"
        print_info "(Content-approval snapshots re-baseline on the new volume; repositories re-clone on first use.)"
    fi
}

prompt_launchagent_setup() {
    # macOS-only feature — silently skip everywhere else.
    is_macos || return 0

    # Only prompt when attached to a terminal; non-interactive runs (CI, piped
    # installs) skip the install rather than block forever on input.
    if [[ ! -t 0 ]]; then
        return 0
    fi

    echo ""
    print_info "The macOS LaunchAgent runs the worker automatically via launchd"
    print_info "(run.sh every 5 minutes, restarted at login). It keeps full GUI"
    print_info "access — it can launch Chrome — while you are logged in."
    print_info "Answer 'y' ONLY on a machine where nothing starts the worker by hand."
    print_info "If you run ./loop.sh yourself, answer 'n' — two workers on one host"
    print_info "collide on the work volumes (Issue #26)."
    # Defaults to NO. Installing starts a second worker on a host that may
    # already have one, and a bare Enter must never do that: on GRQ-23 an
    # Enter through this prompt left launchd running the worker every five
    # minutes beside the operator's own `./loop.sh`, unnoticed until the two
    # were found fighting over the same work volume. The safe answer is the
    # one that changes nothing, so it is the one Enter gives you.
    echo -n "  Install the LaunchAgent now? [y/N] "
    read -r install_launchagent
    if [[ "$install_launchagent" == "y" || "$install_launchagent" == "Y" ||
          "$install_launchagent" == "yes" || "$install_launchagent" == "YES" ]]; then
        run_setup_cli launchagent
        return 0
    fi

    # Declined. An agent an earlier setup installed is still there, still
    # launching the worker every five minutes beside whatever the operator
    # starts by hand - and two workers on one host collide on the work
    # volumes (Issue #26). Say so, and offer to remove it; "no" here must
    # never silently mean "keep the one you have".
    local plist_dir="${VIBE_LAUNCHAGENT_DIR:-$HOME/Library/LaunchAgents}"
    if [[ -f "${plist_dir}/com.vibe.auto-issue-worker.plist" ]]; then
        print_warning "The LaunchAgent is currently installed: launchd starts the worker every 5 minutes on this machine."
        print_info "Starting the worker by hand (./loop.sh) as well would run two workers on this host - one worker per host."
        echo -n "  Remove the installed LaunchAgent now? [Y/n] "
        read -r remove_launchagent
        if [[ "$remove_launchagent" != "n" && "$remove_launchagent" != "N" ]]; then
            run_setup_cli launchagent --uninstall
        else
            print_info "Keeping the LaunchAgent - do not also start the worker by hand on this machine."
        fi
    else
        print_info "Skipping LaunchAgent — continue starting the worker manually (e.g. ./loop.sh)."
    fi
}

main() {
    # --auto-install consents in advance to every offered install (Issue #33),
    # so a scripted `./setup.sh --auto-install` gets the container runtime
    # installed without a terminal to prompt on. It is deliberately a flag the
    # operator types on this invocation, never an environment variable.
    local auto_install=false arg
    for arg in "$@"; do
        case "${arg}" in
            --auto-install) auto_install=true ;;
        esac
    done

    # Issue #672: adding or removing ONE repository must not mean sitting
    # through the whole wizard. The operator said it plainly — "I don't use it
    # for adding repos" — and hand-editing .config.json is what the wizard was
    # meant to prevent. These short-circuit before any prompt, install or sync.
    case "${1:-}" in
        --add-repo)
            [[ -n "${2:-}" ]] || { print_error "--add-repo needs owner/repo"; exit 1; }
            run_setup_cli repos --add "$2"
            return $?
            ;;
        --remove-repo)
            [[ -n "${2:-}" ]] || { print_error "--remove-repo needs owner/repo"; exit 1; }
            run_setup_cli repos --remove "$2"
            return $?
            ;;
        --list-repos)
            run_setup_cli repos
            return $?
            ;;
    esac

    # Prerequisites check via Deno
    if [[ "${auto_install}" == "true" ]]; then
        run_setup_cli prerequisites --auto-install
    else
        run_setup_cli prerequisites
    fi

    # Provision the dedicated credential directory non-interactively from
    # environment variables (Issue #4064). Runs before the prompts so the gh
    # config directory defaults to it and no login prompt is offered for it.
    provision_vibe_credentials

    # Which coding agents this host runs decides which credentials it is asked
    # for (Issue #730). Both this and the prerequisite probe above read the
    # selection through the same seam (worker/deno/setup/agent_providers.ts)
    # from the same file, so the tools the probe demanded and the credentials
    # the prompts ask for describe one host, not two.
    local provider_list provider_id
    provider_list="$(configured_agent_providers)" || exit 1
    local -a agent_providers=()
    while IFS= read -r provider_id; do
        if [[ -n "$provider_id" ]]; then
            agent_providers+=("$provider_id")
        fi
    done <<< "$provider_list"
    # An empty set is a fault in the resolution, not a licence to guess: the
    # default provider here would prompt a Codex host for a Claude token.
    if [[ ${#agent_providers[@]} -eq 0 ]]; then
        print_error "No coding-agent provider resolved from ${CONFIG_FILE} — fix agent_provider/agent_providers and re-run setup"
        exit 1
    fi

    # Fill remaining credential gaps interactively (Issues #4161, #730): offer
    # to copy the existing gh identity, then run one credential flow per
    # configured provider — Claude's OAuth token only on a host that runs
    # Claude.
    prompt_interactive_credentials "${agent_providers[@]}"

    # Prompt interactively when running in a terminal (Issue #583)
    prompt_interactive_config

    # Write config from VIBE_* env vars, then merge interactive values
    run_setup_cli config
    write_interactive_config

    # Ask for the update mode and, when frozen, the pinned ref and the exact
    # tool versions (Issue #626). The whole conversation — the prompts, the
    # ref validation and the merge into .config.json — lives in the Deno
    # command, in the same shape as run.sh delegating to
    # worker-checkout-update; this script keeps no mode logic of its own. It
    # runs after write_interactive_config so a single setup run leaves one
    # coherent config file, and it never prompts without a terminal.
    run_setup_cli update-mode

    # Standardise labels across all monitored repos (Issue #864)
    run_setup_cli label-sync || print_warning "Some labels could not be synced (non-fatal)"

    # Audit workflows and raise issues for missing CI protections (Issue #1444)
    run_setup_cli workflow-sync || print_warning "Workflow sync had issues (non-fatal)"

    # Audit workflows for best-practice findings (Issue #2102 — part of #2094)
    run_setup_cli best-practices-sync || print_warning "Best-practice sync had issues (non-fatal)"

    # Apply canonical .gitignore safety block to monitored repos (Issue #1774).
    # Moved out of per-iteration setupRepo() so it runs once at setup time.
    run_setup_cli gitignore-sync || print_warning "Gitignore sync had issues (non-fatal)"

    # Precheck the worker is a collaborator on every monitored repo (Issue #2326).
    # Runs once per setup invocation (and on VIBE_ADD_REPOS), never in the
    # per-iteration loop — rate-limit budget is the whole reason. Non-fatal.
    run_setup_cli verify-monitored-collaborator \
        || print_warning "Collaborator precheck found misconfigured repo(s) — see filed issue"

    # Apply the default-branch ruleset to every monitored repo
    # (Issue #2588 — part of #2561). Runs after the collaborator precheck
    # (which validates access). Setup-time only, never in the per-iteration
    # loop — one read + at most one PUT per repo. Idempotent and non-fatal.
    # Non-fatal, and the *reason* is on the per-repository lines the CLI
    # printed just above — a private repository on a free plan needs GitHub
    # Pro, which reads identically to a bad token unless it is said out loud
    # (Issue #733).
    run_setup_cli branch-protection-sync \
        || print_warning "Ruleset sync had issues — see the per-repository lines above (non-fatal)"

    # Back-fill `idle-task` label on existing `Run a security scan` wrappers
    # (Issue #2131). Idempotent — already-labelled wrappers emit
    # `already_labelled` events and are not re-touched.
    run_setup_cli backfill-idle-task-labels || print_warning "idle-task label back-fill had issues (non-fatal)"

    # Install security hooks (Issue #34) and clean up retired hooks
    run_setup_cli hooks

    # Remind about host work directories the named volumes made obsolete
    # (Issue #4186). Reminder only — never deletes.
    remind_obsolete_host_work_dirs

    # Offer to install the macOS LaunchAgent (interactive — replaces the old
    # VIBE_SETUP_LAUNCHAGENT env-var gate). Skipped on non-macOS / non-TTY.
    prompt_launchagent_setup

    # Setup screenshot support if requested
    if [[ "${VIBE_SETUP_SCREENSHOT_SUPPORT:-}" == "true" ]]; then
        run_setup_cli screenshot
    fi
}

# Only run when executed, not when sourced — tests source this script to
# exercise individual helpers such as run_setup_cli (Issue #3653).
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
    # Leave through exit rather than falling off the end: bash reads a script
    # lazily by byte offset, so a setup.sh rewritten while a long run is still
    # going (a `git pull` in another window) would otherwise be read past its
    # old end and a fragment of the new text executed as a command.
    exit $?
fi
