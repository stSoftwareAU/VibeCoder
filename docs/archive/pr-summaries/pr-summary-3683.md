## Summary

The pre-PR changed-workflow gate's block message, and the `workflow_gate`
failure diagnosis, told a run it could clear a finding that does not apply by
adding a `# best-practice-ignore: <finding-id>` comment. The gate can never
honour such a comment. Both texts now say the fix is in the file itself, and
that a finding which genuinely does not apply needs a human to review it, or a
fix to the scanner. This takes the issue's first suggested option. Closes #3683.

## Spec

### Intent and Rationale

- `evaluateChangedWorkflowGate` builds each `WorkflowFile` as
  `{ path, rawText, parsed, kind }` with no `lineAuthors`.
  `setSuppressionCommitAuthors` has no production caller, so `findSuppressions`
  rejects every marker. The advice sent the agent into a loop it could not
  leave, and nudged it to write attribution it cannot own.
- Removing the advice is the smallest change that makes the message true. The
  alternative, blaming the branch's files in the gate, would still not let the
  worker clear its own finding, because Issue #334 rejects worker logins as
  marker authors.

### Essential Design Decisions

- The message no longer names the marker at all, so it cannot prompt the agent
  to try one. It does say that no in-file suppression marker and no PR-summary
  prose clears the gate.
- The premise is pinned by a test. With a configured author allowlist but no
  verified commit identity, the gate still reports a correctly formed marker's
  finding. If the gate later gains blame, that test goes red, and the message
  can be revisited at the same time.

### Undiscoverable Facts

- This was found while reviewing PR #3682, outside that PR's scope.

## Evidence

This is a backend/CLI change, so no screenshot applies. The tests covering it:

- `worker/deno/tests/changed_workflow_gate_test.ts::changed-workflow gate - the message names the PR the block lands on (Issue #2044)`
  now asserts that both openings of the message contain `needs a human` and not
  `best-practice-ignore`.
- `worker/deno/tests/changed_workflow_gate_test.ts::changed-workflow gate - a best-practice-ignore marker does not clear a finding the run introduced (Issue #3683)`
  pins the premise the message relies on. The marked tag-pinned checkout is
  still blocked when no commit identity is configured. As a positive control,
  the same marker clears the finding once `setSuppressionCommitAuthors(["nigel"])`
  is set, which proves the marker is correctly formed.
- `worker/deno/tests/failure_diagnosis_test.ts::workflow_gate category - diagnosis, oneliner, display and validation all handle it (Issue #2044)`
  now asserts that the diagnosis contains `needs a human` and not
  `best-practice-ignore`.

Cited issues: #3683 (Changed-workflow gate tells the worker to add a
best-practice-ignore marker, but the gate can never honour one) and #1859
(Worker pre-PR check: run WORKFLOW_FILE_CHECKS over every changed
.github/workflows/ file).

**Docs sweep** — grep: `best-practice-ignore`, "remedy", "Prose in the PR summary", `buildChangedWorkflowGateMessage`, `changed_workflow_gate`; section: `docs/workflows/issue-processing.md#-changed-workflow-files-are-checked-before-the-pr`; siblings: none — no existing set gained a member; updated: `docs/workflows/issue-processing.md`, plus the doc comments in `worker/deno/lib/changed_workflow_gate.ts` (module doc) and `worker/deno/lib/workflow_file_checks.ts` (`fromPerFileScanner`); `worker/deno/lib/workflow_file_checks.ts:130` — still true because the per-step id is the one an audit marker suppresses; `docs/EXTENDING.md:291` — still true because it describes only what the gate scans and blocks, not a remedy; other `best-practice-ignore` hits under `docs/` and `prompts/` describe the idle-task audits' own markers, which this change does not touch

## Test Plan

- Edited: `worker/deno/tests/changed_workflow_gate_test.ts`, which removes the
  assertion `assertStringIncludes(message, "best-practice-ignore");`. Issue
  #3683 requires that the message stop offering the marker remedy, so this
  assertion no longer holds. It is replaced by assertions that the message
  includes `needs a human` and excludes `best-practice-ignore`.
  - Red-check: restoring the old marker sentence in
    `buildChangedWorkflowGateMessage` turned this test red at
    `tests/changed_workflow_gate_test.ts:365`.
- Edited: `worker/deno/tests/failure_diagnosis_test.ts`, which removes the
  assertion `getFailureDiagnosis("workflow_gate"),` /
  `"best-practice-ignore",` (the `assertStringIncludes(` call). Issue #3683
  requires that `failure_diagnosis.ts` drop the marker remedy, so this
  assertion no longer holds. It is replaced by an inclusion check for
  `needs a human` and an exclusion check for `best-practice-ignore`.
  - Red-check: restoring the old diagnosis bullet turned this test red at
    `tests/failure_diagnosis_test.ts:718`.
- Added: the premise test "a best-practice-ignore marker does not clear a
  finding the run introduced (Issue #3683)". It pins current behaviour, so it
  is expected to be green on base, and it is: the change it accompanies is to
  message text, not to suppression. Its positive control (the marker clears
  once a commit identity is configured) shows that its rejection comes only
  from the missing identity.
- `deno task test:unit tests/changed_workflow_gate_test.ts tests/failure_diagnosis_test.ts`
  passed on the final head: 135 passed, 0 failed.
- `deno fmt`, `deno lint` and `deno check` passed on the five changed TypeScript
  files, and `markdownlint-cli2` reported 0 issues on the edited manual.
- `./quality.sh` passed, with skipped checks: deno tests, lint, type check,
  fmt, semgrep and markdownlint all passed. The manual edit landed after that
  run started, so `markdownlint-cli2` was run on it separately: 0 issues.
- No production branch, field or parameter was added; only message text and
  doc comments changed.

<!-- vibe-branch-outcomes -->
