# Security sweep — prompt templates (`prompts/*/prompt.md`)

**Issue:** [#2759](https://github.com/stSoftwareAU/VibeCoder/issues/2759)
(chunk 10) · **Parent:** #2722 · **Swept at:**
`3a566abe0938798bf4996ebe8a6a183f51a20d51`

This is the first recorded sweep of the prompt templates. The set of templates
is `git ls-files 'prompts/*/prompt.md'`, which holds 34 files at the swept
commit.

## Why a new slice

Until now the coverage ledger walked only TypeScript under its roots, so no
slice could claim a template. This change adds `prompts` to the ledger roots and
teaches `listSweptModules` to list `prompt.md` files. The new `10-prompts` slice
claims all 34 templates, and `sweep-drift` reports a template that changes after
`sweptAt` exactly as it reports a drifted module.

## Method

Each template was read together with the assembler that fills its placeholders.
Five classes were checked:

1. **Unfenced untrusted text** — a placeholder that carries issue, PR, comment,
   log or title text without passing through `fenceUntrustedValue`
   (`prompt_builder.ts`), which applies `sanitiseDelimiterPatterns`. Open-issue
   titles go through `renderOpenIssueTitles` instead, which scrubs them, caps
   them at 160 characters and converts `<>` to fullwidth.
2. **Steerable tool, label or lifecycle use** — an instruction that lets issue
   or PR content decide which tools run, which labels are set, or a close, merge
   or reopen.
3. **Secret or path disclosure** — an instruction that could copy a secret, a
   token or a host path into model output or a filed issue.
4. **Reserved-label self-application** — an instruction to apply `work-on`,
   `top-priority`, `question` or another label from the reserved set.
5. **Missing treat-as-data guidance** — untrusted input that reaches the model
   with no `{{BOUNDARY_INTEGRITY_INSTRUCTION}}`
   (`buildBoundaryIntegrityInstruction`) or equivalent wording.

## Triage

Every template has one line below. "Clean" means none of the five classes
survived a reading of the template and its assembler.

| Template                                         | Lines | Verdict                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompts/alert_feed/prompt.md`                   |    57 | Clean — fixed instructions only, no untrusted placeholders                                                                                                                                                                                                                                                         |
| `prompts/bash_script_refs/prompt.md`             |   160 | Clean — scanner-derived refs, descriptive labels only                                                                                                                                                                                                                                                              |
| `prompts/bash_syntax_audit/prompt.md`            |   152 | Clean — scanner-derived input, descriptive labels only                                                                                                                                                                                                                                                             |
| `prompts/best_practices/prompt.md`               |   676 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045) (live re-check dedup); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                             |
| `prompts/ci_fix/prompt.md`                       |   194 | Log excerpt fenced; tool-fetched search output part of [#3046](https://github.com/stSoftwareAU/VibeCoder/issues/3046)                                                                                                                                                                                              |
| `prompts/coding_guidelines/prompt.md`            |  1277 | Clean — standing rules; untrusted-data wording covers images only (see [#3046](https://github.com/stSoftwareAU/VibeCoder/issues/3046))                                                                                                                                                                             |
| `prompts/coding_guidelines_claude/prompt.md`     |    19 | Clean — pointer text only                                                                                                                                                                                                                                                                                          |
| `prompts/dead_code/prompt.md`                    |   406 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                                                   |
| `prompts/deprecated_api/prompt.md`               |   425 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                                                   |
| `prompts/doc_coverage/prompt.md`                 |   637 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                                                   |
| `prompts/documentation_audit/prompt.md`          |  1005 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                                                   |
| `prompts/duplicated_knowledge/prompt.md`         |   495 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                                                   |
| `prompts/format_drift/prompt.md`                 |   488 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                                                   |
| `prompts/gate_skip_drift/prompt.md`              |    75 | Clean — fixed instructions, descriptive labels only                                                                                                                                                                                                                                                                |
| `prompts/github_actions_audit/prompt.md`         |  1482 | Findings [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045), [#3046](https://github.com/stSoftwareAU/VibeCoder/issues/3046) (repository files read with no data rule); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                        |
| `prompts/grill-me/prompt.md`                     |   218 | Clean — issue text fenced; note below on the rubric                                                                                                                                                                                                                                                                |
| `prompts/issue/prompt.md`                        |   887 | Clean — issue body and comments fenced, boundary instruction present                                                                                                                                                                                                                                               |
| `prompts/merge_conflict/prompt.md`               |   129 | Clean — PR text fenced; intent override gated by `renderEligibility`                                                                                                                                                                                                                                               |
| `prompts/orphan_deps/prompt.md`                  |   595 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                                                   |
| `prompts/planning/prompt.md`                     |   184 | Finding [#3046](https://github.com/stSoftwareAU/VibeCoder/issues/3046) — `gh issue list` titles read with no data rule (draft-only, low impact)                                                                                                                                                                    |
| `prompts/planning_critique/prompt.md`            |   250 | Clean — draft fenced, no label or lifecycle verbs                                                                                                                                                                                                                                                                  |
| `prompts/pr_feedback/prompt.md`                  |   115 | Clean — review comments fenced, boundary instruction present                                                                                                                                                                                                                                                       |
| `prompts/private_repo_reference_audit/prompt.md` |   500 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                                                   |
| `prompts/question/prompt.md`                     |   194 | Clean — question text fenced, read-only answer                                                                                                                                                                                                                                                                     |
| `prompts/quorum/prompt.md`                       |   116 | Clean — issue text fenced; note below on `ISSUE_LABELS`                                                                                                                                                                                                                                                            |
| `prompts/quorum_judge/prompt.md`                 |   125 | Clean — fenced inputs, verdict output only                                                                                                                                                                                                                                                                         |
| `prompts/retro/prompt.md`                        |   369 | Clean template; assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                                                                                                           |
| `prompts/security_scan/prompt.md`                |  1876 | Findings [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045), [#3046](https://github.com/stSoftwareAU/VibeCoder/issues/3046), [#3047](https://github.com/stSoftwareAU/VibeCoder/issues/3047) (no redaction of quoted secrets); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048) |
| `prompts/spelling_fix/prompt.md`                 |   126 | Clean — scanner-derived word list, descriptive labels only                                                                                                                                                                                                                                                         |
| `prompts/supply_chain_detection/prompt.md`       |   589 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045) (live re-check dedup)                                                                                                                                                                                                                       |
| `prompts/supply_chain_readiness/prompt.md`       |   614 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                                                   |
| `prompts/test_audit/prompt.md`                   |  1143 | Finding [#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045); assembler [#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048)                                                                                                                                                                   |
| `prompts/workflow_annotation_scan/prompt.md`     |   141 | Clean — annotations scrubbed, descriptive labels only                                                                                                                                                                                                                                                              |
| `prompts/workflow_setup/prompt.md`               |   450 | Clean — "private-repo-22" is already anonymised                                                                                                                                                                                                                                                                    |

## Surviving findings

Each finding was dedup-searched against open issues and filed with descriptive
labels only.

- **[#3045](https://github.com/stSoftwareAU/VibeCoder/issues/3045) — live
  re-check dedups on any author's marker (class 2 and class 5).** Fourteen scan
  templates tell the model to skip a finding whose `<!-- finding-id: … -->`
  marker appears in any open issue body with the scan label. The code-side
  `listOpenIssueBodies` accepts only fleet-authored matches (#1243); the
  template side does not. So an outsider's issue, once labelled by a triager,
  suppresses the real finding. This is related to, but distinct from, #2778.
- **[#3046](https://github.com/stSoftwareAU/VibeCoder/issues/3046) — no
  treat-as-data rule for tool-fetched text (class 5).** The boundary instruction
  covers fenced blocks and images only. Text the model fetches itself — issue
  titles from `planning`'s `gh issue list`, search results in `ci_fix`, and
  repository files in `security_scan` and `github_actions_audit` — gets no data
  wording. This is filed as one cross-cutting issue because the fix is one
  shared rule.
- **[#3047](https://github.com/stSoftwareAU/VibeCoder/issues/3047) — secret
  values may be quoted in filed issues (class 3).** `security_scan` asks the
  model to confirm a live secret and to quote "the concrete input" as evidence.
  It never says to redact the value, and the model files with `gh issue create`
  directly.
- **[#3048](https://github.com/stSoftwareAU/VibeCoder/issues/3048) — `$`-pattern
  expansion of open-issue titles (class 1, assembler side).** Fourteen
  assemblers substitute `{{OPEN_ISSUE_TITLES}}` with the string form of
  `replaceAll`, so `$'` in an outsider's title expands to the rest of the
  template. A probe with three `$'` tokens grew a 1,025-character template to
  4,020 characters. This can bloat or overflow the prompt; it cannot add new
  placeholders, because `{{` is neutralised.

## Notes below the filing threshold

- `quorum`: `ISSUE_LABELS` is sanitised but not fenced. Label names need triage
  rights to set, and quorum's own `gh issue list` phase is read-only.
- Scanner-fed placeholders (`COST_CANDIDATES`, `DUPLICATE_BLOCKS`,
  `COVERAGE_GAPS`) are repository-derived and not scrubbed. Abusing them needs a
  commit on the default branch, which is trusted input.
- `grill-me` calls its rubric "trusted worker output" although the rubric quotes
  user text; that text is filtered by `safeExcerpt`. The template also repeats
  its title and comment-history placeholders.
- `ci_fix`: the failure classification is scrubbed but not fenced; it holds
  fixed strings only.
- The live re-check in `test_audit` and `documentation_audit` searches
  `"BP- in:body"`, a prefix borrowed from `best_practices`. That is a
  dedup-precision oddity, not a security defect.
