# Issue #2141 — state the installed provider set in the per-run override case

## Summary

`agent_provider_test.ts::agent provider - the per-run provider override beats
the configured file value (Issue #2062)` called
`resolveAgentProviderId({ configured: "claude" })` with no `env`, so the
resolver read the ambient `VIBE_IMAGE_AGENT_PROVIDERS` stamp and the startup
guard (`assertImageInstalledProvider`) threw on any image that installed only
`claude`. The case then asserted "which agent CLIs this host's image happens to
carry" rather than "the override beats the configured value", keeping
`./quality.sh` red on every single-provider worker image.

The case now states the installed set with `envFrom` from
`tests/support/env_lookup.ts` — the same shape #1977 applied to
`provider_auto_runtime_test.ts` and #2086 to `config_test.ts`. Test-only
change: no production code path is touched, and the guard it used to trip is a
real one that stays in force. No `Deno.env.set`, which is parallel-unsafe.

Closes #2141.

## Evidence

Backend/CLI change with no web interface to screenshot. Evidence is the test
run, before and after, under a single-provider image stamp:

Before (unfixed code, `VIBE_IMAGE_AGENT_PROVIDERS=claude`):

```
agent provider - the per-run provider override beats the configured file value (Issue #2062) ... FAILED (1ms)
error: Error: The running container image did not install the "deepseek" coding-agent provider. Installed: claude. Rebuild the image with AGENT_PROVIDERS including "deepseek".
    at assertImageInstalledProvider (worker/deno/lib/agent_provider.ts:1359:9)
FAILED | 0 passed | 1 failed | 32 filtered out (7ms)
```

After (same command, whole file):

```
agent provider - the per-run provider override beats the configured file value (Issue #2062) ... ok (37µs)
ok | 33 passed | 0 failed (14ms)
```

The file also passes with no stamp set at all (`ok | 33 passed | 0 failed`), so
the case is now independent of the host image either way.

## Reproduction

- **symptom** — the per-run override case failed inside any container image
  that installed only `claude`, because the resolver read the ambient image
  stamp instead of a stated one
- **status** — `verified` — reproduced red with
  `VIBE_IMAGE_AGENT_PROVIDERS=claude deno test --allow-all --filter "per-run provider override" tests/agent_provider_test.ts`
  against the unfixed case, and green with the same command after the fix
- **regression test** —
  `worker/deno/tests/agent_provider_test.ts::agent provider - the per-run provider override beats the configured file value (Issue #2062)`

## Test Plan

- Modified
  `worker/deno/tests/agent_provider_test.ts::agent provider - the per-run
  provider override beats the configured file value (Issue #2062)` — both
  `resolveAgentProviderId` calls now pass a stated `env` listing
  `claude,deepseek`.
- Ran `deno test --allow-all tests/agent_provider_test.ts` with and without
  `VIBE_IMAGE_AGENT_PROVIDERS=claude` — 33 passed, 0 failed in both.
- Ran `deno fmt`, `deno lint` and `deno check` on the file, plus the full
  `./quality.sh`.
