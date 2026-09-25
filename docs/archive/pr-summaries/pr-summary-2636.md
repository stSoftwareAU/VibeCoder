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

- **met** — The chosen file carries the anti-pattern list, and the PR states why that file was chosen — evidence: `prompts/best_practices/buckets/html.md:59`, `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts::html bucket - carries a short design anti-pattern list`, `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts::html bucket - every anti-pattern links a canonical source`, rationale under "Why `html.md`" above and in `docs/REFERENCES.md:122` — reviewer: met
- **met** — The list does not grow the always-loaded prompt unless the PR justifies the cost — evidence: `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts::coding guidelines - the always-loaded prompt does not carry the list` (`prompts/coding_guidelines/prompt.md` is not in the diff) — reviewer: met
- **unrequested** — `docs/BEST-PRACTICES-SCAN.md:376` html row now names the stylesheets a page loads and web.dev CLS — reviewer: unrequested — reason: doc sync, because the new checks also read `*.css`; bucket selection still rests on HTML bytes
- **unrequested** — `CODING-STANDARDS.md:566` html bucket row gains "visual design anti-patterns" — reviewer: unrequested — reason: doc sync so the bucket table matches the guide's new scope
- **unrequested** — `docs/REFERENCES.md:122` covered count 11 → 13 of 15 — reviewer: unrequested — reason: the row had to change for #2636 anyway, and the count was stale after #2635

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — TDD rule 5 / documentation-drift tests: a whole-file `includes` is not section-scoped — evidence: `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts:71` — reason: stands; it pins the concrete promise for the heading as shipped, but would not catch the list moved in under a different heading. Tightening it is a code change, out of scope for this summary-only fix
- **violation** — TDD rule 5 (no size assertions on prose), borderline — evidence: `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts:19` — reason: stands; the issue explicitly asks to "keep it short", and `MAX_CHECKS` is the executable form of that requirement
- **violation** — DRY / single source of truth, minor — evidence: `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts:28` — reason: stands; `checksIn` repeats the `CHECK_HEADING` shape from `worker/deno/lib/bucket_check_numbering.ts:24` but returns each check's body, which that module does not expose; exporting a splitter for one test is not worth the extra API
- **violation** — TDD rule 4 (exercise real code), minor — evidence: `worker/deno/tests/front_end_design_anti_patterns_2636_test.ts:66` — reason: stands; the renamed-section test exercises the shared `section` helper's error path rather than new content, and is harmless
- **clean** — Australian English, placement (front-end rules in the `html` bucket, not `coding_guidelines`), 10–16 check numbering, link-don't-restate sources, docs sync, `deno fmt`/`deno lint`, Deno/TS test conventions, commit messages referencing #2636, and commit safety (no hidden or credential files)

## Test Plan

- [x] `deno test -A tests/front_end_design_anti_patterns_2636_test.ts`
- [x] `bucket_check_numbering_test`, `bucket_docs_test`,
      `best_practices_bucket_guides_consumer_test` and
      `references_refresh_test`
- [x] `./quality.sh < /dev/null`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
