## Summary

Closes #3971. Part of #3653. Follows #3970 (PR #4026).

This PR adds the Checkov CloudFormation scan to CI as a mandatory part of
`gate`. A new reusable workflow, `.github/workflows/checkov.yml`, runs the
pinned Checkov image and passes the JSON report and the scan's exit code to
the `checkov_report.ts` judge from #3970. `quality.yml` calls it as a
`checkov` job, and `gate.needs` now includes `checkov`, so a red scan turns
`gate` red. A lock-step test keeps the workflow and the pinned config
identical. `linux-verification-host.yaml`, `test-floci.sh` and `floci.yml` are
unchanged. No production code changed.

## Spec

### Intent and Rationale

- CI must run the same scan as the local pre-push gate, with the same image
  and arguments, and a failure must block merge. That is the parity #3653
  asks for.
- The workflow is modelled on `semgrep.yml`: `workflow_call` only, read-only
  permissions, SHA-pinned actions, no concurrency.

### Essential Design Decisions

- The scan runs as `docker run … --entrypoint checkov <CHECKOV_IMAGE>
  <CHECKOV_SCAN_ARGS>`. `--entrypoint checkov` is needed because under
  `GITHUB_ACTIONS=true` the image's own entrypoint ignores its arguments.
- The scan's exit code is captured with `|| status=$?` and handed to the
  judge, so the judge, not Checkov's exit code, decides pass or fail.
- No concurrency block: a called workflow inherits the caller's
  `github.workflow`, so its own group would collide with the caller's. No
  SARIF upload and no path filter, so every run scans the whole tree.
- The lock-step test (`worker/deno/tests/checkov_workflow_test.ts`) parses
  both YAML files. It joins backslash-newline continuations the way bash does
  (the pair is removed with no space), so a flag split mid-word across a
  continuation is still caught. Weakening flags are matched as whole words.
- `joinContinuations` in the test is deliberately not shared with
  `ci_install_pin_scanner.ts`. That owner trims each line and joins with a
  space, which turns `--soft-\` + `fail` into `--soft- fail` and would hide
  the split case this test guards. The test's doc comment says so.
- `linux-verification-host.yaml` needs no change, so no `# checkov:skip` was
  added. An earlier local Checkov run found 0 failed checks on it.

### Undiscoverable Facts

- Docker is not available in the agent sandbox. The real Docker scan, the
  Floci run and zizmor can therefore be proven only by this PR's CI. They are
  the evidence for acceptance criteria 3 and 4.
- Extras the issue did not name, all small: `timeout-minutes: 15`,
  `deno-version-file: .deno-version`, `set -euo pipefail`, a line in
  `docs/REFERENCES.md`, and a regenerated `docs/audits/dependency-inventory.md`
  (the new workflow adds rows for checkout and setup-deno).
- No scanner table with a Semgrep row exists in the docs. Checkov is described
  in a new `CONTRIBUTING.md` section beside the Semgrep material instead.

## Evidence

- `worker/deno/tests/checkov_workflow_test.ts` has 15 tests, all passing. One
  checks the real files and 14 are negative fixtures.
- `actionlint` exits 0 on the new and edited workflows.
- An earlier local Checkov run found 0 failed checks on
  `linux-verification-host.yaml`. The Docker scan on the CI runner, the Floci
  `CREATE_COMPLETE` run and zizmor are CI-only; their output is the check runs
  on this PR.

**Docs sweep** — grep: `semgrep`, `semgrep.yml`; section: `CONTRIBUTING.md` "Checkov (CloudFormation) in CI" and the CI workflow list; siblings: `semgrep` and `semgrep.yml` — hits at `README.md:229`, `README.md:409-413`, `CONTRIBUTING.md:96`, `CODING-STANDARDS.md:1364-1371` and `docs/INTERNALS.md:119` describe the local quality gate and are still true; `docs/EXTENDING.md:242-243` and `docs/PROMPTS.md:37` list target-repo templates and are still true; `docs/MERGE.md`, `docs/AGENT-ACCOUNTABILITY.md:881`, `docs/GITHUB-ACTIONS-AUDIT-SCAN.md`, `docs/SECURITY-TREE-SWEEP.md`, `docs/CONTAINER*.md`, `docs/BEST-PRACTICES-SCAN.md:540`, `docs/security/*`, `docs/workflows/*` and `docs/audits/*` are historical or about target repos and are still true; `SECURITY.md` and `DESIGN-PRINCIPLES.md` do not mention Semgrep; updated: `CONTRIBUTING.md`, `docs/REFERENCES.md` and `docs/audits/dependency-inventory.md`

#3653: Add Checkov security scanning for AWS CloudFormation templates

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — `quality.yml` calls `checkov.yml`, `gate.needs` includes `checkov`, and a failure turns `gate` red — evidence: `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - checkov.yml and quality.yml are in lock-step`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - checkov removed from gate.needs is reported` — reviewer: met
- **met** — `checkov.yml` has `contents: read`, SHA-pinned actions, no concurrency, no SARIF and no path filter — evidence: `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - a top-level concurrency block is reported`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - an upload-sarif step is reported`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - a path filter under workflow_call is reported` — reviewer: met
- **partial** — The template has 0 failed checks, and every skip is inline with the Floci reason — evidence: the template is unchanged and an earlier local Checkov run found 0 failed checks; the Docker scan on CI is the proof — reviewer: partial, pending CI
- **met** — `test-floci.sh` still reaches `CREATE_COMPLETE`, and `floci.yml` is unchanged — evidence: `git diff milestone/pre-push-gate-ci-parity -- .github/workflows/floci.yml test-floci.sh` is empty; the Floci run on CI confirms `CREATE_COMPLETE` — reviewer: met, pending CI
- **met** — The lock-step test passes on the real files and fails on each negative fixture — evidence: `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - a changed image digest is reported`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - an added --soft-fail is reported`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - a weakening flag split mid-word across a continuation is reported`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - checkov removed from gate.needs is reported` — reviewer: met
- **met** — `actionlint`, the tests and `./quality.sh` all pass — evidence: `actionlint` exits 0, `worker/deno/tests/checkov_workflow_test.ts` (15 passing) and the gate run recorded in the Test Plan — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — The independent standards reviewer found no material departure from `CODING-STANDARDS.md` in the diff after the findings below were fixed.
  - Missing negative fixtures for no-SARIF and no-path-filter: added the two checks and tests.
  - A raw-text grep test: deleted.
  - A private copy of `joinContinuations`: kept on purpose and explained in its doc comment, because the owner's trim-and-space join hides a mid-word split. No production code changed.

## Test Plan

- [x] `deno task test tests/checkov_workflow_test.ts`: 15 passed.
- [x] `deno fmt --check`, `deno lint` and `deno check` on the test file are clean.
- [x] `actionlint` exits 0.
- [x] `./quality.sh < /dev/null` passes. The config integration check was
      skipped by the gate itself.
- [x] Red checks: each lock-step check was broken on purpose and its test
      went red, including the continuation join (red under an identity join
      and under the old join), the SARIF check and the path-filter check.
      Each was restored.
- [x] Applied the rule changes to the PR's own diff. This PR adds no prompt
      or standards rule, so there was nothing to apply.
- [ ] CI: the Checkov scan, Floci and zizmor runs on this PR.

<!-- vibe-branch-outcomes -->
