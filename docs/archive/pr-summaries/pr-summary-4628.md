## Summary

Adds the Cargo Security Audit workflow at `.github/workflows/cargo-audit.yml`, copied from the issue's template (runs on `pull_request` only, no `schedule:` trigger). The check is advisory, so its `audit` context is recorded as an exempt context in `worker/deno/lib/pr_check_contexts.ts`, and `quality.yml`'s "not gated" header comment names it. Version bump: not part of this change. Closes #4628.

## Spec

### Intent and Rationale

- The repository was missing the workflow the fleet's workflow sync asks for; the YAML is committed as given, with no schedule trigger, as the issue comments require.
- The repo's own `pr_check_contexts_test.ts` fails for any new always-reporting check that is neither required nor exempt, so the context is exempted rather than silently added to the ruleset.

### Essential Design Decisions

- The ruleset (`infra/rulesets/main.json`) requires `gate` alone and the worker cannot edit rulesets, so making `Cargo Audit / audit` blocking stays a human step, as the issue says. The exemption records that decision.
- The template's `cargo install cargo-audit` is left unpinned: the `ci-install-pins` check only inspects `npm`, `npx` and `gem`, and the file passes all twelve file-scoped checks (run over the real tree: 0 findings each).
- Added a `# actions/checkout@v7.0.1` and a `# dtolnay/rust-toolchain@v1` comment above the pins because `supply_chain_gate.ts` requires the `# owner/action@vX` form; the template's inline `# v7.0.1` / `# v1` comments and the pins themselves are untouched.

### Undiscoverable Facts

- The only Rust in this repository is `evals/capability_security/accept/rust` (a `Cargo.toml`, no tracked `Cargo.lock`), so `cargo audit` at the repo root may report that it cannot load a `Cargo.lock`. The check is advisory, so this does not block a merge.
- `workflow_definitions.ts` still lists `schedule` as a `cargo-audit` trigger and in its template; that catalogue was not changed here (outside this issue).

## Evidence

Backend/CI-only change, no UI. Real-tree checks run on the head:

- `deno test --allow-all tests/pr_check_contexts_test.ts` — 15 passed (it failed with `these checks run on every main PR but are not required: audit` before the exemption was added).
- `deno test --allow-all tests/supply_chain_gate_test.ts` — 43 passed (it failed on the missing pin comments and a stale inventory before this diff's fixes).
- All 12 `WORKFLOW_FILE_CHECKS` run on the real tree report 0 findings for `cargo-audit.yml`.

## Test Plan

- No new test: the existing `worker/deno/tests/pr_check_contexts_test.ts` ("this repository - every PR check on main is required or exempt") and `worker/deno/tests/supply_chain_gate_test.ts` ("the real repository tree passes with no findings") read the real workflow tree and cover this change. Both went red with the workflow added alone and pass at the head.
- `./quality.sh` ran and reported FAILED; the remaining failures are not caused by this change:
  - `tests/lib_sweep_coverage_test.ts`: `worker/deno/lib/fleet_babysitter_codex.ts` is claimed by no sweep slice (module from the base branch, not touched here). This also fails the "completeness checks" stage.
  - `tests/completion_phase_repo_formatters_test.ts` (two Rust formatter tests): "formatter should commit the Rust fix" (worker environment; unrelated to the workflow). Not confirmed against the base branch.
- Not run: the other stages of the gate beyond what `./quality.sh` ran (config integration and checkov were skipped by the gate itself).
