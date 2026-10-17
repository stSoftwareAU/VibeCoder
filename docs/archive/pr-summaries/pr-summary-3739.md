## Summary

Removed assertion entries now need a verified move destination or a quoted
requirement from the issue title/body. Declared replacements must name
assertions added in the same test file. The Standards reviewer identifies
replacement pairs, including omitted entries, and checks for lost coverage.
Closes #3739.

## Spec

### Intent and Rationale

- Naming a removed assertion does not establish that removing it is justified.
- A deterministic reason check supports the existing semantic review; it
  cannot decide whether the cited requirement actually invalidates the check.

### Essential Design Decisions

- Quotes require at least five words and a whitespace-normalised verbatim
  match in issue title/body, never comments. Completion supplies those inputs.
- Moves require canonical matching added assertions and preserve the existing
  guard/context protections. Reasons are local to each Test Plan entry.
- Added assertions in unrelated tests do not imply replacement. Explicit
  replacement entries are validated mechanically; the reviewer detects missing
  entries and compares old/new coverage.

### Undiscoverable Facts

- Independent review identified that requiring a replacement entry for any
  added assertion in a file would force false claims about unrelated tests.
  The final implementation avoids that inference; its regression failed
  against the earlier conservative implementation.

## Evidence

Reproduction status: reproduced. The new reason suite fails the previous
name-only gate for fabricated/absent requirements, wrong moves and unsupported
replacement claims. Live completion tests distinguish title/body quotes from
comment-only quotes. No UI change.

**Docs sweep** — grep: `Required by:`, `Replaced by:`, `removed assertion`; section: CODING-STANDARDS.md Test-Driven Development rule 3; updated: CODING-STANDARDS.md, prompts/issue/prompt.md, docs/workflows/issue-processing.md; siblings: none — this strengthens the existing assertion-removal contract.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Missing, short and fabricated requirement quotes fail; verbatim
  title/body quotes pass, including whitespace normalisation.
- **met** — Move destinations require matching added assertions and context.
- **met** — Declared replacements require added assertions in the same file.
- **met** — Completion supplies issue inputs; retry explains the entry shape;
  Standards review compares semantic coverage and identifies omitted pairs.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Independent review checked quote provenance, entry-local reasons,
  move context, replacement provenance and the reviewer brief. The unrelated
  addition false positive was fixed before publication.

## Test Plan

- `worker/deno/tests/removed_assertion_reasons_test.ts`: 18 reason scenarios.
- Existing `worker/deno/tests/removed_assertion_gate_test.ts` and
  `worker/deno/tests/removed_assertion_gate_context_test.ts` keep their expected outcomes; valid
  summary fixtures now provide real structured reasons and issue text.
- `worker/deno/tests/completion_phase_removed_assertion_test.ts`: no reason
  blocks; title quotes qualify; comment-only quotes fail. Existing success
  fixtures carry the newly required structured reason; assertions are retained.
- Initial reason regressions: 13 failed on the previous gate and two existing
  behaviours passed. The assertion-focused exact frozen run passed 143 tests.
  The independent-added-test regression also failed against the intermediate
  blanket replacement rule. Final combined scoped run passed 344 tests.
- An additional template-literal replacement regression failed on the single-backtick parser. The shared Markdown tokenizer now accepts longer code-span delimiters, retaining exact assertion matching.
- `worker/deno/tests/kept_assertions_3061_docs_test.ts` retains both coverage
  assertions. Its missing explicit `Replaced by:` comparison instruction
  reproduced as a failure; the final brief restores that phrase while keeping
  the instruction to detect omitted pairs. The five guidance tests and the
  wider 330-test completion run pass.
- The full hosted quality gate passed; [#3710](pr-summary-3710.md) records the
  tested commit, run and sole configuration integration skip.
- The edited completion summary fixture contains an assertion as quoted test
  data. It gains a real `Required by:` field and matching issue-body fixture;
  the assertion being tested and every actual completion expectation remain.

- Removed from `worker/deno/tests/completion_phase_removed_assertion_test.ts`: ``- Removed from \`crates/api/tests/decisions.rs\`: \`assert_eq!(record.score.to_string(), "-0.5")\` — #2253 changes the score to a rating, so the old value is untrue``
  Required by: "each removed assertion's Test Plan entry must carry one of two structured reasons"

This scanner-reported removal is assertion-shaped summary fixture text,
not an executable assertion. Its new structured reason is the behaviour
under test; the score assertion and actual completion checks remain.

**Branch outcomes:**

- Valid quote accepted / short, fabricated or comment-only quote refused — `worker/deno/tests/removed_assertion_reasons_test.ts`, `worker/deno/tests/completion_phase_removed_assertion_test.ts`.
- Matching move accepted / absent, duplicate or differently guarded move refused — `worker/deno/tests/removed_assertion_reasons_test.ts`, `worker/deno/tests/removed_assertion_gate_context_test.ts`.
- Added replacement accepted / non-added replacement refused / unrelated addition needs no false replacement claim — `worker/deno/tests/removed_assertion_reasons_test.ts`.
- Entry-local reason accepted / another entry's reason cannot justify removal — `worker/deno/tests/removed_assertion_reasons_test.ts`.
