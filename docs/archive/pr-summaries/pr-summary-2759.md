# PR Summary — Issue #2759: first recorded security sweep of the prompt templates

Refs #2759

## Summary

This is the first recorded security sweep of the 34 `prompts/*/prompt.md`
templates. The record is
`docs/audits/security-sweep-2759-prompt-templates.md`. It gives one triage line
per template and covers five classes: unfenced untrusted text, steerable
tool/label/lifecycle use, secret or path disclosure, reserved-label
self-application, and missing treat-as-data guidance. Four surviving findings
are filed as #3045, #3046, #3047 and #3048.

- `docs/audits/security-sweep-2759-prompt-templates.md` (new) — the method, the
  triage table, the surviving findings, and notes below the filing threshold.
- `worker/deno/lib/lib_sweep_coverage.ts` — `"prompts"` is added to
  `SWEEP_COVERAGE_ROOTS`. `listSweptModules` now also lists files named
  `prompt.md`. Doc comments are updated.
- `docs/audits/lib-sweep-coverage.json` — `prompts` added to `roots`, and a new
  `10-prompts` slice (`sweptAt` `3a566abe0938798bf4996ebe8a6a183f51a20d51`)
  claims all 34 `prompts/*/prompt.md` paths.

This PR went through a review round that found the ledger slice missing from
an earlier head; commit `236c6da72` ("Address PR #3049 feedback") added the
`10-prompts` slice and the `prompts` root. At the current head, the ledger
slice is present, `sweep-drift` reports zero drift for it (no prompt template
changed between `sweptAt` and head), and the coverage and prompt-listing
tests genuinely exercise it.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The record lists every tracked `prompts/*/prompt.md` with a triage
  line — evidence: `docs/audits/security-sweep-2759-prompt-templates.md` (the
  triage table matches `git ls-files 'prompts/*/prompt.md'`, 34 files) —
  reviewer: met
- **met** — A ledger slice covers the prompt templates, and `sweep-drift`
  reports zero drift for it at the PR head — evidence:
  `docs/audits/lib-sweep-coverage.json` — the `10-prompts` slice lists all 34
  `prompts/*/prompt.md` paths with `sweptAt` `3a566abe`, and `roots` includes
  `prompts` — reviewer: met
- **met** — `lib_sweep_coverage_test.ts` and the `sweptAt` ancestry guard
  pass, genuinely exercising the prompts slice — evidence:
  `deno task test:unit tests/lib_sweep_coverage_test.ts
  tests/lib_sweep_coverage_prompt_listing_test.ts` (38 passed, 0 failed); the
  "every non-test module under the ledger roots is claimed by exactly one
  sweep slice" test walks `ledger.roots`, which now includes `prompts` —
  reviewer: met
- **met** — `./quality.sh` / CI passes — evidence: all PR #3049 checks green at
  head `cae0dbe1` (Analyze, CodeQL, gitleaks, markdown-lint, semgrep,
  validate-scripts) — reviewer: met
- **met** — Each surviving finding is filed as its own issue (from "What Needs
  to Be Done") — evidence: #3045, #3046, #3047, #3048 (all open, labelled
  `security`) — reviewer: met
- **met** — `listSweptModules` matches `prompt.md`, and the exclusion of
  `prompts/<type>/buckets/*.md` is tested — evidence:
  `worker/deno/tests/lib_sweep_coverage_prompt_listing_test.ts` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **resolved** — Docs must match code — evidence:
  `docs/audits/security-sweep-2759-prompt-templates.md:14` — the record's claim
  that the `10-prompts` slice claims all 34 templates now matches the ledger.
- **resolved** — Docs must match code — evidence:
  `docs/audits/lib-sweep-coverage.json` — `prompts` is in `roots` and the
  `10-prompts` slice claims every template, matching the `description`.
- **resolved** — Incomplete change — evidence:
  `docs/audits/lib-sweep-coverage.json` — the `10-prompts` slice points at
  `docs/audits/security-sweep-2759-prompt-templates.md`, so both the
  record-exists test and `sweep-drift` see it.
- **resolved** — TDD — evidence:
  `worker/deno/tests/lib_sweep_coverage_prompt_listing_test.ts` — the
  `prompt.md` match in `listSweptModules`, including the
  `prompts/<type>/buckets/*.md` exclusion, is now tested.
- **resolved** — KISS (the change had no effect) — evidence:
  `worker/deno/tests/lib_sweep_coverage_test.ts:400` — `SWEEP_COVERAGE_ROOTS`
  is now asserted against the ledger's `roots` by
  `"the ledger's roots match SWEEP_COVERAGE_ROOTS"`.
- **violation (unresolved, pre-existing)** — Commit messages must reference the
  issue — evidence: commit `b3eb751f` — its message names #4170, not #2759.
  This commit predates the review round and is already on the branch's shared
  history; rewriting it now would require a force-push over commits later
  commits build on, so it is left as a standing minor nit rather than rewound.
- **clean** — Australian English spelling; the record's template count and
  per-template line counts match the swept commit `3a566abe`; the "fourteen"
  counts for #3045 and #3048 match the triage table; the Deno/TypeScript style
  of the predicate change; JSDoc `@param` tags kept; no source-grepping tests
  added.

Note: `sweptAt` (`3a566abe`) is an older ancestor than the branch's later
merge-base with `main`; prompt content is identical across that gap, so drift
is zero and there is no functional impact.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
