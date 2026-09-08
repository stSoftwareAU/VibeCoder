# bats-core and codespell are baked into the image as pinned toolchains

## Summary

Two more monitored-repository toolchains are now part of the image definition,
each a pinned, checksum-verified fragment:

- **`bats-core` 1.14.0** — NEAT-AI-core and NEAT-AI-scorer both run
  `bats tests/scripts` from their own `quality.sh`, and both print
  `⚠️  bats not installed — skipping shell helper tests` in today's image while
  their CI apt-installs the runner and runs the suites (NEAT-AI-core PR 597
  skipped all 394 tests locally). bats-core publishes no release asset, so the
  pinned artefact is the tag's GitHub source tarball, installed by its own
  bundled `install.sh` — pure shell, so one `noarch` digest covers both
  architectures.
- **`codespell` 2.4.3** — NEAT-AI-core's gate skips its spelling check with a
  warning, and NEAT-AI-scorer's `scripts/spell-check.sh` preflight *exits 1*
  when the binary is absent, so that gate fails outright in the current image.
  It is a pure-Python console script with no standalone binary, so it follows
  the semgrep pattern: the pinned wheel installed by the pinned pip into its
  own `/opt/codespell` virtualenv, off the PEP 668 externally-managed system
  interpreter. codespell 2.4.3 declares no required runtime dependencies
  (`chardet` and `tomli` are extras), so `--no-deps` leaves nothing coming
  unverified from the index.

Both are enumerated in `REQUIRED_REPO_TOOLCHAIN_COMMANDS` and in
`CONTAINER_IMAGE_INPUTS`, so dropping either from `container/tools.json` fails
the gate, and the supply-chain inventory records both pins.

Closes #1595.

```mermaid
flowchart LR
    M["container/tools.json<br/>version + sha256 (noarch)"] --> F1["toolchains/bats-core.sh"]
    M --> F2["toolchains/codespell.sh"]
    C["Containerfile<br/>install-toolchains.sh<br/>…,bats-core,codespell"] --> I["install-toolchains.sh"]
    I --> F1
    I --> F2
    F1 --> B1["source tarball → install.sh<br/>/usr/local/bin/bats"]
    F2 --> B2["pinned wheel + pinned pip<br/>/opt/codespell → /usr/local/bin/codespell"]
    M --> G["container_manifest.ts<br/>REQUIRED_REPO_TOOLCHAIN_COMMANDS"]
    F1 --> H["container_image_hash.ts<br/>CONTAINER_IMAGE_INPUTS"]
    F2 --> H
    style M fill:#2d6a4f,stroke:#1b4332,color:#fff
    style G fill:#c9184a,stroke:#800f2f,color:#fff
```

## Evidence

Backend/CLI change — no web interface to screenshot. Both fragments were run
end to end on the running image (arm64) with the committed manifest as their
only source of pins, against sandboxed install paths, so the download, the
checksum verification, the extraction and the version assertion are all
observed rather than assumed:

```text
[bats-core] Installing 1.14.0
/tmp/tmp.0ZgXMmlwVL/bats-core.tar.gz: OK
Installed Bats to /tmp/rehearse/bin/bats
[bats-core] Installed bats 1.14.0

[codespell] Installing 2.4.3 with pip 26.2.1
/tmp/tmp.zSZte0VxAl/pip-26.2.1-py3-none-any.whl: OK
/tmp/tmp.zSZte0VxAl/codespell-2.4.3-py3-none-any.whl: OK
[codespell] Installed codespell 2.4.3
```

**Every pinned digest was verified against the upstream artefact itself** —
each file was downloaded and `sha256sum`-ed on this host:

| Artefact | Digest |
| -------- | ------ |
| `bats-core v1.14.0` source tarball (`archive/refs/tags/v1.14.0.tar.gz`) | `bb537b70b15b732f6d8827dd6578e3d8ce166636ce1f18ea9a074184fcce9177` |
| `codespell-2.4.3-py3-none-any.whl` | `af2505b335e8573dbd2d384d1c4ef498f4006f4ba2d6fceca01e55b91f52628a` |

The wheel digest equals PyPI's own recorded `sha256` for that file. Both pins
are the current upstream releases (bats-core 1.14.0 published 2026-07-21 with
no release assets, which is why the source tarball is the artefact; codespell
2.4.3 uploaded 2026-07-15), both well clear of the 24 h quarantine.

**The gate lines this replaces were read, not assumed.** Fetched from each
repository's committed `quality.sh`:

```text
NEAT-AI-core   quality.sh:41  if command -v bats &>/dev/null; then … bats tests/scripts
NEAT-AI-core   quality.sh:46  "⚠️  bats not installed — skipping shell helper tests"
NEAT-AI-core   quality.sh:68  if command -v codespell &>/dev/null; then … codespell
NEAT-AI-scorer quality.sh:177 if ! ./scripts/spell-check.sh; then   # preflight
NEAT-AI-scorer quality.sh:187 bats tests/scripts
```

and `NEAT-AI-scorer scripts/spell-check.sh` documents its own contract:
`1 — typos detected or codespell missing / invalid invocation`.

**The real suite runs on the pinned runner.** NEAT-AI-core was cloned and its
`bats tests/scripts` run with the bats installed by this fragment — the
assumption the issue flagged (that neither suite depends on behaviour that
changed between CI's apt release and 1.14.0) tested rather than asserted:

```text
1..394
ok 393 no workflow uses an action pinned to a deprecated Node runtime
ok 394 SHA-pin regex rejects floating tags and branch refs
394 tests, 285 ok, 109 not ok
```

The runner executes the whole suite — no version incompatibility, and the
suites `load helpers` from their own `tests/scripts/helpers.bash`, so no
`bats-support` / `bats-assert` library is needed. 31 of the 109 failures name
a *different* image gap — `ModuleNotFoundError: No module named 'yaml'` from
the workflow-parsing suites — filed separately as
**stSoftwareAU/VibeCoder#1628**; the remaining 78 were not diagnosed and are
out of this issue's scope.

Behaviour proved with the installed tools, as the unprivileged user:

```text
bats pass.bats     → ok 1 passes                        (exit 0)
bats fail.bats     → not ok 1 fails                     (exit 1)
codespell dirty/   → note.txt:1: enviroment ==> environment  (exit 65)
codespell clean/   → (no output)                        (exit 0)
codespell --version → 2.4.3
```

Stripped Containerfile: **11,122 bytes** against a `CONTAINERFILE_SIZE_CAP_BYTES`
of 15,000. `./quality.sh` passes (21 checks; `config integration` SKIPPED for
the absent `.config.json`, as on every run here).

### Outstanding — the CI probe step could not be pushed

The `.github/workflows/container-build.yml` probe step the issue asks for is
written, `actionlint`-clean and rehearsed against the real binaries (the output
quoted above *is* that step's script, run locally) — but it is **not in this
branch**. This worker's token carries `admin:public_key, gist, read:org, repo,
user`, and GitHub refuses any push that updates a workflow file without the
`workflow` scope:

```text
! [remote rejected] refusing to allow an OAuth App to create or update workflow
  `.github/workflows/container-build.yml` without `workflow` scope
```

That is the documented `token-scope` condition in
[docs/SETUP.md](../../SETUP.md) — the fix is `gh auth refresh -s workflow` on
the worker account, which only a human can do. The same block was recorded on
the sibling Issue #1596 for the same reason. The step is preserved here so it
is not lost: insert it immediately before `Verify every installed
coding-agent provider` in `.github/workflows/container-build.yml`.

```yaml
      - name: Probe the BATS runner and codespell inside the image
        if: env.IMAGE_CHANGED == 'true'
        run: |
          set -euo pipefail
          echo "=== bats + codespell run, not merely present (Issue #1595) ==="
          # A version string only proves a file exists. This runs both gate
          # tools as the image's default non-root user — the proxy for
          # NEAT-AI-core's `bats tests/scripts` and its codespell stage: the
          # runner must pass a passing suite (exit 0) and fail a failing one
          # (exit 1), and codespell must flag a deliberate misspelling
          # (non-zero) and pass a clean tree (exit 0).
          docker run --rm --entrypoint bash "${IMAGE}" -c '
            set -euo pipefail
            work="$(mktemp -d)"
            cd "${work}"
            printf "@test \"passes\" {\n  [ 1 -eq 1 ]\n}\n" > pass.bats
            printf "@test \"fails\" {\n  [ 1 -eq 2 ]\n}\n" > fail.bats
            bats pass.bats
            if bats fail.bats; then
              echo "FAILED: bats exited 0 over a failing test" >&2
              exit 1
            fi
            mkdir -p dirty clean
            # Written from two halves, the shape the gitleaks probe uses for
            # its planted credential: the misspelling exists only inside the
            # container, never as a literal in this file.
            printf "the %s%s is wrong\n" "enviro" "ment" > dirty/note.txt
            printf "the environment is fine\n" > clean/note.txt
            if codespell dirty; then
              echo "FAILED: codespell exited 0 over a deliberate misspelling" >&2
              exit 1
            fi
            codespell clean
            echo "bats passes a passing suite and fails a failing one; codespell flags a misspelling and passes a clean tree"
          ' < /dev/null
```

The generic toolchain verification already in `container-build.yml` covers the
weaker half of that criterion with no workflow change: it asserts, for
**every** manifest toolchain, that each declared command resolves on the image
PATH as the non-root `vibe` user and that `<versionCommand> --version` reports
the pin — so `bats` and `codespell` are checked in CI the moment this merges.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — `bats --version` and `codespell --version` report `1.14.0` and `2.4.3` inside the image as the `vibe` user; `container-build.yml` toolchain verification and the new probe step pass — evidence: `container/toolchains/bats-core.sh`, `container/toolchains/codespell.sh` (both run, output above), plus the existing generic verification loop in `.github/workflows/container-build.yml` which iterates every `.toolchains[]` entry as the non-root user — reviewer: partial — reason: the probe step is written and rehearsed but absent from the branch; the worker token lacks the `workflow` scope, so a human applies the block quoted under **Outstanding** above.
- **met** — removing either toolchain from `tools.json` fails `container_manifest_test.ts` via `REQUIRED_REPO_TOOLCHAIN_COMMANDS` — evidence: `worker/deno/tests/container_manifest_test.ts::container/ - the image supplies every monitored-repo toolchain command`; written first and observed failing before the manifest entries existed — reviewer: met
- **partial** — the probe step's BATS suite runs inside the built image as a non-root user, and the PR summary quotes the probe log — evidence: the probe script was run verbatim as the unprivileged `vibe` user against the fragments' own install, and its log is quoted above; NEAT-AI-core's real 394-test suite was additionally run on the pinned runner — reviewer: missing — reason: the reviewer saw only the diff, which carries no workflow change, and is right that the step is not in the branch; it is blocked on the `workflow` token scope, so the run is the local rehearsal rather than a CI run.
- **missing** — post-merge check recorded on the issue: NEAT-AI-core's `./quality.sh` inside the rebuilt image shows `bats tests/scripts` and `codespell` executing with no "not installed — skipping" line, and NEAT-AI-scorer's preflight no longer exits 1 — reviewer: missing — reason: by construction this happens after the image is rebuilt from merged `main`; nothing in a pre-merge diff can satisfy it. The closest pre-merge evidence is above — the suite executing on the pinned runner, and both gate lines read from the two repositories' committed `quality.sh`.
- **met** — stripped Containerfile stays under `CONTAINERFILE_SIZE_CAP_BYTES`; `./quality.sh` passes — evidence: 11,122 / 15,000 bytes via `strip-containerfile`; full gate PASSED after the final edit — reviewer: met
- **unrequested** — the four fragment tests in `worker/deno/tests/install_toolchains_test.ts` — reviewer: unrequested — reason: added after the Standards reviewer found the fragments shipping with no test that runs them; each was mutation-checked against the guard it covers, following the existing `rust.sh` precedent in the same file.
- **unrequested** — the two `assert(REQUIRED_REPO_TOOLCHAIN_COMMANDS.includes(…))` lines — reviewer: unrequested — reason: they copy the pre-existing `gitleaks` / `pwsh` lines in the same test and name the criterion; the enforcement that actually fails is `findMissingRuntimeTools` above them.
- **unrequested** — `docs/CONTAINER.md`'s sixth consequence bullet, the "Five → Six" count and the two re-worded fragment lists, plus the `docs/audits/dependency-inventory.md` rows — reviewer: unrequested — reason: all traceable to the issue's "grep `docs/` for other surfaces listing image toolchains"; the enumerations would otherwise be wrong, and the inventory rows are forced by the supply-chain gate, which reports `inventory-stale` without them.
- **unrequested** — the Containerfile comment block explaining the two ids — reviewer: unrequested — reason: every other toolchain group in that file carries one, and the stripped size (11,122 bytes) is unaffected because comments are stripped before the build.
- **unrequested** — stSoftwareAU/VibeCoder#1628, filed for the missing PyYAML — reviewer: unrequested — reason: a distinct image gap this work measured; folding it into this change would be scope creep, and leaving it unrecorded would lose it.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — the new install logic shipped with no test that runs it: the only tests added were two membership assertions on a constant — evidence: `container/toolchains/bats-core.sh:1`, `container/toolchains/codespell.sh:1` (as reviewed) — reason: fixed here; `worker/deno/tests/install_toolchains_test.ts` now executes both fragments against a doctored manifest and a recording `curl` stub, covering the missing-digest, missing-manifest, unpinned-pip and tampered-download aborts. Each was mutation-checked: removing the guard turns the covering test red.
- **violation** — no `docs/archive/pr-summaries/pr-summary-1595.md`, and no Mermaid diagram for a change that adds build-time install layers — evidence: `docs/archive/pr-summaries/` — reason: fixed here; this file, with the diagram above.
- **violation** — Boy Scout Rule: an appended fragment list left a 27-character stub line mid-sentence, an over-long prose line, and out-of-order issue references — evidence: `docs/CONTAINER.md:88`, `docs/CONTAINER.md:306` (as reviewed) — reason: fixed here; both paragraphs re-wrapped and the references ordered `#1594, #1595, #1596`.
- **clean** — Australian English throughout the added lines (`artefact`, `behaviour`, `organisation`); fail-loud behaviour in both fragments (`set -euo pipefail`, `jq -er` resolved into variables rather than argument position, an explicit missing-manifest abort, `sha256sum -c -` before any install, and an installed-version assertion that aborts the build); both version assertions redirect `< /dev/null` for unattended use; no hidden, key or credential path staged; no `curl | sh` and no network fallback; `${CURL_RETRY}` and `${PIP_RETRY}` carried with the documented `SC2086` waivers; the fragments follow `container/toolchains/gitleaks.sh` and the semgrep layer line for line rather than inventing an abstraction; both fragments enumerated in `CONTAINER_IMAGE_INPUTS` and both commands in `REQUIRED_REPO_TOOLCHAIN_COMMANDS`; every docs surface enumerating toolchains updated in the same change; `shellcheck` clean on both fragments; `deno fmt`, `deno lint` and `deno check` clean; commit messages carry the issue reference and the `Vibe-Coder-Run-Id` trailer. Both named repositories are public, so the private-repo-reference rule does not apply.

## Test Plan

- `worker/deno/tests/container_manifest_test.ts` — the existing
  "the image supplies every monitored-repo toolchain command" test now asserts
  `bats` and `codespell` are in `REQUIRED_REPO_TOOLCHAIN_COMMANDS`, and
  `findMissingRuntimeTools` resolves both against the committed manifest.
  Written first: it failed with `AssertionError` before the manifest entries
  existed.
- `worker/deno/tests/install_toolchains_test.ts` — four new tests execute the
  fragments themselves:
  `bats-core.sh - a missing pin aborts before downloading`,
  `bats-core.sh - a missing manifest aborts, naming the path`,
  `codespell.sh - an unpinned pip installer aborts before downloading` and
  `codespell.sh - a tampered download aborts before installing`. Each asserts
  on the exit code and on whether the recording `curl` / `python3` stub was
  reached, never on the script's source text.
- `worker/deno/tests/container_manifest_test.ts` —
  `findToolchainInstallViolations` covers the new fragments: each verifies a
  checksum, carries `${CURL_RETRY}`, pipes nothing into a shell, restates no
  version, and is named by an `install-toolchains.sh` run.
- `worker/deno/tests/container_image_hash_test.ts` — its
  "every pinned toolchain fragment is enumerated" test is what forces both new
  fragment paths into `CONTAINER_IMAGE_INPUTS`.
- `worker/deno/tests/supply_chain_gate_test.ts` — the inventory was
  regenerated with `supply-chain-gate --write-inventory`; the gate reports no
  findings.
- Full `./quality.sh`: PASSED (21 checks, `config integration` SKIPPED).
