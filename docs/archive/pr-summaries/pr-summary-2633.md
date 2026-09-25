# A spent balance is routine, and a refusal names its own provider (Issue #2633)

## Summary

Closes #2633.

#2633 was auto-filed as "Agent provider `deepseek` is refusing requests", and
#2634 duplicated it 4 s later. The cause was a spent DeepSeek balance
(`API Error: 402 Insufficient Balance`), and the alert described it as
"Claude's subscription window is exhausted". There were two defects:

1. **A spent balance is not an outage.** The owner's rule (2026-09-25):
   running out of quota, credit or balance is normal operation, not an error.
   The run is already parked and retried by the provider-outage state in
   `provider_auto_state.ts`; the public alert issue added only noise.
   `isProviderOutageAlertable` now alerts on a refused credential only, the
   one refusal that never clears on its own.
2. **The wrong provider and the wrong condition.** DeepSeek runs the Claude
   Code binary, so it shared the Claude output adapter verbatim, and every
   refusal said "Claude". A 402 balance also read as a subscription window.
   The adapter is now built per provider (`claudeCodeOutputAdapter(providerId,
   name)`): the same event decoder, with refusals that name their provider.
   A spent balance reads "<Provider>'s account balance is spent"; a spent
   window still reads "<Provider>'s subscription window is exhausted".

Out of scope: why the host was on DeepSeek at all (#2637), and the Claude
session resumed on DeepSeek (#2638).

## Acceptance Criteria

The issue is an auto-filed alert with no criteria. What this PR delivers:

- **met**: a spent balance files no alert, and parking is unchanged. Evidence: `isProviderOutageAlertable - a spent balance is routine, not an outage (Issue #2633)`; the parking path (`recordAutomaticProviderOutage`) is untouched.
- **met**: a refused credential still alerts, and the alert's lifecycle (file, update in place, close on recovery) is unchanged. Evidence: `provider_outage_alert_test.ts`, 18 tests.
- **met**: DeepSeek's refusals name DeepSeek, and a balance reads as a balance. Evidence: `deepseek adapter - a 402 Insufficient Balance names DeepSeek and its balance (Issue #2633)`, `claude adapter - a spent Anthropic credit balance is a balance, not a window (Issue #2633)`, `claude adapter - a spent usage window still reads as a window (Issue #2633)`.
- **met**: DeepSeek still decodes the same CLI events. Evidence: `provider descriptor - Claude and DeepSeek decode the same CLI events under their own names; Codex has its own`.

## Test Plan

- `provider_outage_alert_test.ts`, `claude_output_adapter_1695_test.ts` and
  `agent_provider_output_adapter_1695_test.ts`: 42 passed. The new tests
  failed first.
- Every test file referencing the adapter, the outage alert or the provider
  descriptor: see the PR's CI.
- `deno fmt`, `deno lint` and `deno check` are clean on the changed files.
