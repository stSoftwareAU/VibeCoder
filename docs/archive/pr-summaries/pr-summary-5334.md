## Summary

`PROVIDERS_WITH_USAGE_ADAPTER` (`worker/deno/lib/run_callback_telemetry.ts`)
now includes `DEEPSEEK_PROVIDER_ID`. A DeepSeek run that reports no usage, for
example one killed before its terminal result line, is now
`telemetryAbsentReason: "usage_not_reported"` instead of
`provider_unsupported`. DeepSeek runs on the Claude Code CLI and decodes with
`DEEPSEEK_OUTPUT_ADAPTER = claudeCodeOutputAdapter("deepseek", "DeepSeek")`,
which parses usage, so it meets the set's documented definition. The set's doc
comment now says why DeepSeek is listed. Closes #5334.

## Spec

### Intent and Rationale

- `provider_unsupported` tells a consumer "never expect cost data from this
  provider", which is false for DeepSeek: its finished runs report usage.
- The issue offered two fixes: add the id, or derive the set from the provider
  descriptors. Adding the id is one line and keeps the set an explicit list. A
  derived set would treat every future registered provider as having a usage
  adapter, which is the opposite mistake.

### Essential Design Decisions

- Every registered provider (`claude`, `codex`, `gemini`, `deepseek`) is now in
  the set. `provider_unsupported` is still reached for any other provider id,
  so the tests that pinned the adapter-less path now use the unregistered id
  `other`.
- `callbackTelemetryAbsenceReason` is unchanged; both production callers
  (`worker/deno/lib/issue_worker.ts`,
  `worker/deno/lib/idle_task_process_issue_route.ts`) get the new answer
  through it.

### Undiscoverable Facts

None.

## Evidence

Backend only; no UI files.

- Red before the fix (executor run of the two touched test files against the
  unchanged `run_callback_telemetry.ts`: 55 passed, 2 failed):
  - `run_callback_telemetry - a DeepSeek run with no usage is
    usage_not_reported: its adapter parses usage (Issue #5334)` failed with
    `provider_unsupported` where `usage_not_reported` was expected;
  - `#5295 - workOnIssue: telemetryAbsentReason follows the served provider (a
    deepseek pin on a claude host (Issue #5334))` failed the same way.
- Green after it (see Test Plan).
- No other copy of the set exists: `git grep` for `USAGE_ADAPTER`, "usage
  adapter" and "populate `tokenUsage`" outside `docs/archive/` hits only
  `run_callback_telemetry.ts`.
- Docs read: the `VIBECODER_TELEMETRY_ABSENT_REASON` row in `docs/CALLBACKS.md`
  and the `TelemetryAbsentReason` doc in `worker/deno/lib/run_callbacks.ts`
  ("the provider does not report usage"). Neither lists providers, and both
  stay true; no doc change was needed.

Issues cited as provenance:

- #5334: `PROVIDERS_WITH_USAGE_ADAPTER` omits `deepseek`, so a DeepSeek run with
  no usage is reported as `provider_unsupported` although its adapter parses
  usage (this issue)

## Test Plan

- New, in `worker/deno/tests/run_callback_telemetry_test.ts`:
  - `run_callback_telemetry - a DeepSeek run with no usage is
    usage_not_reported: its adapter parses usage (Issue #5334)`: a named
    `deepseek` invocation and the `deepseek` fallback both give
    `usage_not_reported`; control: `other` gives `provider_unsupported`.
  - `run_callback_telemetry - the DeepSeek adapter decodes token usage from a
    Claude-shaped result line (Issue #5334)`: `DEEPSEEK_OUTPUT_ADAPTER.decode`
    returns the literal counts 1200 / 340 / 50 / 7000. It pins the premise the
    set entry relies on, so it is green on base as well.
- Edited, same file: the Issue #1948 adapter-less case and the five Issue #5295
  cases now use `other` where they used `deepseek` as the adapter-less
  provider. The issue makes `deepseek` → `provider_unsupported` untrue. Every
  expected value is kept, and each case still discriminates: the served
  provider versus the fallback, a blank id falling back, and one adapter
  provider among several.
- Edited: the `#5295 - workOnIssue: telemetryAbsentReason follows the served
  provider` loop in `worker/deno/tests/run_callback_provider_5163_test.ts`
  through the real `workOnIssue`. "a deepseek pin on a claude host" now expects
  `usage_not_reported` (Issue #5334). The served-provider-beats-fallback case
  it used to carry moves to the new "an adapter-less provider served on a
  claude host" case, whose runner reports `provider: "other"` →
  `provider_unsupported`. The unpinned and claude-pin cases are unchanged.
- Results on the head (`657c2977a`), from `worker/deno`: `deno test --allow-all
  tests/run_callback_telemetry_test.ts tests/run_callback_provider_5163_test.ts
  tests/claude_output_adapter_1695_test.ts`: 79 passed, 0 failed.
  `./quality.sh`: `Result: PASSED (with skipped checks)`. Config integration
  was skipped (no `.config.json`) and checkov was skipped (not on PATH).
