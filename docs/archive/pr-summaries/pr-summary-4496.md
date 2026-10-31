## Summary

Run, cycle and host-failure callbacks now inherit the proxy variables
(`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and their lower-case forms) of the
process that spawns them. Run and cycle hooks run in the worker container, so
their `git clone` and `curl` go through the egress CONNECT proxy instead of
failing with `Could not resolve host`. The host-failure hook is spawned on the
host and gets the host launcher's own proxy variables, usually none. A proxy
value containing `@` is dropped. Closes #4496.

Version bump: no `VERSION` change in this PR; the merged commit records the
final version.

## Spec

### Intent and Rationale

- Hooks start from a cleared environment, and the container has no DNS by
  design, so without the proxy variables every hook that reaches GitHub fails.
- One shared `inheritedEnv` replaces the three identical copy loops
  (`buildCallbackEnv`, `buildCycleCallbackEnv`, `buildHostFailureEnv`), so the
  `@` check cannot be missed on one of them.

### Essential Design Decisions

- The `@` check applies to all six proxy names, including `NO_PROXY`, as the
  issue says "drop any value that contains `@`". A dropped value is omitted
  whole, never rewritten.
- Cycle and host-failure hooks share the same inheritance code as run hooks
  (`INHERITED_ENV_VARS` already covered all three). The cycle hook runs in the
  worker container (`runCycleCallback` in `run_core_production_deps.ts`), so it
  gets the egress proxy. The host-failure hook is spawned on the host, before a
  container exists (`checkout_update.ts`, `container_restart_backoff.ts`), so it
  inherits whatever proxy variables the host launcher has set, usually none; the
  egress proxy variables exist only in the container environment
  (`container_launch.ts` `workerEnv`).
- Additive only: `CALLBACK_SCHEMA_VERSION` is unchanged.

### Undiscoverable Facts

- None.

## Evidence

Backend only; no UI files touched.

- `worker/deno/lib/run_callbacks.ts`: `PROXY_ENV_VARS`, `INHERITED_ENV_VARS`,
  `inheritedEnv`. `worker/deno/lib/host_failure_hook.ts` calls it.
- Docs read and updated: `docs/CALLBACKS.md` ("What the hook receives" for the
  host-failure hook, "What a hook receives", and the "Do not assume" bullet) and
  `docs/CONFIGURATION.md` ("What a hook receives"). `docs/CALLBACKS.md` "cleared
  environment" and "inherits none of the worker's credential plumbing" were read
  and are still true.
- Callers of the changed loops: all three env builders above; no other code
  reads `INHERITED_ENV_VARS` except the tests.

## Reproduction

- **symptom** — `[grq:success] ... Could not resolve host: github.com` from
  every hook clone under egress containment.
- **status** — `partial` — the missing environment is reproduced at the unit
  level; a real clone through the proxy was not run.
- **reason** — the failure needs the containment network and the proxy
  container. The new tests fail against base `inheritedEnv`-less code because
  the proxy names never reach the hook environment.
- **regression test** —
  `worker/deno/tests/run_callbacks_test.ts::run_callbacks - proxy variables reach the hook as the worker set them (Issue #4496)`

## Test Plan

- `worker/deno/tests/run_callbacks_test.ts`: proxy reaches the run hook and the
  cycle hook unchanged; userinfo proxies are dropped for both, with `PATH` and
  `NO_PROXY` still crossing (positive control) and the secret text absent from
  every value.
- `worker/deno/tests/host_failure_hook_test.ts`: the same two cases for
  `buildHostFailureEnv`.
- `worker/deno/tests/run_callbacks_integration_test.ts`: the spelled-out
  allowlist of the "no worker credential reaches the hook environment" test now
  names the six proxy names. Removed from it: the five-name allowlist literal
  `["PATH", "HOME", "LANG", "TZ", "TMPDIR"]`. Required by: "Add `HTTPS_PROXY`,
  `HTTP_PROXY`, `NO_PROXY` and their lower-case forms to the inherited set".
  Replaced by: the same list plus the six names; the test still fails on any
  other leaked name.
- Mutation check (`run_callbacks.ts:119`, `PROXY_ENV_VARS.includes(name)`
  replaced with `true`): killed by
  `run_callbacks - the userinfo check applies to proxy names only (Issue #4496)`,
  which passes a `PATH` containing `@` and expects it to cross unchanged.
- Red checks: the `@` condition forced false → the userinfo tests fail (run,
  cycle and host-failure); the proxy names removed from `INHERITED_ENV_VARS` → 6
  tests fail.
- Distinct fixture values (PR #4534 review): in `run_callbacks_test.ts` and
  `host_failure_hook_test.ts` each of the six names has its own value (different
  ports for the four URL names, different host lists for `NO_PROXY` and
  `no_proxy`). Red check: `inheritedEnv` reading `readEnv(name.toUpperCase())` →
  the run, cycle and host-failure pass-through tests fail; restored.
- `deno task test:unit`, each file run on the head: `run_callbacks_test.ts` (35
  tests at head), `host_failure_hook_test.ts` (23 tests at head) and
  `run_callbacks_integration_test.ts` (10 tests at head): all passed, 0 failed.
  `deno fmt` on the touched files: clean.
