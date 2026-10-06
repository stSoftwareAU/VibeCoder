## Summary

Five drift tests pinned prompt phrases over the whole flattened file, so a
phrase surviving in an unrelated section kept them green. Each presence pin is
now read with `readRepoDoc` and narrowed with `section()` to the heading that
carries its rule. The string pins then flatten that section with `flat()`;
the `WAIT_CONTRACT` regexes test the raw `section(...)` text, without `flat()`,
and now live in the new `sleep_poll_guidance_drift_test.ts` rather than
`sleep_poll_guidance_1954_test.ts` — the same `markdown_docs.ts`-import hazard
that moved the `no_verify_ban_test.ts` pins. The two "must not appear
anywhere" checks stay on `flatWholeFile`. The tests, and the pins they hold, are
the same as before; only where each pin looks has changed. Closes #3302.

- [x] `standing_violation_3196_test.ts` — pins scoped to "Independent Review Before the PR"
- [x] `reviewer_verdict_rule_test.ts` — pins scoped to "Independent Review Before the PR"
- [x] `sleep_poll_guidance_1954_test.ts` — wait contract scoped per template; split into `sleep_poll_guidance_drift_test.ts` to keep the `check:manifests` family (Issue #1483)
- [x] `reuse_existing_owner_3084_test.ts` — pins scoped per doc
- [x] `no_verify_ban_test.ts` — section pins split into `no_verify_ban_drift_test.ts`
- [x] Per-pin red check (44 checks)
- [x] Full gate

## Spec

### Intent and Rationale

A pin should fail when its rule leaves the section it belongs in, not only when
the phrase disappears from the whole prompt. This PR applies the #3307 bar:

- each pin is mapped to its rule's section;
- no pin is subsumed by another;
- absence checks are kept whole-file;
- each pin has a red check recorded below.

### Essential Design Decisions

- **Absence checks stay whole-file.** These two must hold anywhere in the
  prompt, so they still read `flatWholeFile`:
  - `standing_violation_3196_test.ts`: `!/why it stands/i`
  - `reviewer_verdict_rule_test.ts`: "keep the `reviewer:` field as the reviewer wrote it"
- **Rendered prompts stay whole-file.** `buildClosureVerdictPrompt` and the
  `buildIssueRunAgents` spec-reviewer prompt have no repo headings to narrow to.
- **`no_verify_ban_test.ts` was split.** `worker/deno/tests/support/markdown_docs.ts` spawns git:
  - so any test importing it matches `HEAVY_RE` in `worker/deno/lib/completeness_checks.ts`;
  - which drops that test out of the `check:manifests` completeness family (Issue #1483);
  - and `worker/deno/tests/completeness_checks_test.ts` pins `tests/no_verify_ban_test.ts` as a family member.

  So the section pins moved to the new
  `worker/deno/tests/no_verify_ban_drift_test.ts`.
  `no_verify_ban_test.ts` keeps the whole-tree scan and the `familyText(BAN_OWNER)` check.
- **`sleep_poll_guidance_1954_test.ts` was split the same way.** Its
  `WAIT_CONTRACT` section-scoped pins need `markdown_docs.ts` too, which drops
  it from the `check:manifests` family for the same `HEAVY_RE` reason. Those
  pins moved to the new `worker/deno/tests/sleep_poll_guidance_drift_test.ts`;
  `sleep_poll_guidance_1954_test.ts` keeps the whole-tree sleep-poll scan and
  the `gh`-guard checks, and `completeness_checks_test.ts` now pins it as a
  family member.
- **No pin is a substring of another pin in the same scoped list,** so no pin
  is subsumed.

### Undiscoverable Facts

- `deno task drift-pins-on-base` is case-sensitive. Pins that the test
  lower-cases (`reuse_existing_owner_3084_test.ts`) were checked in their
  source casing.
- Importing `markdown_docs.ts` quietly removes a test from the completeness
  family; see the split above. Follow-up #3309 records this for the remaining conversions.
- Periodic WIP checkpoint commits caught two of the red check's temporary
  deletions: 75a876f8 deleted a phrase in `prompts/issue/prompt.md`, which
  a7ed93c2 restored. a7ed93c2 also deleted a line in
  `prompts/coding_guidelines/prompt.md`, which 0bae9ab9 restored. The net
  diff touches only `worker/deno/tests/` and this summary; no prompt
  changed.

## Evidence

Backend-only change: only test files are touched.

- `./quality.sh < /dev/null` PASSED at e8e0a12b (which includes the
  `sleep_poll_guidance_1954_test.ts`/`sleep_poll_guidance_drift_test.ts` split
  below, from a PR #3310 review round applied after the ecefcab1 run). The
  later correction to this Test Plan's Removed/Result columns (600db042) only
  edits this summary file, so no further `quality.sh` run was needed. The
  config integration step was SKIPPED (no live config in the container).
- Docs sweep: no symbol, flag or documented command was renamed or changed.
  Only test-internal scoping moved, so no doc needed updating. The module doc
  of `worker/deno/tests/reuse_existing_owner_3084_test.ts` was updated to
  describe the section scoping.
- Remaining whole-file presence pins in 26 other drift tests are out of scope
  here. They are tracked in follow-up #3309.

## Test Plan

```text
assertStringIncludes( collapsed, "Bypassing either safeguard (e.g. `git commit --no-verify`, `git add -f`) " + "is forbidden", );
assertStringIncludes(collapsed, "fix the allowlist via PR — do not bypass");
assert(text, `${family} must resolve`);
assertStringIncludes(text, "Bound irreversible actions");
assertStringIncludes(text, "git push --force");
assertStringIncludes(text, "only way forward");
assertStringIncludes(text, "Bypassing the pre-commit gate is");
assertEquals(result.ok, true, `${type} failed to load`);
assertStringIncludes(body, required);
assertStringIncludes( body, "a helper or component the issue says to reuse counts as a stated criterion", );
assertStringIncludes(body, "flag these four departures");
assertStringIncludes( body, "an in-repo helper, component or policy re-implemented by hand instead of called", );
assert(result.ok, "issue prompt failed to load");
assertStringIncludes(flat, "`reviewer:` is a verdict, not a quotation");
assertStringIncludes(flat, `\`${verdict}\``);
assert( !flat.includes("keep the `reviewer:` field as the reviewer wrote it"), "this instruction conflicts with the closed vocabulary the gate parses, " + "and cost #834 a completed run", );
assertStringIncludes(flat, "put the **nearest** of the four in `reviewer:`");
assertStringIncludes(flat, "quote what it actually said in `reason:`");
assertStringIncludes(flat, "not assessed");
assertStringIncludes(flat, "traceable, not creep");
assertStringIncludes( flat, "add a one-line `reason:` saying why you departed", );
assertStringIncludes( flat, "An unrecorded departure is the self-assessment this whole section exists to remove", );
assert( pattern.test(text), `${template}/prompt.md must name ${what} (no match for ${pattern})`, );
assertEquals(result.ok, true, "issue prompt failed to load");
assert( !/why it stands/i.test(body), "the prompt still offers 'why it stands' as a violation's reason", );
assertStringIncludes(body, "reason: fixed in this diff");
assertStringIncludes(body, "reason: pre-existing, filed #<n>");
assertStringIncludes( body, "A breach in a line this diff adds or changes may not be deferred", );
```

The 28 assertions above were removed from existing tests, in diff order. Every
pinned phrase is still asserted. #3302 requires each pin to read its rule's
section, not the whole prompt, so the old whole-file form is untrue to the
issue. Where each one went:

- Removed from `worker/deno/tests/no_verify_ban_test.ts` (the first seven) —
  scoping them needs `markdown_docs.ts`, which would drop this file from the
  `check:manifests` family. They are re-pinned on `flat(section(...))` in
  `no_verify_ban_drift_test.ts::no-verify - the guidelines' Commit Safety section keeps the categorical ban (Issue #783)`
  (Commit Safety) and
  `no_verify_ban_drift_test.ts::no-verify - the two templates keep the rest of the reversibility bullet (Issue #783)`
  (Long-Horizon Execution). `assert(text, ...)` went with the `familyText`
  read: `readRepoDoc` throws on a missing file and `section()` asserts its
  heading exists.
- Removed from `worker/deno/tests/reuse_existing_owner_3084_test.ts` (the next
  five) — the load check went with `loadPrompt`, for the same reason. Each
  phrase is re-pinned, with a message naming its section, in the same-named
  test: `issue - step 1 makes the agent call the existing owner instead of copying it`
  (Instructions), `issue - the Spec reviewer brief treats a named reuse as a criterion`
  (Independent Review Before the PR),
  `pr_feedback - a fix calls the owner and replaces a flagged copy` (Making
  Changes) and
  `CODING-STANDARDS - the over-engineering checklist flags an in-repo helper copied by hand`
  (Coding Principles).
- Removed from `worker/deno/tests/reviewer_verdict_rule_test.ts` (the next
  ten) — the load check went with `loadPrompt`. Each phrase is re-pinned on
  `text` (from `reviewerVerdictSection()`, Independent Review Before the PR) in
  the same-named `reviewer verdict - …` test. The `!flat.includes(...)` absence
  check is still whole-file. It now reads `whole` (`flatWholeFile(doc)`)
  because `flat` is now the imported helper, in
  `reviewer verdict - the prompt no longer demands verbatim reviewer text (Issue #886)`.
- Removed from `worker/deno/tests/sleep_poll_guidance_1954_test.ts` (one) —
  re-asserted against the raw `section(...)` text from
  `WAIT_CONTRACT_SECTION`, with a message naming the section, now in
  `sleep_poll_guidance_drift_test.ts::${template} - names a wait command that works in the container`
  (moved out of `sleep_poll_guidance_1954_test.ts` to keep that file in the
  `check:manifests` family — see Essential Design Decisions; caught by
  PR review, not in the first push).
- Removed from `worker/deno/tests/standing_violation_3196_test.ts` (the last
  five) — the load check went with `loadPrompt`. The `/why it stands/i`
  absence check is still whole-file, now on `flatWholeFile(doc)`. The three
  phrases are re-pinned on `reviewSection` (Independent Review Before the PR)
  in `Issue #3196 - the issue prompt offers only fixed or filed as a violation's reason`.
- Base: every pinned phrase is already in its target section on origin/main
  (416fd710). This is a refactor, so the tests are expected green on base.
- Per-pin red check: for each pin, I deleted every occurrence of the phrase
  within the target section only — the `Removed` column — and ran the test,
  then restored the phrase(s). 44 checks. Five of them (the
  `reason: fixed in this diff`, `` `met` ``, `` `partial` ``, `` `missing` ``
  and `` `unrequested` `` pins in `standing_violation_3196_test.ts` and
  `reviewer_verdict_rule_test.ts`) were first checked by deleting only one of
  several in-section occurrences — those phrases recur 2–7 times in the issue
  prompt's "Independent Review Before the PR" section (the worked examples
  and later prose restate them) — which left the test green: a vacuous check.
  The rows below record the actual in-section occurrence count for all 44
  checks, each re-verified by deleting every occurrence and confirming the
  test goes red.

| Test file | Doc | Section | Pin | Removed | Result |
|---|---|---|---|---|---|
| standing_violation_3196 | issue | Independent Review Before the PR | reason: fixed in this diff | 2 | FAILED |
| standing_violation_3196 | issue | Independent Review Before the PR | reason: pre-existing, filed #<n> | 1 | FAILED |
| standing_violation_3196 | issue | Independent Review Before the PR | A breach in a line this diff adds or changes may not be deferred | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | `reviewer:` is a verdict, not a quotation | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | `met` | 3 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | `partial` | 2 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | `missing` | 3 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | `unrequested` | 7 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | put the **nearest** of the four in `reviewer:` | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | quote what it actually said in `reason:` | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | not assessed | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | traceable, not creep | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | add a one-line `reason:` saying why you departed | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | An unrecorded departure is the self-assessment … | 1 | FAILED |
| sleep_poll_guidance_drift | coding_guidelines | Long-Horizon Runs | gh pr checks --watch | 1 | FAILED |
| sleep_poll_guidance_drift | coding_guidelines | Long-Horizon Runs | gh run watch --exit-status | 1 | FAILED |
| sleep_poll_guidance_drift | coding_guidelines | Long-Horizon Runs | foreground `sleep` refusal | 1 | FAILED |
| sleep_poll_guidance_drift | coding_guidelines | Long-Horizon Runs | bounded by the Bash tool's … timeout | 1 | FAILED |
| sleep_poll_guidance_drift | ci_fix | CI Fix Mode | gh pr checks --watch | 1 | FAILED |
| sleep_poll_guidance_drift | ci_fix | CI Fix Mode | gh run watch --exit-status | 1 | FAILED |
| sleep_poll_guidance_drift | ci_fix | CI Fix Mode | foreground `sleep` refusal | 1 | FAILED |
| sleep_poll_guidance_drift | ci_fix | CI Fix Mode | bounded by the Bash tool's … timeout | 1 | FAILED |
| reuse_existing_owner_3084 | issue | Instructions | call the existing owner | 1 | FAILED |
| reuse_existing_owner_3084 | issue | Instructions | formats, orders, ranks, validates or decides | 1 | FAILED |
| reuse_existing_owner_3084 | issue | Instructions | every component or function the issue names | 1 | FAILED |
| reuse_existing_owner_3084 | issue | Instructions | implementation section | 1 | FAILED |
| reuse_existing_owner_3084 | issue | Instructions | widen its visibility | 1 | FAILED |
| reuse_existing_owner_3084 | issue | Instructions | `pub(crate)` → `pub` | 1 | FAILED |
| reuse_existing_owner_3084 | issue | Instructions | a component the issue says to reuse is a stated requirement | 1 | FAILED |
| reuse_existing_owner_3084 | issue | Independent Review Before the PR | a helper or component the issue says to reuse counts as a stated criterion | 1 | FAILED |
| reuse_existing_owner_3084 | pr_feedback | Making Changes | call the existing owner | 1 | FAILED |
| reuse_existing_owner_3084 | pr_feedback | Making Changes | widen its visibility | 1 | FAILED |
| reuse_existing_owner_3084 | pr_feedback | Making Changes | replace the copy with a call to the owner | 1 | FAILED |
| reuse_existing_owner_3084 | CODING-STANDARDS.md | Coding Principles | flag these four departures | 1 | FAILED |
| reuse_existing_owner_3084 | CODING-STANDARDS.md | Coding Principles | an in-repo helper, component or policy re-implemented by hand instead of called | 1 | FAILED |
| no_verify_ban_drift | coding_guidelines | Commit Safety | Bypassing either safeguard (e.g. `git commit --no-verify`, `git add -f`) is forbidden | 1 | FAILED |
| no_verify_ban_drift | coding_guidelines | Commit Safety | fix the allowlist via PR — do not bypass | 1 | FAILED |
| no_verify_ban_drift | issue | Long-Horizon Execution | Bound irreversible actions | 1 | FAILED |
| no_verify_ban_drift | issue | Long-Horizon Execution | git push --force | 1 | FAILED |
| no_verify_ban_drift | issue | Long-Horizon Execution | only way forward | 1 | FAILED |
| no_verify_ban_drift | issue | Long-Horizon Execution | Bypassing the pre-commit gate is | 1 | FAILED |
| no_verify_ban_drift | pr_feedback | Long-Horizon Execution | Bound irreversible actions | 1 | FAILED |
| no_verify_ban_drift | pr_feedback | Long-Horizon Execution | git push --force | 1 | FAILED |
| no_verify_ban_drift | pr_feedback | Long-Horizon Execution | only way forward | 1 | FAILED |
| no_verify_ban_drift | pr_feedback | Long-Horizon Execution | Bypassing the pre-commit gate is | 1 | FAILED |

Test files are under `worker/deno/tests/` (`<name>_test.ts`); docs are
`prompts/<doc>/prompt.md` unless named.

Branch outcomes: none added

## Pre-PR Security Self-Check

Test-only change: no new input handling, no external calls, no secrets
staged, no new dependency.
