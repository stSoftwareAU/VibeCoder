# PR Summary — Issue #5249

## Summary

`diagnosticErrorLine` now drops the worker's `### Diagnostics` heading and the
`- Key: value` bullets directly under it before it cuts its 20-line window. A
failure message built by `formatDetailedFailureMessage` with no last-output
block therefore records the failure reason, not a bullet such as
`- Clarity: clear`, as the fast-failure tally detail and the diagnostic issue's
"Last error". Closes #5249.

## Spec

### Intent and Rationale

- The issue's first suggested fix was taken: remove the block rather than add
  the bullets to `UNINFORMATIVE_LINE_PATTERNS`. A pattern such as `^- \w+:`
  would also skip a bullet in agent output or a tool's error list. Removing
  only the lines under the heading leaves every other bullet alone.

### Essential Design Decisions

- The heading text is one constant, `DIAGNOSTICS_HEADING`, exported from
  `worker/deno/lib/failure_message.ts`. The formatter writes it and the tracker
  matches it, so renaming the heading cannot silently undo this fix.
- The block is dropped before the window is cut, as git's path list is. If
  nothing is left after dropping it, the existing fallback to all lines still
  records the last line.
- A line that is not a `- ` bullet ends the block. When a last-output block
  follows, the snippet's last line is still chosen, as the #2590 and #2598
  tests require.

### Undiscoverable Facts

- The issue reports that the tally comment on #5237 read
  `execute after 2224s: - Clarity: assessed as clear`. The real cause was only
  in the release comment on #5169.

## Evidence

Backend-only change; no UI file is touched.

- `worker/deno/lib/repo_fast_failure_tracker.ts`: new
  `withoutDiagnosticsBlocks`, applied in `diagnosticErrorLine` with the
  path-line filter; the doc comment is updated.
- `worker/deno/lib/failure_message.ts`: `DIAGNOSTICS_HEADING` is exported, and
  `formatDetailedFailureMessage` writes it. The output is unchanged.
- `docs/CONFIGURATION.md`, Fast-failure repository back-off, "On every fast
  failure, on any host" bullet: one sentence now says the Diagnostics block is
  dropped. That bullet is reflowed to 80 columns. I read the rest of the
  section and found nothing else that describes how the detail line is chosen.
- `recordRepoFastFailure` is the only production caller of
  `diagnosticErrorLine` (`worker/deno/lib/repo_fast_failure_tracker.ts`).

Issue numbers the diff cites:

- #5249: Fast-failure tally records a diagnostics bullet ("- Clarity: ...")
  instead of the failure cause

## Test Plan

Five tests were added in `worker/deno/tests/repo_fast_failure_tracker_test.ts`.
No existing test was edited.

- `diagnosticErrorLine - with no last output the detail is the failure reason,
  not a Diagnostics bullet (Issue #5249)`: the issue's exact repro, built with
  the real formatter.
- `diagnosticErrorLine - a fuller Diagnostics block still yields the reason,
  not a bullet (Issue #5249)`: timeout, exit code, clarity and baseline note
  bullets.
- `recordRepoFastFailure - the stored detail is the reason above the
  Diagnostics block (Issue #5249)`: goes through the production entry point and
  asserts `lastDetail`.
- `diagnosticErrorLine - a bullet outside a Diagnostics block is still kept
  (Issue #5249)`: the negative control.
- `diagnosticErrorLine - a message that is only a Diagnostics block still
  records its last line (Issue #5249)`: the fallback branch.

Red against the unfixed code: the first three failed, for example
`-   - Clarity: clear` / `+   Claude timed out without creating changes`, and
the Note-bullet case returned
`- Note: quality checks had pre-existing failures before this run`. The last
two passed, as expected, because they pin behaviour the fix keeps.

After the fix:

- `deno test -A tests/repo_fast_failure_tracker_test.ts tests/failure_message_test.ts`:
  74 passed.
- The existing #2590 and #2598 tests (snippet after the block) still pass.
- `./quality.sh < /dev/null`: Result PASSED (with skipped checks). Config
  integration was skipped (no `.config.json`), and checkov was skipped (not
  installed on this host).

Not checked: a message carrying the kill-time process table (`killDiagnostics`)
still ends with a `ps` row, which this change does not address; the issue scoped
the fix to the Diagnostics block. No reviewers were dispatched, because the
issue has no acceptance-criteria list.
