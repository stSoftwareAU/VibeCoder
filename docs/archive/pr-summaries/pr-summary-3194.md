## Summary

Adds the rule **"Check where you insert"**. Fleet PRs added a new item or
paragraph at a point that cut existing text off from what it describes, and the
docs sweep did not catch it, because the sentence made wrong was not one the
diff added or edited. GRQ-AutoTrader#2218 and #2413 each put a new Rust function
between another function's doc comment and that function, so rustdoc opened the
new helper's doc with the other function's description. GRQ-AutoTrader#2478 put
a new paragraph in front of "Both paragraphs above describe …". Closes #3194.

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md` ("A Code
  Change Owes a Docs Change"): a new last bullet, word for word identical on
  both surfaces. Before adding a function, item, test or paragraph, read the
  lines directly above and below the insertion point. Insert above an existing
  doc comment, attribute or decorator, never between it and its item. A
  following sentence that points back must still point at what it meant; if not,
  insert after it or reword it to name its subject. Read the first and last
  context lines of every hunk that adds a block.
- `prompts/issue/prompt.md` (PR Summary File, the self-review list that holds
  "the doc comment above a changed function"): a matching **Check where the diff
  inserts** step. It is the last bullet of that list. The bullet before it,
  "re-run this check", still refers to the doc-claims check, as it did before.
- `docs/workflows/issue-processing.md`: a paragraph recording the rule and its
  three examples, after the #3093 paragraph.

## Spec

### Intent and Rationale

- All three review findings came from the same mistake: the insertion point was
  chosen without reading the line directly above and the line directly below.
  The break always shows up within a few lines of the hunk boundary, so a short
  read prevents it. No tooling is needed, and Clippy's
  `empty_line_after_doc_comments` cannot catch the Rust case because there is no
  blank line.

### Essential Design Decisions

- The rule sits in "A Code Change Owes a Docs Change" because it covers the gap
  in the docs sweep. The drift test pins it as identical on both surfaces, as
  the #3093 and #3164 rules are pinned.
- Each new block is appended where its own insertion does not break a
  back-reference. In the issue prompt that is after the last bullet, not
  directly under the doc-comment bullet, because the bullet that follows that
  one opens with "re-run this check".
- Related existing rules checked: **A new branch must be reachable by the input
  it exists for** (#3167, "list each exit above the insertion point") covers
  control flow, not text placement. It does not conflict, and it is unchanged.
  The other bullets of "A Code Change Owes a Docs Change" cover text the diff
  touches or names. The new bullet adds the neighbouring text, and none of them
  needed changing.

### Undiscoverable Facts

None.

## Evidence

This change has no UI and no runtime code. It changes prompts and standards
only.

**Docs sweep** — grep: "Owes a Docs Change", "insertion point", "between it and
its item", "doc comment directly above"; section:
`docs/workflows/issue-processing.md` (the test-discipline paragraphs,
#3093/#3164); updated: `docs/workflows/issue-processing.md`. Hits left in place:
`CODING-STANDARDS.md:414`, `prompts/coding_guidelines/prompt.md:1226`,
`prompts/issue/prompt.md:1053` and `docs/workflows/issue-processing.md:1264` —
still true because they are the #3167 reachability rule about early exits, which
this change does not alter. `prompts/issue/prompt.md:162` and
`CODING-STANDARDS.md:1142` — still true because they link to the section by
name, which is unchanged.

## Test Plan

- Added `worker/deno/tests/insertion_point_rule_3194_docs_test.ts` (2 tests).
  - Written first and run before any doc or prompt edit: both failed
    (`FAILED | 0 passed | 2 failed`).
  - After the edits, both passed (`ok | 2 passed | 0 failed`).
- Every test file under `worker/deno/tests` that reads `CODING-STANDARDS.md`,
  the coding_guidelines prompt, the issue prompt or
  `docs/workflows/issue-processing.md` (93 files, the new suite among them), plus
  `prompt_house_vocabulary_drift_test.ts`: `ok | 886 passed | 0 failed`.
- `deno fmt --check`, `deno lint`, `deno task check` and
  `deno task check:manifests` pass.
- The full suite and the full `./quality.sh` were not run here, because they get
  OOM-killed in this shared container. CI runs them.
