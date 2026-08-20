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
