## Summary

Adds the Cargo Dependency Updates workflow at `.github/workflows/cargo-upgrade.yml`
(weekly and on demand: `cargo upgrade`, `cargo update`, then a pull request via
`peter-evans/create-pull-request`). Closes #4629.

## Spec

### Intent and Rationale

- The issue supplies the fleet's catalogue template (`cargoUpgrade` in
  `worker/deno/lib/workflow_definitions.ts`); it is committed with its resolved
  pins and version comments unchanged, as the issue instructs.

### Essential Design Decisions

- Two deviations from the verbatim template, both forced by this repository's own
  gates: the checkout step sets `persist-credentials: false`
  (`worker/deno/tests/workflow_hardening_test.ts`, GHA-SECRETS-009), and each SHA
  pin has a `# owner/action@vX` comment within three lines above it
  (`supply_chain_gate` rule `action-pin-comment`). The first is safe because
  `create-pull-request` pushes with its own `token` input, not the checkout
  credential; the template's "credential persistence stays on" comment was
  replaced to say so.
- `docs/audits/dependency-inventory.md` was regenerated with
  `supply-chain-gate --write-inventory`, because the new workflow adds two actions
  and a use of `actions/checkout`.

### Undiscoverable Facts

- None.

## Evidence

Backend/CI configuration only; no UI file changed. The 12 file-scoped checks in
`WORKFLOW_FILE_CHECKS` (`worker/deno/lib/workflow_file_checks.ts`) return 0
findings on the file. Before the deviations above, the full `./quality.sh` run
failed on `workflow_hardening_test.ts` and `supply_chain_gate_test.ts`; after
them, both pass.

## Test Plan

- No new test: the repository's existing real-tree tests police the file
  (`worker/deno/tests/workflow_hardening_test.ts`,
  `worker/deno/tests/supply_chain_gate_test.ts`).
- `deno task test:unit` over `workflow_hardening_test.ts`,
  `supply_chain_gate_test.ts`, `workflow_definitions_test.ts`,
  `workflow_auditor_test.ts` and `setup_workflow_sync_test.ts`: 178 passed, 0
  failed.
- `./quality.sh`: every stage before the Deno tests passed, including
  completeness checks (which failed before the deviations), workflow hygiene,
  markdownlint and semgrep. Two full runs hit the 598 s command cap during the
  Deno tests stage (the earlier full run took about 6 minutes there), so that
  stage did not finish on the final head; the one earlier failure it reported
  was the two tests above, which now pass.

<!-- vibe-quality-gate-skipped: ./quality.sh Deno tests stage did not finish within the 598 s command cap on the final head; every earlier stage passed and the two tests it previously failed on pass; CI runs the full gate -->
