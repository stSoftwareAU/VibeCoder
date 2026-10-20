## Summary

Closes #3971. Part of #3653. Follows #3970 (PR #4026).

This PR adds the Checkov CloudFormation scan to CI as a mandatory part of
`gate`. A new reusable workflow, `.github/workflows/checkov.yml`, runs the
pinned Checkov image and passes the JSON report and the scan's exit code to
the `checkov_report.ts` judge from #3970. `quality.yml` calls it as a
`checkov` job, and `gate.needs` now includes `checkov`, so a red scan turns
`gate` red. A lock-step test keeps the workflow and the pinned config
identical. `linux-verification-host.yaml`, `test-floci.sh` and `floci.yml` are
unchanged. The only production change is the `--skip-path` pair added to
`CHECKOV_SCAN_ARGS` in `worker/deno/lib/checkov_report.ts` (see Spec).

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
- `linux-verification-host.yaml` is unchanged, so no `# checkov:skip` was
  added. The CI Checkov run is the evidence that it has 0 failed checks.
- The first CI run failed only on the intentionally bad #3970 fixtures under
  `worker/deno/tests/fixtures/checkov`, because the scan covers the whole tree.
  They are excluded with `--skip-path worker/deno/tests/fixtures/checkov` (a
  regex relative to the working directory), added to `CHECKOV_SCAN_ARGS` in
  `checkov_report.ts`, to the `docker run` line in `checkov.yml`, and to the
  expected args in `checkov_report_test.ts`; the fixtures README notes the
  exclusion. The local pre-push gate uses the same constant, so parity is kept.
- The lock-step test still bans `--skip-path`, but allows exactly the pair
  carried by `CHECKOV_SCAN_ARGS` (read from the constant, removed as whole
  tokens), so any other `--skip-path`, including a longer path such as
  `checkov-extra`, is reported.

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

- `worker/deno/tests/checkov_workflow_test.ts` has 16 tests, all passing. One
  checks the real files and 15 are negative fixtures.
- `actionlint` exits 0 on the new and edited workflows.
- The Docker scan on the CI runner, the Floci `CREATE_COMPLETE` run and zizmor
  are CI-only. Their output is the check runs on this PR; the first Checkov run
  failed only on the #3970 fixtures, which the `--skip-path` pair now excludes,
  the re-run passed (`checkov / checkov (CloudFormation)`, run 39399239691, 27s, and `gate` is green). Floci and zizmor did not run as separate checks on this PR; `floci.yml` and `test-floci.sh` are unchanged.

**Docs sweep** — grep: `semgrep`, `semgrep.yml`; section: `CONTRIBUTING.md` "Checkov (CloudFormation) in CI" and the CI workflow list; siblings: `semgrep` and `semgrep.yml` — hits at `README.md:229`, `README.md:409-413`, `CONTRIBUTING.md:96`, `CODING-STANDARDS.md:1364-1371` and `docs/INTERNALS.md:119` describe the local quality gate and are still true; `docs/EXTENDING.md:242-243` and `docs/PROMPTS.md:37` list target-repo templates and are still true; `docs/MERGE.md`, `docs/AGENT-ACCOUNTABILITY.md:881`, `docs/GITHUB-ACTIONS-AUDIT-SCAN.md`, `docs/SECURITY-TREE-SWEEP.md`, `docs/CONTAINER*.md`, `docs/BEST-PRACTICES-SCAN.md:540`, `docs/security/*`, `docs/workflows/*` and `docs/audits/*` are historical or about target repos and are still true; `SECURITY.md` and `DESIGN-PRINCIPLES.md` do not mention Semgrep; updated: `CONTRIBUTING.md`, `docs/REFERENCES.md` and `docs/audits/dependency-inventory.md`

#3653: Add Checkov security scanning for AWS CloudFormation templates

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — `quality.yml` calls `checkov.yml`, `gate.needs` includes `checkov`, and a failure turns `gate` red — evidence: `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - checkov.yml and quality.yml are in lock-step`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - checkov removed from gate.needs is reported` — reviewer: met
- **met** — `checkov.yml` has `contents: read`, SHA-pinned actions, no concurrency, no SARIF and no path filter — evidence: `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - a top-level concurrency block is reported`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - an upload-sarif step is reported`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - a path filter under workflow_call is reported` — reviewer: met
- **met** — The template has 0 failed checks, and every skip is inline with the Floci reason — evidence: the template is unchanged; the CI run `checkov / checkov (CloudFormation)` (run 39399239691) passed with the #3970 fixtures excluded, so `linux-verification-host.yaml` has 0 failed checks and needs no skip — reviewer: met
- **met** — `test-floci.sh` still reaches `CREATE_COMPLETE`, and `floci.yml` is unchanged — evidence: `git diff milestone/pre-push-gate-ci-parity -- .github/workflows/floci.yml test-floci.sh` is empty, so the Floci behaviour is unchanged by construction; `floci.yml` is path-filtered and did not run as a separate check on this PR — reviewer: met
- **met** — The lock-step test passes on the real files and fails on each negative fixture — evidence: `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - a changed image digest is reported`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - an added --soft-fail is reported`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - a weakening flag split mid-word across a continuation is reported`, `worker/deno/tests/checkov_workflow_test.ts::checkov_workflow - checkov removed from gate.needs is reported` — reviewer: met
- **met** — `actionlint`, the tests and `./quality.sh` all pass — evidence: `actionlint` exits 0, `worker/deno/tests/checkov_workflow_test.ts` (16 passing) and the gate run recorded in the Test Plan — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — The independent standards reviewer found no material departure from `CODING-STANDARDS.md` in the diff after the findings below were fixed.
  - Missing negative fixtures for no-SARIF and no-path-filter: added the two checks and tests.
  - A raw-text grep test: deleted.
  - A private copy of `joinContinuations`: kept on purpose and explained in its doc comment, because the owner's trim-and-space join hides a mid-word split. The only production change is the `--skip-path` pair in `CHECKOV_SCAN_ARGS`.
    - A negative test was added: a `--skip-path` other than the allowed pair is reported (red when the allowance is too broad).

## Test Plan

- [x] `deno task test tests/checkov_workflow_test.ts`: 16 passed.
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
- [x] Red check: widening the `--skip-path` allowance turned only the new negative test red; restored.
- [x] CI: the Checkov scan passed on this PR (run 39399239691) and `gate` is green. No separate Floci or zizmor check ran on this PR; the Floci files are unchanged.

<!-- vibe-branch-outcomes -->
