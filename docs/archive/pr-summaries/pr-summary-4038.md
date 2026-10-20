## Summary

Closes #4038.

A CI-fix run whose agent the provider refused to serve no longer counts as an
auto-fix attempt. It posts nothing, records no attempt marker, applies no
label and returns unprocessed, so the next scan retries. Before this change
the empty working tree read as "reviewed but could not produce a code fix",
and the PR went to `needs-human` on attempt 1 of 3.

## Spec

### Intent and Rationale

- GRQ-AutoTrader#3811 (GRQ-23, 2026-10-20 08:21Z): Codex refused `gpt-5` in
  4.7 s (HTTP 400, #4019), and the run escalated "CI failure needs human
  attention" although nothing had looked at the `pwa-e2e` failure.
- Provider unavailability is normal and parks quietly; a wait that clears by
  itself must never become `needs-human`. This is the CI-fix counterpart of
  #4035.

### Essential Design Decisions

- Classification reuses `isProviderUnavailableFailure` (`agent_output.ts`),
  the predicate whose contract already says such a run must not be charged to
  a streak or a ladder attempt.
- Checked right after the timeout branch, before the quality check and the
  final-mile commit, and only when the run exited non-zero with a classified
  failure. A real no-change run keeps its marker and escalation.

### Undiscoverable Facts

- GRQ-23 was still on 1.10.109, before #4024. #4034 (PR #4036) moves the
  refused run onto `agent_provider_fallback`. This change covers the case
  where no fallback is configured or the fallback refuses too.

## Evidence

The new test was red before the change (the attempt was charged and
escalated). After the change, 143 tests pass across every
`pr_ci_processor*_test.ts` file. `deno check`, `deno lint` and
`markdownlint-cli2` are clean.

## Test Plan

- `worker/deno/tests/pr_ci_processor_auto_fix_cap_test.ts`: `processCiFailure
  - a provider refusal spends no attempt and never escalates (#4038)`. Four
  refused runs on one failure: each is retried, nothing is posted, no
  `needs-human` is applied, and no state file is written. The existing cap and
  no-change tests cover the other direction.
