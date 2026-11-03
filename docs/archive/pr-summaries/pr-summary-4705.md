## Summary

A repository's declared `quality_credentials` now reach the command that the
worker drops to the `agent` account. Before, they were only in the environment
handed to `sudo -n -u agent -- …`, which sudo's `env_reset` strips (the sudo
rule has no `SETENV`). One shared channel now serves every caller that runs a
repository command as `agent`: the quality gate (`spawnRepositoryCommand`), the
merge fast checks (`spawnFastCheck`) and the milestone merge/resolution gates
(`runRepositoryCommand`). The temporary "declared credential → run as the
worker" fallback in `untrusted_gate_spawn.ts` is removed. Version bump: no
`VERSION` change in this diff; the merged commit records the final version.
Closes #4705.

```mermaid
sequenceDiagram
    participant W as worker (Deno)
    participant S as sudo -n -u agent
    participant H as sh -c wrapper (agent)
    participant C as repository command
    W->>S: argv: sh -c WRAPPER … cmd (no secrets)
    W->>S: stdin: count, then NAME=base64 lines
    S->>H: env_reset strips the environment, stdin passes through
    H->>H: read, validate name, decode, export
    H->>C: exec cmd with stdin from /dev/null
    H-->>W: exit 78 + [vibe-credential-channel] line on any fault
```

## Spec

### Intent and Rationale

- `env_reset` discards the environment, argv is visible to `ps` and the sudo
  log, and a file would need an agent-readable path. A stdin pipe is the one
  channel that survives sudo, stays private and needs no new sudo grant.
- One module (`credential_channel.ts`) is called by all three callers, so
  there is a single transport and a single fault contract.

### Essential Design Decisions

- Only the repository's declared credentials are carried. The allowlist and
  `clearEnv` are unchanged; no `SETENV`/`env_keep` is granted; nothing of the
  worker's ambient GitHub/App credentials is added; no value is in argv, the
  wrapper text or any message (errors name the variable only).
- Values travel base64 encoded, so multi-line values, trailing newlines and
  shell metacharacters survive. The wrapper uses no `eval`, validates every
  name, and `exec`s the command with stdin from `/dev/null`. The quality gate
  refuses `stdin: "inherit"` together with declared credentials (nothing in
  `lib` does that today).
- A wrapper fault (exit 78 plus the marker line) is never a pass: the quality
  gate returns exit 1 with the fault line; the fast check throws, which the
  caller already maps to `unverified`; the milestone gates return
  `GateAccountUnavailable` (left to CI). A malformed declared name or a value
  with a NUL byte is refused before anything is spawned.
- With an available `agent` account a command always runs as `agent`. The
  worker account runs it only where the image has no `agent` account.

### Undiscoverable Facts

- A repository command that prints the marker and exits 78 itself is read as a
  channel fault. The effect is only "failed" (quality gate), "unverified" (fast
  check) or "left to CI" (milestone gates): it cannot turn a failure into a
  pass, and CI still runs the repository's own checks.
- This host has an `agent` account and a working `sudo -n -u agent`, so the
  real-sudo tests ran here; they return early on a host without one.

## Evidence

Backend change, no UI. The real `sudo -n -u agent` drop was exercised with
synthetic credentials:

- `sudo -n -u agent -- true` exits 0 on this host.
- Without the channel the declared variable is gone: the same command prints
  `|unset`. With it the command prints `synthetic-4705|unset` while an ambient
  `GH_TOKEN` handed to sudo is stripped.

The production implementation the sudo tests stand in for is the real sudo; the
property relied on (stdin passes through, the environment is reset) was
observed, not assumed. The wrapper's own fault contract is tested through a
real `sh`.

Docs: `docs/CONTAINER.md` ("The placement travels in argv…" bullet),
`docs/CONFIGURATION.md` (`quality_credentials` section), `SECURITY.md` (6b and
the R6 row), `docs/THREAT-MODEL.md` R6, `docs/mutation-check.md` ("Child
environment"; the mutation check runs as the worker and keeps the env route),
`docs/audits/security-sweep-1214-subprocess-argv.md` (the #4659 fallback prose).
Sibling names grepped: `carryEnvThroughSudo`, `untrustedQualityCommandEnv`,
`CARGO_TARGET_DIR`, `GateAccountUnavailable`.

## Acceptance Criteria

The issue states no `## Acceptance Criteria` list, so no reviewer was
dispatched. Every requirement in its reconciliation paragraph was done:

- Include the milestone gate callers as well as the quality gate and fast checks: done.
- One safe credential channel: `worker/deno/lib/credential_channel.ts`.
- Remove the credential-triggered fallback with an available untrusted account:
  done in `untrusted_gate_spawn.ts`.
- Allowlist and `clearEnv` preserved; no blanket SETENV; nothing in argv or
  logs; no ambient GitHub/App credentials: see Essential Design Decisions.
- Missing transport, mint failure or unavailable isolation is never a pass:
  fault tests below; a mint failure already fails the quality-gate phase
  (`runQualityGateCheck` Step 0) and parks the merge, unchanged.
- Synthetic credentials through a real dropped process plus negative checks for
  undeclared names: real-sudo tests below.

## Test Plan

- `worker/deno/tests/credential_channel_4705_test.ts` (module: argv shape, name
  and NUL refusals, byte-exact round trip through a real `sh`, wrapper faults,
  the `stdin` option of `runWithTimeout`/`commandOutputWithTimeout`, real sudo).
- `worker/deno/tests/quality_gate_credentials_4705_test.ts` (real sudo through
  `createDefaultDeps`, bad name, channel fault, no-marker and no-channel twins).
- `worker/deno/tests/merge_fast_checks_credentials_4705_test.ts` (argv and stdin,
  fault throws, no-marker twin, no credentials, real sudo).
- `worker/deno/tests/untrusted_gate_spawn_test.ts` (replaces the fallback test;
  agent account kept, decoded payload holds exactly the declared names, fault →
  `GateAccountUnavailable`, no-marker twin, invalid name, no credentials, two
  real-sudo tests).
- Ran from `worker/deno`: `deno task test:unit` over those files plus
  `quality_gate_phase_test.ts`, `untrusted_command_env_test.ts`,
  `merge_fast_checks_test.ts` (159 passed, 0 failed); `deno task
  check:manifests` passed; `deno fmt`, `deno lint`, `deno check` clean.
- Full `./quality.sh`: every stage passed except `deno tests` (parallel pass:
  32014 passed, 2 failed). The two failures are host-related and not from this
  diff: `babysitter default heartbeat resolves its checkout revision` (JSR
  download of `@std/crypto`) and `verifyResolvedTree - the repository's own task
  sees only the allowlisted environment (Issue #4659)` (the test's temp checkout
  is mode 700, so the `agent` probe cannot read it; it fails identically on the
  unmodified `0a4d803a`). The serial pass did not run after the parallel
  failure; CI runs it. The first gate run also needed a sweep-ledger entry
  (`docs/audits/lib-sweep-coverage/top-up-4705.json`) and no
  `Deno.env` mutation in the new tests (fixed; second run is clean for both).
- Red checks (break, run, restore): removing the `carryCredentialsThroughSudo`
  call in `quality_gate_phase.ts` → the real-sudo test and the bad-name test
  red; in `merge_fast_checks.ts` → the argv/stdin test and real-sudo test red;
  in `untrusted_gate_spawn.ts` → 4 tests red; making a declared credential
  return the un-dropped argv (the old fallback) → 5 tests red (the
  "account stays agent" test is the one that catches it); disabling the fault
  branch in `spawnRepositoryCommand` → the fault test red; dropping the
  wrapper's `export` line → the byte-exact and real-sudo tests red.
- Removed from `worker/deno/tests/untrusted_gate_spawn_test.ts` (test
  "declared credentials survive an available agent account", replaced):
  - Removed: `assertEquals(calls.length, 1)`; `assertEquals(final.executable, "/bin/sh")`;
    `assertEquals(result.value.stdout, "declared")`;
    `assertEquals(final.options.env?.NPM_TOKEN, "declared")`.
    Required by: "remove the credential-triggered fallback on hosts with an available untrusted account"
    (these asserted that the declared credential made the command run as the worker).
    Replaced by: `untrustedAccountOf` is `agent` for the final spawn; the decoded
    stdin payload holds the declared names; the real-sudo test prints
    `synthetic-4705|unset`.
  - Kept (moved into the new tests): `GH_TOKEN` absent from env, `clearEnv` true,
    no declared value in args, `result.ok` and exit code 0.
- Callers checked for the shared `untrustedSpawn`/`carryEnvThroughSudo` change:
  `spawnRepositoryCommand` (formatters stay un-dropped and keep the env route),
  `spawnFastCheck`, `runRepositoryCommand`; the mutation check and coverage
  carry-over run as the worker with no sudo (`docs/mutation-check.md`) and are
  unchanged.
- Rule applied to this PR's own diff: docs claims "never in argv", "only the
  declared credentials" were checked against `credential_channel.ts` and the
  three callers; nothing found.

## Known gaps

- `PROCESS_STATE_MUTATOR_TEST_FILES` is unchanged (still empty): the
  `Deno.env` mutation was removed from the new tests instead. As a result the
  quality-gate real-sudo test can no longer plant an ambient `GH_TOKEN` and
  asserts only the declared prefix; the merge fast-check and module tests do
  plant it through their spawn seam.
- The values are also in the environment handed to `sudo` itself (as they
  were); `env_reset` discards them there.
- Stdin `"inherit"` with declared credentials on the dropped quality-gate path
  is refused rather than supported.
