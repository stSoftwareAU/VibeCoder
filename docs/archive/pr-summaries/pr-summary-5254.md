## Summary

`worker/deno/tests/pre_push_gate_test.ts` ran its fixture `git` calls under
the host's git config, so each fixture `git push` ran the host's `pre-push`
hook over the fixture repository. Those calls now run cut off from host config
and hooks. Closes #5254.

## Spec

### Intent and Rationale

- On a fleet container the host hook arrives through environment variables
  (`GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=core.hooksPath`). `git config
  --show-origin` reports it as `command line`, not as a global file. Setting
  `GIT_CONFIG_GLOBAL=/dev/null` alone, as the issue suggests, would leave the
  hook in place. The fix also sets `GIT_CONFIG_COUNT=0`, as
  `NO_HOST_GIT_CONFIG` does in `git_push_preflight_test.ts`.

### Essential Design Decisions

- A file-local `NO_HOST_GIT_CONFIG` env (`GIT_CONFIG_COUNT=0`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`) goes to the `git`
  helper and to the four raw `git` runners the `listPushedFiles` tests pass in.
  Deno merges it with the parent env, so `PATH` survives.
- `GIT_ENV` also carries `-c core.hooksPath=/dev/null`, so the fixtures run no
  hook from any config source. The fixtures are isolated in the helper, not
  push by push, so a future fixture push cannot miss it. The one push that
  already used `--no-verify` is unchanged.
- Production code under test (`runPrePushGate`'s own git and tool runners) is
  unchanged.

### Undiscoverable Facts

- The hook injection is visible on this container: `env | grep ^GIT_CONFIG`
  shows `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=core.hooksPath` and
  `GIT_CONFIG_VALUE_0=/tmp/vibe-pre-push-…/hooks`.

## Evidence

Test-only change; no UI files.

- Observed: `GIT_CONFIG_COUNT=0 GIT_CONFIG_GLOBAL=/dev/null
  GIT_CONFIG_NOSYSTEM=1 git -c core.hooksPath=/dev/null config --get
  core.hooksPath` prints `/dev/null` in a fresh repository, with the host's
  `GIT_CONFIG_KEY_0=core.hooksPath` still set in the parent env.
- Base failure, quoted from the run of the unchanged file:
  `[PRE_PUSH_BLOCKED] Pre-flight gate BLOCK (Issue #3577): command
  '/usr/local/bin/markdownlint-cli2' --no-globs 'README.md' failed with exit
  code 1`, then `README.md:1:1 error MD018/no-missing-space-atx`, thrown from
  the `git` helper during a fixture push.

## Test Plan

No test was added. The change itself makes the existing file independent of
the host. No assertion or fixture content was changed.

- Before (base `5be66720e`, run directly on this container with the host hook
  env in place): `deno test -A tests/pre_push_gate_test.ts` reported
  `170 passed | 43 failed`. Every failure was the host hook blocking a fixture
  push.
- After (head, same container, same env): `213 passed | 0 failed`.
- `deno fmt`, `deno lint` and `deno check` on the file: clean.
- `./quality.sh < /dev/null`: `Result: PASSED (with skipped checks)`. Config
  integration was skipped (`deno or .config.json not available`), and so was
  checkov (no checkov on PATH).
- Docs: the `CODING-STANDARDS.md` section "Never let a unit test inherit the
  host's state" was read through. It names no git specifics, and the change
  makes nothing in it false, so no doc was changed.

Not done: none of the other test files that spawn `git` were audited for the
same leak, because the issue names this file only.
