## Summary

The local quality gate now runs the same pinned Checkov scan that the CI `checkov` job runs, so a developer finds a CloudFormation finding before the push. The new stage never installs or pulls anything. When no pinned route is usable it reports `SKIPPED` with the reasons, never a false `PASSED`. This is part of #3653 and depends on #3970 (PR #4026) and #3971 (b6f9648a).

- `worker/deno/lib/checkov_check.ts` (new):
  - detects a pinned route: a `checkov` on PATH whose `--version` output equals `CHECKOV_IMAGE_TAG`, else `docker` or `podman` already holding `CHECKOV_IMAGE` (checked with `image inspect`, never pulled).
  - runs the image read-only (`:ro`) with `--entrypoint checkov` and `CHECKOV_SCAN_ARGS`.
  - takes the verdict from the shared `judgeCheckovRun`.
  - with no usable route, reports `SKIPPED` with the reasons and an install hint; a deadline hit is `FAILED`.
  - redacts the stderr tail via `redactedLineTail` before it is shown on a failed run.
- `worker/deno/lib/quality_gate.ts` (+22): `runCheckovQualityCheck`; the `checkov` stage is registered only when `.github/workflows/checkov.yml` exists.
- `worker/deno/lib/semgrep_check.ts`: now exports `spawnWithDeadline` and `probe` for reuse.
- `worker/deno/tests/checkov_check_test.ts` (new, 19 tests).
- `CONTRIBUTING.md` (+33) and `docs/INTERNALS.md` (+16): how the stage chooses a route, and what `SKIPPED` and `--strict` mean.
- `CODING-STANDARDS.md` (+7).
- `docs/audits/lib-sweep-coverage/top-up-3972.json`: the lib-sweep ledger entry for the new lib file.

`container/tools.json` is unchanged.

Closes #3972

## Spec

### Intent and Rationale

- The local quality gate runs the same pinned Checkov scan CI runs, so a developer finds a failure before the push.
- An honest `SKIPPED` rather than a false `PASSED`: a stage that cannot run says so, and says why.

### Essential Design Decisions

- Only the exact pinned version is trusted: an unpinned PATH binary falls through to the container route rather than blocking it.
- It never installs or pulls, and makes no network or metered call (`--skip-download` is in `CHECKOV_SCAN_ARGS`).
- The verdict is delegated to the shared `judgeCheckovRun`, so local and CI cannot diverge.
- `--strict` promotes `SKIPPED` to `FAILED` via the existing `formatSummary`.

### Undiscoverable Facts

- The fleet image has neither a pinned checkov nor docker, so the stage reports `SKIPPED` there.
- `judgeCheckovRun` only accepts exit codes 0 and 1, and non-JSON stdout is `FAILED`.

## Evidence

- `./quality.sh < /dev/null` exited 0 with "Result: PASSED (with skipped checks)" (checkov and config-integration stages SKIPPED in this sandbox).
- `deno task test:unit tests/checkov_check_test.ts`: `ok | 19 passed | 0 failed`.
- The flip results: every branch outcome in `docs/archive/pr-summaries/pr-summary-3972.facts.json` was flipped on purpose and went red (see Test Plan).
- NOT run: no real checkov binary or docker/podman was run; the tests use stubbed probe/spawn only.
- The stage reports `SKIPPED` in the fleet image.
- **Docs sweep** — grep: `CHECKOV_IMAGE_TAG`, `checkov --version`, `SKIPPED`, `--strict`, `checkov.yml` across docs and README; section: CONTRIBUTING.md#checkov (the "### Checkov (CloudFormation) before the push and in CI" heading at CONTRIBUTING.md:166) — the operator guide for the local gate, where the stage's route choice is described; siblings: `semgrep` (listed as a local gate stage at CONTRIBUTING.md:96) and `gitleaks` (named at CONTRIBUTING.md:128 as a CI workflow, not a local stage); updated: CONTRIBUTING.md, docs/INTERNALS.md, CODING-STANDARDS.md; CONTRIBUTING.md:182 — still true because it states the `checkov --version` equals `CHECKOV_IMAGE_TAG` rule the code implements; docs/INTERNALS.md:153 — still true because it states the same rule; README.md:227-229 — still true because the unchanged quality-gate paragraph names the gate's tools but not per-stage routing.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — With the pinned `checkov` on PATH, the stage runs `CHECKOV_SCAN_ARGS` and returns the shared judge's verdict. — evidence: `worker/deno/tests/checkov_check_test.ts::runCheckovCheck - a PATH checkov on the pin is used with the CI scan args`, `::runCheckovCheck - a failing scan is FAILED with the judge's finding`, `::runCheckovCheck - a clean scan is PASSED` — reviewer: met — reason: the pinned PATH route runs the CI scan args, and the verdict comes from the shared judge in both the failing and the clean case.
- **met** — With only a container runtime that already holds `CHECKOV_IMAGE`, the stage runs it read-only and never pulls. — evidence: `worker/deno/tests/checkov_check_test.ts::buildCheckovContainerArgs - mounts read-only and keeps --entrypoint checkov`, `::runCheckovCheck - a docker-held image runs read-only via --entrypoint checkov`, `::runCheckovCheck - podman is used when docker is absent and podman holds the image`, `::runCheckovCheck - a runtime without the image is not used and is SKIPPED` — reviewer: met — reason: the mount is read-only, the entrypoint is checkov, and a runtime without the image is not used.
- **met** — With no usable pinned route, including an unpinned PATH binary without an available pinned image, the stage reports `SKIPPED` with a reason, never `PASSED`. An unpinned PATH binary must not prevent the pinned-container fallback. `--strict` makes a final `SKIPPED` become `FAILED`. — evidence: `worker/deno/tests/checkov_check_test.ts::runCheckovCheck - a PATH version mismatch is not run and falls through to SKIPPED`, `::runCheckovCheck - a PATH version mismatch still reaches the docker route`, `::runCheckovCheck - SKIPPED names every unusable route and the install hint`, `::runCheckovCheck - a SKIPPED checkov fails the gate under --strict` — reviewer: met — reason: a mismatched PATH binary falls through, the container route still runs, and the no-route case names its reasons and stays SKIPPED until --strict.
- **met** — The stage adds no suppression, edits no workflow, and makes no network or metered API call. — evidence: the diff against b6f9648a touches no `.github/workflows/*` and no skip or suppression list; `CHECKOV_SCAN_ARGS` carries `--skip-download`; image presence is checked by `image inspect`, never a pull — reviewer: met — reason: the stage only reads the workflow file's presence and runs a local scan.
- **met** — `container/tools.json` is unchanged. — evidence: `container/tools.json` is absent from the diff against b6f9648a — reviewer: met — reason: the diff against b6f9648a lists eight files and does not include it.
- **met** — Tests and `./quality.sh` pass. — evidence: `./quality.sh < /dev/null` exit 0 ("PASSED (with skipped checks)") and the 19 tests in `worker/deno/tests/checkov_check_test.ts` (`ok | 19 passed | 0 failed`) — reviewer: met — reason: the quality gate exits 0 and the targeted test file passes in full.
- **unrequested** — the lib-sweep ledger `docs/audits/lib-sweep-coverage/top-up-3972.json` — reviewer: unrequested — reason: required for the new lib file to be accounted for.
- **unrequested** — the `CODING-STANDARDS.md` and `docs/INTERNALS.md` edits — reviewer: unrequested — reason: they document the new stage where the standards and internals already list gate stages.
- **unrequested** — the redacted stderr tail on a FAILED non-JSON run — reviewer: unrequested — reason: so a crash is diagnosable, redacted with `redactedLineTail`.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — secrets must not reach logs/reasons: checkov stderr tail was first unredacted — evidence: `worker/deno/lib/checkov_check.ts:284` — reason: fixed in this diff; the tail is now built by `redactedLineTail` (line 288), and line 284 is the guard that decides whether a non-empty stderr is appended.
- **clean** — fail-loud (SKIPPED never PASSED, timeout FAILED, non-NotFound read fault rethrown), no new dependency, Deno-native, no network, tests exercise real code with a negative test per guard, branch outcomes enumerated, no history assumptions.

## Test Plan

- `deno task test:unit tests/checkov_check_test.ts`: 19 pass (`ok | 19 passed | 0 failed`).
- `./quality.sh < /dev/null` passes (exit 0, "Result: PASSED (with skipped checks)").
- Each branch outcome in `docs/archive/pr-summaries/pr-summary-3972.facts.json` was flipped on purpose and went red; one line per outcome is in that file.
- Docs sweep: CONTRIBUTING.md, docs/INTERNALS.md and CODING-STANDARDS.md were updated, and the cited lines (CONTRIBUTING.md:182, docs/INTERNALS.md:153, README.md:227-229) were re-read before this summary was finalised.

<!-- vibe-branch-outcomes -->
