## Summary

Adds a self-review rule, **An issue number cited as provenance is one you
looked up**, to `CODING-STANDARDS.md` (PR Summary and Evidence, directly
after the forward-reference rule **Behaviour another issue delivers is not
described as present**). It is mirrored in `prompts/issue/prompt.md`
(Instructions, next to that rule's mirror) and in `prompts/pr_feedback/prompt.md`
(Making Changes). Every issue number a diff adds as the reason a change
exists (`Issue #N`, `#N follow-up`, `_<N>_test.ts`, `(Issue #N)`) must be one
the run resolved with `gh issue view N`, and its title must match the reason
it is cited. A follow-up is cited only after `gh issue create` returns its
number. Otherwise the run cites the closed issue or `PR #N review`. Each cited
number is listed as `#N: <title>` in the PR summary's Evidence.
Closes #3338.

## Spec

### Intent and Rationale

- Two fleet PRs were sent back because of wrong provenance numbers.
  VibeCoder#3068 cited "Issue #4040 follow-up", but #4040 was never filed.
  VibeCoder#3308 attributed its hardening to #3309, an unrelated drift-test
  issue, when the hardening actually came from the review of PR #3308.
- The existing forward-reference rule already says to run `gh issue view N`.
  Agents do not apply it to provenance citations because it is framed around
  another issue's deliverable.

### Essential Design Decisions

- This is a separate short rule placed next to the forward-reference rule,
  rather than a widening of that rule. The issue allowed either. A separate
  rule keeps each rule's trigger plain.
- The pr_feedback mirror cites `PR #{{PR_NUMBER}} review`, the PR being
  fixed, because the #3308 citation was added during a review-fix push.
- The optional mechanical post-commit resolver (proposal item 3) is not
  built. The list of `#N: <title>` entries in the PR summary is its manual
  form. A resolver can be a separate issue if send-backs continue.

### Undiscoverable Facts

- The examples are fleet PR review send-backs: VibeCoder#3068 at head
  `4234ed5` and VibeCoder#3308 at head `5c1fa0c`, as quoted in the issue body.

## Evidence

Prompt and standards change only: no UI and no runtime code. The drift test
`worker/deno/tests/provenance_citation_rule_3338_docs_test.ts` pins the rule
in all three documents.

**Cited issue numbers in this diff:** each was resolved with `gh issue view`
in this run.

- #3338: Fleet PRs cite a wrong or never-filed issue number as a change's
  provenance (VibeCoder#3068, #3308). This is the issue this PR closes, and
  is the source of every `(Issue #3338)`, the `_3338_` test name and the
  test names.
- #3068: Security: idle-task dedup trusts only the fleet-authored known-open
  list (Issue #3045). This is the first send-back example.
- #3308: Pre-commit gate: accept hidden paths the repo's tracked .gitignore
  re-allows (#3296). This is the second send-back example.
- #3309: Remaining drift tests still pin presence phrases over a whole
  flattened doc instead of section(). It is cited as the unrelated issue
  that PR #3308 wrongly named.

**Related existing rules checked:**

- `CODING-STANDARDS.md` **Behaviour another issue delivers is not described
  as present** (line 1423): agrees, and the new rule extends its
  `gh issue view N` check to provenance.
- **Reference the issue number in all commit messages**: unchanged and
  compatible.
- **A named test must exist**: complementary, because it covers test paths,
  not issue numbers.
- The `prompts/pr_feedback/prompt.md` escape hatch: it files the follow-up
  first and then names it, which is consistent.
- The issue prompt's reviewer "provenance" markers: these use a different
  sense of the word and are unaffected.
- No rule contradicts the new one.

**Rule applied to this PR's own diff:** every issue number the diff adds
(`#3338`, `#3068`, `#3308`, `#3309`, and the `_3338_` test name) is in the
list above, resolved with `gh issue view`, and its title matches the reason
it is cited. Nothing needed changing.

**Docs sweep:**

- grep: "provenance", `gh issue view N`, "follow-up\w* by number", "next free
  number".
- section: `CODING-STANDARDS.md` PR Summary and Evidence,
  `prompts/issue/prompt.md` Instructions, and `prompts/pr_feedback/prompt.md`
  Making Changes.
- updated: the same three files.
- `CODING-STANDARDS.md:1423` is still true, because the forward-reference
  rule is unchanged and the new rule sits beside it.

## Test Plan

- Added `worker/deno/tests/provenance_citation_rule_3338_docs_test.ts`. It
  has 3 section-scoped tests.
- `deno task test:unit` with that test, `forward_reference_rule_3223_docs_test`
  and `own_diff_rule_check_3249_docs_test`: 9 passed, 0 failed.
- Red without the change: with `CODING-STANDARDS.md` restored to base, the
  CODING-STANDARDS test failed (2 passed, 1 failed).
- `deno task drift-pins-on-base origin/main …` was run for each section.
  Every pinned phrase is absent on base:
  - `CODING-STANDARDS.md` "PR Summary and Evidence": "An issue number cited
    as provenance is one you looked up", "`_<N>_test.ts` in a test file
    name", "Never cite a follow-up by number before it is filed", "file the
    follow-up with `gh issue create` and cite the number it returns",
    "(`PR #N review`)", "as `#N: <title>` in the PR summary's Evidence".
  - `prompts/issue/prompt.md` "Instructions": "An issue number the diff adds
    as provenance", "Never cite a follow-up by number before it is filed",
    "file it with `gh issue create` and cite the number it returns", "as
    `#N: <title>` in the PR summary's Evidence".
  - `prompts/pr_feedback/prompt.md` "Making Changes": "An issue number you
    cite as provenance is one you looked up", "Never cite a follow-up by
    number before it is filed", "(`PR #{{PR_NUMBER}} review`)", "as
    `#N: <title>` in the PR summary's Evidence".
- markdownlint: no new findings. The MD018 at `CODING-STANDARDS.md:1017` is
  on base.
- `timeout 900 ./quality.sh < /dev/null`: **PASSED** (exit 0). Config
  integration was SKIPPED because `.config.json` is not available in this
  checkout, which is expected.

Branch outcomes: none added

### Independent review

- **Spec reviewer:** met on every acceptance criterion (CODING-STANDARDS,
  issue prompt, pr_feedback prompt, rule content). The optional mechanical
  check (item 3) is not implemented, and the reviewer agreed it is not a gap.
- **Standards reviewer:** no violations. Optional note: the `owner/repo#N`
  `--repo` clause is only in `CODING-STANDARDS.md`. The prompts point to that
  rule by name, so the mirrors are left short.

### Process note

One executor was launched by mistake as a placeholder. It made no changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
