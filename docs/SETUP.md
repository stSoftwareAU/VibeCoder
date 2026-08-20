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

*Placeholder — this section will explain how to bring a bare host to a passing
prerequisites probe by hand on each platform (#80, parent #66).*

## Manual setup: credentials

*Placeholder — this section will explain how to build the
`~/.vibe-coder/credentials` directory by hand, correctly, on each platform
(#81, parent #66).*

## Manual setup: writing `.config.json`

*Placeholder — this section will explain how to hand-write `.config.json`
instead of letting `setup config` and the interactive prompts produce it
(#82, parent #66).*

## Manual setup: repo sync steps and verification

*Placeholder — this section will cover running the repo-side sync phases one
subcommand at a time, the equivalence checklist, and the first foreground run
(#83, parent #66).*
