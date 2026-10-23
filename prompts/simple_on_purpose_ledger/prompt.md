# SIMPLE-ON-PURPOSE Ledger Audit

This is a report-only idle-task. It lists every `SIMPLE-ON-PURPOSE` marker in the repository's tracked non-Markdown text files (Markdown, binary, oversized, symlink and submodule-gitlink entries are skipped), with its ceiling (the limit the simple code accepts) and its upgrade condition (the event that should prompt a rewrite), and flags any marker that has no `upgrade when` clause.

## Who performs this audit

A native, deterministic scanner does the work. It reads the tracked non-Markdown text files, skips binary and oversized files, and reads each marker only when the keyword is the first token of a comment line. No language model runs for this task, and the worker takes no action on the repository. It never edits a file, never commits, and never opens a pull request.

## What the report contains

- Every marker in the scanned files, as `path:line`, with its ceiling and its upgrade condition.
- The markers missing an `upgrade when` clause, listed first, because a limit with no stated upgrade condition cannot be reviewed.
- A single report issue per repository. It is created when markers exist, refreshed in place when its content changes, and left alone when it is identical. When no markers exist and no report is open, nothing is filed.

## What a maintainer should do with it

Review the flagged markers first. For each one, either add an `upgrade when` clause that names the condition that should trigger the upgrade, or confirm that the simple version is still the right choice. Keep the marker's ceiling accurate when the code changes.

## Fail-loud contract

If the scan cannot run (the file list cannot be read, or a tracked file cannot be read), the run reports a failure and files nothing. An unreadable tree is never reported as an empty ledger.

{{ATTRIBUTION_FOOTER}}
