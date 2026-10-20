## Summary

Closes #3897. The coding-guidelines bullet **"Vet every regex on untrusted text,
one hostile case per pattern"** now says what a hostile case asserts: the
pattern's result on an input long enough that catastrophic backtracking never
returns (so it hangs on every host), or a deterministic step count, guarded by
output and then by counted work, as the timing bullets above say. It is not a
wall-clock ratio where the repository's own testing standard keeps timing out of
unit tests. The **pr_feedback** paragraph "A backtracking finding covers every
regex in the module." gets one sentence with the same constraint and keeps its
link back to that guidelines bullet. The VibeCoder-only precedents (the
VibeCoder#3085 sentence, "(Issue #3186)" and "(Issue #3164)") were removed or
reworded generically from the edited paragraphs, so no VibeCoder helper or issue
number is cited for other repositories.

Changed files: `prompts/coding_guidelines/prompt.md`, `CODING-STANDARDS.md` (the
twin bullet, kept byte-identical to preserve the #3164 identity test),
`prompts/pr_feedback/prompt.md`, and `worker/deno/tests/timing_assertion_policy_test.ts`.

## Spec

### Intent and Rationale

- A fleet agent in another repository that follows the two rules can still copy the VibeCoder habit of timing N against 4N with a wall-clock helper. The issue asks that each hostile case say what it asserts, and defer to that repository's timing standard.

### Essential Design Decisions

- The guidelines bullet names the output and counted-work rule and does not name `assertLinearGrowth`, `tests/support/growth.ts` or any VibeCoder issue.
- The pr_feedback paragraph carries one sentence with the same constraint and links back to the guidelines bullet. It does not restate the full rule, per the twinned-rules guidance.
- `CODING-STANDARDS.md` changes only so that its twin bullet stays byte-identical to the guidelines bullet, as the #3164 identity test requires.

### Undiscoverable Facts

- `prompts/coding_guidelines_claude/prompt.md` has no "Vet every regex" bullet (checked by grep over `prompts/`), so there is no twin to edit there.

### Issue asks

1. Guidelines bullet: say what a hostile case asserts (output or counted work) and point back to "Guard super-linear cost by output, then by counted work".
2. pr_feedback paragraph: add the same constraint in one sentence and link back to the guidelines.
3. Check `prompts/coding_guidelines_claude/` for a twin. Result: none exists, so nothing changes there.
4. Add a policy test to `timing_assertion_policy_test.ts` that slices the two paragraphs, pins the new wording and forbids the VibeCoder-only tokens.

Out of scope: VibeCoder's own tests that use `assertLinearGrowth`. `CODING-STANDARDS.md` still allows a ratio there as a last resort.

## Evidence

Docs sweep: grep: "Vet every regex on untrusted text", `hostile case`, `wall-clock`, `backtrack\w*` across `docs/`, `prompts/` and `CODING-STANDARDS.md`; section: `prompts/coding_guidelines/prompt.md` "Unit Tests vs Benchmarks", `prompts/pr_feedback/prompt.md` "Making Changes", `CODING-STANDARDS.md` "Unit tests"; siblings: `one hostile case per pattern`, `A backtracking finding covers every regex in the module`; updated: `prompts/coding_guidelines/prompt.md`, `prompts/pr_feedback/prompt.md`, `CODING-STANDARDS.md`, `worker/deno/tests/timing_assertion_policy_test.ts`. Hits left in place: `prompts/coding_guidelines/prompt.md:782` is still true because it is the edited bullet's own continuation; `prompts/pr_feedback/prompt.md:135` is still true because it states the requirement and carries the timing constraint in its sentence "never a wall-clock ratio where the repository's own standard keeps timing out of unit tests" (the brief's line ~100 is not where the hit is; the only hit is 135); `CODING-STANDARDS.md:1311` and `:1323` are still true because they are the twin bullet, byte-identical to the guidelines bullet; `docs/workflows/issue-processing.md:1712-1728` is still true as far as it goes, since it restates the hostile-case requirement, but it does not carry the timing constraint, and that restatement is out of this issue's scope and was not edited; `docs/TEST-AUDIT-SCAN.md:129` and `docs/SECURITY-SCAN.md:640` are still true because they state the timing and ratio rules for other checks; `docs/audits/*` hits are backtracking notes on other parsers, still true. The `pr-summary` archive hits are historical records and are still true as written. The brief's `head -30` cut the `hostile case` grep at `docs/archive/pr-summaries/pr-summary-3534.md:171`; the `docs/workflows/issue-processing.md` hit was found by a separate grep for "Vet every regex".

Related existing rules checked:

- The timing bullets in `prompts/coding_guidelines/prompt.md` ("Guard super-linear cost by output, then by counted work") and `CODING-STANDARDS.md`. The new sentence defers to them and does not add a second timing policy.
- The #3732 twin work. The twin bullet stays identical, and no second copy of the timing policy is added.
- The #3164 `KEY_PHRASES` test and the #3186 pins still hold, because the edited paragraphs keep the "Vet every regex on untrusted text" link text and the pinned phrases.
- The #3250 pr_feedback paragraph order test still holds.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The guidelines regex bullet says what a hostile case asserts (output or counted work) and defers to the target repository's timing standard. Evidence: `prompts/coding_guidelines/prompt.md:770-789`, pinned by `worker/deno/tests/timing_assertion_policy_test.ts` "timing policy - regex hostile-case rules assert output or counted work, not a wall-clock ratio (Issue #3897)". — reviewer: met
- **met** — The pr_feedback backtracking paragraph carries the same constraint in one sentence and links back to the guidelines. Evidence: `prompts/pr_feedback/prompt.md:135`, sentence "Each case asserts the pattern's result or a counted step, never a wall-clock ratio where the repository's own standard keeps timing out of unit tests", and "See **Vet every regex on untrusted text** in the guidelines", both pinned by the same test. — reviewer: met
- **met** — Neither paragraph names a VibeCoder-only helper or issue number as precedent. Evidence: the forbidden-token check in the same test, pinned by the fixture test "timing policy - the absence check reports each forbidden token it is fed and no clean text (Issue #3897)". The check covers `assertLinearGrowth`, `tests/support/growth.ts`, `Issue #530`, `stSoftwareAU/VibeCoder#` and `(Issue #3164)`. — reviewer: met — reason: the reviewer noted the older precedent citations still in the text, and a strict reading of "issue number as precedent" could call this partial. I removed the stSoftwareAU/VibeCoder#3085 and (Issue #3164)/(Issue #3186) citations, and the policy test forbids them, so no VibeCoder issue number remains as a precedent.
- **met** — The new policy tests in `timing_assertion_policy_test.ts` pass, and fail when the new wording is removed. Evidence: the test run below passed. The red checks listed in the Test Plan were run and recorded. — reviewer: met — reason: judged from the test code only; the reviewer did not run it. I ran it and recorded the red checks in the Test Plan.
- **met** — `./quality.sh` passes. Evidence: Result: PASSED, with the config integration stage skipped, as in other runs. This is the result recorded for the branch head. — reviewer: partial — reason: the reviewer cannot run quality.sh and could not verify it. I ran it: Result PASSED with the config integration stage skipped.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Negative test must be able to fail. Red checks are recorded in the Test Plan, with each restored byte-identical and checked with `cmp`.
- **clean** — Twin identity kept. The `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md` regex bullets are identical; `cmp` of the two line ranges returned identical.
- **clean** — Regex vetting. No regex is added to production code. The test's `forbiddenIn` helper uses `String.includes` on whitespace-collapsed text, not a regex.
- **clean** — Docs sweep done (see Evidence).
- **clean** — The rule is applied to this PR's own diff. Grepping the added lines in the two prompts and `CODING-STANDARDS.md` for `assertLinearGrowth`, `growth.ts`, `Issue #530` and `stSoftwareAU/VibeCoder#` found nothing. The forbidden list lives only in the test file.
- **clean** — No test-only members in production. The test-only constants live in the test file.
- **clean** — Australian English.

## Test Plan

<!-- vibe-branch-outcomes -->

No production branch is added: this is a documentation and test change only.

- Run from `worker/deno` with stdin from `/dev/null`: `deno task test:unit` on `tests/timing_assertion_policy_test.ts`, `tests/regex_vetting_rule_3164_docs_test.ts`, `tests/regex_vetting_rule_3186_docs_test.ts` and `tests/e2e_browser_check_run_3250_test.ts`. Result: `16 passed | 0 failed`.
- `./quality.sh`: PASSED.
- Drift pins on base (`origin/milestone/fleet-guidance-tests-twins-and-portability`): every new pin phrase is absent from the base section. These are the guidelines pins, the pr_feedback sentence "never a wall-clock ratio where the repository's own standard keeps timing out of unit tests", and the link-back sentence.
- Red checks, each restored byte-identical and verified with `cmp`:
  - (i) appending `assertLinearGrowth` to the guidelines bullet gives 3 failed (#3680 whole-file ban, #3897 test, #3164 twin check);
  - (ii) the same on the pr_feedback paragraph gives 1 failed (#3897);
  - (iii-a) `stSoftwareAU/VibeCoder#3085` in the guidelines bullet gives 2 failed (#3897, #3164);
  - (iii-b) the same in the pr_feedback paragraph gives 1 failed (#3897);
  - (iv) `forbiddenIn` returning `[]` gives 1 failed (the fixture test "the absence check missed 'assertLinearGrowth'");
  - (v) the link-back removed from the pr_feedback paragraph gives 1 failed (#3897);
  - deleting the new wording turns the test red, and deleting only the pr_feedback sentence turns it red.

## Notes

- (a) #3892 is consolidated here. The pattern for later effectiveness review is "a regex hostile case asserts output or counted work, not a wall-clock ratio". The deployed commit is the merge commit of this PR and will be recorded when it lands. No production observation has happened, and none is claimed.
- (b) The `CODING-STANDARDS.md` twin changed only to keep the #3164 byte-identity. `prompts/coding_guidelines_claude/prompt.md` has no twin bullet.
- (c) Not done or not verified: `deno fmt --check` on the Markdown files was not run separately beyond what `./quality.sh` runs (markdownlint passed there). The `CODING-STANDARDS.md` twin was not red-checked separately, because the #3164 identity test covers it. No production-outcome observation has been made.
- (d) Risks: none beyond those above.
