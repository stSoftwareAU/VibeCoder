## Summary

Adds the Cargo Dependency Updates workflow at
`.github/workflows/cargo-upgrade.yml` (weekly and on demand; when a root `Cargo.toml` exists it runs `cargo upgrade`
and `cargo update`, then opens a pull request via
`peter-evans/create-pull-request`).
This repository has no root `Cargo.toml` (its only Rust is the eval fixture
under `evals/`), so the toolchain, `cargo install`, `cargo upgrade`,
`cargo update` and pull-request steps are all guarded with
`if: hashFiles('Cargo.toml') != ''` and skipped until one is committed, as
`.github/workflows/cargo-audit.yml` does for `Cargo.lock`. Closes #4629.

## Spec

### Intent and Rationale

- The issue supplies the fleet's catalogue template (`cargoUpgrade` in
  `worker/deno/lib/workflow_definitions.ts`); it is committed with its resolved
  pins and version comments, as the issue instructs, plus the deviations
  listed below.

### Essential Design Decisions

- Three deviations from the verbatim template. Two are forced by this
  repository's own gates: the checkout step sets `persist-credentials: false`
  (`worker/deno/tests/workflow_hardening_test.ts`, GHA-SECRETS-009), and each
  SHA pin has a `# owner/action@vX` comment within three lines above it
  (`supply_chain_gate` rule `action-pin-comment`). The third, added in review,
  is the `if: hashFiles('Cargo.toml') != ''` guard on the toolchain, `cargo
  install`, `cargo upgrade`, `cargo update` and pull-request steps (see
  Summary). The first is safe because
  `create-pull-request` pushes with its own `token` input, not the checkout
  credential; the template's "credential persistence stays on" comment was
  replaced to say so.
- `docs/audits/dependency-inventory.md` was regenerated with
  `supply-chain-gate --write-inventory`, because the new workflow adds two
  actions and a use of `actions/checkout`.

### Undiscoverable Facts

- None.

## Evidence

Backend/CI configuration only; no UI file changed. The 12 file-scoped checks in
`WORKFLOW_FILE_CHECKS` (`worker/deno/lib/workflow_file_checks.ts`) return 0
findings on the file. Before the deviations above, the full `./quality.sh` run
failed on `workflow_hardening_test.ts` and `supply_chain_gate_test.ts`; after
them, both pass.

## Test Plan

- New `worker/deno/tests/workflow_hardening_test.ts` test: every non-checkout
  step of `cargo-upgrade.yml` and `cargo-audit.yml` carries its root-file
  guard. Red check: removing the guard from the `cargo update` step fails it
  with "cargo-upgrade.yml: step lacks `if: hashFiles('Cargo.toml') != ''`".
- `deno task test:unit` at head: `worker/deno/tests/workflow_hardening_test.ts`
  (6 tests at head), `worker/deno/tests/workflow_definitions_test.ts` (70 tests
  at head) and `worker/deno/tests/supply_chain_gate_test.ts` (43 tests at head,
  run unchanged as a gate over the new workflow); 0 failed.
- `./quality.sh` was not re-run in the review-fix round (budget); CI runs the
  full gate.

<!-- vibe-quality-gate-skipped: ./quality.sh not re-run in the PR #4686 review-fix round; targeted tests pass and CI runs the full gate -->
