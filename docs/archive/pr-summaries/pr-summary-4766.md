## Summary

Added the subscription-first babysitter provider chooser, DeepSeek paid overflow,
and the spending policy documentation. The full quality gate is still red on an
unchanged launcher harness timing check. Part of #4766.

## Spec

### Intent and Rationale

- Babysitter repairs need the subscription quota ranking while preserving the
  worker's separate auto-mode wait policy.

### Essential Design Decisions

- Automatic selection reuses `refreshAutomaticProviderRouting`; DeepSeek is
  built through the existing provider credential export and child-environment
  filter.
- Config reads, status resolution, credential export, environment reads and
  logging are injected for deterministic tests.

### Undiscoverable Facts

- The owner confirmed this babysitter-only paid overflow exception in #4766.
- The shared launcher mounts the staged config and passes
  `CONFIG_PATH=<mounted config>/.config.json`; the babysitter run-argument
  adapter preserves the config mount and environment argument. The chooser test
  also asserts it reads the injected mounted path.
- This change adds the chooser seam only; no production caller currently calls
  it, consistent with the task's scope boundary around babysitter command
  orchestration.

## Evidence

Backend-only change. The chooser tests exercise selection, overflow logging,
credential isolation and configuration pins.

### Deno regression avoided

- Implemented in Deno TypeScript without adding Node tooling or dependencies.

## Acceptance Criteria

- **met** — Test: in auto mode with one subscription that has quota, it selects that subscription, logs a line starting `[quota] automatic provider selected=`, and returns `overflow: false`. — evidence: `worker/deno/tests/babysitter_provider_choice_4738_test.ts::babysitter auto mode chooses a subscription with quota and logs runtime selection`
- **met** — Test: in auto mode with two subscriptions, it selects the one with more quota remaining. — evidence: `worker/deno/tests/babysitter_provider_choice_4738_test.ts::babysitter auto mode ranks subscriptions by remaining quota`
- **met** — Test: in auto mode with every subscription exhausted, it selects `deepseek`, returns `overflow: true` and the DeepSeek child env, and logs the `babysitter paid overflow` line naming each exclusion reason. — evidence: `worker/deno/tests/babysitter_provider_choice_4738_test.ts::babysitter auto mode uses isolated DeepSeek env only after all subscriptions exhaust`
- **met** — Test: the same fixture with one subscription restored never selects DeepSeek. — evidence: `worker/deno/tests/babysitter_provider_choice_4738_test.ts::restored subscription quota keeps babysitter off DeepSeek`
- **met** — Test: exhausted subscriptions with no DeepSeek credential throw with that cause. — evidence: `worker/deno/tests/babysitter_provider_choice_4738_test.ts::exhausted subscriptions without a DeepSeek credential fail with the cause`
- **met** — Test: pinned mode returns the pinned provider and never calls the DeepSeek export. — evidence: `worker/deno/tests/babysitter_provider_choice_4738_test.ts::configured pinned mode returns the configured provider without probing or overflow`; environment-pin and missing-config pin cases are also covered.
- **met** — The existing `provider_auto_runtime` and `review_round` tests pass unchanged. — evidence: targeted combined unit run passed 44 tests.
- **met** — The `DESIGN-PRINCIPLES.md` section exists, links the README auto-mode policy, and states that the worker does not overflow. — evidence: `DESIGN-PRINCIPLES.md`, “Subscription quota first, metered API last”.
- **partial** — `./quality.sh` passes. — reason: the gate reports `every test in tests/launcher_harness_reclaim_stub_test.ts (2, 3.02s) is over the 1.00s unit-test budget`; that file is unchanged from `origin/main`. — evidence: full gate output.

## Standards Review

Not run: this task explicitly prohibited agent delegation, so no independent
standards review was dispatched. This summary does not claim a reviewer verdict.

## Test Plan

- `deno task test:unit tests/babysitter_provider_choice_4738_test.ts tests/provider_auto_runtime_test.ts tests/review_round_test.ts` — passed, 44 tests.
- Subscription-first mutation: changed the winner guard so a subscription winner fell through to DeepSeek — three subscription-selection tests failed; restored the guard.
- Pinned-mode mutation: disabled the chooser's pinned-mode guard — both configured-pin tests failed; restored the guard.
- `deno task check:manifests` — passed, 847 passed, 0 failed, 1 ignored. Added `docs/audits/lib-sweep-coverage/top-up-4766.json` because the completeness check requires each new `worker/deno/lib/` module to have a coverage slice.
- `deno fmt --check`, targeted `deno lint`, and targeted `deno check` — passed. The full gate also passed lint, type check, formatting, Semgrep and Markdown checks.
- `./quality.sh < /dev/null` — failed only at the unit-test time budget for the unchanged launcher harness test noted above. Config integration and Checkov were skipped by the gate because the required config/tool was unavailable.
- Config propagation: `container_launch.ts` mounts the staged config and emits `CONFIG_PATH`; `buildBabysitterRunArgs` preserves non-named mounts and environment arguments. The chooser test asserts the supplied `/mounted/.config.json` path is read.
- No assertions were removed from existing tests. `deno task pr-summary-check` was run and blocked because the required independent review markers/verdicts were not available without delegation, which this task prohibited.
