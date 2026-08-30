# Bake semgrep into the agent image so the SAST gate stage scans

## Summary

The quality gate's `semgrep` stage (`worker/deno/lib/semgrep_check.ts`, Issue
#559) reported `SKIPPED` on every fleet run: `container/tools.json` pinned no
`semgrep`, and the image carries no container runtime to run the CI-pinned
`semgrep/semgrep` image with either. The skip was loud and `--strict` promoted
it to `FAILED`, but agents still met `p/default` findings only after a red PR.

The image now installs semgrep at exactly the version CI runs. semgrep's CLI is
a Python application with no standalone binary release, so the install is not
the usual single checksum-verified binary:

- `container/tools.json` pins the manylinux wheel per architecture (each
  bundles its own `semgrep-core`) as a `semgrep` toolchain, and the `pip` wheel
  that installs it as a build-time `tools` entry — Debian's `python3` ships no
  `ensurepip`, so the installer is an artefact in its own right.
- `container/Containerfile` verifies the pip wheel against its digest, runs it
  as a zipapp (nothing installs pip *into* the image), creates a
  `/opt/semgrep` virtualenv — the system interpreter is PEP 668 externally
  managed — verifies the resolved semgrep wheel against the committed
  per-architecture digest **before** installing it, symlinks
  `/usr/local/bin/semgrep`, and asserts `semgrep --version` reports the pin.
- `SEMGREP_VERSION` must equal `SEMGREP_IMAGE_TAG` in
  `worker/deno/lib/pinned_actions.ts`; `container_manifest_test.ts` fails the
  gate on drift, and `semgrep` joins `REQUIRED_REPO_TOOLCHAIN_COMMANDS` so a
  manifest that stops supplying it fails loudly rather than silently skipping.

Image-size decision: about **350 MB**, ~260 MB of it the bundled
`semgrep-core`. That is the largest single toolchain in the image and it was a
deliberate trade — the alternative is every fleet agent discovering SAST
findings in CI. The stage scans changed files only, so run-time cost stays
small.

Closes #650.

## Evidence

Backend/CLI change — no web interface to screenshot. Evidence is the install
steps executed in the agent container and the gate stage's own output.

```mermaid
flowchart LR
    A["curl pip wheel<br/>PIP_SHA256_NOARCH"] --> B["sha256sum -c"]
    B --> C["python3 -m venv --without-pip<br/>/opt/semgrep"]
    C --> D["pip download --no-deps<br/>semgrep==SEMGREP_VERSION"]
    D --> E["sha256sum -c<br/>SEMGREP_SHA256_AMD64/ARM64"]
    E --> F["pip install wheel<br/>+ dependency wheels"]
    F --> G["ln -s /usr/local/bin/semgrep"]
    G --> H["semgrep --version == pin<br/>(build fails otherwise)"]
```

**1. The Containerfile's install steps run end to end** — the same commands,
with the venv prefix redirected to a writable path so they run unprivileged
inside the agent container itself (aarch64, Debian trixie 13, ruby 3.4.10,
python3 3.13.5). The premise the design rests on is confirmed there too:
`import venv` succeeds and `import ensurepip` raises `ModuleNotFoundError`,
which is why pip is a pinned artefact rather than an `ensurepip` bootstrap.

```text
/tmp/pip-26.2.1-py3-none-any.whl: OK
/tmp/sg/semgrep-1.173.0-cp310...py314-none-manylinux_2_34_aarch64.whl: OK
1.173.0
VERSION ASSERT OK
351M    <venv>
```

Both checksums are the committed pins — pip resolved the wheel from the index
and the committed `arm64` digest matched the bytes — and the final
`semgrep --version | grep -qxF "${SEMGREP_VERSION}"` assertion passed. The
351 MB measured is the ~350 MB the docs record.

**2. The gate stage scans instead of skipping** — `runSemgrepCheck()` over this
branch's changed files, before and after putting that semgrep on PATH:

```text
before: SKIPPED (semgrep is not installed and no container runtime holds
        semgrep/semgrep:1.173.0@sha256:67319956… — install semgrep …)
after:  PASSED (3 changed file(s), p/default via semgrep 1.173.0 on PATH)
```

No drift note in the output, i.e. the installed version is the CI pin — which
is the issue's "done when".

**3. Full gate** — `./quality.sh` with that semgrep on PATH:

```text
✓ semgrep: PASSED (6.8s)
✗ deno tests: FAILED (605.3s)   16007 passed | 36 failed
✓ deno lint / deno type check / deno fmt / markdownlint / mermaid: PASSED
```

The `semgrep` stage is the line the issue is about — `PASSED`, not `SKIPPED`.
The 36 test failures are pre-existing and unrelated: `gh_spawn_test.ts`,
`service_account_env_test.ts` and `run_core_rate_limit_resume_test.ts` fail
identically when the same files are run on `origin/main` in a clean worktree
(this sandbox's `gh` guard shim, an unwritable `gh` config dir, and a GitHub
API rate limit). `worker/deno/tests/container_manifest_test.ts` — the file this
change touches — is 87 passed / 0 failed.

`docs/audits/dependency-inventory.md` is regenerated
(`supply-chain-gate --write-inventory`) with the two new pins, which the
supply-chain gate requires.

## Done when

- **met** — `./quality.sh` inside the agent container reports `semgrep PASSED`
  over the changed files instead of `SKIPPED` — evidence: gate output above,
  and `container/Containerfile` puts `semgrep` on the image PATH.
- **met** — the installed version matches the CI pin — evidence:
  `worker/deno/tests/container_manifest_test.ts::container/ - semgrep is
  pinned at the version CI runs (Issue #650)` asserts
  `manifest.toolchains.semgrep.version === SEMGREP_IMAGE_TAG`, and the build
  step asserts `semgrep --version` reports it.

## Test Plan

Added to `worker/deno/tests/container_manifest_test.ts`:

- `findMissingRuntimeTools - reports semgrep when no toolchain installs it
  (Issue #650)` — the manifest state that made the stage skip.
- `container/ - semgrep is pinned at the version CI runs (Issue #650)` —
  exactly one toolchain owns the `semgrep` command, its version equals
  `SEMGREP_IMAGE_TAG`, both architecture digests and the `pip` pin are
  64-hex, and nothing falls back to a host install.
- `container/ - the base image supplies the Python semgrep needs (Issue #650)`
  — the base records `python3` in `provides` with a floor at or above
  semgrep's requires-python of 3.10.
- `container/Containerfile - installs the pinned semgrep wheel and proves the
  version (Issue #650)` — the build verifies both checksums, selects the
  per-architecture digest, exposes the binary on PATH and asserts the version.
- Extended `container/ - the image supplies every monitored-repo toolchain
  command` with the `semgrep` requirement.

The existing `findContainerfileViolations` checks cover the other half: every
manifest version and checksum must be restated verbatim as a build `ARG`, and
no build step may download without verifying a checksum.
