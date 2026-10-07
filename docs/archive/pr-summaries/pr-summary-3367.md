# PR Summary — Issue #3367

## Summary

Closes #3367

The worker container now ships the floci AWS Local Emulator. The native binary
is copied from a digest-pinned `docker.io/floci/floci:2.2.0` image stage. It is
checked against a per-arch sha256 from `container/tools.json` and installed as
`/usr/local/bin/floci`. A build-time smoke check then starts it once and
confirms it answers on `http://127.0.0.1:4566/`. The entrypoint never starts
floci.

```mermaid
flowchart LR
    I["floci image stage<br/>(digest-pinned)"] -->|"COPY --from=floci<br/>/app/application"| T["/tmp/floci-application"]
    T --> C{"sha256 matches<br/>tools.json pin?"}
    C -- no --> F["build fails"]
    C -- yes --> W["install binary +<br/>--version wrapper"]
    W --> S{"smoke check:<br/>127.0.0.1:4566 answers?"}
    S -- "no (000)" --> F
    S -- yes --> K["stop server,<br/>remove source"]
```

## Spec

### Intent and Rationale

- Worker runs need floci on the PATH as a LocalStack drop-in on port 4566,
  without each repository installing it.
- The pins live in `container/tools.json` (`images[]` and toolchain `floci`).
  This keeps the supply-chain gate, the inventory and the image hash watching
  floci like any other toolchain.

### Essential Design Decisions

- **COPY from a digest-pinned image stage, not a download.** The image is the
  only published distribution of the native binary. Copying it out means the
  fragment fetches nothing over the network, and the image digest plus the
  per-arch file sha256 pin the bytes twice.
- **A thin `--version` wrapper.** The native binary has no version flag, so
  `/usr/local/bin/floci` answers `--version` from the pinned version and execs
  `/usr/local/lib/floci/application` for everything else.
- **Loopback probes are exempt from the fragment retry rule.** The rule now
  ignores a `curl` that names only `127.0.0.1` or `localhost` URLs, because that
  is a probe of a server the fragment started, not a download. A line that also
  names a remote URL is still flagged. The smoke probe still uses bounded
  `--retry --retry-connrefused`, as the issue asked.
- **No entrypoint start, and a `FLOCI_PREFIX` test seam.** The smoke check stops
  the server before the layer ends. `FLOCI_PREFIX` (default `/usr/local`) lets
  the tests run the fragment end to end without root.

### Undiscoverable Facts

- `floci --version` (any argument) starts the full server rather than printing a
  version.
- The image's binary is `/app/application`, a self-contained Quarkus native
  executable for both `linux/amd64` and `linux/arm64`. I inspected it in the
  real 2.2.0 image for each arch, and the two sha256 pins are taken from those
  files.
- The server binds `0.0.0.0:4566` unless `-Dquarkus.http.host` is passed, so the
  smoke check pins it to `127.0.0.1`. It also writes `./data`, so it runs from a
  scratch directory.

## Evidence

- `./quality.sh < /dev/null` → `Result: PASSED (with skipped checks)`. Only
  config integration was skipped; deno tests, lint, type check, fmt,
  markdownlint, mermaid and semgrep all passed.
- Stripped Containerfile: 14754 of the 15000-byte `CONTAINERFILE_SIZE_CAP_BYTES`
  cap.
- `deno task test tests/install_toolchains_test.ts
  tests/container_manifest_test.ts < /dev/null`
  → `ok | 187 passed | 0
  failed`.
- The 4566 answer in the build log comes from the Container Build CI run on this
  PR (`[floci] smoke check: http://127.0.0.1:4566/ answered HTTP …`).
- **Docs sweep** — grep: `floci`, `/usr/local/bin/floci`, `fragmentDownloads`,
  `FETCH_RE`, `retry-connrefused`, "loopback"; section: `docs/CONTAINER.md`
  (toolchain table, entrypoint note, fragment retry rule) and
  `docs/CONTAINER-IMAGE.md`; updated both. The `/usr/local/bin/floci` hits in
  `docs/CONTAINER.md` and `docs/CONTAINER-IMAGE.md` describe the default prefix
  and stay true.
- `docs/audits/dependency-inventory.md` was regenerated with
  `supply-chain-gate
  --write-inventory`.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **`floci --version` works on amd64 and arm64** — partial. reviewer: the
  fragment maps both arches and both sha256 pins come from the real image.
  Container Build CI builds amd64 only, though: both jobs run on `ubuntu-latest`
  with no arch matrix, a gap that predates this PR. The arm64 build is therefore
  unexercised in CI.
- **The build log shows the 4566 response** — met (mechanism); pending CI.
  reviewer: the smoke check echoes the HTTP status and fails the build on `000`.
- **The image is digest-pinned** — met. reviewer: `FLOCI_IMAGE` and `images[]`
  carry `@sha256:e97cd0c1…`.
- **The manifest test passes and Container Build is green** — partial; pending
  CI. reviewer: local `quality.sh` passed, including `check:manifests`;
  Container Build awaits CI.
- **The entrypoint does not start floci** — met. reviewer: the entrypoint is
  unchanged, and the smoke-check server is stopped inside the fragment.
- **Verify the binary first and record its path** — met. reviewer:
  `/app/application` is recorded in `tools.json` notes and the docs, and the
  verification is stated under Undiscoverable Facts.
- **Unrequested: loopback exemption, inventory regeneration, selfcheck fixture,
  image-hash input, `FLOCI_PREFIX` seam** — unrequested. reviewer: each is
  needed for the gate to accept the requested fragment, or to test it.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **Every outcome of a branch you add needs a test that reaches it** — the smoke
  check's failure and success branches had no test. reason: fixed in this diff
  (two new tests in `worker/deno/tests/install_toolchains_test.ts`, using the
  `FLOCI_PREFIX` seam).
- **Clean** against these rules: fail loud; cross-platform bash; regex safety on
  untrusted text (hostile-run test); a code change owes a docs change; a new
  test must go red without its change; a named test must exist; a stub mirrors
  the real callee's contract (the curl stub prints `000` and exits 7, as real
  curl does on a refused connection); Australian English; commit safety; no
  workflow change.

## Test Plan

- `worker/deno/tests/container_manifest_test.ts`:
  - "findToolchainInstallViolations - a loopback smoke probe of a server the
    fragment started is not a download (Issue #3367)";
  - "… one curl naming both loopback and a remote URL is flagged";
  - "… a localhost look-alike host is not treated as loopback";
  - "… flags the remote download on a long hostile run of URL characters".
- `worker/deno/tests/install_toolchains_test.ts`
  (`container/toolchains/floci.sh - …`):
  - "a missing sha256 pin aborts before installing";
  - "a missing version pin aborts, naming it";
  - "an unsupported architecture aborts, naming it";
  - "a tampered source binary aborts before installing";
  - "a missing source binary aborts before installing";
  - "a smoke check that gets no HTTP answer fails the build";
  - "installs the wrapper and passes the smoke check on an HTTP answer".
- `worker/deno/tests/toolchain_selfcheck_test.ts`: `floci` added to the
  real-image output fixture.
- **Branch outcomes:**
  - `worker/deno/lib/container_manifest.ts:1438`:
    - loopback-only line → not a download ("a loopback smoke probe…");
    - mixed loopback and remote → download ("one curl naming both…");
    - look-alike host → download ("a localhost look-alike…").
    - Red on base: the base rule flagged `floci.sh`'s loopback probe, so the
      loopback test fails without the exemption. The mixed, look-alike and
      hostile tests expect a violation; they guard against the exemption being
      widened too far.
  - `container/toolchains/floci.sh:58` → missing version → exit 1 ("a missing
    version pin…").
  - `container/toolchains/floci.sh:65` → unsupported arch → exit 1 ("an
    unsupported architecture…").
  - `container/toolchains/floci.sh:72` → missing sha256 → exit 1 ("a missing
    sha256 pin…").
  - `container/toolchains/floci.sh:78` → missing source → exit 1 ("a missing
    source binary…").
  - `container/toolchains/floci.sh:83` → checksum mismatch → exit 1 ("a tampered
    source binary…").
  - `container/toolchains/floci.sh:135` → status `000` → exit 1 ("a smoke check
    that gets no HTTP answer…"). Flip: replacing the condition with `false`
    turned the test red.
  - `container/toolchains/floci.sh:143` → an answer → install completes and the
    source is removed ("installs the wrapper…"). Flip: dropping
    `rm -f "${FLOCI_SOURCE}"` turned the test red.
- **Callers checked:** `FETCH_RE` has callers at `container_manifest.ts:1438`,
  `:1726`, `:1737` and `:1858`. Only the fragment rule (`:1438`, via
  `fragmentDownloads`) gained the loopback exemption; the Containerfile checks
  still use raw `FETCH_RE`.
- **Rule applied to this PR's own diff:** the narrowed fragment rule passes
  every other fragment unchanged, since only `floci.sh` uses a loopback curl.

## Pre-PR Security Self-Check

- [x] Input validation: manifest fields are read with `jq -er` and each missing
      field is named; the architecture is allow-listed.
- [x] Secrets: none staged.
- [x] Injection surface: no user input reaches a shell command; the jq filters
      use `--arg`.
- [x] Output encoding: not applicable.
- [x] Authentication/authorisation: not applicable. The smoke-check server binds
      to `127.0.0.1` only.
- [x] Error handling: every failure exits non-zero with a named cause.
- [x] Dependencies: the floci image is pinned by digest, and the binary by a
      per-arch sha256.
- [x] Path confinement: no new path guard.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
