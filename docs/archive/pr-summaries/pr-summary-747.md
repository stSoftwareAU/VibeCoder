# Adopt Claude Fable 5.1 — pricing, docs, and a prompt review

## Summary

Anthropic released **Claude Fable 5.1** (`claude-fable-5-1`) on 2026-09-01 at
the same $10 / $50 per MTok as Fable 5, but with **cache reads at $0.25/MTok —
a quarter of the Fable 5 rate**. The worker requests the tier alias `fable`,
never a pinned model id, so routing needs no change; what needed changing was
the price the run-stats comment applies to those cache reads.

This change adds the `claude-fable-5-1` pricing row, refreshes the other
current-model rows against Anthropic's published pricing (Sonnet 5 is
**cheaper** than the 4.x line it replaces, at $2 / $10), makes `lookupModelPricing()`
classify Fable and Sonnet ids by version so a dated id prices at its own
generation's rate, and updates `docs/MODEL-AND-CACHING.md`. `claude-fable-5`
keeps its own $1.00 cache-read row so a run whose served model was Fable 5 is
still costed at the rate it was billed at. Closes #747.

## Evidence

Backend/CLI change with no web interface, so no screenshot applies. The
evidence is the test suite plus the published rates each row was checked
against.

**Rates verified against Anthropic's published pricing** (fetched during this
run: `platform.claude.com/docs/en/about-claude/pricing` and the
[Fable 5.1 overview](https://platform.claude.com/docs/en/models/fable-5-1/overview)):

| Model | Input | Output | Cache write | Cache read | Change |
|---|---:|---:|---:|---:|---|
| Fable 5.1 | $10 | $50 | $12.50 | **$0.25** | new row |
| Fable 5 | $10 | $50 | $12.50 | $1.00 | unchanged |
| Opus 5 / 4.5–4.8 | $5 | $25 | $6.25 | $0.50 | unchanged |
| Sonnet 5 | $2 | $10 | $2.50 | $0.20 | **new row** — the launch rate is now standard; the scheduled rise to $3/$15 was cancelled |
| Sonnet 4.6 / 4.x | $3 | $15 | $3.75 | $0.30 | unchanged |
| Haiku 4.5 | $1 | $5 | $1.25 | $0.10 | unchanged |
| Opus 4.0/4.1, Haiku 3.5 | — | — | — | — | unchanged, still correct |

**Live alias probe.** `claude --model fable --print --output-format stream-json`
on the container's CLI (2.1.223) reports `"model":"claude-fable-5"` at init, and
the call itself returned `Not logged in · Please run /login` from a nested
invocation, so no served model could be observed here. The alias flip is the
CLI's to make; both pricing rows are carried so neither side of the flip needs
a config change. This is why the live-run criterion below is `missing`.

```mermaid
flowchart LR
    W["worker: --model fable"] --> C["Claude CLI<br/>resolves the alias"]
    C -->|CLI with the 5.1 table| F51["claude-fable-5-1<br/>cache read $0.25"]
    C -->|older CLI| F5["claude-fable-5<br/>cache read $1.00"]
    F51 --> P["lookupModelPricing()<br/>classifies by minor version"]
    F5 --> P
    P --> S["run-stats cost estimate"]
    style F51 fill:#2d6a4f,stroke:#1b4332,color:#fff
```

## Prompt review — Fable 5.1 guidance vs the Fable-preferring phase prompts

Reviewed the eight Fable-preferring phases' surfaces (`prompts/planning/v23.md`,
`prompts/planning_critique/v7.md`, `prompts/grill-me/v14.md`,
`prompts/question/v9.md`, `prompts/quorum/v1.md`, `prompts/quorum_judge/v1.md`)
against [Prompting Claude Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)
and the [migration guide](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide).
Outcome per guidance item:

| 5.1 guidance | Outcome |
|---|---|
| Three breaking API changes (forced `tool_choice` 400s; thinking blocks bound to model and to an unedited prefix) | **No change needed** — the worker drives the Claude Code CLI, which owns request construction and history; the worker sends only CLI flags. Recorded in `docs/MODEL-AND-CACHING.md` |
| Audit for narration-suppressing lines | **Changed, as a filed gap** — `grill_me` renders both "Narrate briefly as you go" (`prompts/grill-me/v14.md:6`) and "no running commentary while you work" (`worker/deno/lib/verbosity.ts:38`, via `standard`). One prompt asks for and forbids narration. Which side wins is a product call, and committed `vN.md` files are immutable, so it is filed as stSoftwareAU/VibeCoder#759 per the checklist's gap-issue policy |
| Remove anti-formatting rules written for older models | **No change needed** — no Fable-phase template carries one (grepped the latest version of every template) |
| "Finish the whole task" / don't ask permission mid-task | **No change needed** — every Fable-phase template already opens with the unattended-autonomy framing (`prompts/planning/v23.md:10`, `prompts/grill-me/v14.md:6`, `prompts/quorum/v1.md:6`, `prompts/quorum_judge/v1.md:6`) |
| Keep changes and tests to what the task asks | **No change needed** — covered by the shared coding-guidelines scope rules and checklist row 20 |
| Batch independent tool calls in agent loops | **No change needed** — the guidance targets a caller that owns the tool loop; the CLI owns ours, and the shared guidelines already carry parallel-tool-call guidance (checklist row 11) |
| Fewer search calls at **low** effort | **Not applicable** — all eight Fable phases run at `high` (`PHASE_EFFORT_DEFAULTS`) |
| Leave room for long outputs at `xhigh`/`max` | **Not applicable** — the Fable phases run at `high`; `max` is where the Opus fallback is spent |
| Writing density, quoting retrieved sources, targeted edits over whole-file rewrites | **No change needed** — speculative without a measured run, and House row H2 requires a line to change behaviour against the model's default before it earns its context cost |
| The guide's model-specific section restructured into one **Model-specific guidance** table | **Changed** — `docs/PROMPT-BEST-PRACTICES-CHECKLIST.md` names that section (with Fable 5.1 among the pages it links) in place of four now-nonexistent per-model headings, keeping the doc's "every guide heading is accounted for" invariant true; the guard test's heading list moves with it |

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — separate `claude-fable-5-1` row at $10 / $50 / $12.50 / $0.25 with `claude-fable-5` kept at $1.00 — evidence: `worker/deno/lib/token_usage.ts:65-82`, `worker/deno/tests/token_usage_test.ts::prices Fable 5.1 cache reads at a quarter of Fable 5` — reviewer: met
- **met** — other current-model rows checked against Anthropic's published pricing, stale rates corrected — evidence: `worker/deno/lib/token_usage.ts:104-117` (Sonnet 5), `docs/MODEL-AND-CACHING.md` Model Pricing table — reviewer: met
- **partial** — prompt review of the phase templates, adjustments applied, each finding's outcome recorded — evidence: the Prompt review table above; `docs/PROMPT-BEST-PRACTICES-CHECKLIST.md`; stSoftwareAU/VibeCoder#759 — reviewer: partial — reason: no `prompts/` template changed. One genuine gap was found and filed rather than edited (committed `vN.md` files are immutable and the winning side is a product call); every other item is recorded above as no-change-needed or not-applicable with its reason
- **met** — `docs/MODEL-AND-CACHING.md` updated where it names Fable 5 as the top tier, with the alias resolution and the $0.25/MTok cache-read rate — evidence: `docs/MODEL-AND-CACHING.md` "Fable 5.1 — the current top tier" and the Model Selection alias paragraph — reviewer: met
- **missing** — verify on a real run that the CLI serves `claude-fable-5-1` with `Degraded: no` — reviewer: missing — reason: no Fable-phase run happens in this container, and the alias probe run here reports `claude-fable-5` on CLI 2.1.223 and could not authenticate. What is proven instead is that the detector accepts 5.1 (`worker/deno/tests/planning_run_stats_test.ts::modelsMatch - Fable 5.1 satisfies a Fable-preferring phase`), so the first real Fable-phase run on a 5.1-capable CLI reports `Degraded: no` without further change
- **unrequested** — the historical "Opus↔Sonnet gap shrank to ~1.7×" decision note gained a parenthetical saying Sonnet 5 reopened it to ~2.5× — reviewer: unrequested — reason: the line reads as a current rate in the same document the issue asked to refresh; the original figure is kept and marked as the rate at the time rather than rewritten

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — quality gates must pass: collapsing the four per-model rows broke the untouched guard `worker/deno/tests/prompt_best_practices_checklist_test.ts` — evidence: `worker/deno/tests/prompt_best_practices_checklist_test.ts:59` — reason: fixed here — the guide replaced those four headings with one `Model-specific guidance` section, so the constant now names that section and says why
- **violation** — a PR summary under `docs/archive/pr-summaries/` was missing — evidence: commit `d5703f8` file list — reason: fixed here — this file
- **violation** — Boy Scout Rule: the reworded Fable paragraph carried a truncated sentence forward ("…`quorum_judge`) under, and.") — evidence: `docs/MODEL-AND-CACHING.md` Model Pricing section — reason: fixed here — the sentence now ends cleanly
- **violation** *(from the spec reviewer, same axis)* — a load-bearing comment gave the wrong reason for the row ordering — evidence: `worker/deno/lib/token_usage.ts:153` — reason: fixed here — `lookupModelPricing()` classifies fable ids by version before reaching the map, so the comment now names the consumer that really depends on insertion order, `estimateBatchCost` in `batch_api.ts`
- **clean** — Australian English throughout; `deno fmt`/`deno lint`/`deno check` on the touched files; tests call real functions and assert results (no source-grepping); no error swallowing; renamed private constants have no stale references; commit cites Issue #747 and carries the `Vibe-Coder-Run-Id` trailer; no hidden paths staged; no `prompts/` file mutated, so prompt-version immutability holds

## Test Plan

Added to `worker/deno/tests/token_usage_test.ts`:

- `prices Fable 5.1 cache reads at a quarter of Fable 5` — `claude-fable-5-1` → $0.25 cache read
- `prices a dated Fable 5.1 id at the 5.1 rate` — `claude-fable-5-1-20260901`
- `returns pricing for a dated Fable 5 id` — `claude-fable-5-20260115` is **not** captured by the 5.1 row
- `returns pricing for Sonnet 5` — $2 / $10 / $2.50 / $0.20
- `estimateCost prices Fable 5.1 cache reads at $0.25/MTok` — end-to-end cost breakdown

Added to `worker/deno/tests/planning_run_stats_test.ts`:

- `modelsMatch - Fable 5.1 satisfies a Fable-preferring phase` — `fable` and `claude-fable-5` both accept `claude-fable-5-1` (and its dated form); a different tier still fails

Modified, because the behaviour they pinned changed:

- `returns pricing for bare fable alias` — the `fable` alias resolves to the latest Fable, so it now expects the 5.1 cache-read rate
- `resolves bare 'sonnet'/'haiku' aliases` — the `sonnet` alias now expects Sonnet 5's $2 / $10
- `tier fallback gives Sonnet 4.x pricing for unknown 4-family minor` — renamed and re-commented: an unknown Sonnet **4** minor keeps $3 / $15 now that Sonnet 5 has its own branch
- `prompt_best_practices_checklist_test.ts` out-of-scope heading list — tracks the guide's restructure into one `Model-specific guidance` section
