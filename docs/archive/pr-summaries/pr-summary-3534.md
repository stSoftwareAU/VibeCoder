# PR Summary — Issue #3534

## Summary

Adds `worker/deno/lib/summary_facts.ts`, a pure module for a versioned
summary-facts JSON document:

- `parseSummaryFacts(raw)` validates the document and returns a
  `Result<SummaryFacts>`. Every error names the field and the reason.
- `renderBranchOutcomes(facts)` renders the `Branch outcomes:` block
  deterministically. Hostile strings cannot break it.
- `namedTestPathsFromFacts(facts)` lists the declared test paths.

Closes #3534 ("Add a versioned summary-facts schema, validator and
Branch-outcomes renderer").

## Spec

### Intent and Rationale

- #3396 moves PR-summary facts from free text to structured data. This is the
  first step: a schema the worker can validate, and a renderer whose output the
  existing `Branch outcomes:` gate already accepts. Nothing calls it yet.
- The renderer round-trips through `parseBranchOutcomes`, so the existing gate
  and `namedTestPaths` keep working on rendered summaries unchanged.

### Essential Design Decisions

- The size cap (`MAX_FACTS_CHARS`) is checked before `JSON.parse`. `version`
  must be `1`. Unknown keys are refused at every level, and a hostile key is
  capped and quoted in the error, never echoed raw.
- Each entry is exactly one of `{test, testName, flipWentRed}` or
  `{exempt: {kind, reason}}`. `test` must pass `isTestFilePath`. `reason` must
  have at least 3 words, counted by the gate's own `reasonWordCount`, which this
  diff exports rather than copies.
- `MAX_ENTRIES` and `MAX_ENTRY_CHARS` are reused from `branch_outcomes_gate.ts`.
  The rendered entry is checked against `MAX_ENTRY_CHARS` at parse time, so a
  document that parses always renders to lines the gate accepts.
- Paths fail closed. They use a fixed character set (letters, digits,
  `_ . - /`), have no `..` or empty segment, no leading `/`, and are capped at
  `MAX_PATH_CHARS`.
- Rendering replaces control characters and line breaks with spaces. A code
  span gets a fence one backtick longer than the longest run inside it. Exempt
  reasons render as escaped plain text. All regexes are fixed literals with no
  nested quantifiers, and none is built from input.

### Undiscoverable Facts

- `assertLinearGrowth` measures wall-clock time, so the test file is listed in
  `WALL_CLOCK_TEST_FILES` in `lib/parallel_unsafe_test_manifest.ts`.
- Each new lib module needs a sweep-ledger slice, so
  `docs/audits/lib-sweep-coverage/top-up-3534.json` is added.

## Evidence

Backend-only change: no UI files are touched, so no screenshot.

- Issue numbers this diff adds as provenance: #3396, "Review learning loop:
  prefer deterministic checks, retire guidance that doesn't work, and make
  summary facts structured data"; #3534, "Add a versioned summary-facts schema,
  validator and Branch-outcomes renderer".

**Docs sweep** — grep: `reasonWordCount`, `summary_facts`, `WALL_CLOCK_TEST_FILES`, `parseBranchOutcomes`; section: none (new module with no documented surface); updated: none

Where each hit stands:

- **`reasonWordCount`.** Its only change is the `export`; its doc comment in
  `branch_outcomes_gate.ts` is still true.
- **`summary_facts`.** The only hits are the new module, its test, the sweep
  slice and the manifest entry.
- **`WALL_CLOCK_TEST_FILES`.** The manifest's doc comment still describes the
  new entry correctly.
- **`parseBranchOutcomes`.** Hits in docs describe the existing gate, which is
  unchanged.

### Author's own checks (not from the independent reviewer)

- Callers checked: `reasonWordCount` was module-private; exporting it changes
  no existing caller. `isTestFilePath`, `MAX_ENTRIES` and `MAX_ENTRY_CHARS` are
  only read, not changed.
- Each refusal probe has a legal counterpart that parses, so every rejection is
  refused by the rule its test names.
- Every regex has a hostile-input test, and the parser and renderer have linear
  growth tests.

## Test Plan

- 80 tests in `worker/deno/tests/summary_facts_3396_test.ts` pass.
- Each branch below was flipped in a scratch worktree. At least one test went
  red for every flip, and all pass with the code restored.
- `./quality.sh < /dev/null`: see the final line of this section.

Paths are relative to the repository root. `SF` is
`worker/deno/lib/summary_facts.ts` and `T` is
`worker/deno/tests/summary_facts_3396_test.ts`.

Branch outcomes:

- SF:103 — unknown key → refused — T `rejects: unknown branchOutcomes key` — flip went red
- SF:112 — non-object → "expected an object" — T `rejects: entry as array` — flip went red
- SF:118 — path not a string → refused — T `rejects: path as number` — flip went red
- SF:119 — empty path → refused — T `rejects: empty path` — flip went red
- SF:121 — path over MAX_PATH_CHARS → refused — T `rejects: over-cap path` — flip went red
- SF:124 — path outside the charset → refused — T `hostile path charset run is refused by the charset rule` — flip went red
- SF:126 — leading slash → refused — T `rejects: leading slash` — flip went red
- SF:129 — dot-dot segment → refused — T `rejects: dot-dot segment` — flip went red
- SF:132 — empty segment → refused — T `rejects: empty segment` — flip went red
- SF:140 — test path not a test file → refused — T `rejects: non-test test path` — flip went red
- SF:142 — test path without extension → refused — T `hostile dotted test path is refused by the extension rule` — flip went red
- SF:148 — line not a number → refused — T `rejects: line as string` — flip went red
- SF:150 — line not a positive safe integer → refused — T `rejects: line 1.5` — flip went red
- SF:160 — text not a string → refused — T `rejects: outcome as number` — flip went red
- SF:162 — text over MAX_FIELD_CHARS → refused — T `rejects: over-cap string` — flip went red
- SF:164 — multi-line text → refused — T `hostile long outcome ending in a newline is refused as multi-line` — flip went red
- SF:166 — empty required text → refused — T `rejects: empty outcome` — flip went red
- SF:192 — exempt missing key → refused — T `rejects: exempt missing reason` — flip went red
- SF:196 — bad exempt kind → refused — T `rejects: bad exempt kind` — flip went red
- SF:201 — reason under 3 words → refused — T `rejects: reason under 3 words` — flip went red
- SF:216 — both shapes → refused — T `rejects: both shapes` — flip went red
- SF:222 — neither shape → refused — T `rejects: neither shape` — flip went red
- SF:225 — missing path, line or outcome → refused — T `rejects: entry missing line` — flip went red
- SF:229 — partial test shape → refused — T `rejects: partial test shape` — flip went red
- SF:238 — endLine present → read — T `happy path: valid facts parse and equal the input` — flip went red
- SF:242 — endLine below line → refused — T `rejects: endLine below line` — flip went red
- SF:252 — endLine kept in the output — T `happy path: out-of-scope, none, and endLine == line` — flip went red
- SF:256 — exempt vs test shape built — T `round trip through parseBranchOutcomes and the gate` — flip went red
- SF:275 — rendered entry over MAX_ENTRY_CHARS → refused — T `rendered-entry cap: all fields at the cap are rejected, just under passes` — flip went red
- SF:289 — branchOutcomes missing key → refused — T `rejects: missing entries` — flip went red
- SF:293 — noneAdded not boolean → refused — T `rejects: noneAdded as string` — flip went red
- SF:299 — entries not an array → refused — T `rejects: entries as object` — flip went red
- SF:305 — over MAX_ENTRIES → refused — T `rejects: over-cap entries` — flip went red
- SF:308 — noneAdded with entries → refused — T `rejects: noneAdded true with entries` — flip went red
- SF:311 — not noneAdded and no entries → refused — T `rejects: noneAdded false with no entries` — flip went red
- SF:327 — raw not a string → refused — T `rejects: non-string raw input` — flip went red
- SF:329 — over MAX_FACTS_CHARS → refused before parse — T `rejects: over-cap file (checked before parse)` — flip went red
- SF:335 — invalid JSON → refused — T `rejects: invalid JSON` — flip went red
- SF:342 — missing top-level key → refused — T `rejects: missing version` — flip went red
- SF:345 — version not 1 → refused — T `rejects: version 2` — flip went red
- SF:372 — longest backtick run tracked — T `backtick fence is one longer than the longest inner run` — flip went red
- SF:375 — text starts or ends with a backtick → padded — T `backtick fence is one longer than the longest inner run` — flip went red
- SF:396 — line vs range rendered — T `render is deterministic and pinned` — flip went red
- SF:400 — exempt entry → exempt render — T `exempt reason renders as plain text that cannot open a span or comment` — flip went red
- SF:402 — untestable vs out-of-scope label — T `render is deterministic and pinned` — flip went red
- SF:418 — noneAdded → "Branch outcomes: none added" — T `round trip: none added` — flip went red
- SF:431 — only test entries named — T `round trip: de-duplicates declared tests in first-seen order` — flip went red

- `./quality.sh < /dev/null` on the final head: `Result: PASSED (with skipped checks)`, `exit=0`. The only skipped check is config integration, because this host has no `.config.json`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — parseSummaryFacts caps size before JSON.parse, requires version 1 and rejects unknown keys at every level. — evidence: `worker/deno/lib/summary_facts.ts (parseSummaryFacts, unknownKey); worker/deno/tests/summary_facts_3396_test.ts::rejects: over-cap file (checked before parse)` — reviewer: met
- **met** — branchOutcomes{noneAdded, entries} with mismatch rules; entry path, line, endLine and outcome rules. — evidence: `worker/deno/lib/summary_facts.ts (checkBranchOutcomes, checkEntry, checkPath, checkLine); worker/deno/tests/summary_facts_3396_test.ts::rejects: noneAdded true with entries` — reviewer: met
- **partial** — Each entry has exactly one of the test shape (test passes isTestFilePath) or the exempt shape (reason of at least 3 words). — evidence: `worker/deno/lib/summary_facts.ts (checkEntry, checkTestPath, checkExempt); worker/deno/tests/summary_facts_3396_test.ts::rejects: both shapes` — reviewer: partial — reason: testName and flipWentRed are free single-line text, so the schema cannot prove the flip happened
- **met** — Rejection table; errors name the field and the reason. — evidence: `worker/deno/tests/summary_facts_3396_test.ts::rejects: unknown branchOutcomes key` — reviewer: met
- **met** — Deterministic render that round-trips through parseBranchOutcomes with the same count and test paths. — evidence: `worker/deno/tests/summary_facts_3396_test.ts::round trip through parseBranchOutcomes and the gate; ::render is deterministic and pinned` — reviewer: met
- **partial** — Hostile strings cannot add a line or heading or close a code span. — evidence: `worker/deno/tests/summary_facts_3396_test.ts::hostile allowed strings render as single safe bullets; ::backtick fence is one longer than the longest inner run` — reviewer: partial — reason: the reviewer read the tests but did not run the hostile strings; the tests cover them and pass
- **met** — No regex is built from input and none has nested quantifiers. — evidence: `worker/deno/lib/summary_facts.ts:70-75` — reviewer: met
- **met** — Quality gate passes. — evidence: `./quality.sh < /dev/null` — reviewer: met
- **unrequested** — Path charset, empty-segment rule and MAX_PATH_CHARS, test-path extension rule, MAX_FIELD_CHARS, exported constants and types, escaping in plainText, sweep slice and manifest entry. — evidence: `worker/deno/lib/summary_facts.ts:30-75; docs/audits/lib-sweep-coverage/top-up-3534.json; worker/deno/lib/parallel_unsafe_test_manifest.ts` — reviewer: unrequested — reason: fail-closed hardening and gate-required housekeeping; the charset rule refuses paths containing `+`, `@` or a space

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **partial** — A refusal test must be refused by the rule it names: the rendered-entry cap test asserts only that a just-under input passes, not how close to the cap it is. — evidence: `worker/deno/tests/summary_facts_3396_test.ts::rendered-entry cap: all fields at the cap are rejected, just under passes` — reviewer: partial — reason: the at-cap refusal is asserted by name; the just-under bound is loose but the flip of SF:275 still goes red
- **partial** — Output encoding for the target sink: plainText escapes Markdown and HTML-comment openers but not `&`. — evidence: `worker/deno/lib/summary_facts.ts (plainText)` — reviewer: partial — reason: the sink is Markdown parsed line by line by parseBranchOutcomes, where `&` cannot add a line, open a span or close one
- **clean** — Australian English, named tests exist, reasonWordCount reused rather than copied, one hostile case per regex, every branch outcome reached, legal counterpart for each refusal probe, no workflow changes. — evidence: `worker/deno/tests/summary_facts_3396_test.ts::refusal probes: the same input with the value made legal is accepted` — reviewer: clean
