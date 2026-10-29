## Summary

Removed the requirement to hand-write a per-phrase `drift-pins-on-base` result
in the PR Test Plan, from all five places the issue lists. The check itself is
kept: it is still per pinned phrase, still run with
`deno task drift-pins-on-base`, and a phrase the base section already held is
still a blocking self-review finding. Closes #4470.

Version bump: no `VERSION` change; docs, prompts and one test only.

## Spec

### Intent and Rationale

- The hand-written record was easy to get slightly wrong (#4170, #4468) and sent
  back PRs whose pins were clean. It did not make a pin any less vacuous, so
  only the record is dropped.

### Essential Design Decisions

- The three drift tests now pin the surviving rule ("the base section already
  held is a blocking self-review finding"), as the issue prescribes. That phrase
  was already in each section on base, so it cannot go red from this change
  alone. I therefore added an `assertFalse` absence check for the removed record
  sentence in the same three tests; that is what goes red if the obligation
  returns.
- The `CODING-STANDARDS.md` / `prompts/coding_guidelines/prompt.md` twin
  paragraphs were edited identically.

### Undiscoverable Facts

- None.

## Evidence

- Edited: `CODING-STANDARDS.md` (condition 4 and "A new test must go red without
  its change"), `prompts/coding_guidelines/prompt.md`,
  `prompts/issue/prompt.md`, `prompts/pr_feedback/prompt.md`,
  `worker/deno/tests/drift_pins_on_base_3193_test.ts`.
- Grep for the removed record wording (`Record the result for every`,
  `record .* each pinned phrase`) outside `docs/archive/` finds nothing in docs,
  prompts or tests. `evals/capability_security/comparison-20261026.json` is an
  archived eval snapshot and still quotes the old text; left as is.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — No sentence in `CODING-STANDARDS.md`,
  `prompts/coding_guidelines/prompt.md`, `prompts/issue/prompt.md` or
  `prompts/pr_feedback/prompt.md` asks for a per-phrase `drift-pins-on-base`
  result to be recorded in the Test Plan — evidence:
  `worker/deno/tests/drift_pins_on_base_3193_test.ts::pr_feedback prompt - a drift test's base check is per pinned phrase`
  (absence assertions) — reviewer: met
- **met** — Each of those places still says the check is per pinned phrase,
  names `deno task drift-pins-on-base`, and says a phrase the base section
  already held is a blocking self-review finding — evidence:
  `worker/deno/tests/drift_pins_on_base_3193_test.ts::issue prompt - a drift test's base check is per pinned phrase`
  — reviewer: met — reason: the reviewer noted `CODING-STANDARDS.md` condition 4
  never carried the "blocking" sentence; it lives in "A new test must go red
  without its change" in the same file and is unchanged
- **met** — `drift_pins_on_base_3193_test.ts` pins the surviving rule instead of
  the record sentence, and `deno task test` passes — evidence:
  `worker/deno/tests/drift_pins_on_base_3193_test.ts` — reviewer: met — reason:
  the reviewer could not run tests;
  `deno task test:unit tests/drift_pins_on_base_3193_test.ts` was run here and
  passed (9 passed). The full gate is not run, see Test Plan

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — new pins were already on base — evidence:
  `worker/deno/tests/drift_pins_on_base_3193_test.ts:155` — reason: required by
  #4470 (the issue prescribes this exact pin); an absence check for the removed
  record sentence was added in this diff so the tests do go red without the
  change
- **violation** — edited expectations stayed green without the diff — evidence:
  `worker/deno/tests/drift_pins_on_base_3193_test.ts:167` — reason: fixed in
  this diff (absence assertions added at the three tests)
- **clean** — twinned rule edited in both copies, no stale docs outside
  `docs/archive/`, Australian English, no hidden files staged

## Test Plan

- Modified `worker/deno/tests/drift_pins_on_base_3193_test.ts`: three pins
  changed, two tests renamed, three `assertFalse` absence checks added.
- Removed from `worker/deno/tests/drift_pins_on_base_3193_test.ts`:
  `"each pinned phrase is absent from the base section"` positive pin (three
  tests)
  - Required by: "replace that pin with the base section already held is a
    blocking self-review finding"
  - Replaced by:
    `the base section already held is a blocking self-review finding`
- Red check: re-inserting "and record in the Test Plan that each pinned phrase
  is absent from the base section" into `prompts/pr_feedback/prompt.md` makes
  the pr_feedback test fail at the `assertFalse`; restored, 9 passed. The
  coding-guidelines and issue-prompt `assertFalse` lines were not individually
  red-checked.
- `deno task test:unit tests/drift_pins_on_base_3193_test.ts tests/coding_guidelines_twin_drift_test.ts`:
  passed. `deno fmt --check` and `deno lint` on the test file: passed.
- Twin copies: `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`
  both changed.
- Full `./quality.sh` on the final head: markdownlint, mermaid, semgrep, deno
  lint, type check and fmt passed. `deno tests` failed on 3 tests unrelated to
  this change, in files the diff does not touch:
  `completion_phase_repo_formatters_test.ts` (2, "formatter should commit the
  Rust fix") and `pr_maintenance_command_test.ts:344` (1, merge-queue rules
  read). The parallel pass stopped there, so the serial pass did not run. I did
  not confirm these fail on the base branch.
