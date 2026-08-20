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
