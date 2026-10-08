# PR Summary — Issue #3400

## Summary

Closes #3400

Point the worker's model tables at Claude Haiku 5.5: its 1M-token context
window, the cheap budget-probe model, and the current Haiku id.

- [x] `worker/deno/lib/context_budget.ts` — `MODEL_CONTEXT_WINDOWS.haiku` is
      now `1_000_000`, so a 300k-token `summarise` stays on Haiku. A new
      `"claude-haiku-4": 200_000` row keeps a phase pinned to a Haiku 4.x id
      (e.g. `claude-haiku-4-5`) on the old window. Without it, the id would
      prefix-match `haiku` and get 1M, and the large-input escalation guard
      would stop protecting it.
- [x] `worker/deno/lib/claude_token_budget.ts` — `CLAUDE_BUDGET_PROBE_MODEL`
      is now `claude-haiku-5-5`.
- [x] `worker/deno/lib/current_models.ts` — `CURRENT_TIER_MODELS` gains a
      `haiku` row (`claude-haiku-5-5`), so `previousGenerationOf()` now reports
      a served Haiku 4.x id as a previous generation. The `degraded-model`
      label for haiku-tier issue runs is not wired up yet; that is open
      Issue #3405.
- [x] `worker/deno/lib/phase_model_escalation.ts` — the escalation reason no
      longer appends `(haiku=<window>)`. With `haiku` at 1M, that suffix would
      print a misleading `haiku=1,000,000` next to a 200k escalation, so the
      now-unused `MODEL_CONTEXT_WINDOWS` import is dropped too.
- [x] Comments in `claude_runner.ts`, `phase_model_escalation.ts`,
      `context_budget.ts` and `current_models.ts` now describe the new windows.
- [x] Docs: `docs/MODEL-AND-CACHING.md`, `docs/CONFIGURATION.md`,
      `docs/INTERNALS.md`.

**Docs sweep** — grep: `MODEL_CONTEXT_WINDOWS`, `CLAUDE_BUDGET_PROBE_MODEL`, `CURRENT_TIER_MODELS`, `previousGenerationOf`, `selectModelForLargeInput`, `phase_model_escalation`, `claude-haiku-4-5`, `haiku=`, "200k", "200,000", "budget probe", "probe model", and Haiku within 60 characters of "window", "escalat" or "truncat", across `README.md`, `docs/` (excluding `docs/archive/`) and every `*/README.md`; section: `docs/MODEL-AND-CACHING.md#context-window-sizes`, the trivial-phases paragraph and the phase-defaults table in `docs/MODEL-AND-CACHING.md`, and the `CURRENT_TIER_MODELS` / previous-generation section of `docs/MODEL-AND-CACHING.md`, plus the context-budget steps in `docs/CONFIGURATION.md` and `docs/INTERNALS.md`; updated: `docs/MODEL-AND-CACHING.md`, `docs/CONFIGURATION.md`, `docs/INTERNALS.md` (in the branch's own commit), plus a reflow in `docs/MODEL-AND-CACHING.md` committed with this summary so `#3400),` no longer starts a line (markdownlint MD018); still true after reading: `docs/MODEL-AND-CACHING.md:137` and `:2840` (a non-Claude id still has no `MODEL_CONTEXT_WINDOWS` row and falls back to the 200,000-token default), `docs/CONFIGURATION.md:602` (model aliases list, unaffected), `docs/CODEX-BUDGET-SOURCES.md:8` and `docs/workflows/issue-processing.md:141` (they name the probe but not its model); the `docs/audits/` hits are dated audit records, left as history. Left stale, out of this diff's scope: the Haiku 4.5 row of the pricing table (`docs/MODEL-AND-CACHING.md` "Model Pricing") has no Haiku 5.5 row yet. That row is owned by #3407, and the code rates by #3399. The minimum-cacheable-prefix row (`docs/MODEL-AND-CACHING.md` "Minimum cacheable prefix") still names Haiku 4.5 for `haiku`. Haiku 5.5's minimum is not established in #3400 or its parent #3385, so no figure was invented; both are listed under Standards Review below.

## Test Plan

Assertions removed from existing tests. Each one asserted the old Haiku 4.5
behaviour that #3400 replaces:

- Removed from `worker/deno/tests/context_budget_test.ts`: `assertEquals(MODEL_CONTEXT_WINDOWS["haiku"], 200_000);` — #3400 sets `MODEL_CONTEXT_WINDOWS.haiku` to `1_000_000`, so the old value is untrue. The test now asserts `1_000_000` (`context_budget - Haiku context window is 1M tokens (Issue #3400)`).
- Removed from `worker/deno/tests/current_models_test.ts`: `assertEquals(previousGenerationOf("claude-haiku-4-5"), undefined);` — #3400 adds a `haiku` row to `CURRENT_TIER_MODELS`, so Haiku is no longer an untracked tier and `claude-haiku-4-5` is now a previous generation. The opposite is asserted in `worker/deno/tests/current_models_test.ts::previousGenerationOf - Haiku 4.5 is a previous generation of Haiku 5.5 (Issue #3400)`. The untracked-tier test keeps its `claude-sonnet-4-6` assertion.
- Removed from `worker/deno/tests/phase_model_escalation_test.ts`: `assertEquals(result.model, "haiku");` (two occurrences: `summarise input just below threshold` and `custom threshold percent suppresses escalation under threshold`) — #3400 gives the `haiku` alias a 1M window, so those tests now pin `claude-haiku-4-5` to keep exercising the 200k ceiling, and the unchanged model they assert is `claude-haiku-4-5`. The `haiku` alias staying put is still asserted in `worker/deno/tests/phase_model_escalation_test.ts::phase_model_escalation - a 300k-token summarise stays on haiku (Issue #3400)` and the unchanged small-input tests.

Other existing escalation tests (`at threshold`, `over 200k`, `any phase
pinned to a 200k model`, custom target and threshold, and the Issue #957
lookup seam) keep their assertions. They now pin `claude-haiku-4-5` through
the env lookup instead of relying on the `haiku` alias.

Tests added, one per acceptance criterion; each fails if its constant
regresses:

- `worker/deno/tests/phase_model_escalation_test.ts::phase_model_escalation - a 300k-token summarise stays on haiku (Issue #3400)`
- `worker/deno/tests/context_budget_test.ts::context_budget - checkContextBudget uses 1M window for haiku (Issue #3400)` and `::context_budget - getContextWindowSize returns 1M for haiku and claude-haiku-5-5 (Issue #3400)`
- `worker/deno/tests/claude_token_budget_test.ts::the probe request names claude-haiku-5-5 (Issue #3400)`
- `worker/deno/tests/current_models_test.ts::CURRENT_TIER_MODELS - Haiku's current model is Haiku 5.5 (Issue #3400)` and `::previousGenerationOf - Haiku 4.5 is a previous generation of Haiku 5.5 (Issue #3400)`

`deno test --allow-all` over the four touched test files passes: 105 passed,
0 failed.

**Branch outcomes:**

The diff adds no new condition. It changes table rows that the existing
lookups branch on, so each row's outcome is listed and was flipped on purpose:

- `worker/deno/lib/context_budget.ts:36` — `haiku` alias resolves to a 1M window (a 300k input stays on Haiku) — `worker/deno/tests/phase_model_escalation_test.ts::phase_model_escalation - a 300k-token summarise stays on haiku (Issue #3400)`, `worker/deno/tests/context_budget_test.ts::context_budget - checkContextBudget uses 1M window for haiku (Issue #3400)` — flipped to `200_000`, 4 tests went red
- `worker/deno/lib/context_budget.ts:39` — a Haiku 4.x id resolves to 200k and still escalates — `worker/deno/tests/context_budget_test.ts::context_budget - getContextWindowSize returns 200k for claude-haiku-4-5 (Issue #1399)`, `worker/deno/tests/phase_model_escalation_test.ts::phase_model_escalation - summarise input over 200k escalates to sonnet` — row removed, 7 tests went red
- `worker/deno/lib/current_models.ts:52` — Haiku is a tracked tier (`claude-haiku-4-5` is a previous generation) — `worker/deno/tests/current_models_test.ts::previousGenerationOf - Haiku 4.5 is a previous generation of Haiku 5.5 (Issue #3400)`, `worker/deno/tests/current_models_test.ts::CURRENT_TIER_MODELS - Haiku's current model is Haiku 5.5 (Issue #3400)` — row removed, 2 tests went red
- `worker/deno/lib/claude_token_budget.ts:105` — probe names `claude-haiku-5-5` — `worker/deno/tests/claude_token_budget_test.ts::the probe request names claude-haiku-5-5 (Issue #3400)` — flipped to `claude-haiku-4-5`, test went red

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A 300k-token prompt routed to `haiku` stays on Haiku (no context-window fallback) — evidence: `worker/deno/tests/phase_model_escalation_test.ts::phase_model_escalation - a 300k-token summarise stays on haiku (Issue #3400)`, `worker/deno/tests/context_budget_test.ts::context_budget - checkContextBudget uses 1M window for haiku (Issue #3400)` — reviewer: met
- **met** — The budget probe sends `claude-haiku-5-5` — evidence: `worker/deno/tests/claude_token_budget_test.ts::the probe request names claude-haiku-5-5 (Issue #3400)` — reviewer: met
- **met** — `CURRENT_TIER_MODELS.haiku === "claude-haiku-5-5"`; the existing fable/opus entries are unchanged — evidence: `worker/deno/tests/current_models_test.ts::CURRENT_TIER_MODELS - Haiku's current model is Haiku 5.5 (Issue #3400)` — reviewer: met
- **unrequested** — new `"claude-haiku-4": 200_000` row in `MODEL_CONTEXT_WINDOWS` — reviewer: unrequested — reason: necessary, because without it `claude-haiku-4-5` would prefix-match `haiku` and get 1M, breaking the escalation guard for Haiku 4.x pins. Reviewer caveat: ids that only match `haiku` loosely (a Bedrock-style `us.anthropic.claude-haiku-4-5-…` id, or the retired `claude-3-5-haiku-…`) now resolve to 1M. Low impact, since the worker has no Bedrock path.
- **unrequested** — escalation reason drops the `(haiku=<window>)` suffix and the `MODEL_CONTEXT_WINDOWS` import in `phase_model_escalation.ts` — reviewer: unrequested — reason: necessary, because with `haiku` at 1M the suffix would print a misleading window next to a 200k escalation
- **unrequested** — escalation tests re-pinned from the `haiku` alias to `claude-haiku-4-5` — reviewer: unrequested — reason: necessary, because the alias no longer escalates, so these tests pin a 200k model to keep covering the guard
- **unrequested** — `previousGenerationOf("claude-haiku-4-5")` assertion moved from "untracked" to the new previous-generation test — reviewer: unrequested — reason: direct consequence of the third criterion (Haiku becomes a tracked tier); wiring it to the `degraded-model` label is open Issue #3405
- **unrequested** — extra `getContextWindowSize` 1M test, comment rewrites (`claude_runner.ts`, `context_budget.ts`, `current_models.ts`, `phase_model_escalation.ts`, `claude_token_budget.ts`) and doc edits (`docs/MODEL-AND-CACHING.md`, `docs/CONFIGURATION.md`, `docs/INTERNALS.md`) — reviewer: unrequested — reason: keeps tests, comments and docs consistent with the new constants

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Code change owes a docs change: comments outside the diff still call Haiku 4.5 the current Haiku — evidence: `worker/deno/lib/token_usage.ts:152`, `worker/deno/lib/token_usage.ts:380` — reason: not fixed in this diff; these are the Haiku pricing rows, which Haiku 5.5's banded pricing (#3399) replaces
- **violation** — Code change owes a docs change: `summarise` is described as running on Haiku 4.5 with a 4,096-token cache minimum — evidence: `worker/deno/lib/claude_runner.ts:3825` — reason: not fixed in this diff; Haiku 5.5's minimum cacheable prefix is not established in #3400 or #3385, so a corrected figure would be invented, and this retry is limited to the summary
- **violation** — Code change owes a docs change: the minimum-cacheable-prefix table names Haiku 4.5 for `haiku`, and the pricing table has no Haiku 5.5 row — evidence: `docs/MODEL-AND-CACHING.md:2126`, `docs/MODEL-AND-CACHING.md:2472` — reason: not fixed in this diff; the pricing row is owned by #3407 (docs) and #3399 (rates), and the cache-minimum figure is unknown, as above
- **violation** — Comment accuracy: the comment says Haiku 5.5 differs from Haiku 4.5 in price, but `lookupModelPricing` still gives every Haiku one rate — evidence: `worker/deno/lib/current_models.ts:32` — reason: not fixed in this diff; the comment describes the real models, and the code rates catch up in #3399
- **clean** — Australian spelling in added lines (unrecognised, summarise, behaviour); `deno fmt --check` passes on all changed TS files and `deno lint` passes on the files the reviewer ran it on; no unused imports or dead code after dropping `MODEL_CONTEXT_WINDOWS` from `phase_model_escalation.ts` and its test; markdownlint passes on `docs/MODEL-AND-CACHING.md` with the reflow committed here (MD018); every new test fails if its constant regresses (probe test asserts a string literal, not the constant); the removed `previousGenerationOf("claude-haiku-4-5")` assertion is made untrue by the issue and its opposite is asserted; KISS/DRY: the escalation reason no longer hard-codes the Haiku window, and `getContextWindowSize`'s longest-key-first lookup gives `claude-haiku-4-5` 200k
