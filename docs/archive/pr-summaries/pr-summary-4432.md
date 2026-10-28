## Summary

Mined the Google Rust Style Guide for rules the Rust best-practices bucket did not check. Nine become new checks 43–51 in a new `## Google Rust Style Guide learnings` section of `prompts/best_practices/buckets/rust.md`, each with a grep-able pattern and `severity:low`. The guide is credited in `docs/REFERENCES.md` and `docs/BEST-PRACTICES-SCAN.md`. Closes #4432.

Version bump: none; prose-only change to a prompt bucket and two docs.

## Spec

### Intent and Rationale

- The issue asks whether the guide teaches us anything and, if so, to update the reference doc, the prompts and the scans. Nine grep-able gaps qualified; each is a numbered check so the scan files it like checks 1–42.
- A new section (not folded into checks 1–42) follows the precedent of `## Toolchain 1.95–1.99 learnings`: a mined source gets its own preamble and `### Checks` list.

### Essential Design Decisions

- Every new finding is `severity:low`, because none fails a build on its own. The toolchain section differs (deny-by-default lints), so it escalates; this one does not.
- Checks name the clippy lint only as an optional human confirmation; the scan never runs clippy, matching the bucket's static-evidence discipline.
- The guide's `[chrome]` / `[Fuchsia]` rules and judgement calls (naming, `Rc`/`Arc`, iterator chains) are excluded. `prompts/coding_guidelines/prompt.md` is untouched so it stays language-neutral.
- Overlaps are cross-referenced, not duplicated: check 48 defers reachability to check 12 and `debug_assert!` safety to check 10; check 49 leaves lock ordering to check 16; check 50 accepts the FFI case that check 20 already requires; check 51 points at check 30's "let the human confirm" discipline.

### Undiscoverable Facts

- Scope, severity and placement were agreed in the issue's grill-me rounds (all recommended options kept).
- Nothing is fetched at run time; the guide is restated in our own words (rule 2 of `docs/REFERENCES.md`).
- Clippy was not installed in this environment, so lint group labels (pedantic / restriction / warn-by-default) come from the lint documentation, not a run.

## Evidence

Prose-only change, no code or UI. Verified by tests that read these files and by the markdown linter.

- `prompts/best_practices/buckets/rust.md`: fourth canonical-guide bullet; new section with checks 43–51 (each appears once, in order).
- `docs/REFERENCES.md`: new Google Rust Style Guide row in "Language and platform best practices", pointing at `prompts/best_practices/buckets/rust.md` (an existing path, so the path-exists test keeps passing).
- `docs/BEST-PRACTICES-SCAN.md`: guide added to the `rust` row of the bucket table, plus a short `### Rust style-guide checks` subsection.
- Stale-doc sweep: grep of `README.md`, `docs/` (excluding `docs/archive/`), `prompts/` and `CODING-STANDARDS.md` for a "42 checks" / "1–42" count found no list of the Rust bucket's checks needing the new members. Sibling members grepped: the existing `### Rust bug-class checks` and `### Rust build profiles` subsections; their counts ("three build-profile checks") describe their own sub-lists and stay true.

## Test Plan

- `deno test -A tests/bucket_docs_test.ts tests/references_doc_test.ts tests/markdown_anchors_test.ts` (from `worker/deno`): 41 passed, 0 failed.
- `tests/best_practices_cost_speed_reliability_test.ts` and `tests/best_practices_verbose_gate_test.ts` (both read `docs/BEST-PRACTICES-SCAN.md`): 19 and 30 passed, 0 failed.
- `markdownlint-cli2` over the three edited files: 0 issues.
- No test added: the change is prompt and doc prose with no new behaviour; existing tests already guard that credited paths exist, bucket files are documented, and anchors resolve. No existing test was edited.
- `deno fmt --check` on `rust.md` fails identically on the unmodified HEAD copy (existing prose width); not touched.
- Rule applied to this PR's own diff: the only claims about other components are cross-references to checks 10, 12, 16, 20 and 30, each read at head (check 20 names `catch_unwind` at the FFI boundary; check 10 names `debug_assert!`; check 12 names reachable `assert!`). Related existing rules checked: checks 2, 8, 12, 16, 20 and 30 in the same bucket. Found no contradiction.

<!-- vibe-quality-gate-skipped reason="prose-only change; targeted tests and markdownlint run instead, full ./quality.sh left to CI and the worker's pre-PR gate" -->
