# 📦 Vibe Coder worker image

Design rationale for `container/Containerfile` (Issue #4061). The prose lives
here rather than in the Containerfile because Apple `container` rejects
Dockerfiles over 16384 bytes (apple/container#735) — and within a few bytes of
that cap the build fails with an unexplained `Stream unexpectedly closed`
instead of the named error. `worker/deno/tests/container_manifest_test.ts`
enforces a size margin on the Containerfile; keep new commentary here.

## Supply-chain posture

Standard OCI instructions only, so the file builds identically under Apple
`container`, `docker build` and `podman build`. Every version installed is
pinned in `container/tools.json`; `container_manifest_test.ts` fails the
quality gate when the two drift apart. Both base images are pinned by
immutable digest and every downloaded tool is verified against a recorded
SHA-256, so nothing in the build resolves to "whatever upstream published
most recently". Tarballs from npm are downloaded and checksum-verified first,
then installed from the local file with `--ignore-scripts` — `npm install
<name>@<version>` would take upstream's word for the bytes and run lifecycle
scripts as root.

## Base image

The base is the official Ruby image (itself built on `buildpack-deps:trixie`)
because `./quality.sh` needs both (Issue #4090): the Pages scripts under
`.github/scripts/*.rb` need ruby >= 3.1 for `Psych.safe_load_file`
(Issue #3661), and git >= 2.41 is required for `--end-of-options` to be dropped from
argv rather than taken as a revision (Issue #3714). The image already ships
bash, GNU coreutils (so `timeout` resolves without the macOS `gtimeout`
fallback), git, curl and ca-certificates, which is why there is no
package-manager install step to rot.

## Layer order

Node.js is installed ahead of the coding-agent provider layer because a
provider whose CLI ships as a JavaScript bundle needs the runtime at install
time. The monitored-repository toolchains come last of the install steps: the
worker-runtime layers above are untouched by a toolchain bump, so bumping a
version reuses their cache. Within that block the order is least-to-most
churn — the static analysers move rarely; Rust moves every few weeks and is
the largest download, so it sits last and a Rust bump rebuilds only itself.

## Coding-agent providers (Issues #4067, #4105)

The providers are a separable layer selected as a comma-separated *set*
(quorum mode needs several agent CLIs in one image): the build runs one
fragment from `container/providers/` per requested id, in order. Adding a
provider means adding a fragment plus a `container/tools.json` `providers`
entry — the base definition does not change. An empty list, a malformed or
duplicate id, an id with no fragment, or a failing fragment aborts the build
loudly, naming the fragments that do exist (`install-providers.sh`,
Issue #3234). The default set is the manifest's `installedProviders`
(gate-checked), and the set is part of the hashed definition, so changing it
changes the image tag (Issue #4062) rather than reusing a tag whose contents
differ.

`COPY providers/*.sh` is a glob, not a bare directory COPY, because Apple
container 1.2.2's builder silently materialises `COPY providers
/tmp/providers` (and the trailing-slash form) as an empty directory; the glob
copies the fragments correctly on every runtime.

## Rust toolchain

The standalone rust-lang distribution is installed into `/usr/local` rather
than via rustup, so there is no per-user toolchain directory and nothing to
update at run time. The combined `rust-<version>` package carries only
rustc/cargo/rust-std (rust-docs is dropped to keep the layer smaller);
rustfmt and clippy are separate component packages, each with its own pinned
checksum. `QUALITY_SKIP_RUST_UPDATE=1` stops private-repo-9's gate running
`rustup update stable` — the image owns its toolchain.

## Playwright + headless Chromium (Issue #4069)

The worker captures PR evidence through the Playwright MCP server, and a
contained worker has no host browser or desktop session to borrow, so
Chromium is installed at build time into `PLAYWRIGHT_BROWSERS_PATH` — nothing
downloads a browser at container start or mid-run. `PLAYWRIGHT_VERSION` is
not a free choice: it is exactly the version `@playwright/mcp` depends on,
because Playwright resolves browsers as `chromium-<revision>` and each
release pins its own revision; the gate fails when the pin drifts from
`PLAYWRIGHT_INSTALLER_VERSION` in `worker/deno/setup/screenshot.ts`.
`--with-deps` apt-installs the system-library and font set Playwright itself
declares, and because Playwright only warns when it does not recognise a
distribution, the build then launches the browser and renders a page: a
missing library fails the build rather than the first screenshot
(Issue #3234).

## Pre-warmed Deno cache (Issue #4392)

The MCP server itself is launched as `deno run npm:@playwright/mcp@<pin>`,
and Deno resolves that package — with its own copy of `playwright-core` —
into the *Deno* npm cache, not the global npm install above. Left alone,
that meant a mid-run download from npm on every fresh workspace volume (or
after the cache guard wiped it), and a registry blip broke screenshots for
the run. The image therefore carries a pre-warmed Deno cache at
`VIBE_DENO_SEED_DIR` (`/opt/deno-seed`): the build runs `deno cache` for
`container/deno-seed/seed.ts` against `container/deno-seed/deno.json` and
its lockfile — `@playwright/mcp` at `PLAYWRIGHT_MCP_VERSION`, plus the
worker's own JSR dependencies at the versions `worker/deno/deno.lock` pins —
fails if the lock would change (every tarball's integrity is pinned), and
proves the result with `deno run --cached-only`. At container start the
entrypoint copies whatever the durable volume cache lacks from the seed
(never overwriting what is there), so a cold cache needs no npm or jsr.io
round trip. `worker/deno/tests/container_manifest_test.ts` fails the gate
when the seed's pins drift from `screenshot.ts`, the Containerfile ARG or
the worker lock, and Container Build drives the MCP server from the seed
with `--network none`.

## Built from a comment-stripped copy (Issue #4393)

Apple `container` rejects a Dockerfile over 16,384 bytes (apple/container#735),
and `container/Containerfile` is mostly the comments that make its pins
reviewable. So nothing builds from the committed file directly: the launch
plan (`container-launch-plan`) writes a comment-stripped copy beside its plan
file and points `--file` at it (the build context stays `container/`), and
Container Build does the same through `mod.ts strip-containerfile`. The
strip removes comment lines and blank lines only — the Dockerfile parser
discards both itself, continuations included, so the build is byte-for-byte
the same recipe — and keeps `# syntax=`/`# escape=` directives at the top.
`tests/containerfile_strip_test.ts` caps the *stripped* text at 15,000 bytes;
the readable file may grow.
