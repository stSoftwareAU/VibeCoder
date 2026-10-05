# PR summary: Rust toolchain 1.99.0 in the container, release notes mined into the Rust bucket (Issue #3258)

## Summary

Closes #3258.

Four monitored crates (NEAT-AI-Discovery, -scorer, -Lamarck, -Backpropagation)
pin Rust 1.99.0 and declare `rust-version = "1.99"`, so on the 1.98.0 image
every `cargo check` on them failed with exit 101. This PR moves the image and
mines the releases between the last mined one and this one into the review
prompt:

- **Container.** `container/tools.json` pins `rust` at 1.99.0 with all six
  checksums (rust, rustfmt and clippy, amd64 and arm64), taken from the
  `.sha256` files beside each package on `static.rust-lang.org/dist`. The
  manifest note now says that the image has no `rustup`, so
  `rust-toolchain.toml` is not consulted there and every crate builds with
  this pin. `container/toolchains/rust.sh` reads the manifest and needed no
  change.
- **Docs.** `docs/CONTAINER.md` names 1.99.0 and lists which fleet crates pin
  which channel; `docs/audits/dependency-inventory.md` carries the new
  checksums; the self-check fixture in
  `worker/deno/tests/toolchain_selfcheck_test.ts` quotes
  `cargo 1.99.0 (5f94df478 2026-08-27)`.
- **Best practices.** `prompts/best_practices/buckets/rust.md`'s learnings
  section now spans 1.95 to 1.99 (1.96 to 1.98 were mined at the 1.98.0 bump,
  Issue #297). It extends check 29 with the POSIX symbols 1.99 added to the
  runtime-symbol lints and check 31 with the 1.95 and 1.99 standard-library
  supersessions, and adds six checks: deprecations that now warn (legacy
  integer modules and `Atomic*::fetch_update` in 1.99,
  `Eq::assert_receiver_is_total_eq` in 1.95), zero-size chunking as a compile
  error, `#[no_mangle]` on generic items as a hard error, statement macros in
  expression position from other crates, unreachable `cfg_select!` arms,
  unused `#[path]` on inline modules and clippy's pedantic
  `assert_is_empty`, and rustdoc's unused footnotes and dangling doctest
  attributes. The later checks are renumbered 38 to 42; nothing referred to
  them by number. A closing note lists the 1.95 and 1.99 changes that are
  not review checks so nobody re-derives them.

## Spec

### Intent and Rationale

- The owner asked for the release notes from 1.94 to 1.99 to be reviewed and
  the prompts, container and best practices updated. 1.96 to 1.98 were already
  mined; this PR covers 1.95 and 1.99.
- The pre-rollout check the issue asks for was run with the local
  `rustup` 1.99.0 toolchain over every monitored crate still pinned to 1.98.0
  (see Evidence), since the image itself is built by the launcher after merge.

### Essential Design Decisions

- The image ignores `rust-toolchain.toml` (no `rustup`), so the pin and the
  crates' pins are documented as needing to move together, and the note says
  so where the pin lives.
- Two live breakages found by the pre-rollout check went into the bucket as
  checks (`fetch_update` deprecated, `assert_is_empty` pedantic). Ockham's is
  already fixed in NEAT-AI-Ockham#254; GRQ-AutoTrader's still needs a PR
  there, and is not worked around here.
- No bucket test pins the learnings section by text or number, so the
  renumbering needed no test change; the orchestrator's one by-number
  reference is to check 27, which did not move.

### Undiscoverable Facts

- NEAT-AI-Forests' bump the issue asks for already exists as
  NEAT-AI-Forests#128, one of the "Require Rust 1.99" PRs under
  NEAT-AI-core#747 (also Ockham#254, Rebase#135, Refinery#79, Predict#30),
  all green and awaiting review; this PR does not duplicate it.
- Clippy's `assert_is_empty` is allow-by-default (pedantic). GRQ-AutoTrader
  met it because its workspace sets `pedantic = { level = "warn" }`.
- `Atomic*::fetch_update` is deprecated in 1.99 with the note "renamed to
  `try_update`"; the release page summary does not list it, the compiler
  does.

## Evidence

- Checksums: each of the six values equals the `.sha256` file published next
  to its package for 1.99.0.
- Tests: `container_manifest_test`, `install_toolchains_test`,
  `toolchain_selfcheck_command_test`, `toolchain_selfcheck_test`,
  `supply_chain_gate_test`, `container_image_hash_test` and
  `dependency_lock_regen_test` pass (305 tests); `markdownlint-cli2` passes.
- Pre-rollout gate check on Rust 1.99.0 (`cargo fmt --check` and
  `cargo clippy --all-targets -- -D warnings`, fresh worktree of each repo's
  default branch):

  | Repo | fmt | clippy | Note |
  |---|---|---|---|
  | template-rust | ok | ok | |
  | NEAT-AI-Forests | ok | ok | bump open as NEAT-AI-Forests#128 |
  | NEAT-AI-Rebase | ok | ok | bump open as NEAT-AI-Rebase#135 |
  | NEAT-AI-Refinery | ok | ok | bump open as NEAT-AI-Refinery#79 |
  | GRQ-AutoTraderBackTesting | ok | ok | |
  | NEAT-AI-Ockham | ok | fail | one `fetch_update`, deprecated in 1.99; already renamed in NEAT-AI-Ockham#254 |
  | GRQ-AutoTrader | ok | fail | seven `assert!(…is_empty())` hits of `clippy::assert_is_empty` in `crates/tax/tests/store.rs` and `lots.rs` under the gate's `--all-features`; its gate goes red on the new image until a fix PR lands there (not yet raised) |

- **Docs sweep** — grep: `1.98.0`, `1.98`, `rust-toolchain.toml`,
  `Toolchain 1.96`, `fetch_update`, `assert_is_empty` over `docs/`
  (excluding `docs/archive/`), `README.md`, `prompts/`, `container/` and
  `worker/deno/lib`; section: `docs/CONTAINER.md#what-the-image-carries`;
  updated: `docs/CONTAINER.md`, `docs/audits/dependency-inventory.md`,
  `container/tools.json`, `prompts/best_practices/buckets/rust.md`;
  `docs/CONTAINER.md:120` — still true because it describes the crates that
  still pin 1.98.0; `prompts/best_practices/buckets/rust.md:390,406` — still
  true because checks 29 and 30 describe what 1.98 changed;
  `worker/deno/tests/toolchain_selfcheck_test.ts:297` — updated to the 1.99.0
  capture.

## Test Plan

- No new test: the change is a pin, docs and prompt text. The seven manifest
  tests above exercise the new pin and checksums; the self-check fixture is
  the 1.99.0 cargo version string.
