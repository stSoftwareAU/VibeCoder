# PR Summary — Issue #839

## Summary

Applies the house vocabulary (`docs/PROMPT-HOUSE-VOCABULARY.md`) to the eight
remaining prompt directories — the two injected guidelines fragments, the four
lightweight audits, `issue` and `workflow_setup`. Five carried drift;
`alert_feed`, `bash_syntax_audit` and `coding_guidelines_claude` were already at
the house form and are untouched. Names and casing only: no instruction, gate,
output contract or worked-example body changed. Closes #839.

| Change | Files |
| --- | --- |
| Mode heading → `## <X> Mode` | `issue` (had none), `workflow_setup` (was `## System Context`) |
| Repo-standards section → `## Project Guidelines` | `issue` (was `## Coding Guidelines`) |
| Worked examples → `### Worked Examples` | `issue`, `coding_guidelines` (both were H2) |
| Persona → `senior engineer` | `coding_guidelines` (was "an experienced software engineer") |
| Bare `quality.sh` → `./quality.sh` | `issue:465`, `coding_guidelines:943` |
| Prose `markdown` → `Markdown` | `issue` (×3) |
| `the executor` → `the worker` | `workflow_annotation_scan` (×2) |

**The issue's mechanism no longer exists.** It asked for one new `vN.md` per
directory. Issue #844 (commit `c97783b`) removed prompt versioning: every
directory holds a single `prompt.md` and `loadPrompt()` reads only that file, so
the edits land there with git history as the record — the same landing #838 used
for the interactive batch.

**One worker source file changed, deliberately.**
`worker/deno/lib/prompt_leak_redaction.ts:88` quoted the guidelines' opening
sentence verbatim in `RAW_LEAK_PHRASES` — the fallback that masks a leak when a
model echoes the injected block without its `<coding_guidelines>` tags. Renaming
the persona without updating that literal would have silently stopped the
fallback matching its own template. The phrase is updated and pinned by a new
test that reads the sentence from `prompts/coding_guidelines/prompt.md`, so the
two cannot drift apart again.

## Evidence

Prompt-text and CLI change with no web interface, so no screenshot applies.
Evidence is the gate, the new regression test, and the post-change sweep.

Post-change sweep over the eight templates — every banned form is gone:

```text
$ grep -inE 'the executor|VibeCoder|idle task|experienced software engineer' <the eight>
(no output)
$ grep -nE '(^|[^./`a-zA-Z-])quality\.sh' <the eight>
(no output)
$ grep -n 'markdown' <the eight>
prompts/workflow_setup/prompt.md:180:  `markdownlint` produce false positives   # tool name — exempt
prompts/coding_guidelines/prompt.md:753:- `.markdownlint-cli2.jsonc` (markdownlint config)   # filename — exempt
prompts/issue/prompt.md:549,601,640,783,816,828:```markdown                       # fence infostrings — exempt
$ grep -n './quality.sh < /dev/null' prompts/coding_guidelines/prompt.md
362:./quality.sh < /dev/null                                # preserved verbatim
$ grep -rn 'System Context|## Coding Guidelines|Worked Examples' worker/deno/ --include=*.ts
worker/deno/tests/prompt_house_vocabulary_doc_test.ts:224-230                     # asserts on the canon doc, not on templates
```

No renamed heading was a code anchor.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — Eight new `vN.md` files, one per directory; no existing `vN.md`
  modified or deleted — evidence: five edited `prompts/*/prompt.md`, no version
  files anywhere — reviewer: met — reason: the literal mechanism was removed by
  #844 before this run, so the equivalent landed instead: one edit per directory
  that carried drift, three no-ops where there was none.
- **missing** — Each new file's H1 states its own new version number —
  reviewer: missing — reason: no version files exist post-#844, so there is no
  version H1 to state.
- **met** — `prompts/issue/` opens with `## Issue Implementation Mode`;
  `prompts/workflow_setup/` with `## Workflow Setup Mode` — evidence:
  `prompts/issue/prompt.md:2`, `prompts/workflow_setup/prompt.md:2` —
  reviewer: met.
- **partial** — `issue` uses `## Project Guidelines`; worked-examples sections
  are `### Worked Examples` — evidence: `prompts/issue/prompt.md:158`,
  `prompts/issue/prompt.md:393`, `prompts/coding_guidelines/prompt.md:1006` —
  reviewer: partial — reason: `prompts/bash_script_refs/prompt.md:52` keeps
  `## Worked examples — the reported / not-reported boundary`. It is a
  lightweight audit, and the canon scopes the `### Worked Examples` row to the
  interactive family; demoting a peer section under `## Known limitations` would
  misfile it. A casing-only edit was made and then reverted after review, on the
  Standards reviewer's point that it manufactures the exact `## Worked Examples`
  literal the canon bans.
- **partial** — `coding_guidelines` and `coding_guidelines_claude` both state
  the `senior engineer` persona and stay consistent — evidence:
  `prompts/coding_guidelines/prompt.md:1` — reviewer: met — reason: the criterion
  is unsatisfiable as written. `coding_guidelines_claude` is a *Working Style*
  overlay appended to the base block (`coding_guidelines_overlay.ts`), not a
  byte-twin, and carries no persona line; adding one is a presence gap the issue
  puts out of scope. The composed block states the persona once.
- **met** — No `the executor`, `VibeCoder` in prose, bare `quality.sh`,
  `idle task` or lowercase prose `markdown` across the eight;
  `./quality.sh < /dev/null` preserved — evidence: the greps under
  **Evidence**; `prompts/coding_guidelines/prompt.md:362` unchanged —
  reviewer: met.
- **met** — No persona line and no section added beyond the two mode headings —
  evidence: the diff adds exactly two heading lines; the four persona-less
  audits are untouched — reviewer: met.
- **partial** — A grep of `worker/deno/` confirms no renamed heading was a code
  anchor; no worker source file is modified — evidence: the grep under
  **Evidence** for the first half; `worker/deno/lib/prompt_leak_redaction.ts:88`
  for the second — reviewer: partial — reason: the heading half holds. The
  persona sentence, not a heading, *was* a code anchor: it is a literal in
  `RAW_LEAK_PHRASES`, so the rename required that one-line update or the leak
  fallback would have gone silently stale.
- **met** — `./quality.sh` passes — evidence: full gate run in the foreground
  after the final edit — reviewer: missing — reason: the reviewer saw only the
  diff and could not run the gate; it was run here.
- **unrequested** — `worker/deno/lib/prompt_leak_redaction.ts:88` — reviewer:
  unrequested — reason: required by the persona rename, as above; leaving it
  would have been a silent security regression.
- **unrequested** — `worker/deno/tests/prompt_leak_redaction_test.ts:104` —
  reviewer: unrequested — reason: the regression test that pins the phrase to
  the template so the coupling cannot break silently again.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — No PR summary recorded the batch — evidence:
  `docs/archive/pr-summaries/pr-summary-839.md` (absent at review time) —
  reason: fixed here; this file is the summary.
- **violation** — Out-of-scope casing edit manufactured the banned
  `## Worked Examples` literal in a lightweight audit — evidence:
  `prompts/bash_script_refs/prompt.md:52` — reason: fixed — the edit is reverted
  and the file is untouched by this PR.
- **violation** — Demoting `## Worked Examples` to H3 nests it under
  `## Untrusted Images`, whose scope it exceeds — evidence:
  `prompts/coding_guidelines/prompt.md:1006` — reason: stands. The issue names
  this exact site for the H2 → H3 change and the canon bans the H2 form;
  relocating the section is a structural move, not a name, so it is outside a
  names-and-casing sweep. The same nesting applies at
  `prompts/issue/prompt.md:393` under `## Escape Hatch`, where the canon does
  mandate H3 for the interactive family.
- **violation** — Boy Scout Rule on a touched line: the sentence still ends
  "…invokes it before `./quality.sh`; see." — evidence:
  `prompts/coding_guidelines/prompt.md:943` — reason: stands. The dangling
  clause is one of several link-stripping artefacts in this template (e.g. the
  `gitignore_enforcer.ts` parenthesis at :793); fixing one instance of a class
  in a names-and-casing sweep leaves the file less consistent, not more.
- **clean** — Australian English throughout the diff; no American spellings
  introduced; `Favour`/`stabilise` preserved.
- **clean** — Vocabulary sweep correctness across all eight directories; the
  `./quality.sh < /dev/null` exemplar preserved verbatim; remaining lowercase
  `markdown` occurrences are fence infostrings, tool names and filenames.
- **clean** — Twin consistency: `coding_guidelines_claude` is an overlay with no
  persona line, so the three untouched directories are correct no-ops.
- **clean** — No code anchors broken; mode-heading placement matches the
  `{{VERBOSITY_INSTRUCTIONS}}` + H2 shape of the interactive batch.
- **clean** — TDD linkage verified by hand (red with the old phrase restored,
  green as committed); the test exercises real code, not a source grep; fail-loud
  `assert` before dereferencing the loaded template.

## Test Plan

- Added `worker/deno/tests/prompt_leak_redaction_test.ts::prompt leak - masks
  the injected guidelines' own opening line (Issue #839)`. It reads the first
  paragraph of `prompts/coding_guidelines/prompt.md`, feeds it to
  `detectPromptLeakage()` / `redactPromptLeakage()` as if a model had echoed it,
  and asserts the paragraph is masked. Observed failing with the pre-rename
  phrase restored in `prompt_leak_redaction.ts` (`0 passed | 1 failed`) and
  passing as committed (`16 passed | 0 failed`).
- Re-ran the template-reading suites that could have anchored on a renamed
  heading: `workflow_setup_prompt_test.ts`, `workflow_setup_prompt_v5_test.ts`,
  `workflow_setup_prompt_v8_test.ts`,
  `workflow_annotation_scan_template_test.ts` (30 passed),
  `coding_guidelines_twin_drift_test.ts`,
  `prompt_house_vocabulary_doc_test.ts`, `coding_guidelines_overlay_test.ts`,
  `prompt_builder_test.ts` (101 passed).
- `./quality.sh < /dev/null` run in the foreground after the final edit.
