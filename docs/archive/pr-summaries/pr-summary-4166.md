## Summary

Corrects `docs/PROVIDER-FEASIBILITY.md` against the head code and adds a live validation record for the Codex items that need a subscription host. Closes #4166.

- The five discrepancies the issue lists are fixed: the unvalidated-model rule, the `--providers` default, the auto-mode outage rule, the credit-entry guard, and the stale 0.147.0 pin and row counts.
- The section 1 table and section 6 now describe the default candidates (`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`). Section 6 carries a fresh run on this host, 2026-10-25: `rows=30 go=9 no-go=6 unavailable=15`.
- A new "Live validation record" subsection in section 6 lists the ten items that need a Codex-capable host. Each says how to exercise it, what evidence to record, and that it is `not run — no Codex-capable host`. None is marked met.
- A comment in `worker/deno/lib/provider_feasibility.ts` made the same false claim as the doc, so it is reworded. No behaviour change.
- Version bump: `VERSION` is not changed by this docs and comment change.

## Spec

### Intent and Rationale

- The issue's doc fixes were verified against head code, so the doc now states what `evaluateFeasibility`, `runProviderFeasibility`, `provider_auto_state.ts` and `claude_runner.ts` do.
- The live items cannot be run here. This host has no `codex` binary, no `~/.codex`, no `docker` or `podman`, and the agent-state directory holds no Codex home. The doc therefore records them as pending instead of claiming them.

### Essential Design Decisions

- The record is a table with a status column. An operator replaces `not run — no Codex-capable host` with evidence, so the pending items cannot be read as met.
- The gemini and deepseek row keeps its "need `--providers` and `--models`" wording. That one is true: they are not in the default `--providers`, and have no default candidates. For claude and codex, `--models` alone suffices, which the new bullet in section 5 says.

### Undiscoverable Facts

- The 2026-10-25 run was made on this worker host. `claude` is at `/usr/local/bin/claude` and `codex` is absent.

## Evidence

Command run from `worker/deno` (stdin from `/dev/null`): `deno run --frozen --lock=deno.lock --allow-read --allow-env --allow-run --allow-sys=hostname mod.ts provider-feasibility`. Output relied on: header `[feasibility] rows=30 go=9 no-go=6 unavailable=15`; Codex rows carry `cli-not-runnable (not on PATH)`, `billing-unknown (subscription-credential-missing)`, `model-not-validated-on-host`.

Verified against head code: `provider_feasibility.ts:287-299` (no-go for an unregistered provider, before the validation check at `:350-355`); `commands/provider_feasibility.ts:58`, `:302`, `:317-325` (`--providers` default and `--models` check); `provider_auto_state.ts:15-17`, `:28`, `:59-60` (only `authentication` and `quota-exhausted` recorded, `retryAt` only for quota); `claude_runner.ts:2511` (credit write guarded by `creditLogDir && workerName`); `container/tools.json:65` (0.163.0).

**Docs sweep** — grep: `whatever else is true`, `rows=40`, `40 rows`, `0\.147`, `345-347`, `codex_executor.ts:56`, `claude_runner.ts:2465`, `PROVIDER-FEASIBILITY`; section: `docs/PROVIDER-FEASIBILITY.md` sections 1, 2, 4, 5, 6 (read through); siblings: none — no existing set gained a member (the candidate list changed but is described only in this document); updated: `docs/PROVIDER-FEASIBILITY.md`, `worker/deno/lib/provider_feasibility.ts` (comment); `docs/PROVIDER-FEASIBILITY.md:153` — still true because it is the history note for the superseded 2026-10-17 run; `docs/PROVIDER-FEASIBILITY.md:33` and `:161` — still true because they record the 0.147.0 to 0.163.0 raise; `docs/PROVIDER-PARITY.md:137-140` — still true because it already limits recorded categories to quota and authentication failure.

Left as it was: the section 3 and section 7 line citations that this change does not touch were not re-audited.

## Test Plan

- No test is added or edited: the change is documentation plus one comment, and no test reads `docs/PROVIDER-FEASIBILITY.md`.
- `deno task test:unit tests/provider_feasibility_test.ts` from `worker/deno`: passed (21 passed, 0 failed) on the final head.
- `deno fmt --check lib/provider_feasibility.ts` and `deno lint lib/provider_feasibility.ts`: passed.
- `markdownlint-cli2 docs/PROVIDER-FEASIBILITY.md`: 0 issues. `deno fmt --check` on the Markdown file also fails on HEAD with the same diffs; the gate excludes `docs/` Markdown from `deno fmt` (`worker/deno/lib/quality_gate.ts:1563-1567`).
- Twinned rules: the false "unavailable whatever else is true" claim appeared in the doc and in the comment at `provider_feasibility.ts:350`. Both are fixed. No other copy was found.

<!-- vibe-branch-outcomes -->

<!-- vibe-quality-gate-skipped reason="documentation and comment-only change; the gate takes about 15 minutes, beyond the 10-minute cap on a foreground command here; left to CI and the worker pre-PR run" -->
