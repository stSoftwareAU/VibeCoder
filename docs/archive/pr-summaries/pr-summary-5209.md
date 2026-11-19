# PR Summary — Issue #5209

## Summary

The issue prompt's PR Summary Test Plan rule no longer requires a per-assertion
removal inventory. It used to have the agent copy each removed assertion into a
`Removed from <path>` entry, justify it on a `Required by` / `Moved to` /
`Obsolete` + `Still covered by` / `Removed functionality` line, list each
replacement under `Replaced by:`, and add every replacement in the same test
file. It also described the worker counting removed assertions, which no worker
code does. All of that is replaced by a concise reference to
`CODING-STANDARDS.md` TDD rule 3. The rule now asks the agent to record which
old behaviour is obsolete or changed, which required behaviour remains, and
which replacement or existing coverage proves it. For removed functionality, the
evidence that the behaviour and its callers are gone is the proof. Rule 2 in
Instructions pointed at "the removal entries", so it now points at the Test Plan
rule under **PR Summary File**. Closes #5209.

## Spec

### Intent and Rationale

- #3739 kept recurring after it closed (32 independent PRs). Copying assertion
  syntax into a list does not show that the required behaviour is still
  protected. The two cited gaps (#4941 and NEAT-AI-Lamarck #275) were semantic
  coverage losses that a list cannot catch.
- TDD rule 3 is already the canonical policy, and it accepts existing coverage
  and genuinely removed functionality. The same-file/addition restriction got in
  the way of both, so the prompt now refers to rule 3 and does not keep a second
  copy of the policy.

### Essential Design Decisions

- These substantive requirements are kept: a removed behaviour assertion with no
  justification is still a blocking self-review finding, independent review
  checks the record against the head, the implementer's own assertion is not
  proof, and the issue requirement must be quoted from the issue itself.
- The Instructions rule 2 and "Change only what the issue changes" text is
  unchanged, apart from the one stale pointer. The existing tests that pin it
  still pass.
- No gate, lint rule, summary obligation, recovery trigger or auto-merge
  behaviour is added or changed.

### Undiscoverable Facts

- The recurrence count comes from the review-fleet-prs learning ledger
  (`guidance.ts due`), which is outside this repository.

## Evidence

This change touches only the prompt and a test, with no UI or runtime code. It
is verified by the documentation-drift test and the full gate.

- `worker/deno/lib/removed_assertion_gate.ts` is absent from the head. A grep of
  `worker/deno/lib/`, `worker/deno/commands/`, `.claude/` and
  `prompts/pr_review_brief/` for `removed_?assert`, `Removed from <`,
  `Replaced by:` and `Required by:` finds no parser or counter for these
  entries. That confirms the removed "The worker counts as removed …" sentence
  described nothing at the head.
- Doc surface updated: `prompts/issue/prompt.md`, both the "PR Summary File"
  Test Plan item and Instructions rule 2. On the final head, a stem grep for
  `removal entr|Removed from <|Replaced by:|Still covered by|counts as removed`
  across `*.md` and `*.ts` (outside `docs/archive/`, `docs/audits/` and the
  test's own retired-phrase list) finds no remaining hit for the schema. The one
  other match is the reviewer brief's general wording, "still covered by a
  `replacement` or `existing`", which agrees with TDD rule 3.
- Related existing rules checked:
  - `CODING-STANDARDS.md` TDD rule 3: now the referenced source, unchanged.
  - Issue prompt Instructions rule 2, "Change only what the issue changes":
    consistent, and only its pointer was reworded.
  - `prompts/pr_review_brief/prompt.md`, test-change review: consistent.
- Rule applied to this PR's own diff: the diff edits one existing test. Its
  record is below, in the shape the new rule asks for, with no `Removed from`
  schema.
- Provenance cited in the diff:
  - #5209: Simplify the ineffective per-assertion removal inventory after #3739
    recurrence.

## Test Plan

- `worker/deno/tests/kept_assertions_3061_docs_test.ts`, test "issue prompt - PR
  Summary Test Plan defers removed-assertion evidence to TDD rule 3":
  - It still asserts that the "PR Summary File" section says "blocking
    self-review finding" and "the issue requirement that makes it untrue".
  - It now also asserts the TDD rule 3 reference, "which required behaviour
    remains", "which replacement or existing coverage proves it", and "the
    evidence that the behaviour and its callers are gone".
  - It asserts that the retired schema phrases are absent.
  - Red before the prompt edit: `1 failed`, on the missing
    "`CODING-STANDARDS.md` TDD rule 3". Green after it: 3 passed, 0 failed.
- The one changed expectation is the dropped check for "this existing entry also
  covers obsolete call-count and call-order assertions".
  - Obsolete: the issue retires the per-entry syntax that sentence belonged to
    ("Remove the Removed from/Required by/Moved to/Replaced by syntax
    mandates").
  - Still required: obsolete call-count and call-order assertions remain
    justifiable as obsolete behaviour.
  - Coverage: the same test's new "which replacement or existing coverage proves
    it" and TDD rule 3 assertions, and the absence check that pins the
    retirement.
- Every test file that reads the issue prompt (66 files) was run with
  `deno task test:unit`, with 0 failures.
- `./quality.sh` on head `4b9d9090e` gave `PASSED (with skipped checks)`.
  `config integration` was skipped because there is no `.config.json`, and
  `checkov` was skipped because it is not on PATH.
  - The first run failed only on
    `worker/deno/tests/pr_summary_ci_workflow_3768_test.ts`, with
    `dns error: failed to lookup address information` while fetching `mdurl`.
    That test reads the default `~/.cache/deno`, which was cold on this host.
  - Copying the warm `DENO_DIR` npm cache there, outside the repository, made it
    pass (11 passed). The gate was then re-run.
