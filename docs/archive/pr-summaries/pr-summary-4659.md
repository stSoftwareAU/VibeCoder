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
  <cmd>`
  and the values go on the child's stdin (`runWithTimeout`'s new `input`), so
  the process table (`hard_kill_evidence.ts`, `kill_diagnostics.ts`) never shows
  them. Without `sudo` they ride `Deno.Command`'s `env`. A mint failure refuses
  both gates. The command label is redacted (`commandLabel` on
  `runWithTimeout`). Callers `presyncMilestoneBranchForIssueRun` and
  `syncMilestoneBranchForSweep` pass `qualityCredentials` from `repoConfig`, and
  the sweep's rebuild gate (`rebuildGateForSweep`, PR #4344) resolves them with
  `rebuildGateWithCredentials` and refuses on a mint failure.
- Fail closed on an unusable checkout, as an environment fault (PR #4703 review,
  Issue #4697). When the command is dropped to `agent`, `runRepositoryCommand`
  first runs `test -r <cwd> -a -x <cwd> -a -r
  <cwd>/<manifest>` as that
  account. For `cargo` with no `CARGO_TARGET_DIR` (cargo then writes
  `<cwd>/target`) it also checks the account can write what cargo writes:
  `find <cwd>/target ! -writable -print -quit` must print nothing when `target`
  exists (an earlier worker-run gate leaves it owned by the worker, Issue
  #4113), else `test -w <cwd>`. A failed probe returns an
  `UnverifiableCheckoutError` and the command does not run. The two spawners map
  it to `unverifiable: true`, which `checkMergedTree` and `verifyResolvedTree`
  return as a `failed` outcome flagged `unverifiable`. The push is still refused
  (nothing was checked), but: `runGateWithRepair` offers no repair round (as for
  `toolchainGap`); `gateThenPushMilestoneBranch` raises
  `mergeGateUnverifiableError` instead of `mergeGateFailureError`; the
  resolution path sets `MilestoneConflictEscalation.unverifiable`; and
  `judgeSyncFailure` returns `not-charged` / `MERGE_GATE_COULD_NOT_CHECK_TREE`
  with no `refusal` flag for both. That reason is not in `climbsRecoveryLadder`
  and adds nothing to `refusedCycles`, so it never spends the conflict budget,
  counts toward the refusal ceiling or reaches the roll-back, rebuild or close
  rungs. The log still carries the cause, and a failure that does not clear
  takes the sync's existing non-conflict escalation. Milestone syncs on a host
  whose shared clone is not agent-readable stay unverified until #4697's access
  is fixed; running them as the worker instead would undo the isolation this
  issue asks for. The gates were not moved to a different checkout: the sweep,
  presync and rebuild gate all run in the shared clone by design.
- `spawnTask` and `spawnTypeCheck` are now exported with an optional `deps`
  argument, so tests can inject the runner and environment source.

### Undiscoverable Facts

- Run as `agent`, `deno check` over a directory `agent` cannot read exits 0 with
  "No matching files found", and `cargo` there reports no `Cargo.toml`. Lane
  worktrees are agent-readable (the quality gate relies on it); the shared
  `${workDir}/<repo>` clone may not be (Issue #4697), hence the readability
  probe above (and the unverifiable handling that follows it). A test fixture
  from `Deno.makeTempDir` (0700) is not readable either, so `withTempDir` in
  `milestone_merge_gate_test.ts` and `withTree` in
  `milestone_merge_only_4326_test.ts` chmod 0755.

## Evidence

Tests (all under `worker/deno/`):

- `tests/untrusted_gate_spawn_test.ts` (23 tests at head): covers
  `runRepositoryCommand`, `spawnTask` and `spawnTypeCheck`. The original cases
  plant `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` in the injected `source`
  (asserting they are there), then assert the child's `env` lacks them and
  `clearEnv` is true; also the `sudo -n -u agent --` wrapping, the no-account
  fallback, and result/timeout/spawn-failure mapping. Later rounds added the
  `cwd`, `timeoutMs`, injected `source` and `CARGO_TARGET_DIR` carry through
  `sudo` (`runRepositoryCommand` has optional `trimRefused` and `root` deps,
  tests only; production omits them), and the credential and probe cases below.
- Mutation check, re-run on the head by hand (each mutation applied to
  `untrusted_gate_spawn.ts`, the file run, then restored; `git diff` empty
  afterwards). Every one turned the file red:
  - final spawn `clearEnv: true` -> `false`: `13 passed | 8 failed`;
  - env call `repoCredentialEnv: deps.repoCredentialEnv ?? {}` -> `{}`:
    `19 passed | 2 failed`;
  - `cwd` deleted from the `untrustedQualityCommandEnv` call:
    `20 passed | 1 failed`;
  - `deps.source === undefined` ternary negated: `18 passed | 3 failed`;
  - `target === undefined` (`CARGO_TARGET_DIR`) ternary negated:
    `19 passed | 2 failed`;
  - `timeoutMs` deleted from the final spawn: `20 passed | 1 failed`;
  - `cwd` deleted from the final spawn: `20 passed | 1 failed`.
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
- Second PR #4703 review round (unverifiable, not charged):
  `tests/untrusted_gate_spawn_test.ts` types the probe error, asserts both gates
  return `unverifiable` (and the readable control does not), covers the cargo
  `target` probes (no `target`: `test -w <cwd>`; existing `target` with an
  unwritable entry: refused; none: runs; explicit `CARGO_TARGET_DIR`: no scan),
  and the manifest-task path of `verifyResolvedTree`.
  `tests/milestone_gate_repair_test.ts` asserts no repair round is offered.
  `tests/milestone_sync_merge_gate_test.ts` drives the real
  `syncMilestoneBranchWithDefault` for a clean merge and a resolved conflict:
  nothing pushed, branch reset, `judgeSyncFailure` returns `not-charged` with no
  `refusal`, and the same fixture refused by a real failing gate stays `failed`
  / `refusal: true`. Red checks, each applied alone then restored: dropping the
  `runGateWithRepair` guard, the `git_pull.ts` error choice, the
  `finalGate.unverifiable` hand-off, the `judgeSyncFailure` branch, the cargo
  probe condition, the `find` output check, and the `unverifiable` branches in
  `checkMergedTree` and `verifyResolvedTree` each turned a test red.
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
  `milestone_resolution_gate`, `milestone_merge_only_4326`,
  `subprocess_timeout`, `milestone_gate_credentials_wiring`,
  `milestone_presync_merge_only_4326`, `milestone_sweep_merge_only_4326` and
  `lib_sweep_coverage` tests: passed (118 parallel, 62 serial) in the earlier
  round. This round: `untrusted_gate_spawn`, `milestone_merge_gate`,
  `milestone_resolution_gate`, `milestone_gate_credentials_wiring`,
  `milestone_merge_only_4326`, `milestone_sync_refusal_ladder_4328`,
  `milestone_cargo_withhold_not_counted_4588`, `milestone_sync_gate_escalation`,
  `milestone_branch_sync`, `milestone_gate_repair` and
  `milestone_sync_merge_gate` passed. `deno fmt --check`, `deno lint`,
  `deno check` and `deno task check:manifests` (847 passed) pass.
- Edited tests: `tests/milestone_merge_gate_test.ts` `withTempDir` and
  `tests/milestone_merge_only_4326_test.ts` `withTree` gain `chmod 0o755`; no
  assertion removed. Edited expectations in `tests/untrusted_gate_spawn_test.ts`
  (`call.args.includes("DECLARED_TOKEN=…")` → `assertCredentialOffArgv`) still
  go red if the value returns to argv, because the helper scans every argv
  element. Without it, "real `deno check` rejects a broken tree" fails (red
  observed) because `agent` cannot read the fixture.
- Callers checked: `spawnTask` is the default of `runTask` in
  `checkResolvedTree`; `spawnTypeCheck` the default of `checkMergedTree`'s
  runner; both go through `runRepositoryCommand`. The other repository-code
  spawns (`spawnFastCheck`, quality gate, lock regen, bump-deps, pre-flight)
  already isolate the environment.
- Callers also checked for the new `runRepositoryCommand` probe: `spawnTask` and
  `spawnTypeCheck` pass their manifests (`manifestsFor`); no other caller.
  Callers of `runWithTimeout` are unchanged (`input` is optional).
- `./quality.sh` was not run in this round (see the note below); CI runs it.

<!-- vibe-quality-gate-skipped: full gate not run in the PR #4703 review round; targeted tests, check:manifests, markdownlint, fmt, lint and type check passed; CI runs the full gate -->
