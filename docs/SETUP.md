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

*Placeholder — this section will list everywhere macOS, Linux and Windows
actually diverge during an automated setup run (#79, parent #66).*

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
