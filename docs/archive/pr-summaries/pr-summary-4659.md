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
- Declared `quality_credentials` are resolved at the gate only
  (`syncWithMergeOnlyBindings` calls `resolveRepoCredentials` per gate run, so a
  sync that needs no check mints nothing) and passed as
  `UntrustedGateSpawnDeps.repoCredentialEnv`. `runRepositoryCommand` validates
  each name and adds the values to the allowlist. Under `sudo`, whose
  `env_reset` would drop them, they never touch argv: the command becomes
  `sudo -n -u agent -- sh -c '<read NAME=base64 lines, export, exec "$@">' sh
  <cmd>` and the values go on the child's stdin (`runWithTimeout`'s new
  `input`), so the process table (`hard_kill_evidence.ts`,
  `kill_diagnostics.ts`) never shows them. Without `sudo` they ride
  `Deno.Command`'s `env`. A mint failure refuses both gates. The command label
  is redacted (`commandLabel` on `runWithTimeout`). Callers
  `presyncMilestoneBranchForIssueRun` and `syncMilestoneBranchForSweep` pass
  `qualityCredentials` from `repoConfig`, and the sweep's rebuild gate
  (`rebuildGateForSweep`, PR #4344) resolves them with
  `rebuildGateWithCredentials` and refuses on a mint failure.
- Fail closed on an unreadable checkout (PR #4703 review, Issue #4697). When
  the command is dropped to `agent`, `runRepositoryCommand` first runs
  `test -r <cwd> -a -x <cwd> -a -r <cwd>/<manifest>` as that account and
  returns an error (so `checkMergedTree` and `verifyResolvedTree` report
  `failed`) if it fails, instead of running a check that cannot see the tree.
  On a host where the shared clone is not agent-readable, milestone syncs are
  refused until that access is fixed; running them as the worker instead would
  undo the isolation this issue asks for.
- `spawnTask` and `spawnTypeCheck` are now exported with an optional `deps`
  argument, so tests can inject the runner and environment source.

### Undiscoverable Facts

- Run as `agent`, `deno check` over a directory `agent` cannot read exits 0 with
  "No matching files found", and `cargo` there reports no `Cargo.toml`. Lane
  worktrees are agent-readable (the quality gate relies on it); the shared
  `${workDir}/<repo>` clone may not be (Issue #4697), hence the readability
  probe above. A test fixture from `Deno.makeTempDir` (0700) is not readable
  either, so `withTempDir` in `milestone_merge_gate_test.ts` and `withTree` in
  `milestone_merge_only_4326_test.ts` chmod 0755.

## Evidence

Tests (all under `worker/deno/`):

- `tests/untrusted_gate_spawn_test.ts`: nine cases covering
  `runRepositoryCommand`, `spawnTask` and `spawnTypeCheck`. Each plants
  `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` in the injected `source` (asserting
  they are there), then asserts the child's `env` lacks them and `clearEnv` is
  true; also the `sudo -n -u agent --` wrapping, the no-account fallback, and
  result/timeout/spawn-failure mapping.
- Mutation check (follow-up): three further cases in the same file pin the
  `cwd`, `timeoutMs`, injected `source` and the `CARGO_TARGET_DIR` carry through
  `sudo`; `runRepositoryCommand` gained optional `trimRefused` and `root` deps
  (tests only; production omits them) so the ephemeral placement is reachable.
  Each mutation was applied by hand and turned the file red: deleted `cwd` on
  the env call (line 60), negated `source` ternary (62), negated `target`
  ternary (67), deleted `cwd` (70) and `timeoutMs` (71) on the spawn.
- `worker/deno/lib/untrusted_gate_spawn.ts:61` exempt (untestable): deleting
  `repoCredentialEnv: {}` is an equivalent mutant, because the callee spreads
  `undefined` into the overlay as a no-op; the property is only there to satisfy
  the required type.
- Red check: with `clearEnv: true` flipped to `false` in
  `untrusted_gate_spawn.ts`, the file goes `2 passed | 7 failed`.
- Credential follow-up (head `c3d17dee`): `tests/untrusted_gate_spawn_test.ts`
  adds a test that declared credentials reach both gates and a mint failure
  refuses both, one that they cross `sudo` while undeclared ones stay out, and
  one that both gates forward them to every task including merge-only;
  `tests/subprocess_timeout_test.ts` pins the redacted label in a timeout
  diagnostic; `tests/milestone_merge_only_4326_test.ts` covers the merge-only
  binding.
- PR #4703 review round (credentials, unreadable clone, rebuild gate):
  `tests/untrusted_gate_spawn_test.ts` now asserts no argv element holds a
  credential value while the child still receives it (env, plus stdin under
  sudo), runs the real `sh` wrapper to prove it delivers spaces, newlines, an
  empty value and non-ASCII exactly, pins the probe argv, and asserts neither
  `checkMergedTree` nor `verifyResolvedTree` reports `passed` when the probe
  fails even though the fake check would exit 0 with "No matching files found"
  (control: the same fixture passes when the probe succeeds).
  `tests/milestone_gate_credentials_wiring_test.ts` runs a real Deno `check`
  that needs a minted token through the presync, the sweep and the rebuild gate
  (control: no declared credentials fails), plus a mint failure refusing the
  rebuild gate. `tests/subprocess_timeout_test.ts` covers `input`. Red checks:
  deleting the `qualityCredentials` line in the sweep, in the presync, or the
  credential env in the rebuild gate each turns its wiring case red; skipping
  the probe turns three cases red.
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
- `#4697`: Merge-conflict pre-push checks (#4616) refuse base merges in a Cargo
  repo: cargo fmt run as agent reports no Cargo.toml in the clone...

## Test Plan

- `deno task test:unit` over `untrusted_gate_spawn`, `milestone_merge_gate`,
  `milestone_resolution_gate`, `milestone_merge_only_4326`, `subprocess_timeout`,
  `milestone_gate_credentials_wiring`, `milestone_presync_merge_only_4326`,
  `milestone_sweep_merge_only_4326` and `lib_sweep_coverage` tests: passed
  (118 parallel, 62 serial). `deno fmt --check`, `deno lint`, `deno check` and
  `deno task check:manifests` (847 passed) pass.
- Edited tests: `tests/milestone_merge_gate_test.ts` `withTempDir` and
  `tests/milestone_merge_only_4326_test.ts` `withTree` gain `chmod 0o755`; no
  assertion removed. Edited expectations in `tests/untrusted_gate_spawn_test.ts`
  (`call.args.includes("DECLARED_TOKEN=…")` → `assertCredentialOffArgv`) still go
  red if the value returns to argv, because the helper scans every argv element. Without it, "real `deno check` rejects a
  broken tree" fails (red observed) because `agent` cannot read the fixture.
- Callers checked: `spawnTask` is the default of `runTask` in
  `checkResolvedTree`; `spawnTypeCheck` the default of `checkMergedTree`'s
  runner; both go through `runRepositoryCommand`. The other repository-code
  spawns (`spawnFastCheck`, quality gate, lock regen, bump-deps, pre-flight)
  already isolate the environment.
- Callers also checked for the new `runRepositoryCommand` probe: `spawnTask`
  and `spawnTypeCheck` pass their manifests (`manifestsFor`); no other caller.
  Callers of `runWithTimeout` are unchanged (`input` is optional).
- `./quality.sh` was not run in this round (see the note below); CI runs it.

<!-- vibe-quality-gate-skipped: full gate not run in the PR #4703 review round; targeted tests, check:manifests, markdownlint, fmt, lint and type check passed; CI runs the full gate -->
