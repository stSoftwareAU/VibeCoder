## Summary

Fixes the backtracking regexes that PR #3188 found outside its scope, in
`issue_lifecycle.ts`, `milestone_partial_rollup.ts` and
`planning_processor.ts`. Each reads untrusted text, and each has its own
hostile case. Closes #3206.

- `worker/deno/lib/issue_lifecycle.ts`: both branches of the
  `commitMessagesReferenceIssue` pattern (commit messages) used `\s*:?\s*`.
  Two whitespace runs with only an optional colon between them split a run of
  spaces in every way before a rejected character, which is quadratic. Both
  now use `\s*(?::\s*)?`, which accepts the same text.
- `worker/deno/lib/milestone_partial_rollup.ts`: `CLOSING_KEYWORD_PATTERN`
  scans the partial-rollup body, and the body carries branch names of any
  length that pass `isValidBranchName`. Its `[\w.-]*\/?[\w.-]*#` reference
  split a long name in every way (quadratic). A branch repeating `fix.` also
  restarted the search at every keyword and rescanned to the end (cubic).
  The reference is now `(?:[\w.-]{0,100}\/)?[\w.-]{0,100}#`, and the
  separator is `\s*(?::\s*)?`.
- `worker/deno/lib/planning_processor.ts`: the sub-issue `parentLinkRe`
  (sub-issue bodies) had `parent\s*:?\s*` followed by a shared `\s*#`. That
  is three whitespace runs, so cubic. Each branch now owns its trailing
  whitespace, and `parent` takes `\s*(?::\s*)?`.
- `docs/workflows/issue-processing.md`: a paragraph after the Issue #3186
  one.

## Spec

### Intent and Rationale

- The issue asked for every regex in the three modules that reads untrusted
  text to be checked for both shapes in the regex-vetting rule: overlapping
  quantifiers before a failing token, and a `(.*)$` tail. None of the three
  modules has a `(.*)$` tail. Three patterns had the first shape.

### Essential Design Decisions

- `\s*(?::\s*)?` and `\s*:?\s*` accept exactly the same text, so the
  commit-message and parent-link patterns match what they matched before.
- In the closing-keyword guard, splitting `[\w.-]*\/?[\w.-]*` into
  `(?:[\w.-]*\/)?[\w.-]*` removes the overlap but leaves the repeated-keyword
  rescan: each `fix.` start still scans to the end of the name. So each side
  is capped at 100 characters instead. A GitHub owner is at most 39
  characters and a repository name at most 100, so the guard still matches
  every reference GitHub would act on. It no longer matches a reference
  whose name is longer than 100 characters, and GitHub would not act on
  that either.

### Patterns checked and judged safe

- `milestone_partial_rollup.ts` `SHA_PATTERN` (`^[0-9a-f]{40}$`): anchored
  and fixed length.
- `milestone_partial_rollup.ts` `TITLE_PATTERN` (`^[^"<>\r\n]{1,255}$`):
  anchored, one capped class.
- `milestone_partial_rollup.ts` `CLOSING_KEYWORD_PATTERN` URL branch
  (`https?:\/\/\S+\/issues\/\d+`): one `\S+` before literals, linear for each
  start. It is reachable only through the title, which `TITLE_PATTERN` caps
  at 255 characters, because branch names cannot hold `:`.
- `planning_processor.ts` sub-issue URL patterns (three copies of
  `https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+`): `[^/]` and the `/`
  separators are disjoint, and each run stops at the next `/`, so the scan
  is linear overall.
- `planning_processor.ts` `CREATED_ISSUE_RE`: literal alternatives with one
  `\d+`, no overlap.
- `planning_processor.ts` `parentLinkRe` `part\s+of` and `child\s+of`
  branches: the literal `of` separates the runs. They moved with the fix
  only so that each branch owns its trailing whitespace.

## Evidence

This change has no UI.

Measured against the unfixed patterns (Deno, one call each): `issue` plus
20 000 spaces plus `x` took about 0.36 s, and `fixes` plus the same took
about 0.16 s. `milestone/fix.` plus 20 000 `a` took about 0.22 s. A branch
repeating `fix.` 500 times took about 0.4 s, and `parent` plus 2 000 spaces
plus `x` took about 1.3 s.

**Docs sweep** — grep: "backtrack", "quadratic", "CLOSING_KEYWORD_PATTERN",
"parentLinkRe", "commitMessagesReferenceIssue"; section:
`docs/workflows/issue-processing.md` (the Issue #3164 and Issue #3186
regex-vetting paragraphs); updated: `docs/workflows/issue-processing.md`.

## Test Plan

- Added `worker/deno/tests/regex_backtrack_followup_3206_test.ts` (6 tests:
  five hostile cases and one regression case). It asserts parser output and
  reads no clock.
  - Before the `worker/deno/lib/` changes, the two commit-message cases took
    42 s and 31 s, and the padded-branch case took 43 s. The repeating-branch
    and parent-link cases had not returned when they were stopped at 120 s.
    The regression case (a real reference in the title is still refused)
    passed, as intended.
  - After the changes, all 6 passed in about 75 ms in total.
- The existing suites for the touched modules (`issue_lifecycle`,
  `issue_lifecycle_cache`, `issue_lifecycle_close_exemption`,
  `milestone_partial_rollup`, `planning_processor`) pass, except
  `processIssuePlanning - drafts, self-critiques, revises, then publishes
  (Issue #2652)`. That test fails the same way on unchanged `main`
  (`FAILED | 0 passed | 1 failed`), so this change did not cause it.
- `deno fmt --check`, `deno lint`, `deno task check` and
  `deno task check:manifests` pass, and `markdownlint-cli2` reports 0 issues.
  The full suite is left to CI.
