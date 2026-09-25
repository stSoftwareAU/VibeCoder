# PR Summary — Issue #2636: a design anti-pattern list for front-end work

## Summary

Closes #2636

- **`prompts/best_practices/buckets/html.md`** gets a new section, **Visual
  design anti-patterns**, with seven short checks (10–16):
  - low text contrast;
  - colour used as the only signal;
  - the focus ring removed;
  - tiny or crowded tap targets;
  - zoom blocked, or a fixed-width layout;
  - motion with no reduced-motion opt-out;
  - layout shift.

  Each check is one sentence in our own words, and each links the WCAG 2.2
  Understanding page or web.dev article that defines the bar.
- **Why `html.md`:**
  - A bucket guide is inlined only into a best-practices scan of a repo whose
    GitHub languages include HTML. Every other run, including every
    issue/PR run that loads `prompts/coding_guidelines/prompt.md`, pays
    **zero tokens** for the list.
  - The `html` bucket already cites WCAG and the ARIA Authoring Practices, so
    the new checks sit beside their natural sources.
  - The other candidates were weaker:
    - `react.md` is about hook and render correctness, and a copy there
      would duplicate the list (DRY).
    - A new front-end bucket would need a picker signal (CSS bytes) and a
      weighting for a list of only seven checks.
    - `coding_guidelines` is ruled out by the second acceptance criterion.
- **Known limit:** a repo that has only React (`.tsx`/`.jsx`) and no HTML
  bytes draws the `react` bucket, never `html`, so its scans do not see this
  list. Most React repos ship an `index.html` and still draw `html`. If that
  gap matters, the fix is a one-line cross-reference in `react.md`, not a
  copy.
- **Docs:**
  - `docs/REFERENCES.md`: the Opus 5.5 row now names where the list lives,
    and its "covered" count is corrected to 13 of 15.
  - `docs/BEST-PRACTICES-SCAN.md`: the `html` row's targets now include the
    stylesheets a page loads, and web.dev CLS is added as a source.
  - `CODING-STANDARDS.md`: the bucket table's `html` row now lists visual
    design anti-patterns.

## Evidence

- `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts` reads the
  guide through `readBucketGuide` and `bucketGuidePath`, the same path the
  scan uses. Before the section existed, four of its tests failed. All six
  pass now.
- `./quality.sh < /dev/null` passed locally: all checks green, with
  `config integration` skipped as usual.
- No visual surface changed; this is a prompt and docs change only, so there
  are no screenshots.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **The chosen file carries the anti-pattern list, and the PR states why
  that file was chosen.** — reviewer: met.
  - `html.md` checks 10–16 carry the list.
  - The rationale is in this summary under "Why `html.md`", in the
    `docs/REFERENCES.md` row, and in the test header.
- **The list does not grow the always-loaded prompt unless the PR justifies
  the cost.** — reviewer: met.
  - `prompts/coding_guidelines/prompt.md` is untouched.
  - The test "the always-loaded prompt does not carry the list" pins this
    through `loadPrompt`.
- **`docs/BEST-PRACTICES-SCAN.md` html row widened** — reviewer: unrequested.
  - reason: This is a doc sync for the new stylesheet checks. The Targets
    column names the files a scan reviews, not what selects the bucket
    (selection stays on HTML bytes).
- **`docs/REFERENCES.md` covered count 11 → 13** — reviewer: unrequested.
  - reason: The count went stale after #2635, and the row was being edited
    anyway.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

Findings from the standards reviewer:

- Fixed:
  - The circular negative control is replaced by a real one: removing the
    links makes `unlinked()` report the checks.
  - An error-path test is added: a renamed section throws.
  - Numbering is now checked across the whole guide with the existing
    `findCheckNumberingIssues`, not just the section's first number.
  - The 16-line test header is cut to 4 lines.
  - The `CODING-STANDARDS.md` bucket table row is updated.
- Kept: the test's check-splitting regex. It splits on the same heading
  shape as `CHECK_HEADING` but returns each check's body, which
  `checkNumbersIn` does not. Exporting a splitter for one test is not worth
  the extra API.
- Australian English, no hidden files, no secrets: clean.

## Test Plan

- [x] `deno test -A tests/front_end_design_anti_patterns_2636_test.ts`
- [x] `bucket_check_numbering_test`, `bucket_docs_test`,
      `best_practices_bucket_guides_consumer_test` and
      `references_refresh_test`
- [x] `./quality.sh < /dev/null`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
