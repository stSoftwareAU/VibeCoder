# PR Summary — #2617

## Summary

Records [Getting the most out of Opus 5.5](https://claude.dev/blog/getting-the-most-out-of-opus-5-5/) in the "Read, not yet adopted" table of `docs/REFERENCES.md`, directly below the "Prompting Claude Opus 5.5" row. It also raises the two gap issues:

- #2635: a running checklist so progress survives summarisation. It targets `prompts/coding_guidelines/prompt.md` Long-Horizon Runs and must state how many lines it adds to the fixed prompt.
- #2636: a design anti-pattern list for front-end work. That issue decides which prompt or bucket carries it.

11 of the 15 tips are already covered. "Typing mid-run" has no surface to change here. `/fast` was declined because the worker runs unattended, where quality and token spend matter more than speed. No prompt, rubric or container change.

Closes #2617

## Evidence

- A docs-only change: one row added to `docs/REFERENCES.md`.
- `deno test tests/references_doc_test.ts tests/references_refresh_test.ts tests/references_refresh_command_test.ts`: 48 passed, 0 failed.
- `./quality.sh`: PASSED (config integration skipped, as usual locally).

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- [x] One new row in the "Read, not yet adopted" table, beside the Opus 5.5 row. **reviewer: PASS**. It is a single-line addition directly below that row.
- [x] "What it proposes for us" names both gaps. **reviewer: PASS**
- [x] It notes that `/fast` was considered and declined, and why. **reviewer: PASS**
- [x] "Tracked in" links both new issues (#2635, #2636). **reviewer: PASS**
- [x] Exactly two GitHub issues were raised, and both are open. **reviewer: PASS**
- [x] Each issue names the file it would change. **reviewer: PASS**. #2636 lists the candidate files and leaves the choice to itself, as #2617 specifies.
- [x] The checklist issue requires stating the lines it adds to the fixed prompt. **reviewer: PASS**
- [x] No prompt, rubric or container change. **reviewer: PASS**. Only `docs/REFERENCES.md` changed.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- Australian English: PASS ("summarisation").
- Concision: PASS. The reviewer suggested dropping the "11 of 15" count; it is kept because #2617 asks for it to be recorded.
- Stay in scope: PASS. One row, and each gap is tracked in an issue per Rule 3.
- Commit safety: PASS. No hidden or secret files.
- A code change owes a docs change: N/A (docs only).

## Test Plan

- [x] REFERENCES doc and refresh tests pass.
- [x] markdownlint is clean on `docs/REFERENCES.md`.
- [x] `./quality.sh < /dev/null` passes.
