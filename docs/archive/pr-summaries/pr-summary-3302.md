## Summary

Five drift tests pinned prompt phrases over the whole flattened file, so a
phrase surviving in an unrelated section kept them green. Each presence pin is
now read with `readRepoDoc`, narrowed with `section()` to the heading that
carries its rule and flattened with `flat()`. The two "must not appear
anywhere" checks stay on `flatWholeFile`. The tests, and the pins they hold, are
the same as before; only where each pin looks has changed. Closes #3302.

- [x] `standing_violation_3196_test.ts` — pins scoped to "Independent Review Before the PR"
- [x] `reviewer_verdict_rule_test.ts` — pins scoped to "Independent Review Before the PR"
- [x] `sleep_poll_guidance_1954_test.ts` — wait contract scoped per template
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
- **No pin is a substring of another pin in the same scoped list,** so no pin
  is subsumed.

### Undiscoverable Facts

- `deno task drift-pins-on-base` is case-sensitive. Pins that the test
  lower-cases (`reuse_existing_owner_3084_test.ts`) were checked in their
  source casing.
- Importing `markdown_docs.ts` quietly removes a test from the completeness
  family; see the split above. Follow-up #3309 records this for the remaining conversions.
- Periodic WIP checkpoint commits caught two of the red check's temporary
  deletions:
  - 75a876f8 in `prompts/issue/prompt.md`;
  - a7ed93c2 in `prompts/coding_guidelines/prompt.md`.

  0bae9ab9 restores them. The net diff touches only `worker/deno/tests/`
  and this summary; no prompt changed.

## Evidence

Backend-only change: only test files are touched.

- `./quality.sh < /dev/null` PASSED at ecefcab1. The config integration
  step was SKIPPED (no live config in the container). HEAD's content equals
  ecefcab1 apart from this summary (`git diff --stat ecefcab1 HEAD -- worker prompts`
  is empty).
- Docs sweep: no symbol, flag or documented command was renamed or changed.
  Only test-internal scoping moved, so no doc needed updating. The module doc
  of `worker/deno/tests/reuse_existing_owner_3084_test.ts` was updated to
  describe the section scoping.
- Remaining whole-file presence pins in 26 other drift tests are out of scope
  here. They are tracked in follow-up #3309.

## Test Plan

- Removed assertions: none. Every pin was moved to a narrower read, not
  dropped.
- Base: every pinned phrase is already in its target section on origin/main
  (416fd710). This is a refactor, so the tests are expected green on base.
- Per-pin red check: for each pin, I deleted exactly one occurrence of the
  phrase, from the target section only, and ran the test. Each run FAILED,
  then I restored the phrase. 44 checks; no vacuous or misplaced pin.

| Test file | Doc | Section | Pin | Removed | Result |
|---|---|---|---|---|---|
| standing_violation_3196 | issue | Independent Review Before the PR | reason: fixed in this diff | 1 | FAILED |
| standing_violation_3196 | issue | Independent Review Before the PR | reason: pre-existing, filed #<n> | 1 | FAILED |
| standing_violation_3196 | issue | Independent Review Before the PR | A breach in a line this diff adds or changes may not be deferred | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | `reviewer:` is a verdict, not a quotation | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | `met` | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | `partial` | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | `missing` | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | `unrequested` | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | put the **nearest** of the four in `reviewer:` | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | quote what it actually said in `reason:` | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | not assessed | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | traceable, not creep | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | add a one-line `reason:` saying why you departed | 1 | FAILED |
| reviewer_verdict_rule | issue | Independent Review Before the PR | An unrecorded departure is the self-assessment … | 1 | FAILED |
| sleep_poll_guidance_1954 | coding_guidelines | Long-Horizon Runs | gh pr checks --watch | 1 | FAILED |
| sleep_poll_guidance_1954 | coding_guidelines | Long-Horizon Runs | gh run watch --exit-status | 1 | FAILED |
| sleep_poll_guidance_1954 | coding_guidelines | Long-Horizon Runs | foreground `sleep` refusal | 1 | FAILED |
| sleep_poll_guidance_1954 | coding_guidelines | Long-Horizon Runs | bounded by the Bash tool's … timeout | 1 | FAILED |
| sleep_poll_guidance_1954 | ci_fix | CI Fix Mode | gh pr checks --watch | 1 | FAILED |
| sleep_poll_guidance_1954 | ci_fix | CI Fix Mode | gh run watch --exit-status | 1 | FAILED |
| sleep_poll_guidance_1954 | ci_fix | CI Fix Mode | foreground `sleep` refusal | 1 | FAILED |
| sleep_poll_guidance_1954 | ci_fix | CI Fix Mode | bounded by the Bash tool's … timeout | 1 | FAILED |
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
