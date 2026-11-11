## Summary

The babysitter PR-description guard no longer counts a line-wrapped (`Closes` /
`#N`) or code-split (``Closes `x` #N``) keyword as the governing issue's close,
so a completed run's description keeps a close GitHub honours.

Closes #4964.

Version bump: `VERSION` is untouched by this change.

## Spec

### Intent and Rationale

- `guardPrBodyProposal` skipped appending `Closes #N` when `closingRefs` found a
  keyword, but `CLOSING_KEYWORD_RE` joins keyword and `#N` with `\s+` and the
  code mask blanks to spaces, so both forms matched. The guard does not restore
  the live body's governing reference, so the published body lost its only
  effective close.
- The guard now asks the same question as `ensurePrReferencesIssue`
  (`hasGithubClosingReference`: same-line `[ \t]+`, code masked by a non-space
  placeholder), exported from `worker/deno/lib/pr_body.ts` rather than a third
  pattern.

### Essential Design Decisions

- `hasGithubClosingReference` gained an optional `repo`: a same-repository
  `owner/repo#N` still counts for the guard (as before), a qualified reference
  never counts when `repo` is omitted, so `ensurePrReferencesIssue` is
  unchanged.
- `assertWithheld` (the withheld-state backstop) now reads code with the
  placeholder mask, keeping the loose `\s+` pattern. Without this, the withheld
  code-split form ``Closes `x` #N`` threw "still closes" for a reference GitHub
  does not honour. A line-wrapped form still throws there (the conservative
  side). `assertWithheld` is exported so a test can reach the backstop, because
  the withhold rewrite runs first and no proposal reaches the throw through the
  guard.
- Follow-up (verifier finding): the colon and full-URL forms had the same
  defect, because `COLON_CLOSE_RE` and `URL_CLOSE_RE` use `\s` and match across
  a newline (`Closes:\n#N`, `Closes\n: #N`,
  `Closes\nhttps://github.com/o/r/issues/N`). The append decision now calls a
  new `hasGithubColonOrUrlClosingReference` in `worker/deno/lib/pr_body.ts`
  (same-line `[ \t]`, code masked by the same placeholder, same repository only)
  instead of the loose patterns. The withhold rewrite and `assertWithheld` keep
  the loose `governingColonAndUrlCloses`, the conservative side.
- Only the governing issue's append decision changed. The kept/restored
  closing-reference logic for other issues still uses `closingRefs` (not asked
  for).

### Undiscoverable Facts

- #4936 / PR #5021 (suppressing real closes when work is partial) landed before
  this run (commit 74ca6622); the withheld-state tests here pin that the shared
  parser leaves no effective close for the line-wrapped, code-split, colon and
  full-URL forms.

## Evidence

```mermaid
flowchart TD
    P["Proposal text"] --> H{"hasGithubClosingReference<br/>same line, outside code"}
    H -- yes --> K["Keep as written"]
    H -- no --> C{"Colon or URL close,<br/>Part of or Refs?"}
    C -- yes --> K
    C -- no --> A["Append Closes #N"]
```

This is pure text matching, so no external tool was observed; the failure is
pinned by the red checks in the Test Plan.

## Acceptance Criteria

The issue states no Acceptance Criteria or Definition of done heading, and
nothing it asks is left undone, so no block is required. Its asks and where they
land:

- Same check as `ensurePrReferencesIssue` (plus a same-line colon and URL
  variant), exported from `pr_body.ts`: `hasGithubClosingReference` in
  `worker/deno/lib/pr_body.ts`.
- Guard tests for line-wrapped and code-split proposals, plain same-line close
  unchanged: `worker/deno/tests/babysitter_pr_body_guard_test.ts`.
- Both states end to end, including colon and full-URL forms, with a quoted or
  code-formatted example never an effective close: the withheld-state tests in
  the same file.

## Test Plan

Tests added in `worker/deno/tests/babysitter_pr_body_guard_test.ts` (names
contain "Issue #4964"):

- line-break split close gets `Closes #N` appended;
- code-split close gets `Closes #N` appended;
- same-repository qualified close honoured with no duplicate, another
  repository's not;
- tab-joined and `Fixes` same-line closes left unchanged;
- line-wrapped colon (`Closes:\n#N`, `Closes\n: #N`), line-wrapped full-URL and
  code-split colon closes get `Closes #N` appended; same-line colon and full-URL
  closes are left unchanged;
- withheld state: line-wrapped, code-split, colon and full-URL forms leave no
  effective close;
- `assertWithheld` still throws for real closes and not for code-formatted ones;
- "a colon or full-URL close is honoured for this repository in any case, and
  another repository's is not (PR #5038 review)": a colon close and a full-URL
  close naming this repository in another letter case are honoured with no
  `Closes #N` appended, and the same forms naming another repository are not.

Tests added in `worker/deno/tests/pr_body_test.ts`: `hasGithubClosingReference`
with and without `repo`, and the line-break split.

Results on the final head: `deno task test:unit` on the three touched test files
(`babysitter_pr_body_guard_test.ts`, `pr_body_test.ts`, `pr_body_sync_test.ts`)
passed (123 and 41); `tests/fleet_pr_babysitter_test.ts` passed (120);
`./quality.sh < /dev/null` result: PASSED (config integration and checkov
skipped by the gate itself).

Red checks:

- the colon and URL operand of `namesClosingOrPartOf` restored to
  `governingColonAndUrlCloses(...)`: the line-wrapped colon and URL append test
  went red.
- `namesClosingOrPartOf` plain operand restored to
  `closingRefs(masked, repo).some(...)`: the line-break and code-split append
  tests went red; the qualified same-repository test stayed green.
- `assertWithheld` restored to `maskMarkdownCode`: the withheld-state test and
  the backstop test went red.

Callers of the changed helpers checked: `ensurePrReferencesIssue` (calls
`hasGithubClosingReference` without `repo`; `pr_body_test.ts` #4808 cases still
pass) and the babysitter guard (`fleet_pr_babysitter_test.ts` passes).
Twinned-rule search: the loose `CLOSING_KEYWORD_RE` copy in
`missing_criterion_close_guard.ts` is intentionally kept for the withhold
rewrite (conservative).

Docs: `docs/workflows/fleet-pr-babysitter.md` item 4 updated (the plain, colon
and full-URL closing forms count only when same-line and outside code).

Not done: the kept/restored closing-reference comparison for issues other than
the governing one still reads the loose pattern; not asked for here. Shell
portability is not touched.
