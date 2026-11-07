## Summary

`container/entrypoint.sh` no longer follows symbolic links when it grants the `vibework` group over the work root. The `*/` glob matches a symlink to a directory, and `chgrp`/`chmod` follow it, so the untrusted `agent` account could plant a link to a worker-owned directory (`.container-state`, the session store) and have it made group-writable on the next launch. The loop now skips symlinks, and, unless running as root, entries the worker does not own. Closes #4759.

## Spec

### Intent and Rationale

- Closes the hole that undid the reserved-name protection from Issue #1384: the walk's reserved list works on names, but a link under a non-reserved name bypassed it.
- Skipping at the top of the loop leaves the clone, reserved-name and quarantine logic untouched.

### Essential Design Decisions

- The ownership skip uses bash `-O` (effective uid) and is bypassed when `id -u` is 0, because a root entrypoint legitimately re-grants worker-owned clones. For a non-root worker the skip changes nothing in practice: `chgrp`/`chmod` on an entry it does not own already failed silently.
- Residual: a link swapped in between the check and the `chgrp` is a race the shell cannot close; the work root's sticky bit stops `agent` replacing entries it does not own, which bounds it.

### Undiscoverable Facts

- `tests/work_root_group_grant_test.ts` is in the integration manifest, so `deno task test:unit` skips it; run it with `deno task test`.

## Evidence

Backend/shell change only; no UI. The new test runs the real entrypoint against a work root holding a link to `.container-state` and a link to `audit`.

## Test Plan

- Added `worker/deno/tests/work_root_group_grant_test.ts::entrypoint - a symlink in the work root does not get its target's group or mode changed (Issue #4759)`. The `chgrp` stub now logs its arguments, and `runEntrypoint` takes an optional `plant` hook. Existing call sites are unchanged.
- Red check: with the `[[ -L "${entry%/}" ]] && continue` line removed, the test fails (`.container-state was changed through a symlink in the work root`); restored, it passes.
- `deno task test tests/work_root_group_grant_test.ts`: 18 passed, 0 failed. `deno task test tests/container_entrypoint_test.ts`: 43 passed, 0 failed. `bash -n container/entrypoint.sh`, `deno fmt --check` and `deno lint` clean.
- `container/entrypoint.sh` ownership-skip (`! -O`): `exempt (untestable)`: the check reads the real euid, the `id` stub cannot affect it, and a foreign-owned directory cannot be created without root. Harness searched: `grep -ln entrypoint worker/deno/tests` finds `work_root_group_grant_test.ts` and `container_entrypoint_test.ts`, and neither can stage a foreign owner as uid 1000.
- `./quality.sh`: ran twice; both runs passed every stage up to and including `release-tag ruleset` (formatting, lint, type checks, completeness, mermaid, markdownlint, semgrep), then hung in the stage after it until the 400 s and 600 s timeouts killed it. No stage failed.

<!-- vibe-quality-gate-skipped reason="quality.sh hung past its timeout after the release-tag ruleset stage; all earlier stages passed; the worker runs the gate again before the PR is raised" -->
