## Summary

Closes #4034.

When a provider refuses the requested model and has no cheaper model, the
agent runner now retries the same invocation on the next provider in
`agent_provider_fallback`. Before this change it logged
`no cheaper fallback available (no-ladder-for-provider)` and gave up. Only the
health gate consulted the fallback list (Issue #4014), so a phase whose model
the provider would not serve failed every cycle while a healthy alternative
stood idle.

## Spec

### Intent and Rationale

- A model refusal is terminal for that provider. A ChatGPT login that does not
  offer `gpt-5-codex` never will (Issue #4019), so waiting is futile, and Codex
  has no model ladder.
- The configured fallback list is the operator's stated remedy for a
  `model-unavailable` outage (`PROVIDER_OUTAGE_CLASSES`), so the runner now
  applies it, not just the health gate.

### Essential Design Decisions

- `loadConfig` records the resolved policy on a seam in
  `provider_fallback_policy.ts`, the same way it records the active and
  enabled provider ids, because the runner holds no config handle. Each reload
  replaces it.
- The switch reuses `mayFallbackOn` / `nextFallbackProvider`, so the
  one-switch cap and the no-revisit rule match every other fallback. A pinned
  policy (the default) still gives up exactly as before.
- On a switch the explicit `model` and the session are cleared. The refused id
  names the old provider's catalogue, and a session id belongs to the CLI that
  recorded it. The fallback resolves its own phase model.

### Undiscoverable Facts

- On GRQ-23 (2026-10-20) the health gate passed while grill-me and PR-feedback
  phases ran on Codex and were refused with HTTP 400. Part of that was #4024
  (fixed in 1.10.111). Any phase whose model differs from the health model can
  still hit this.

## Evidence

The new runner test was red before the change, and its log matched GRQ-23's
line for line:

```
[model-fallback] The codex coding-agent provider has no cheaper-model ladder ...
Model "gpt-5-codex" unavailable and no cheaper fallback available (no-ladder-for-provider). Giving up.
```

After the change both new tests pass, and 207 tests pass across the targeted
config, runner fallback, model fallback and provider-policy suites.
`deno check`, `deno lint` and `markdownlint-cli2` are clean.

## Test Plan

- `worker/deno/tests/claude_runner_provider_fallback_4034_test.ts`: refused
  Codex model with `agent_provider_fallback: ["claude"]` → one switch, run
  succeeds on the fallback; with no fallback → gives up, no other provider
  invoked.
- `worker/deno/tests/config_test.ts`: `loadConfig records the provider
  fallback policy for the agent runner (Issue #4034)`, including a reload
  without the key resetting it to pinned.
