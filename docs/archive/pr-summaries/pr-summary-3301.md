# PR Summary — Issue #3301

## Summary

Adds a credit row for "The Complete Guide to Building Skills for Claude" to the
"Agents, prompting and accountability" table in `docs/REFERENCES.md`, and files
six unlabelled issues for a human to vet: five prompt ideas from the guide and
one for review-fleet-prs triggering tests. No file under `prompts/` changes.
Closes #3301.

| Issue | Proposal | Prompt file | Guide section |
|---|---|---|---|
| #3421 | Put the irreversible-action rules first, or open with a short digest of them | `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md` | Ch5 "Instructions not followed", item 2 "Instructions buried" |
| #3422 | A short `## Critical` block in the Claude overlay; measure before adopting | `prompts/coding_guidelines_claude/prompt.md` | Ch5 "Instructions not followed", items 2 and 4 |
| #3423 | A `deno task pr-summary-check` script replaces prose self-checks of the PR summary | `prompts/issue/prompt.md`, `prompts/pr_feedback/prompt.md`, `prompts/ci_fix/prompt.md` | Ch5 item 3 "Advanced technique"; Pattern 3 "Iterative refinement" |
| #3424 | A "This run does not …" scope block under each mode heading | `prompts/pr_feedback/prompt.md`, `prompts/ci_fix/prompt.md`, `prompts/issue/prompt.md` | Ch5 "Skill triggers too often"; Ch3 "Iteration based on feedback" |
| #3425 | Four-cause diagnosis (too verbose, buried, ambiguous, effort) in retro category 3 | `prompts/retro/prompt.md` | Ch5 "Instructions not followed", items 1–4; Ch2 "Writing the main instructions" |
| #3426 | Triggering tests: 10–20 should-trigger and should-not-trigger queries against a live model, 90% target | `.claude/skills/review-fleet-prs/SKILL.md` | Ch3 "Recommended Testing Approach › 1. Triggering tests"; Ch2 "Define success criteria"; Reference A |

## Spec

### Intent and Rationale

- The guide shaped the review-fleet-prs skill layout (#3298, #3299, #3300), so it earns a credit row like the other sources in `docs/REFERENCES.md`.
- Prompt changes need a human's approval, so ideas are filed as unlabelled issues rather than edited into `prompts/`, following #612 / PR #666.

### Essential Design Decisions

- "What we took" paraphrases the guide in our own words and states only claims checked against the PDF text (kebab-case `name`, 1,024-character `description` with no angle brackets, progressive disclosure via `references/`, deterministic checks in `scripts/`).
- "Where it shows up" names the four paths the issue lists; `references_doc_test.ts` fails if any is later deleted.
- Shared-prompt ideas stay provider-neutral; the one Claude-only idea (#3422) targets `prompts/coding_guidelines_claude/prompt.md`.
- Each issue that would reword a phrase pinned by a drift test (#3263, #3262) says that test must change in the same PR.

### Undiscoverable Facts

- Duplicate searches over open issues found no match for any idea; #3423 cross-references #3396 as related, not duplicate.
- The candidate "swap fragile language checks for scripts" became #3423; "explicit negative triggers" became #3424.

## Evidence

Docs-only change, no UI file touched. Six issues filed, each confirmed with
`gh issue view <n> --json labels` → `[]`, and each ending "Filed from #3301
(part of #3265)".

**Docs sweep** — grep: `Complete Guide`, `Building Skill` over `README.md`, `CODING-STANDARDS.md` and `docs/` (excluding `docs/archive/`); only hit is the new row at `docs/REFERENCES.md:66`; section: none

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The credit row exists, and every path in its "Where it shows up" column exists. The existing `docs/REFERENCES.md` tests pass. — evidence: `docs/REFERENCES.md:66`; `worker/deno/tests/references_doc_test.ts` and `worker/deno/tests/references_refresh_test.ts` pass — reviewer: met
- **met** — Every filed prompt-idea issue is unlabelled, names a guide section and names at least one existing `prompts/<type>/prompt.md`, and duplicates no open issue. — evidence: #3421–#3425, labels `[]`, table above — reviewer: met — reason: the reviewer relied on the reported issue list; labels were verified here with `gh`
- **met** — The triggering-tests issue is filed and unlabelled. — evidence: #3426, labels `[]` — reviewer: met — reason: as above
- **met** — `git diff --name-only` shows no file under `prompts/`. — evidence: diff touches only `docs/REFERENCES.md` and this summary — reviewer: met
- **met** — `./quality.sh` passes. — evidence: `Result: PASSED (with skipped checks)`; only config integration skipped (no `.config.json`) — reviewer: met — reason: the reviewer saw only the diff; the gate was run here

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — no material departures. The named test file exists, spelling is Australian English, and the stub, fake, workflow and drift-test rules do not apply to a docs-only row.

## Test Plan

- From `worker/deno`: `references_doc_test.ts`, `references_refresh_test.ts` and `claude_skill_frontmatter_test.ts` → 63 passed, 0 failed.
- `./quality.sh < /dev/null` → `Result: PASSED (with skipped checks)`.
- No existing test edited, so no assertion is removed.

Branch outcomes: none added
