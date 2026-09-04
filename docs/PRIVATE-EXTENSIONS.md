# 🧩 Private Extensions

Extend a deployment with software this repository has never heard of — install
the legacy thing, install the thing you are migrating to, configure one of
them, and point an agent across the two — **without forking this repository,
and without your toolchain ever appearing in it**.

The governing rule is one sentence:

> **Core provides extension points. It never learns what is plugged into
> them.**

There is no list of supported software here, and there is not meant to be one.
Enumerating what an operator might install is the failure mode, not the
feature: the moment core knows one particular tool exists, every other tool
becomes second-class and the next operator has to send a pull request to be
recognised. The extension points below take an arbitrary install, an arbitrary
configuration step and arbitrary direction for the agent, and stay incurious
about all three. (GitHub Actions is named in this repository only because it
is the CI *this project itself runs on* — not as an offered integration.)

Incurious is not unbounded. What you install is your business; **where it
lands is still ours** — see [Step 2](#-step-2--declare-what-to-install).

This page is a **procedure**. Follow it start to finish and you end with a
working extension. Where a step cannot be completed today, it says so and
points at [Known gaps](#-known-gaps) rather than describing an interface
nobody has built.

## 📋 Table of Contents

- [Before you start](#-before-you-start)
- [Step 1 — Lay out your private repository](#-step-1--lay-out-your-private-repository)
- [Step 2 — Declare what to install](#-step-2--declare-what-to-install)
- [Step 3 — Install from a private or credentialed source](#-step-3--install-from-a-private-or-credentialed-source)
- [Step 4 — Configure a tool after it is installed](#-step-4--configure-a-tool-after-it-is-installed)
- [Step 5 — Tell the agent what the work is](#-step-5--tell-the-agent-what-the-work-is)
- [Step 6 — Build, and confirm it actually worked](#-step-6--build-and-confirm-it-actually-worked)
- [Step 7 — Upgrades](#-step-7--upgrades)
- [Contributing behaviour, and what happens when it fails](#-contributing-behaviour-and-what-happens-when-it-fails)
- [Known gaps](#-known-gaps)

## ✅ Before you start

You need:

- A **clone** of Vibe Coder — not a fork. You will never edit a file inside it.
- A **container runtime** the launcher supports, and the ability to build an
  image locally (the first build takes several minutes).
- For each piece of software you intend to install: a **`.tar.gz`, `.tar.xz`
  or `.zip` archive reachable over HTTPS**, and its **SHA-256 digest**. If your
  software is not published that way, see
  [If your software is not published as an archive](#if-your-software-is-not-published-as-an-archive).

Throughout, `<base-dir>` is your Vibe Coder clone and `tool-a` / `tool-b` are
placeholders for whatever you are actually installing.

## 📁 Step 1 — Lay out your private repository

Two directories, and only one of them is Vibe Coder:

```text
~/vibe-coder/                 # the clone — you never edit anything in here
  .config.json                # <- your file; gitignored by Vibe Coder
  worker/ container/ docs/    # upstream, untouched

~/my-deployment/              # your own private repository
  config/.config.json         # the real copy, version-controlled by you
  scripts/configure-tool.sh   # your post-install configuration
  README.md                   # your notes
```

`.config.json` is listed in Vibe Coder's `.gitignore`. It is read at runtime
and never committed upstream, which is what makes the extension private. Keep
the authoritative copy in **your** repository and put it in place with a
symlink or a deploy step:

```bash
ln -sf ~/my-deployment/config/.config.json ~/vibe-coder/.config.json
```

The worker resolves the file as `--config`, else `CONFIG_PATH`, else
`<base-dir>/.config.json`. Nothing else you write ever needs to live inside
the clone.

## 📦 Step 2 — Declare what to install

Extra software is a **top-level `container_tools` array** in `.config.json` —
top level, *not* inside `repo_config`. It is baked into the container image at
**build time**, which is not a preference: the worker runs as a non-root
user and — on every runtime that supports it — with a read-only root
filesystem, so nothing can be installed once it is running. Build time is the
only door.

Each entry is a declarative archive install: download → verify SHA-256 →
extract → put `bin` directories on `PATH` → set `env`. There are deliberately
no install commands and no package names, because those would be a place for
core to start having opinions.

```json
{
  "container_tools": [
    {
      "id": "tool-a",
      "version": "3.2.1",
      "url": {
        "amd64": "https://artefacts.example.com/tool-a-3.2.1-linux-x64.tar.gz",
        "arm64": "https://artefacts.example.com/tool-a-3.2.1-linux-aarch64.tar.gz"
      },
      "sha256": {
        "amd64": "e58fcdcd637b25c03ca84cbbcefc70d11efb8f4b4cbd05decc9f661769d77f94",
        "arm64": "621f7196f0b682fb557da58bec89bd7dfe5419811fe1c0ba75c9cc8432f084c7"
      },
      "stripComponents": 1,
      "bin": ["bin"],
      "env": { "TOOL_A_HOME": "" }
    },
    {
      "id": "tool-b",
      "version": "14.1",
      "url": {
        "noarch": "https://artefacts.example.com/tool-b-14.1-bin.tar.gz"
      },
      "sha256": {
        "noarch": "80ffca22aed9e8b9713a232f3394fd81d7f20322df75efdb2b047dbd3e3a23bb"
      },
      "stripComponents": 1,
      "bin": ["bin"],
      "env": { "TOOL_B_HOME": "" }
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lower-case letters, digits, hyphens. Installs to `/opt/vibe-tools/<id>` |
| `version` | yes | Free-form; recorded, never parsed |
| `url` | yes | Per architecture (`amd64`, `arm64`, `noarch`). **`https:` only** |
| `sha256` | yes | 64 hex characters per architecture. A `url` without a matching digest is rejected |
| `stripComponents` | no (`0`) | Leading archive path components dropped on extract; `1` is usual |
| `bin` | no (none) | Directories **relative to the prefix**, added to `PATH` |
| `env` | no (none) | Variables set to **prefix-relative** paths; `""` is the prefix root |

Where one tool must find another, express it with `env` — each entry above
gets a `*_HOME` pointing at its own prefix.

**What core still insists on**, whatever the archive contains:

- **The prefix is fixed** at `/opt/vibe-tools/<id>`, and every `bin`/`env`
  value is interpreted relative to it. An absolute path, a `~`, or a `..` that
  escapes the prefix is rejected at validation.
- **Every download is digest-verified.** A mismatch aborts the build naming
  the tool. You choose the software; you do not get to skip the pin.

A malformed spec is never partially applied — the parser reports the first
fault naming the tool and the field.

### If your software is not published as an archive

The installer accepts `.tar.gz`/`.tgz`, `.tar.xz` and `.zip`, and aborts on
anything else rather than guessing. Software that ships only as a distribution
package, or as source needing compilation — often the case for the legacy half
of a migration — is still supported, but the build is yours: compile or unpack
it once, `tar czf` the result, host it where your build can reach it, and pin
its digest like any other entry. The installer does not care where an archive
came from.

## 🔐 Step 3 — Install from a private or credentialed source

Software that is not public is a first-class case, not an appendix. What works
today depends on **how the source authenticates**, and the honest answer is
mixed.

### Supported: sources that authorise by network position

If your artefact host is reachable only from the build network — a private
artefact server on a VPN, an IP-allowlisted host, or one requiring client
certificates terminated at the network layer — it works unchanged:

```json
{
  "url": { "noarch": "https://artefacts.internal.example.com/tool-a-3.2.1.tar.gz" },
  "sha256": { "noarch": "80ffca22aed9e8b9713a232f3394fd81d7f20322df75efdb2b047dbd3e3a23bb" }
}
```

No credential appears in the spec, the digest is still mandatory, and the
install is as verifiable as a public one. **This is the recommended route for
non-public software.**

The same applies to an archive you built yourself and published to your own
internal host, which also covers software that is proprietary, unreleased, or
has no public distribution at all.

### Not supported: sources needing a secret in the request

`container/install-tools.sh` fetches with `curl -fsSL "${url}"` and **sends no
credentials**: there is no `Authorization` header, no `.netrc`, no registry
login, and no way to supply one.

The only place a secret could go is inside the URL itself — and **you must not
put one there**. The `container_tools` array is passed to the build as the
`VIBE_CONTAINER_TOOLS` build argument and is mixed into the image tag, so
anything in it is build metadata whose exposure varies by container runtime.
Treat every value in `container_tools` as non-secret.

A short-lived signed URL is the least-bad variant if you have no other option,
but it is still a credential in build metadata, and because the URL changes on
each reissue it changes the image tag and forces a rebuild every time. It is
not a route this page recommends.

There is also no `file:` support, so you cannot stage an archive on the build
host and point at it locally — the URL must be `https:`.

**If your source requires a secret in the request, stop here**: stage the
archive on a network-authorised host instead (the supported route above). This
is a real limitation, recorded in [Known gaps](#-known-gaps).

## ⚙️ Step 4 — Configure a tool after it is installed

Installing and configuring are different jobs, and `container_tools` only does
the first. Configuration is `pre_setup_command` under
`repo_config.<owner/repo>` — an arbitrary shell command run before the agent
starts work on that repository:

```json
{
  "repo_config": {
    "your-org/legacy-system": {
      "pre_setup_command": "./scripts/configure-tool.sh"
    }
  }
}
```

It runs via `bash -c` in the cloned repository directory, with `REPO_PATH` and
`REPO_NAME` exported, and a default timeout of **300 seconds**. A non-zero exit
is reported as a failure naming the exit code, so a broken step is visible
rather than silent.

Four constraints to design around:

1. **It is scoped to a repository, not to a tool.** No hook fires when a tool
   is installed. Two repositories needing the same configuration each declare
   the command.
2. **It re-runs on every setup.** Make it idempotent — regenerate the config
   file each time rather than appending.
3. **It must write somewhere writable.** Treat the image as read-only: the
   writable locations are the work volume, the named volumes and the scratch
   mounts. Do not try to modify `/opt/vibe-tools` in place. See
   [Containment](CONTAINMENT.md).
4. **It runs as a non-root user** and cannot install packages — the same
   boundary as Step 2, seen from the other side.

A configuration script that respects those looks like:

```bash
#!/usr/bin/env bash
# scripts/configure-tool.sh — regenerate tool-b's config each setup.
set -euo pipefail

config_dir="${HOME}/.config/tool-b"
mkdir -p "${config_dir}"

# Written fresh every run: idempotent by construction.
cat > "${config_dir}/settings.conf" <<EOF
legacy_root=${TOOL_A_HOME}
project_root=${REPO_PATH}
EOF

"${TOOL_B_HOME}/bin/tool-b" --validate-config "${config_dir}/settings.conf"
```

The final validation line matters: it turns a silently wrong configuration
into a non-zero exit the worker reports.

## 🎯 Step 5 — Tell the agent what the work is

`custom_instructions`, also under `repo_config.<owner/repo>`, is free prose
appended to the agent's instructions for that repository. This is where the
migration is actually described — and the reason core never needs to know
which languages are involved:

```json
{
  "repo_config": {
    "your-org/legacy-system": {
      "pre_setup_command": "./scripts/configure-tool.sh",
      "custom_instructions": "This repository is mid-migration. Port one module at a time from tool-a to tool-b, keeping the existing test suite green at every step."
    }
  }
}
```

## 🔍 Step 6 — Build, and confirm it actually worked

**Do not skip this step.** An extension that installs nothing fails *quietly* —
the empty selection is a valid configuration, not an error — so the only way to
tell a working extension from an inert one is to check.

### 6a. Validate the spec and capture the tag

Run this **before and after** adding `container_tools`:

```bash
cd ~/vibe-coder
deno run --allow-env --allow-read worker/deno/mod.ts container-image-hash
```

It prints `vibe-coder:<short hash>`. Two things to check:

- **A malformed spec exits non-zero, naming the offending field.** If it
  prints a tag, your spec parsed.
- **The tag must change** once `container_tools` is populated. The selection is
  mixed into the image identity, so an unchanged tag means *your array was
  never read* — almost always because it was placed inside `repo_config`
  instead of at the top level, or the key was misspelled. **This is what a
  silently inert extension looks like, and this is how you catch it.**

### 6b. Build

Start the worker as usual; a missing image is built automatically. The build is
where installs are verified, and it fails loudly:

```text
install-tools: tool "tool-a": SHA-256 mismatch — refusing to install.
```

Nothing is extracted and no image is produced. That failure is the mechanism
working.

### 6c. Confirm the tools are present in the image

```bash
IMAGE="$(deno run --allow-env --allow-read worker/deno/mod.ts container-image-hash)"
podman run --rm "$IMAGE" bash -lc 'echo "$TOOL_A_HOME"; command -v tool-a; tool-a --version'
```

Expect `/opt/vibe-tools/tool-a`, a path under that prefix, and your tool's
version. Substitute `docker` for `podman` if that is your runtime. The whole
resolved set is listed in `/opt/vibe-tools/environment`, one `PATH=` or
`<KEY>=<value>` line per entry:

```bash
podman run --rm "$IMAGE" cat /opt/vibe-tools/environment
```

### 6d. Confirm the configuration step ran

`pre_setup_command` runs per repository, so check the worker log for the
repository you configured. A failure is reported with its exit code and
stderr; a timeout is reported as `Pre-setup command timed out after 300
seconds`. Silence in the log with no configured file present means the command
was never reached — check the `repo_config` key is the exact `owner/repo`
slug the worker is monitoring.

### Failure reference

| Symptom | Cause |
| --- | --- |
| `container-image-hash` exits non-zero naming a field | Malformed spec — fix the named field |
| Tag unchanged after adding tools | The array was not read: wrong nesting or a misspelled key |
| `SHA-256 mismatch — refusing to install` | Digest does not match the bytes served; re-fetch the published checksum |
| `unsupported archive extension` | Not `.tar.gz`/`.tar.xz`/`.zip` — repackage it |
| `download failed from <url>` | Unreachable, or the source needs a credential (see Step 3) |
| Tool missing from `PATH` at runtime | `bin` is wrong, or `stripComponents` left an extra directory level |
| Config file absent, no log line | `pre_setup_command` under the wrong repo slug |

## 🔄 Step 7 — Upgrades

**Upgrading Vibe Coder does not disturb your extension.** Your `.config.json`
lives outside the upstream tree and is never touched by an update. When the
worker checkout moves, the image reference is recomputed from the new
definition *plus your unchanged selection*; the tag changes, the image is
rebuilt, and your tools are installed again from the same pinned digests.

Two things that remain yours:

- **Your pins.** The digests do not update themselves. Bump `version`, `url`
  and `sha256` together the way you would any dependency, and observe the
  24-hour quarantine in [Coding Standards](../CODING-STANDARDS.md) — do not pin
  a release published in the last day.
- **Archive availability.** If you host your own archive, the build depends on
  that host staying reachable. A URL that 404s fails the build rather than
  producing an image missing the tool.

After any change to `container_tools`, re-run
[Step 6a](#6a-validate-the-spec-and-capture-the-tag): a changed selection must
produce a changed tag.

## 🧱 Contributing behaviour, and what happens when it fails

Everything above is configuration. **Contributing TypeScript behaviour from
outside this repository is not supported today.**

The CI-log provider registry in `worker/deno/lib/ci_log_provider.ts` is real —
`registerCiLogProvider`, `unregisterCiLogProvider`, `getCiLogProvider`,
`listCiLogProviders` and `resolveCiLogProvider` all work, and the dispatcher
needs no edit to gain a provider. Two things stop an outside extension using
it:

1. **The registry is not exported.** `mod.ts` re-exports config, logging, the
   command registry, the GitHub client and several helpers, but nothing from
   `ci_log_provider.ts`. Code outside the package cannot reach
   `registerCiLogProvider`.
2. **There is no loader.** Nothing reads a path, a module specifier or a
   configuration key and imports operator-supplied code at start-up. An
   exported registry would still have no caller, because the worker only runs
   modules already inside its image.

**What failure looks like if you try anyway:** naming an unregistered provider
in `ciProviders` is not a config error — it is caught at dispatch, and the
worker logs a warning, `ci_log_provider did not produce a result`, carrying
`error=no CI log provider registered for '<id>'`, then carries on with
annotations only. The run does not crash; the CI-fix prompt is simply built
without a log excerpt. So a mistyped or unavailable provider id degrades
quietly in the log rather than stopping the worker — check the worker log for
that line if fix quality drops unexpectedly.

Adding a provider *inside* this repository remains appropriate for CI systems
**this project itself runs on**. Anything specific to one deployment belongs in
that deployment's own repository. See
[Extending the Worker](EXTENDING.md#-adding-a-ci-log-provider) for the provider
contract.

## 🚧 Known gaps

Recorded here rather than written around:

| Gap | Effect |
| --- | --- |
| No credentialed download | `install-tools.sh` sends no `Authorization` header, no `.netrc`, no registry login. Private sources must authorise by network position (Step 3) |
| No `file:` URLs | An archive already on the build host cannot be referenced; it must be served over HTTPS |
| No tool-scoped post-install hook | Configuration is per repository via `pre_setup_command`, re-run each setup, not once per install |
| Registry not exported | `mod.ts` exports nothing from `ci_log_provider.ts` |
| No extension loader | Operator-supplied TypeScript cannot be loaded without editing this repository |
| No install verification command | Confirming a tool landed means running it in the image (Step 6c); `first-run-verify` does not check `container_tools` |

## 🔗 Related documentation

- [Container Image](CONTAINER.md#deployer-supplied-build-time-tools) — the
  `container_tools` schema and checksum rules
- [Configuration Reference](CONFIGURATION.md#-per-repository-configuration) —
  every `repo_config` key
- [Containment](CONTAINMENT.md) — the mount set and the read-only boundary
- [Troubleshooting](TROUBLESHOOTING.md#which-image-is-this-host-meant-to-run) —
  resolving which image a host should run
- [Extending the Worker](EXTENDING.md) — extension points inside this
  repository
