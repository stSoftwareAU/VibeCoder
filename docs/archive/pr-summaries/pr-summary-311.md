# PR Summary — Issue #311

## Summary

Bumps the fleet's pinned Rust toolchain from 1.95.0 to 1.98.0 in
`container/Containerfile` and `container/tools.json`, with the six SHA-256
digests refreshed, and updates the documentation that restates the pin.

The Containerfile installs three rust-lang component packages (`rust`,
`rustfmt`, `clippy`) for two target triples, so six digests are pinned. Every
one was fetched from `https://static.rust-lang.org/dist/` and is recorded
byte-for-byte in both the Containerfile and the manifest — a mismatch between
them is committed drift the manifest test rejects.

| Package | Target | SHA-256 |
| --- | --- | --- |
| `rust` | x86_64 | `aa30409a…3900` |
| `rust` | aarch64 | `5fbb4282…0cc3` |
| `rustfmt` | x86_64 | `0f425a5e…9a95` |
| `rustfmt` | aarch64 | `61f29320…af51` |
| `clippy` | x86_64 | `22a5d1ed…ebd7` |
| `clippy` | aarch64 | `2333ba79…2a9b` |

The install block below the `ARG`s is version-agnostic and unchanged, as the
issue notes.

### The fourth consumer

`container/tools.json`'s `rust` note and `docs/CONTAINER.md` both said the
1.95.0 channel was pinned by **three** repos. Issue #309 asked whether
NEAT-AI-Forests is a fourth. It is: that repo commits `Cargo.toml`,
`deny.toml` and its own `quality.sh`, pins the same channel in
`rust-toolchain.toml`, and is in the worker's monitored repo list. Its bump
is [NEAT-AI-Forests#54](https://github.com/stSoftwareAU/NEAT-AI-Forests/pull/54),
where the new clippy lint it hit is fixed. Both statements here now say four.

`docs/CONTAINER.md` uses cleartext repo names, so it simply names
NEAT-AI-Forests. `container/tools.json` uses redacted `private-repo-N`
aliases, and **the alias for Forests is not recoverable from this repository**
— `export_redact.ts` writes the mapping beside the staging tree, never inside
it. Rather than invent a number in a supply-chain manifest, the note names the
three known aliases, says a fourth exists, and points at `docs/CONTAINER.md`
for the cleartext list. Someone with the mapping can substitute the alias in a
one-line follow-up; a guessed identifier would have been worse than an honest
gap.

Closes #311.

## Evidence

Infrastructure change with no web interface, so there is no screenshot to
capture.

**The published digests are real, not transcribed.** All six URLs return
200 — the issue is explicit that a 404 means 1.98.0 is not published as
claimed and the work should stop rather than invent a digest:

```text
200  rust-1.98.0-x86_64-unknown-linux-gnu
200  rust-1.98.0-aarch64-unknown-linux-gnu
200  rustfmt-1.98.0-x86_64-unknown-linux-gnu
200  rustfmt-1.98.0-aarch64-unknown-linux-gnu
200  clippy-1.98.0-x86_64-unknown-linux-gnu
200  clippy-1.98.0-aarch64-unknown-linux-gnu
```

**The toolchain resolves and runs.** Installed independently and used to gate
all four consumer repos:

```text
rustc 1.98.0 (88d9e12ae 2026-08-18)
clippy 0.1.98 (88d9e12ae1 2026-08-18)
```

**The Containerfile and the manifest agree.** The acceptance criterion the
issue names:

```text
$ deno test --allow-all tests/container_manifest_test.ts
container/ - the committed definition matches its pinned manifest ... ok
container/ - the committed definition drives install-tools.sh from the build argument ... ok
ok | 78 passed | 0 failed (11ms)
```

That test earned its place here. A first attempt at the manifest edit replaced
the first `"amd64"`/`"arm64"` keys in the file rather than the `rust` entry's,
silently rewriting the `claude` toolchain's checksums. The manifest test caught
it immediately; the edit was redone bounded to the `rust` entry's text span,
and the diff is now confined to lines 164–187.

**No 1.95.0 restatement is left** anywhere under `container/` or
`docs/CONTAINER.md`.

**Full quality gate** (`./quality.sh`, host run): every static gate PASSED —
`deno type check`, `deno lint`, `deno fmt`, markdownlint, mermaid, workflow
hygiene, the chokepoint gates and `supply-chain-gate`. `deno tests` reports
only the 11 pre-existing `setup.ps1` failures (`NotFound: Failed to spawn
'pwsh'`, environmental) and two timing-sensitive `runClaudeWithTimeout`
watchdog cases that pass in isolation and failed only under host load.

`docs/audits/dependency-inventory.md` is regenerated, as the bumped pin
changes it — `supply-chain-gate` reports no findings.

## Test plan

No new tests. This is a pin bump, and the repository already has the gate that
proves it:

| Existing test | What it pins here |
| --- | --- |
| `container_manifest_test.ts` — *the committed definition matches its pinned manifest* | Every `ARG RUST_*` in the Containerfile equals the `rust` entry in `tools.json`, digest for digest. This is what makes a half-applied bump a build failure rather than a silent drift. |
| `container_manifest_test.ts` — *drives install-tools.sh from the build argument* | The version reaches the install script through `RUST_VERSION` rather than a second hard-coded copy. |
| `supply-chain-gate` (`inventory-stale`) | `docs/audits/dependency-inventory.md` records the new version and digests. |
| `markdownlint` | The reworded `docs/CONTAINER.md` table row and bullet stay well-formed. |

The four consumer repos are gated in their own PRs, each running that repo's
`./quality.sh` under 1.98.0:

| Repo | Sub-issue | PR | New lints |
| --- | --- | --- | --- |
| NEAT-AI-Forests | #309 | [#54](https://github.com/stSoftwareAU/NEAT-AI-Forests/pull/54) | `chunks_exact_to_as_chunks` ×2, fixed in code |
| NEAT-AI-Backpropagation | #308 | [#100](https://github.com/stSoftwareAU/NEAT-AI-Backpropagation/pull/100) | none |
| NEAT-AI-Lamarck | #307 | [#195](https://github.com/stSoftwareAU/NEAT-AI-Lamarck/pull/195) | `chunks_exact_to_as_chunks` ×2, `map_or_identity` ×1, all fixed in code |
| NEAT-AI-scorer | #306 | see the issue | — |
