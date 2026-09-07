# Write `.config.json` owner-only from the add/remove repo paths

## Summary

`.config.json` is credential-bearing — `imgbb_api_key`, the GitHub App
identifiers, and the per-repo `repo_config` block — but the add-repo filesystem
deps wrote it with a bare `Deno.writeTextFile` (`worker/deno/lib/add_repo.ts`),
reached by both `addRepoToMonitoredList` and `removeRepoFromMonitoredList`. A
file created that way lands at the process umask default (0o644), and a
pre-existing 0o644 copy was never tightened, so any local account could read the
worker's API key.

Both writes now go through `atomicWrite` at mode `0o600`, the same hardened path
the canonical writer `setup/config_setup.ts:writeConfigFile` already uses. The
0o600 temp file is renamed over the target, so an already-loose file is
tightened rather than merely left alone. `commands/process_add_repo.ts` no
longer re-rolls its own `Deno.writeTextFile` — it reuses the exported
`defaultAddRepoFsDeps`, so there is one production write, not two. A write
failure still surfaces as `Failed to write <path>: …` rather than a silent
success.

`atomicWrite` derives its target directory from the last `/`, so the production
default config path `.config.json` (no directory component) is normalised to
`./.config.json` by the small exported `configWriteTarget` helper; without it
the add path would have broken outright.

Closes #1241.

## Evidence

Backend/CLI change with no web interface to screenshot. Evidence is the test
run: the three permission tests were observed failing against the unfixed write
and passing after the fix.

Red — `worker/deno/lib/add_repo.ts` reverted to `Deno.writeTextFile`:

```text
addRepoToMonitoredList - creates .config.json owner-only => FAILED
  [Diff] Actual / Expected
  -   420   (0o644)
  +   384   (0o600)
removeRepoFromMonitoredList - rewrites the config owner-only => FAILED
defaultAddRepoFsDeps - the production write is owner-only => FAILED
addRepoToMonitoredList - tightens a world-readable config => FAILED
```

Green — with the fix in place:

```text
deno task test tests/add_repo_test.ts
ok | 33 passed | 0 failed (112ms)

deno test tests/process_add_repo_test.ts tests/add_repo_process_issue_route_test.ts tests/add_repo_test.ts
ok | 55 passed | 0 failed (498ms)
```

Full gate: `./quality.sh` — `Result: PASSED (with skipped checks)`; semgrep,
deno lint, type check, fmt and the full test suite all PASSED.

### Original trigger is closed, with no trivial bypass

The trigger in the issue — an `add-repo: owner/name` issue on a host where
`.config.json` does not yet exist — now reaches `writeConfigSecurely`, which
creates the file `O_EXCL` at 0o600 and renames it into place, so the file is
never observable at the umask default. Every route into the config write is
covered: `addRepoToMonitoredList`, `removeRepoFromMonitoredList` and
`listMonitoredRepos` share the single `defaultAddRepoFsDeps` default, and
`commands/process_add_repo.ts` — the only caller that used to supply its own
write — now falls back to that same default. The `setup_cli.ts --add-repo` /
`--remove-repo` paths pass no deps at all, so they inherit it too. No production
call site constructs a bare `Deno.writeTextFile` for this file any more, and the
pre-existing-0o644 case is closed as well because the rename replaces the inode
rather than truncating it. Test-injected deps remain overridable, which is the
in-process test seam only and not an attacker-reachable path.

## Test Plan

Added to `worker/deno/tests/add_repo_test.ts` (all call real functions against a
real temp directory and assert on the resulting file mode):

- `worker/deno/tests/add_repo_test.ts::addRepoToMonitoredList - creates .config.json owner-only`
  — the regression test for the issue: it reproduces the flaw (file created at
  0o644), fails against the unfixed code and passes after the fix.
- `worker/deno/tests/add_repo_test.ts::addRepoToMonitoredList - tightens a world-readable config`
  — a pre-existing 0o644 config is narrowed to 0o600 while unknown keys survive;
  fails against the unfixed code, passes after the fix.
- `worker/deno/tests/add_repo_test.ts::removeRepoFromMonitoredList - rewrites the config owner-only`
  — the remove path gets the same mode; fails before, passes after.
- `worker/deno/tests/add_repo_test.ts::defaultAddRepoFsDeps - the production write is owner-only`
  — covers the shared default both `add_repo.ts` and `process_add_repo.ts` now
  use; fails before, passes after.
- `worker/deno/tests/add_repo_test.ts::addRepoToMonitoredList - an unwritable path fails loud`
  — a write into a missing directory returns `Failed to write …`, never a silent
  success.
- `worker/deno/tests/add_repo_test.ts::configWriteTarget - a bare filename names the current directory`
  — pins the `./` normalisation the production default path depends on.

No existing tests were modified or removed.
