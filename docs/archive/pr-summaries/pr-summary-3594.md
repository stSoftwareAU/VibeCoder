# Repo-owned review checklists reach the fleet reviewer and the pre-PR verifier

## Summary

A repo can declare path-scoped review checklists in `review-checklists.json` at
the PR's base ref. One shared loader feeds them to the fleet PR reviewer
(`gate.ts`) and the pre-PR verifier (#3395). Each checklist whose paths match
the diff gets a per-item verdict: `met`, `missing` or `not applicable`. A
`missing` item makes the fleet outcome `changes_requested`.

- **One loader.** `worker/deno/lib/review_checklists.ts` parses the file,
  matches globs and renders the brief section. Both reviewers call it.
- **Fleet reviewer.** `gate.ts` reads the file from the base ref
  (`repos/{repo}/contents/review-checklists.json?ref={baseRef}`) and lists the
  changed files. `review_log.ts` turns a `missing` item into `changes_requested`
  and renders a "Repository review checklists" section.
- **Pre-PR verifier.** `pre_pr_verifier.ts` adds `REVIEW_CHECKLISTS` to the
  brief (step 7 of `prompts/pr_review_brief/prompt.md`) and reads a `checklist`
  array from the reply. An absent or null array is read as `[]`, and nothing
  checks that every rendered item got a verdict. `prePrVerifierBlocked` blocks
  on any finding or any `missing` verdict, so a `missing` item blocks even when
  the reply has no finding. `prePrVerifierBlockReason` and
  `buildPrePrVerifierGateComment` name the missing items.
- **Unsafe globs rejected.** `parseReviewChecklists` drops a leading `./` from
  each `paths` glob and then rejects it if it starts with `/` or has an empty
  (`//`, trailing `/`) or `..` segment. The error names the checklist and index,
  so the file loads as malformed and renders the BLOCKING section. Before this,
  such a glob loaded and the checklist was silently never applied.
  `matchesPathGlob` now drops a leading `./` from the glob as well as the path.
- **Visible failures.** A malformed or unreadable file renders a BLOCKING
  instruction into the brief. So does a changed-file list passed as `null`.
  `gate.ts` (`changedPaths`) passes `null` when the list has 3000 or more
  entries (`CHECKLIST_FILE_LIST_LIMIT`). The pre-PR verifier does not use that
  limit: it passes `null` only when the list is unknown, and matches a list of
  any length normally. An absent file or no matching path renders nothing.
- **Docs.** `docs/review-checklists.md` documents the location, format and
  path-glob mapping. Pointers sit in `docs/workflows/issue-processing.md` and
  `docs/MODEL-AND-CACHING.md`.

```mermaid
flowchart LR
    F["review-checklists.json<br/>(base ref)"] --․> L["review_checklists.ts<br/>loader + matchesPathGlob"]
    D["changed files"] --․> L
    L --․>|"no match"| N["no section"]
    L --․>|"malformed / unreadable / list ≥ 3000"| B["BLOCKING instruction"]
    L --․>|"matched"| V["per-item verdicts"]
    V --․> G["gate.ts → review_log.ts<br/>missing ⇒ changes_requested"]
    V --․> P["pre_pr_verifier.ts<br/>missing ⇒ blocked"]
```

Closes #3594

## Spec

### Intent and Rationale

Repo-specific review rules, such as money or release policy on a path, were only
enforced when a human remembered them. Declaring them next to the code, at the
base ref, lets both automated reviewers check them on every PR. Reading from the
base ref stops a PR from weakening its own checklist.

### Essential Design Decisions

- One loader for both reviewers, so the file format, glob semantics and failure
  rendering cannot drift apart.
- The glob matcher is hand-written DP over tokens with no dynamic `RegExp`. It
  refuses to match when the glob or the path has a `..` segment, an empty
  segment or a leading `/`, after dropping a leading `./` from both. The parser
  rejects such a glob up front, so it fails loudly instead of matching nothing.
- A malformed, unreadable or truncated input never reads as "no checklist": it
  renders a BLOCKING instruction that tells the model to report a finding. The
  code does not add that finding itself.
- An absent file is quiet by design, as documented in
  `docs/review-checklists.md`.

### Undiscoverable Facts

- `gh api repos/{repo}/contents/…?ref=` returns HTTP 404 for a missing file, and
  the 404 branch in `gate.ts` matches `HTTP 404|Not Found` on the error message.
  Any other failure is reported as unreadable, not absent.
- Refs containing `/` are passed through literally, so a branch such as
  `milestone/x` is read at the right ref.

## Evidence

- Targeted, on this head: `deno test -A` from `worker/deno` with `< /dev/null`
  over the seven touched test files (the two new files,
  `pre_pr_verifier_3395_test.ts`, `pr_review_brief_shared_3395_test.ts`,
  `completion_phase_pre_pr_verifier_3395_test.ts`,
  `review_fleet_prs_log_2678_test.ts`,
  `review_fleet_prs_needs_human_2927_test.ts`) plus `lib_sweep_coverage_test.ts`
  — 158 passed, 0 failed. `deno lint` is clean on the changed lib and test
  files, and `deno fmt --check` is clean on the changed lib files and
  `docs/review-checklists.md`.
- `./quality.sh < /dev/null` — PASSED, exit 0, with the config integration step
  SKIPPED as usual. This is a historical run from before the verifier-review
  fixes (missing verdicts block, unsafe globs rejected, mutation-killing tests).
  Those were checked with the targeted run above; the worker re-runs the quality
  gate on this head.

Docs sweep: grep `review-checklists`, `REVIEW_CHECKLISTS`,
`Repository review checklists`, `reviewChecklists`; section:
`docs/review-checklists.md` (new); siblings: `testChangeNotes`,
`unrelatedIssues`, `PREVIOUS_FINDINGS` (the existing reply fields and brief
placeholders the new `checklist` field and `｛｛REVIEW_CHECKLISTS｝｝` joined);
updated: `README.md:519`, `docs/workflows/issue-processing.md:1193`,
`docs/MODEL-AND-CACHING.md:777`, `.claude/skills/review-fleet-prs/SKILL.md:230`,
`prompts/pr_review_brief/prompt.md:48`. Remaining hits:

- `docs/workflows/issue-processing.md:1191` — still true: lists the reply fields
  and now names the `checklist` array beside `testChangeNotes` and
  `unrelatedIssues`.
- `.claude/skills/review-fleet-prs/SKILL.md:231` — still true: says the value is
  read at the base ref and matched against the changed files, as `gate.ts` does.
- `docs/MODEL-AND-CACHING.md:777` — still true: a pointer only.

## Acceptance Criteria

<․!-- vibe-spec-review inputs="diff+issue-body" --․>

- **met** — The location and format are documented, with path globs mapped to
  checklist items. — evidence: `docs/review-checklists.md`,
  `worker/deno/lib/review_checklists.ts` `parseReviewChecklists` — reviewer: met
- **met** — A test fixture repo, with a checklist on one path and a diff that
  touches it, produces a review listing each item with a verdict. — evidence:
  `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts` (applicable path,
  `reviewBody`) — reviewer: met — reason: the reviewer model is mocked in the
  fixture; a live reviewer run is not covered.
- **met** — A diff that doesn't touch the path produces no checklist section. —
  evidence: `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts`
  (non-matching or absent file gives an empty section) — reviewer: met
- **partial** — A missing or malformed checklist file fails visibly in the
  review output and is never silently ignored. — evidence:
  `worker/deno/tests/review_checklists_3594_test.ts` (malformed and unreadable
  are blocking), `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts`
  (malformed file is loud and blocking) — reviewer: partial — reason: the code
  renders a BLOCKING instruction into the brief but does not emit the finding
  itself, so visibility depends on the model obeying it. An absent file is quiet
  by design.

## Standards Review

<․!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" --․>

- **clean** — Checked: fail loud (malformed, unreadable and truncated inputs
  render BLOCKING), path confinement (`..`, `//` and leading `/` rejected on
  glob and path, with negative tests), branch outcomes (each flipped, see
  below), docs sweep, no test-only members, and regex safety (no dynamic
  `RegExp`). Two pre-existing `fmt` and `require-await` issues in
  `review-fleet-prs` were left alone as out of scope.

## Test Plan

Added:

- `worker/deno/tests/review_checklists_3594_test.ts` (26 tests): parse shape and
  rejections, `matchesPathGlob` cases including evasion and hostile input,
  loader, `renderChecklistSection`, `parseChecklistVerdicts`, the unsafe-glob
  test, and four tests added after the verifier review:
  `parseReviewChecklists reports the JSON parser's own message for bad JSON`,
  `parseReviewChecklists rejects a path glob that can never match, naming the checklist and index`,
  `parseReviewChecklists accepts a leading ./ on a glob, and the matcher applies it`,
  and
  ``matchesPathGlob: `**/` matches only after a position the prefix reached``.
- In `worker/deno/tests/pre_pr_verifier_3395_test.ts`:
  `a missing checklist verdict blocks even with no findings, and is named in the reason and comment`,
  `met and not-applicable checklist verdicts alone do not block`,
  `runPrePrVerifier: a failed run that also changed the issue checkout reports a review with an empty checklist`,
  and
  `createMockDeps' unscripted pre-PR verifier is clean with an empty checklist`.
- `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts` (9 tests): gate
  applicable path, base-ref read with slash refs, non-matching or absent file,
  malformed file, non-404 failure, changed-file list at the limit,
  `decideOutcome`, `reviewBody`, post path.

Replaced: none.

Removed:

- Removed from `worker/deno/tests/pr_review_brief_shared_3395_test.ts`:
  `assertThrows( () => renderReviewBrief(extra, { REVIEW_CONTEXT: "c", NO_TEST_ADDED_NOTE: "n", TEST_CHANGES: "t", PREVIOUS_FINDINGS: "p", }), Error, "EXTRA_FIELD", );`
  — #3594 adds `REVIEW_CHECKLISTS` as a required fifth `ReviewBriefFields` key,
  so the four-field call no longer type-checks. The same test
  (`an extra placeholder in the template is caught`) now makes the call with all
  five fields and still asserts the `EXTRA_FIELD` throw.

Extended: `worker/deno/tests/pre_pr_verifier_3395_test.ts`,
`worker/deno/tests/pr_review_brief_shared_3395_test.ts`.

Mutation check (the four surviving mutants, each applied alone, then restored;
RED both with type checking and with `--no-check`):

- `worker/deno/lib/issue_worker_wiring.ts:1211` delete `checklist` — killed by
  `createMockDeps' unscripted pre-PR verifier is clean with an empty checklist`.
- `worker/deno/lib/pre_pr_verifier.ts:533` delete `checklist` — killed by
  `runPrePrVerifier: a failed run that also changed the issue checkout reports a review with an empty checklist`.
- `worker/deno/lib/review_checklists.ts:76` negate the ternary condition —
  killed by
  `parseReviewChecklists reports the JSON parser's own message for bad JSON`,
  which asserts the exact message (`String(error)` would add a `SyntaxError:`
  prefix).
- `worker/deno/lib/review_checklists.ts:194` (was `:176`) `let seen = false` to
  `true` — killed by
  ``matchesPathGlob: `**/` matches only after a position the prefix reached``
  (`x**/y` against `a/y`).

Branch outcomes:

- `worker/deno/lib/pre_pr_verifier.ts:729` a `missing` verdict with no findings
  → blocked — `worker/deno/tests/pre_pr_verifier_3395_test.ts:1105` — flipped to
  `false`, went RED.
- `worker/deno/lib/review_checklists.ts:97` unsafe `paths` glob → malformed —
  `worker/deno/tests/review_checklists_3594_test.ts:355` — flipped to
  `if (false)`, went RED.
- `worker/deno/lib/review_checklists.ts:165` leading `./` dropped from the glob
  — `worker/deno/tests/review_checklists_3594_test.ts:380` — flipped to
  `const g = glob;`, went RED.
- `worker/deno/lib/review_checklists.ts:166` path operand `hasUnsafeSegment(p)`
  true → no match — `worker/deno/tests/review_checklists_3594_test.ts:122` —
  flipped (glob operand kept alone), went RED.
- `worker/deno/lib/review_checklists.ts:166` glob operand `hasUnsafeSegment(g)`
  true → no match — `worker/deno/tests/review_checklists_3594_test.ts:139` —
  flipped (operand removed), went RED.
- `worker/deno/lib/review_checklists.ts:55` empty list → rejected —
  `worker/deno/tests/review_checklists_3594_test.ts:36` and `:66` — flipped,
  went RED.
- `worker/deno/lib/review_checklists.ts:236` malformed or unreadable → BLOCKING
  instruction — `worker/deno/tests/review_checklists_3594_test.ts:261` (asserts
  `:268`, `:275`) — flipped, went RED.
- `worker/deno/lib/review_checklists.ts:259` changed-file list null → "NOT
  checked" BLOCKING section (`:263`) —
  `worker/deno/tests/review_checklists_3594_test.ts:294` — flipped to
  `return "";`, went RED.
- `.claude/skills/review-fleet-prs/scripts/gate.ts:942` HTTP 404 → absent, empty
  section — `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts:131` —
  flipped, went RED.
- `.claude/skills/review-fleet-prs/scripts/gate.ts:942` other error → unreadable
  with cause — `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts:149`
  — reached by the non-404 test.
- `.claude/skills/review-fleet-prs/scripts/gate.ts:974` list at the limit → null
  (not checked) —
  `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts:160` — flipped,
  went RED.
- `.claude/skills/review-fleet-prs/scripts/review_log.ts:215` a `missing` item →
  `changes_requested` —
  `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts:199` and `:232` —
  flipped, went RED.

Red-check (each flip applied alone, run from `worker/deno` with `< /dev/null`,
then restored with `git checkout -- <file>`):

| Flip                                                          | Result                                                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `review_log.ts:215` guard to `if (false)`                     | RED, 2 failed (`worker/deno/tests/review_fleet_prs_checklists_3594_test.ts:199`, `:232`)                                      |
| `gate.ts:942` to `if (false) {`                               | RED, 1 failed (`worker/deno/tests/review_fleet_prs_checklists_3594_test.ts:131`)                                              |
| `review_checklists.ts:166` keep only `hasUnsafeSegment(g)`    | RED, 1 failed (`worker/deno/tests/review_checklists_3594_test.ts:122`)                                                        |
| `review_checklists.ts:166` remove `hasUnsafeSegment(g)`       | RED, 1 failed (`worker/deno/tests/review_checklists_3594_test.ts:139`)                                                        |
| `gate.ts:974` to `if (false) return null;`                    | RED, 1 failed (`worker/deno/tests/review_fleet_prs_checklists_3594_test.ts:160`)                                              |
| `review_checklists.ts:236` `blockingInstruction` returns `""` | RED, 1 failed (`worker/deno/tests/review_checklists_3594_test.ts:261`)                                                        |
| `review_checklists.ts:259` null-list branch returns `""`      | RED, 1 failed (`worker/deno/tests/review_checklists_3594_test.ts:294`)                                                        |
| `review_checklists.ts:55` drop `\|\| value.length === 0`      | RED, 2 failed (`worker/deno/tests/review_checklists_3594_test.ts:36`, `:66`); also affects `paths`, so not an items-only flip |

The glob-side guard test pins `src**/` against `src`, which would match only
because `**/` matches zero directories. The `..`, `//` and leading `/` globs are
literal and cannot match a safe path anyway, so they pin the outcome without
isolating the guard. The test has a positive control, `src/*.ts` against
`src/x.ts`.

Callers and siblings:

- `worker/deno/lib/pre_pr_verifier.ts`: `buildPrePrVerifierPrompt` takes a
  required `reviewChecklists` option. The reply's `checklist` is optional:
  `parseChecklistVerdicts` reads an absent or null value as `[]`
  (`worker/deno/lib/review_checklists.ts:303`).
- `worker/deno/lib/issue_worker_wiring.ts` mock reply: `checklist: []`.
- `worker/deno/tests/completion_phase_pre_pr_verifier_3395_test.ts`,
  `worker/deno/tests/review_fleet_prs_log_2678_test.ts`,
  `worker/deno/tests/review_fleet_prs_needs_human_2927_test.ts`: fixtures given
  `checklist: []`.
- Deviation: the `gate.ts:874` `auditBlocked` push sets `reviewChecklists: ""`
  and makes no `gh` call. Audit-blocked PRs get no review, so no checklist
  section is rendered for them. This is intentional.

Self-review: every test path above was checked with `git ls-files` from the repo
root; each docs-sweep hit was re-read at the cited line on this head; each
branch outcome was flipped alone and restored; the Acceptance Criteria were
re-read against the issue body.

Pre-PR Security Self-Check:

- [x] Input validation: `parseReviewChecklists` rejects a `paths` glob with a
      `..` segment, an empty segment (`//` or a trailing `/`) or a leading `/`,
      after dropping a leading `./`. `matchesPathGlob` refuses to match such a
      glob or changed path.
- [x] Secrets: no key or token files staged.
- [x] Injection surface: no shell interpolation and no dynamic `RegExp`; the
      glob matcher is hand-written DP.
- [x] Output encoding: `plain()` in `review_log.ts` flattens whitespace, bounds
      length, and replaces only a backtick (with `'`), `<` and `>` (with a
      space) and `@` (with `@` plus a zero-width space) in the posted review.
      Other markdown characters such as `*`, `_`, `[`, `]` and `#` pass through.
      `inlineSafe()` only flattens whitespace, swaps backticks and bounds length
      for text placed inside a code span in the brief.
- [x] Authorisation: the checklist is read from the base ref, so a PR cannot
      weaken its own checklist.
- [x] Error handling: non-404 failures are reported with their cause line, not
      as absent.
- [x] Dependencies: none added.
- [x] Path confinement: the guard rejects unsafe segments on both glob and path,
      with negative tests for each side.

## Disclosure of unrequested additions

- `docs/audits/lib-sweep-coverage/top-up-3594.json`, a lib-sweep ledger slice at
  full SHA `7638942f380cabff8505d3a0a129849f45875937`, needed by
  `lib_sweep_coverage_test.ts` for the new module.
- Docs pointers in `docs/workflows/issue-processing.md` and
  `docs/MODEL-AND-CACHING.md`, and the `README.md` docs-table row.
- The unsafe-glob test added during the red-check, listed above.
- `matchesPathGlob` now drops a leading `./` from the glob too. Without it, a
  `./src/**` glob would pass the new parse check but never match.
- The original code and test edits were made by executor sub-agents. The fixes
  after the pre-PR verifier review (missing verdicts block, unsafe globs
  rejected, the mutation-killing tests and the doc corrections) were made by the
  lead.
