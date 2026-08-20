# 🛠️ Setup Guide

This is the document you read to get a Vibe Coder configured on a host — by
script or by hand — on macOS, Linux or Windows. It ends where the
[Deployment Guide](DEPLOYMENT.md) begins: once the worker runs correctly by
hand, the background-service setup (cron, launchd, systemd or Task Scheduler)
is [DEPLOYMENT.md](DEPLOYMENT.md)'s job, and this document links to it rather
than repeating it.

There are two supported routes, and they produce the same end state:

- **The automated route** — `./setup.sh` on macOS and Linux, `setup.ps1` on
  Windows. The script probes prerequisites, provisions credentials and
  configuration, syncs the monitored repositories and installs the hooks.
- **The manual route** — every step by hand, so the script is never required.
  An operator who cannot or will not run the script can still bring a bare
  host to exactly the state a scripted run would have produced.

## 📋 Table of Contents

- [What the automated setup does](#what-the-automated-setup-does)
- [Platform differences in the automated setup](#platform-differences-in-the-automated-setup)
- [Manual setup: prerequisites](#manual-setup-prerequisites)
- [Manual setup: credentials](#manual-setup-credentials)
- [Manual setup: writing `.config.json`](#manual-setup-writing-configjson)
- [Manual setup: repo sync steps and verification](#manual-setup-repo-sync-steps-and-verification)

## What the automated setup does

*Placeholder — this section will carry the numbered phase walkthrough of an
automated setup run, with a Mermaid flow diagram (#78, parent #66).*

## Platform differences in the automated setup

The phase sequence is the same everywhere; this section is the short list of
everywhere the platforms actually diverge. Read the shared walkthrough plus
your platform's column and you have the whole picture — nothing below repeats
what another document owns.

| | macOS | Linux (Debian/Ubuntu) | Windows |
|---|---|---|---|
| Entry point | `./setup.sh` (bash) | `./setup.sh` (bash) | `.\setup.ps1` (PowerShell) |
| Unattended consent | `./setup.sh --auto-install` | `./setup.sh --auto-install` | `.\setup.ps1 -AutoInstall` |
| Install offers use | Homebrew (`brew install …`) | apt (`sudo apt-get install -y …`) | `winget install --exact --id … --source winget` |
| Container runtime | Apple `container`, installed **and** started | Docker, then Podman | Docker Desktop, then Podman |
| Credential/config protection | `chmod` 0700 / 0600 | `chmod` 0700 / 0600 | Inheritance-stripped ACL, current identity only |
| Background-service offer | LaunchAgent prompt | None at setup time | Scheduled-task prompt |
| Home directory | `$HOME` | `$HOME` | `%USERPROFILE%` (then `HOME`) |

**Entry point and invocation.** macOS and Linux run `./setup.sh` under bash;
Windows runs `setup.ps1` under PowerShell. The unattended-consent switch —
`./setup.sh --auto-install`, `.\setup.ps1 -AutoInstall` — consents in advance
to every install the run would otherwise offer interactively. It is
deliberately a flag typed on that one invocation, never an environment
variable, so consent cannot leak into later runs.

**What an install offer can resolve to.** When the prerequisites probe finds a
tool missing, the offer resolves to a package-manager command from a fixed
per-platform table (`worker/deno/setup/prerequisite_install_plan.ts`):
Homebrew on macOS, apt on Debian/Ubuntu (these steps may prompt for `sudo`),
and `winget --source winget` on Windows (winget elevates through UAC itself).
The table has holes you close by hand:

- **No package manager, no plan.** On a macOS host without Homebrew, or a
  Linux host without apt, every offer is withheld and the report falls back
  to a manual install hint — the script never runs a remote install script
  for you.
- **No `deno` package exists for Debian/Ubuntu**, so Deno is never offered
  there; you install it yourself.
- **`git` has no install plan on macOS or Linux** (it arrives with the Xcode
  command line tools, or is already present as a bootstrap dependency); only
  Windows can have it installed for you (winget `Git.Git`).

**Container runtime.** macOS accepts only Apple `container` — Docker Desktop
is not the containment boundary there — and its install offer both installs
the Homebrew formula and starts the service, because the probe checks the
running service rather than the binary's presence. Linux and Windows probe
Docker first, then Podman. What the runtime runs and how the image is built is
[CONTAINER.md](CONTAINER.md); why containment is mandatory is
[CONTAINMENT.md](CONTAINMENT.md).

**File permissions on credential and config files.** On macOS and Linux the
credential directories are `chmod` 0700 and the files within 0600. On Windows
the same protection is an ACL: `Protect-VibePath` (`setup.ps1`) strips the
path's inherited access outright and grants full control to the current
identity alone, so a profile that gives *Users* read access cannot leak a
credential. Windows also writes every credential and config file LF-terminated
and without a byte-order mark (`Write-VibeTextFile`), because the container
reads them on Linux — hand-edit these files on Windows with the same
discipline.

**Background-service offer.** A terminal-attached run ends with a
platform-specific offer: macOS offers to install the LaunchAgent (launchd
starts the worker every five minutes), Windows offers to register the
scheduled task (Task Scheduler, every five minutes and at logon). Linux gets
no offer at setup time — the operator wires cron or systemd from
[DEPLOYMENT.md](DEPLOYMENT.md), which owns background-service configuration on
every platform.

**Where paths differ.** The credential directory defaults to
`~/.vibe-coder/credentials` on every platform. On Windows, `~` means the
profile directory: `setup.ps1` resolves the home directory as `USERPROFILE`,
falling back to `HOME` (`Get-VibeHomeDirectory`), so the default lands at
`%USERPROFILE%\.vibe-coder\credentials`, and the same resolution expands a
leading `~` in the paths setup handles.

## Manual setup: prerequisites

This section brings a bare host to a passing prerequisites probe entirely by
hand — no `setup.sh`, no `setup.ps1`. The end state is exactly what the
scripted probe demands, so once the probe passes you continue with the
[credentials](#manual-setup-credentials) and
[`.config.json`](#manual-setup-writing-configjson) sections.

### The target state

The probe (`worker/deno/setup/prerequisites.ts`) classifies every tool as
**host-fatal** (a gap fails the probe) or **informational** (reported, never
fatal). The classification table lives in the
[Deployment Guide](DEPLOYMENT.md#-initial-setup); the checklist below is the
same set, stated as the state your host must reach:

- [ ] **`git`** installed — host-fatal.
- [ ] **`gh`** installed **and authenticated** (`gh auth status` passes) —
  host-fatal.
- [ ] **`deno`** installed — host-fatal.
- [ ] **`claude`** (the Claude Code CLI) installed — host-fatal, even though
  the worker runs the coding agent inside the container: setup mints and
  validates the worker's OAuth token with `claude setup-token`, so the host
  needs the CLI too.
- [ ] **A container runtime** installed *and answering its probe* —
  host-fatal. The **worker image** must be present or buildable from the
  committed definition; a missing image is fine (the launcher builds it on
  first run), a missing `container/` definition is not. The image itself is
  the [Container Image guide](CONTAINER.md)'s subject.
- [ ] **`jq`** and **`timeout`** — informational only. The
  [image](CONTAINER.md) provides both to the worker, so a host without them
  still passes.

### macOS

```bash
# git — ships with the Xcode command line tools (the automated path never
# offers this: it is a large, interactive Apple download)
xcode-select --install        # or: brew install git

# gh, then authenticate (always the operator's own step)
brew install gh
gh auth login

# deno
brew install deno

# claude CLI
brew install --cask claude-code

# container runtime — Apple container is a Homebrew formula, and the binary
# alone is not enough: the probe runs `container system status`, which fails
# until the service is started
brew install container
container system start

# optional (the image provides both): jq, and coreutils for timeout —
# Homebrew installs it as gtimeout, which the probe accepts
brew install jq coreutils
```

### Linux (Debian/Ubuntu as the worked example)

```bash
# git — the distribution package
sudo apt-get install -y git

# gh (Debian 12+ / Ubuntu 22.04+ carry it), then authenticate
sudo apt-get install -y gh
gh auth login

# deno — the upstream installer; no Debian or Ubuntu package exists,
# which is also why the automated path refuses to install it here.
# Installs to ~/.deno/bin — put that on PATH.
curl -fsSL https://deno.land/install.sh | sh

# claude CLI — no distribution package; use the upstream installer
# (https://docs.anthropic.com/en/docs/claude-code)
curl -fsSL https://claude.ai/install.sh | bash

# container runtime — the distribution's own Docker package (the automated
# path deliberately never adds Docker's third-party apt repository), or Podman
sudo apt-get install -y docker.io    # or: sudo apt-get install -y podman

# optional (the image provides both): jq; coreutils already supplies timeout
sudo apt-get install -y jq
```

On older releases without a `gh` package, install from
[cli.github.com](https://cli.github.com/) instead.

### Windows

Run in PowerShell. Winget may prompt to elevate through UAC.

```powershell
# git
winget install --exact --id Git.Git --source winget

# gh, then authenticate
winget install --exact --id GitHub.cli --source winget
gh auth login

# deno
winget install --exact --id DenoLand.Deno --source winget

# claude CLI — no winget package; use the upstream installer
# (https://docs.anthropic.com/en/docs/claude-code)
irm https://claude.ai/install.ps1 | iex

# container runtime — Docker Desktop, or Podman
winget install --exact --id Docker.DockerDesktop --source winget
# or: winget install --exact --id RedHat.Podman --source winget

# optional: jq (the image provides it)
winget install --exact --id jqlang.jq --source winget
```

An installed runtime must also be *answering*: start Docker Desktop (it is a
GUI application) or initialise the Podman machine before probing. `timeout`
has no Windows package at all — it stays informational there, as the
[Windows table](DEPLOYMENT.md#the-windows-table) explains.

### Clone the repository — a dedicated one

```bash
gh repo clone <your-org>/VibeCoder
```

The clone the worker runs from is an appliance checkout: the worker
hard-resets and cleans it on every cycle, so never point it at a clone you
also develop in. The
[Deployment Guide](DEPLOYMENT.md#the-worker-needs-its-own-dedicated-clone)
explains the failure modes in both directions.

### Verify — run the probe on its own

The probe runs standalone, so you can confirm the host is ready before
writing any credential or configuration:

```bash
cd worker/deno
deno task setup prerequisites
```

On an interactive terminal a failing probe offers to install what it can —
that is the [automated path's installer](DEPLOYMENT.md#interactive-install-offer);
decline the offers to stay manual. A pass prints one `✓` line per check
(informational gaps print as `ℹ`), ends with the headline, and exits `0`:

```text
✓  git is installed
✓  gh CLI authenticated as: your-login
✓  deno is installed
✓  Docker is installed and answering (/usr/bin/docker)
✓  Worker image vibe-coder:<hash> is not built yet — the launcher builds it on first run
✓  claude CLI is installed
ℹ  jq is not installed on the host — the container image provides it
ℹ  No action needed: container-only is the supported run mode.
✓  timeout is installed
✓  All host prerequisites satisfied (run mode: container)
```

A fail marks each host-fatal gap with `✗` and its fix, ends with the failing
headline, and exits `1`:

```text
✗  gh CLI is not authenticated
ℹ  Run: gh auth login
✗  Some host prerequisites are missing or not configured (run mode: container).
ℹ  Container mode needs git, an authenticated gh, deno, the claude CLI (setup mints the worker's OAuth token with it) and a working container runtime on the host; the image provides jq and timeout.
ℹ  VIBE_SKIP_PREREQ_CHECK=true skips the whole probe (CI only — it hides real gaps).
```

Out of scope here: credentials beyond `gh auth login`
([next section](#manual-setup-credentials)), `.config.json`
([its own section](#manual-setup-writing-configjson)), and background
services ([Deployment Guide](DEPLOYMENT.md)).

## Manual setup: credentials

The worker authenticates from files, never from a login. This section builds
by hand exactly what the scripted route's credential provisioning would have
written: one dedicated directory, read by the worker and mounted read-only
into the container. The authoritative layout, and the `VIBE_LAUNCHAGENT_*`
environment variables that provision it automatically instead, are in
[Deployment — Credential Provisioning](DEPLOYMENT.md#-credential-provisioning-non-interactive);
those variables are the scripted route, and everything below is the by-hand
one. Pointing `gh_config_dir` at the result is part of
[writing `.config.json`](#manual-setup-writing-configjson), the next section.

The invariant a manual setup must respect: **no runtime step may reach an
interactive credential mechanism** — no browser login, no `gh auth login` on
the run path, no macOS Keychain lookup. The credential is a file the operator
writes, not a login the worker performs.

### The layout to reproduce

```text
~/.vibe-coder/credentials/        (override with VIBE_CREDENTIAL_DIR)
├── gh/hosts.yml                  the worker's GitHub token
└── <provider>/provider.env       one file per enabled agent vendor
```

Nothing else belongs in that directory. Build only the vendors you use: an
unenabled provider is simply absent, and provisioning one vendor never touches
another's file. The permitted entries are exactly `gh/` plus one sub-directory
per **enabled** provider — a directory for a vendor that is not enabled counts
as unexpected material and fails the startup preflight, so remove a vendor's
sub-directory when you stop enabling it.

### `gh/hosts.yml`

Write the token inline — never a keychain reference, because the container
cannot reach a host credential store. On macOS in particular, a `hosts.yml`
taken from an ordinary `gh auth login` may contain no token at all (gh keeps
it in the Keychain); such a file fails the preflight even though `gh` works
fine on the host.

```yaml
github.com:
    oauth_token: ghp_your_token
    git_protocol: ssh
```

The preflight accepts any `oauth_token:` (or `token:`) line with a non-blank
value; a blank or empty-quoted value counts as no token.

### `<provider>/provider.env`

A single `NAME=value` line per file, using a variable name that vendor
accepts. `#` comment lines and an `export ` prefix are tolerated, and quotes
around the value are stripped, but one plain line is the canonical form:

```bash
ANTHROPIC_API_KEY=sk-ant-your_key
```

| Vendor | File | Accepted variable names |
|--------|------|-------------------------|
| Claude Code | `claude/provider.env` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex CLI | `codex/provider.env` | `OPENAI_API_KEY`, `CODEX_API_KEY` |
| Gemini CLI | `gemini/provider.env` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |

Any of the listed names works; the first is the one `setup.sh` writes. This
table mirrors `vibe_provider_credential_table` in `setup.sh` and the
descriptors in `worker/deno/lib/agent_provider.ts`, which remain the source of
truth — a quality-gate test fails when they drift.

### Permissions

On macOS and Linux, directories are owner-only `700` and files `600`
(substitute the vendors you actually built):

```bash
chmod 700 ~/.vibe-coder/credentials \
          ~/.vibe-coder/credentials/gh \
          ~/.vibe-coder/credentials/claude
chmod 600 ~/.vibe-coder/credentials/gh/hosts.yml \
          ~/.vibe-coder/credentials/claude/provider.env
```

On Windows there is no POSIX mode; the equivalent — what `setup.ps1`'s
`Protect-VibePath` does — is to break ACL inheritance, remove every inherited
rule, and grant full control to the current identity alone. A credential
directory left inheriting the profile's `Users` read access is exactly the
state the preflight exists to reject:

```powershell
icacls "$env:USERPROFILE\.vibe-coder\credentials" `
    /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" /t
```

`/inheritance:r` drops the inherited rules, `/grant:r` replaces the grants
with full control for you alone, and `/t` applies the same to every file and
sub-directory inside.

### Line endings on Windows

These files are read by Deno inside a Linux container: write them
LF-terminated and without a byte-order mark. That is **not** what
Windows PowerShell's `Set-Content` or `Out-File` produce by default, so write
them the way `setup.ps1` does:

```powershell
[System.IO.File]::WriteAllText(
    "$env:USERPROFILE\.vibe-coder\credentials\claude\provider.env",
    "ANTHROPIC_API_KEY=sk-ant-your_key`n",
    [System.Text.UTF8Encoding]::new($false))
```

`UTF8Encoding($false)` suppresses the BOM, and the explicit `` `n `` keeps the
line ending LF.

### Verify against the startup preflight

Every worker start runs the credential preflight
(`worker/deno/lib/credential_preflight.ts`) before any work begins; when the
directory is wrong the worker exits with a named, actionable failure rather
than degrading into a mid-run auth error. So the verification of a hand-built
directory is simply the
[first foreground run](#manual-setup-repo-sync-steps-and-verification) — and
each failure it can name maps to a specific hand-editing mistake:

| Preflight failure | The hand-editing mistake that causes it |
|-------------------|------------------------------------------|
| `credential-dir-missing` | The directory was never created at the path the worker resolves — a typo in the path, the wrong user's home, or `VIBE_CREDENTIAL_DIR` pointing somewhere else. |
| `credential-dir-not-a-directory` | A *file* named `credentials` was created where the directory belongs. |
| `credential-dir-unreadable` | The directory itself cannot be read by the worker — created as another user (or root, e.g. with `sudo mkdir`), or its read permission stripped instead of set to `700`. |
| `credential-dir-empty` | The directory exists but the files were written elsewhere — for example into `~/.vibe-coder` itself, or under a mistyped sub-directory name. |
| `github-credentials-missing` | `gh/hosts.yml` is absent, or present without a usable inline token: copied from a macOS Keychain-backed `gh` install (no `oauth_token:` line), a blank or empty-quoted token value, or the file/token line otherwise malformed. |
| `provider-credentials-missing` | The named vendor's `provider.env` is absent, uses a variable name that vendor does not accept (see the table above), or carries a blank value. The failure names the vendor and the variable that provisions it, so a multi-vendor host knows which file to fix. |
| `credential-permissions-too-open` | A credential file is group- or world-readable — `chmod 600` was skipped, or the file was created with a default umask (e.g. mode `644`). The message names the file and the exact `chmod` to run. |
| `unexpected-credential-material` | A stray entry sits directly inside the credential directory: a backup copy, a notes file, or a sub-directory for a vendor that is not enabled. Only `gh/` and the enabled providers' sub-directories belong there (`.DS_Store` is ignored). |

Two notes on reading a result. First, `github-credentials-missing` and
`provider-credentials-missing` fire only when *neither* the file *nor* the
corresponding environment variables supply the credential — but on a contained
host the directory is the only route that reaches the worker, because the
container is started with no token variables passed through (see
[Deployment — Credential Provisioning](DEPLOYMENT.md#-credential-provisioning-non-interactive)).
Second, the preflight reports every problem it finds in one pass, so fix the
whole list before re-running rather than one failure at a time.

## Manual setup: writing `.config.json`

*Placeholder — this section will explain how to hand-write `.config.json`
instead of letting `setup config` and the interactive prompts produce it
(#82, parent #66).*

## Manual setup: repo sync steps and verification

*Placeholder — this section will cover running the repo-side sync phases one
subcommand at a time, the equivalence checklist, and the first foreground run
(#83, parent #66).*
