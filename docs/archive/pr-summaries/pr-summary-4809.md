## Summary

The fast-failure tally recorded `setup after 26s: Aborting` for #4658, so the
diagnostic issue gave no hint why setup failed. `diagnosticErrorLine` kept the
last line of a multiline Git refusal, and Git ends a refused checkout or merge
with the generic `Aborting`. The recorded detail now keeps the refusal itself
(`error: Your local changes to the following files would be overwritten by
checkout:`).
Closes #4809.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- The tally issue is a symptom report; the actionable defect is that its comment
  dropped the cause. Fixing the line selection makes the next failure
  diagnosable.
- Chosen over special-casing checkout text: the existing uninformative-line list
  already skips git's trailers, so the new lines join it.

### Essential Design Decisions

- Tab-indented lines (git's list of affected paths) and the
  `Please commit your changes or stash them before you switch branches|merge.`
  advice are skipped only when an informative line exists; otherwise the true
  last line is kept, as before.
- Lines are now matched on their trimmed form but only `trimEnd` is applied
  before the tab test, so the indentation is still visible to it; the chosen
  line is trimmed before it is redacted and bounded.

### Undiscoverable Facts

- The underlying cause of the #4658 setup abort (a local change blocking a
  checkout) is not reproduced here; this PR only restores the diagnostic text.

## Evidence

Command: `git checkout -B feature other` in a repository with a local edit to a
file that differs on `other` prints, on stderr,
`error: Your local changes to the following files would be overwritten by checkout:`,
a tab-indented path,
`Please commit your changes or stash them before you switch branches.` and
`Aborting`. The code depends on that shape; the first test builds it with the
real `git`.

## Reproduction

- **symptom** — a fast-failure comment read `setup after 26s: Aborting`, with no
  cause
- **status** — `verified` — the new tests fail against the base
  `repo_fast_failure_tracker.ts` (49 passed, 2 failed) and pass with the fix (51
  passed)
- **regression test** —
  `worker/deno/tests/repo_fast_failure_tracker_test.ts::diagnosticErrorLine - Git checkout's Aborting trailer preserves its cause`

## Test Plan

- `worker/deno/tests/repo_fast_failure_tracker_test.ts`: added
  `diagnosticErrorLine - Git checkout's Aborting trailer preserves its cause`
  (real git) and
  `diagnosticErrorLine - a refused merge keeps its cause, not the advice and Aborting`.
  Red check: base production file restored, both fail; fix restored, both pass.
  Merge-advice alternative removed would fail the second test.
- `deno task test:unit tests/repo_fast_failure_tracker_test.ts`: 51 passed, 0
  failed.
- Existing `diagnosticErrorLine` tests (last non-empty line, multi-line secret
  redaction, length bound) pass unchanged.
- Docs: `docs/CONFIGURATION.md` fast-failure paragraph now says the detail skips
  generic trailing lines such as `Aborting`.

- `./quality.sh`: every stage passed except `deno tests`, which failed only
  `worker/deno/tests/completion_phase_repo_formatters_test.ts` (lines 480 and
  567, Rust formatter). Neither this change nor its dependencies touch that
  file; I did not compare against `main`.

Not done: the cause of the #4658 abort itself is not investigated;
`deno task pr-summary-check` was not run.
