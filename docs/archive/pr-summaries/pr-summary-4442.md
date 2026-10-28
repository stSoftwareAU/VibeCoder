## Summary

A repository-admin finding whose setting the worker could not apply (a token
without admin rights, a plan-gated surface) failed the `admin_only_repair` phase
as `internal_error`. The classifier maps that to a code-fixable `worker-crash`,
so every such refusal auto-filed a worker-crash issue. The refusal now carries a
declared not-code-fixable `repo-config` classification (`REPO_ADMIN_REFUSED`),
so nothing is filed. Closes #4442.

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

### Undiscoverable Facts

- The issue body carries no failure message (source repo withheld), so the
  refusal as the cause is inferred from the phase, the 9–10s duration and
  `repairAdminOnlyFinding`'s failure modes; no live run was inspected.
- `planCodingFailure` treats this run as a transient/no-attempt disposition with
  or without the classification (checked with `deno eval`), so the ladder is
  unchanged.

## Evidence

Backend only, no UI. Tests (run from `worker/deno`):
`deno task test:unit tests/issue_worker_test.ts tests/admin_only_finding_test.ts tests/run_outcome_classifier_test.ts tests/run_failure_issue_test.ts`
passed (185 passed, 0 failed); `deno fmt --check`, `deno lint` and `deno check`
on the seven changed files exit 0. The full `./quality.sh` was not run.

## Reproduction

- **symptom** — a refused repository-admin repair (phase `admin_only_repair`,
  category `internal_error`) was classified code-fixable `worker-crash` and
  auto-filed as a worker-fault issue.
- **status** — `verified` — with the `classification` spread removed from
  `issue_worker.ts` (the base behaviour) the new test failed (`undefined` vs
  `"not_code_fixable"`); it passes with the fix.
- **regression test** —
  `worker/deno/tests/issue_worker_test.ts::workOnIssue #4298 - a refused repository-admin fix is a failure to retry, not a hand-off`

## Test Plan

- `worker/deno/tests/issue_worker_test.ts`: the #4298 refusal test now also
  asserts `not_code_fixable` / `repo-config`; new
  `workOnIssue #4442 - an unmapped repository-admin finding stays a worker-crash, not a repo-config refusal`.
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
- Docs: only the doc comment in `lib/coding_failure_ladder.ts` mentioned the
  `repo-config` scope and was updated; `docs/` has no statement the change makes
  false.
- Not run: the full `./quality.sh` gate.

<!-- vibe-quality-gate-skipped reason="run budget; targeted tests, fmt, lint and check passed; CI runs the full gate" -->
