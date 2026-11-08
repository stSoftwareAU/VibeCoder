## Summary

`listPushedFiles` now skips any pushed path that resolves outside the checkout
through a symlinked parent directory, so `deno fmt`, `deno lint`,
`markdownlint-cli2` and `cspell` no longer run on files outside the repository.
Closes #4909.

## Spec

### Intent and Rationale

- `Deno.lstat` only refuses a symlink in the last path component. A directory
  replaced by a symlink in a later commit left `dir/file.json` listed, and it
  resolved outside the checkout.
- Requiring `realPath(cwd/name) === realPath(cwd) + "/" + name` is the issue's
  second suggested form and covers every ancestor in one call.

### Essential Design Decisions

- `realPath(cwd)` is resolved once, so a checkout that itself sits under a
  symlink (for example `/tmp` on macOS) is not wrongly rejected.
- An unresolvable checkout returns an `Err` naming the cause rather than an
  empty list. An empty candidate set returns early, as before, without touching
  the filesystem.

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI. New test
`worker/deno/tests/pre_push_gate_test.ts::listPushedFiles: a file behind a directory later replaced by a symlink is skipped (#4909)`
commits `dir/file.json`, then replaces `dir` with a symlink to an outside
directory holding `file.json`. Against the unfixed code it failed with
`dir/file.json` still listed; with the fix it lists only `README.md` and
`keep/ok.md`.

## Test Plan

- Added the test above (red on base, green on head). `keep/ok.md` is the
  positive control that nested real files still list.
- `worker/deno/tests/pre_push_gate_test.ts::listPushedFiles: a symlinked checkout retains real files and skips escaping paths (#4909)`
  checks both ordinary files and an escaping path through a symlinked checkout.
  Replacing `realCwd` with `cwd` in the comparison makes this test fail.
- `tests/completion_phase_pre_push_gate_3689_test.ts`: 29 passed.
  `tests/completion_phase_repo_formatters_test.ts`: 8 passed.
- Callers checked: `runPrePushGate` and
  `formatBranchChanges`/`formatWorkerOwnedArchive` in `repo_formatters.ts` take
  the same list; their tests above pass. Docs: no manual describes the filter.
- Added
  `listPushedFiles: an unresolvable checkout returns an Err naming the
  cause (#4909)`:
  a fake git lists `README.md` for a checkout path that does not exist, and the
  test asserts `ok: false` with the exact
  `could not resolve checkout ...: <realPath error message>` text. This kills
  the mutation check's three survivors at `pre_push_gate.ts:222` (`false` ->
  `true`, deleted `ok`) and `:224` (negated `instanceof Error` ternary).
- `deno task test:unit tests/pre_push_gate_test.ts`: 55 passed, 0 failed.
- On the merged tree, formatting, lint, type checking, markdownlint and
  completeness checks passed. The full unit suite could not complete: Deno
  panicked in its parallel test runtime on two attempts. The local quality gate
  also timed out probing Checkov and skipped unavailable Semgrep. The base
  merge's PR #4914 passed its GitHub checks; CI will run on the pushed head.
