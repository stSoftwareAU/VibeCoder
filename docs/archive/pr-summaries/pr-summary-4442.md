## Summary

A repository-admin finding whose setting the worker could not apply (a token
without admin rights, a plan-gated surface) failed the `admin_only_repair` phase
as `internal_error`. The classifier maps that to a code-fixable `worker-crash`,
so every such refusal auto-filed a worker-crash issue. A failure whose every
refused result is a repository or token refusal now carries a declared
not-code-fixable `repo-config` classification (`REPO_ADMIN_REFUSED`), so
nothing is filed. Every other failure, including a fault in the worker's own
hardener, still files a `worker-crash`. Closes #4442.

Version bump: not applicable; no `VERSION` file change.

## Spec

### Intent and Rationale

- A refused admin write is a repository or credential condition; filing it as a
  worker defect is noise the run-failure filer was built to avoid.
- The classification is declared at the source (`result.classification`, already
  carried to `deriveRunOutcome` and honoured by `fileRunFailureIssue`) instead
  of parsing the message.

### Essential Design Decisions

- The category stays `internal_error`, so display and retry handling are
  unchanged.
- `NoAutomaticFixError` (finding missing from `FINDING_STEP_KIND`) stays a
  `worker-crash`: that one is a genuine worker gap.
- Refusal is declared, never assumed (PR #4460 review). `repairAdminOnlyFinding`
  returns a `RepoAdminRefusalError` only when every refused result passes
  `isRepoRefusal`: a deliberate skip, a 403 or 404 (`classifyGitHubError`), or
  a result `hardenRepo` marks with the new `HardenResult.refusal` field
  (`organisation-ruleset`, `inherited-role`). `hardenRepo`'s catch-all for an
  exception in its own code, a 422, a 5xx, a rate limit and a local fault stay a
  plain `Error`, so the run stays a `worker-crash` and is filed.

### Undiscoverable Facts

- The issue body carries no failure message (source repo withheld), so the
  refusal as the cause is inferred from the phase, the 9–10s duration and
  `repairAdminOnlyFinding`'s failure modes; no live run was inspected.
- Because the cause is inferred, only declared refusals are reclassified: if
  the recurring #4442 failure is really a hardener fault it is still filed.
- `planCodingFailure` treats this run as a transient/no-attempt disposition with
  or without the classification, so the ladder is unchanged and writes no
  record; `RECORD_ONLY_FAILURE_CLASSES`'s doc comment now says so, pinned by a
  `coding_failure_ladder_test.ts` test.

## Evidence

Backend only, no UI. Tests (run from `worker/deno`):
`deno task test:unit tests/issue_worker_test.ts tests/admin_only_finding_test.ts tests/run_outcome_classifier_test.ts tests/run_failure_issue_test.ts`
passed (185 passed, 0 failed); `deno fmt --check`, `deno lint` and `deno check`
on the seven changed files exit 0. The full `./quality.sh` was not run.

Review fix (PR #4460): `admin_only_finding_test.ts`, `issue_worker_test.ts`,
`repo_settings_harden_test.ts`, `coding_failure_ladder_test.ts` and every test
file importing the changed modules (221 files): 3417 passed, 6 failed. The six
(`pr_ci_processor_state_file_4394_test.ts`,
`baseline_quality_resumed_fork_point_4412_test.ts`,
`planning_processor_test.ts`, `pr_branch_update_test.ts`) fail identically on
`main` in this environment. `check:manifests` files: 846 passed. `deno fmt
--check`, `deno lint` and `deno check` on the eight changed files exit 0. Docs:
grepped `docs/` for `repo-config`, `not_code_fixable`, `HardenResult`,
`admin_only_finding` and `repairAdminOnlyFinding`; no manual lists the refusal
sources or `HardenResult`'s fields, so only doc comments changed.

## Reproduction

- **symptom** — a refused repository-admin repair (phase `admin_only_repair`,
  category `internal_error`) was classified code-fixable `worker-crash` and
  auto-filed as a worker-fault issue.
- **status** — `partial` — reason: the issue carries no failure message, so
  the refusal cause is inferred, and the regression test drives a stubbed
  hardener reporting a 403 rather than the recorded `admin_only_repair`
  failure. With the `classification` spread removed from `issue_worker.ts`
  (the base behaviour) that test failed (`undefined` vs `"not_code_fixable"`);
  it passes with the fix. #4442's own recurrences (10-second
  `admin_only_repair` failures every two hours) are still undiagnosed: if they
  are a hardener fault, a 422 or a 5xx, they keep filing as `worker-crash`.
- **regression test** —
  `worker/deno/tests/issue_worker_test.ts::workOnIssue #4298 - a refused repository-admin fix is a failure to retry, not a hand-off`

## Test Plan

- `worker/deno/tests/issue_worker_test.ts`: the #4298 refusal test now also
  asserts `not_code_fixable` / `repo-config`; new
  `workOnIssue #4442 - an unmapped repository-admin finding stays a worker-crash, not a repo-config refusal`.
- `worker/deno/tests/issue_worker_test.ts`: the #4298 refusal test now runs the
  real `repairAdminOnlyFinding` over a hardener reporting a 403; new
  `workOnIssue #4442 - a hardener exception reported as a failed result stays a worker-crash, not a repo-config refusal`
  runs it over `hardenRepo`'s catch-all result shape. Red check: with the old
  `!(error instanceof NoAutomaticFixError)` test restored in `issue_worker.ts`,
  it fails.
- `worker/deno/tests/admin_only_finding_test.ts`: new #4442 tests — a hardener
  exception, a 422, a 5xx and a local write fault are not refusals; a 403, a
  404, an organisation ruleset, an inherited role and a held skip are; one
  worker fault among refusals keeps the failure a worker defect; and through
  the real `hardenRepo`, a 403 is a refusal while a `TypeError` is not. Red
  check: with every failure made a `RepoAdminRefusalError`, five fail; with
  `refusal` ignored, the refusal test fails.
- `worker/deno/tests/repo_settings_harden_test.ts`: the organisation-ruleset
  and inherited-role tests assert the `refusal` field; the invalid-login test
  asserts it is absent. Red check: with the field removed from
  `repo_settings_harden.ts`, two fail.
- `worker/deno/tests/coding_failure_ladder_test.ts`: a refused admin setting
  is `transient` on the coding-failure ladder, never record-only.
- `worker/deno/tests/issue_worker_test.ts`: new
  `workOnIssue #4442 - a repository-admin repair that throws is not classed as a repo-config refusal`
  pins the `let refusedByRepo = false` initial value (`issue_worker.ts:527`);
  with it mutated to `true` this test goes red, restored it passes (127 passed).
- `worker/deno/tests/admin_only_finding_test.ts`: unmapped error is a
  `NoAutomaticFixError`, refused-write error is not.
- `worker/deno/tests/run_failure_issue_test.ts`: a refused admin setting is
  suppressed as `repo-config`; the same `internal_error` without the
  classification files a `worker-crash` issue.
- Red check: removing the `classification` spread turned the refusal test red;
  restored and green.
- Docs: the doc comment in `lib/coding_failure_ladder.ts` now says the admin
  refusal is `repo-config` only for the run-failure filer and transient on the
  ladder; `docs/` has no statement the change makes false.
- Not run: the full `./quality.sh` gate.

<!-- vibe-quality-gate-skipped reason="run budget; targeted tests, fmt, lint and check passed; CI runs the full gate" -->
