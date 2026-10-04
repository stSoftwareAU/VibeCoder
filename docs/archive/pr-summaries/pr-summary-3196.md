## Summary

The issue prompt's Standards reviewer found breaches in lines the PR itself
wrote, and the run recorded them as a `violation` that "stands" or is "left for
a follow-up", filed nothing, and raised the PR. Fleet review then read the PR's
own Standards Review and sent it back (VibeCoder#3065, GRQ-AutoTrader#2210 and
#2479). The prompt and both gates' template offered "why it stands" as a valid
reason, and the independent-review gate accepted any text. Closes #3196.

- [x] Gate: `validateIndependentReview` blocks PR creation when a `violation`
      reason neither opens with `fixed` / `corrected` / `resolved` nor links an
      issue (`#123`, `owner/repo#123` or a GitHub issue URL). The block message
      prints both acceptable reason lines.
- [x] Prompt (`prompts/issue/prompt.md`): the template line is now
      `reason: fixed in this diff`, and the rule says a breach in a line this
      diff adds or changes may not be deferred. Only a pre-existing breach may
      carry `reason: pre-existing, filed #<n>`.
- [x] `REVIEW_BLOCK_TEMPLATE`, printed by both gates, shows
      `reason: fixed in this diff`.
- [x] Closure-verdict recovery: `assessVerdictCoverage` applies the same rule,
      so the re-ask names the shortfall. The field sanitiser now keeps a `#`
      followed by a digit, so a filed `#123` survives rendering. The recovery
      brief asks for the same two reasons.
- [x] Manuals: `docs/workflows/issue-processing.md`, `docs/PROMPTS.md`,
      `docs/MODEL-AND-CACHING.md`

## Spec

### Intent and Rationale

- The reviewer had already found the defect with a `file:line`, so the fix was
  one line away. The only escape left open was the free-text reason, and that
  is the one thing this change closes.

### Essential Design Decisions

- One predicate, `violationReasonSettles`, lives in
  `independent_review_gate.ts`. `closure_verdict.ts` imports it, so the gate
  and the in-run recovery cannot disagree.
- "Fixed" is matched only at the start of the reason, so "not fixed — it
  stands" is refused. `corrected` and `resolved` are accepted too, because an
  existing test summary already wrote "corrected to `behaviour` in this diff".
- A placeholder `#<n>` has no digits, so it does not count as a link.
- **Optional part not done:** the issue offered an optional cross-check of the
  evidence `file:line` against the diff's added lines. The gate is pure and
  sees only the issue body and the summary, not the diff. The prompt carries
  that rule instead, and the gate closes the free-text escape.

### Undiscoverable Facts

- `closure_verdict.ts`'s `sanitiseField` used to strip every `#` to stop
  forged headings. That would have turned `filed #123` into `filed 123` and
  failed the new rule. A markdown heading needs a space after its hashes, so
  `#` followed by a digit cannot open one.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD (each new test watched red first), bounded
  regexes over capped untrusted text, docs sweep, no bare product name in prompt
  prose

## Evidence

Backend and prompt change; no UI files touched.

**Docs sweep:** grep `why it stands`, `fixed here`, `whether it was fixed`,
`may stand`, `violation` over `README.md`, `docs/` (excluding `docs/archive/`),
`prompts/` and `worker/deno/lib`. Updated `docs/workflows/issue-processing.md`,
`docs/PROMPTS.md`, `docs/MODEL-AND-CACHING.md`, `prompts/issue/prompt.md`,
`review_block_template.ts`, `closure_verdict.ts` and
`closure_verdict_recovery.ts`. Section:
`docs/workflows/issue-processing.md#-independent-review-on-two-axes`.

## Test Plan

- [x] New tests failed first: 4 in `independent_review_gate_test.ts` and
      `closure_verdict_test.ts`, then 3 in `standing_violation_3196_test.ts`
- [x] `independent_review_gate_test.ts`: `stands, left for a follow-up` blocks;
      `fixed in this diff` passes; `pre-existing, filed #123` passes; issue
      URLs and `owner/repo#n` pass; `#<n>` blocks
- [x] `closure_verdict_test.ts`: a standing violation is a coverage shortfall;
      a filed `#123` survives rendering and passes the gate
- [x] 69 targeted test files that read the touched code, prompt or docs: 656
      passed, 0 failed
- [x] `deno fmt --check`, `deno lint`, `deno task check`,
      `deno task check:manifests` all pass
