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
- `deno task test:unit tests/pre_push_gate_test.ts`: 53 passed, 0 failed.
  `tests/completion_phase_pre_push_gate_3689_test.ts`: 29 passed.
  `tests/completion_phase_repo_formatters_test.ts`: 8 passed.
- Callers checked: `runPrePushGate` and
  `formatBranchChanges`/`formatWorkerOwnedArchive` in `repo_formatters.ts` take
  the same list; their tests above pass. Docs: no manual describes the filter.
- Not covered by a test: the `could not resolve checkout` error branch (needs a
  candidate file with a vanished checkout, not stageable portably).
- `./quality.sh` on this head: every stage passed except `deno tests`, whose one
  failure is `tests/merge_fast_checks_credentials_4705_test.ts:101`
  (`spawnFastCheck`). It fails because this host's
  `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` variables appear in the expected argv.
  It does not touch `pre_push_gate.ts`; 33152 other tests passed. The serial
  pass did not run after that failure. Not re-run on a clean environment.
