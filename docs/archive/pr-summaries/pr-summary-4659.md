## Summary

The milestone resolution gate (`spawnTask`) and merge gate (`spawnTypeCheck`)
ran the repository's own tasks (`deno task`, `bash quality.sh`, `cargo check`,
`cargo test`) with the worker's whole inherited environment. Both now call one
new function, `runRepositoryCommand` in
`worker/deno/lib/untrusted_gate_spawn.ts`, which builds the child environment
with `untrustedQualityCommandEnv`, passes `clearEnv: true`, and wraps the argv
with `untrustedSpawn` so the command runs as the `agent` account where the image
provides one. Closes #4659.

Version bump: no `VERSION` change in this diff; the merged commit records the
final version.

## Spec

### Intent and Rationale

- Code from merged PR branches must not see worker credentials (SEC-1214-02);
  the two milestone gates were missed by that sweep. One shared function keeps
  the two spawns from drifting apart.

### Essential Design Decisions

- Unlike `spawnFastCheck`, `runRepositoryCommand` does not throw when the
  `agent` account is unavailable: it falls back to the worker account with the
  allowlisted environment, because the issue says "where the image provides one"
  and `untrustedSpawn` already logs the `[SECURITY]` degradation.
- Declared `quality_credentials` are not threaded to the milestone sync path
  (`repoCredentialEnv: {}`), so a task needing one fails instead of inheriting
  the worker's environment. Assumption: threading them is a wider change than
  the issue asks for.
- `spawnTask` and `spawnTypeCheck` are now exported with an optional `deps`
  argument, so tests can inject the runner and environment source.

### Undiscoverable Facts

- Run as `agent`, `deno check` over a directory `agent` cannot read exits 0 with
  "No matching files found". Production checkouts are agent-readable (the
  quality gate relies on it), but a test fixture from `Deno.makeTempDir` (0700)
  is not, so `withTempDir` in `milestone_merge_gate_test.ts` now chmods 0755.

## Evidence

Tests (all under `worker/deno/`):

- `tests/untrusted_gate_spawn_test.ts`: nine cases covering
  `runRepositoryCommand`, `spawnTask` and `spawnTypeCheck`. Each plants
  `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` in the injected `source` (asserting
  they are there), then asserts the child's `env` lacks them and `clearEnv` is
  true; also the `sudo -n -u agent --` wrapping, the no-account fallback, and
  result/timeout/spawn-failure mapping.
- Red check: with `clearEnv: true` flipped to `false` in
  `untrusted_gate_spawn.ts`, the file goes `2 passed | 7 failed`.
- `docs/audits/lib-sweep-coverage/top-up-4659.json` claims the new module for
  the lib sweep ledger; `deno task check:manifests` passes (847 passed).
- Doc: `docs/audits/security-sweep-1214-subprocess-argv.md` gains a follow-up
  paragraph under SEC-1214-02.

Issue numbers cited as provenance, each looked up with `gh issue view`:

- `#571`: The coding agent runs as the worker's own uid...
- `#572`: Credentials are in the environment when third-party code runs...
- `#1214`: Security sweep chunk 12a: subprocess and argv construction...
- `#2247`: On a trim-refused runtime, put build artefacts and caches on the
  ephemeral container layer...

## Test Plan

- `deno task test:unit tests/untrusted_gate_spawn_test.ts
  tests/milestone_merge_gate_test.ts tests/milestone_resolution_gate_test.ts`:
  passed (38 parallel, 39 serial).
- `deno task test:unit tests/lib_sweep_coverage_test.ts`: 39 passed.
- Edited test: `tests/milestone_merge_gate_test.ts` `withTempDir` gains
  `chmod 0o755`; no assertion removed. Without it, "real `deno check` rejects a
  broken tree" fails (red observed) because `agent` cannot read the fixture.
- Callers checked: `spawnTask` is the default of `runTask` in
  `checkResolvedTree`; `spawnTypeCheck` the default of `checkMergedTree`'s
  runner; both go through `runRepositoryCommand`. The other repository-code
  spawns (`spawnFastCheck`, quality gate, lock regen, bump-deps, pre-flight)
  already isolate the environment.
- `./quality.sh`: the first run's only failures were the lib-sweep ledger (fixed
  and re-verified above); the rerun passed every stage up to `deno tests` and
  then exceeded the 590 s command cap before finishing, so the final full gate
  did not complete.

<!-- vibe-quality-gate-skipped: full gate exceeded the 590 s command cap after the ledger fix; targeted tests, check:manifests, markdownlint, fmt, lint and type check passed; CI runs the full gate -->
