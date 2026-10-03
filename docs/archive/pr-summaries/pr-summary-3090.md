## Summary

Closes #3090. PR #3083 put the #3072 rule ("verify a claim about another
component before you write it") into `CODING-STANDARDS.md` and the issue prompt
only. Review-fix runs never saw it, so they replaced a false claim with a new
unverified one (VibeCoder#3075 fix commit `7354d78d`, #3068). The `pr_feedback`
prompt now carries the rule in a fix-run form.

- [x] New rule **Verify a claim about another component before you write it** in
      `prompts/pr_feedback/prompt.md` → **Making Changes**, next to **Keep the
      PR summary true to the head**.
- [x] Drift test `system_behaviour_claims_3072_test.ts` extended to the
      `pr_feedback` prompt.
- [x] Documented in `docs/workflows/pr-feedback.md`.

## Spec

### Intent and Rationale

A finding that says some text misdescribes another component invites a quick
rewrite from the finding's own wording. That rewrite is itself an unchecked
claim about the system. The rule makes the fix run open the implementing code
first and cite the file and function or line in `.pr_response_message`, and in
the PR summary when it repeats the claim. It covers new statements a fix adds,
above all exclusive or negative ones ("the only …", "any …", "never …", "the
worker does not …"). When the text does not need the claim, it is dropped in
favour of the rule and the risk it addresses.

### Essential Design Decisions

- The citation goes to `.pr_response_message` (the fix run's reply) rather than
  only the PR body, because that is where a fix run explains each finding. The
  PR summary also gets it when it repeats the claim.
- The new rule's list of exclusive claims adds "any …" (absent from the
  `CODING-STANDARDS.md` and issue-prompt lists), because #3075's false claim was
  "any non-empty `git diff` …".
- The security-control clause (`SECURITY.md` / `docs/THREAT-MODEL.md`) is
  carried over unchanged, so all three surfaces agree.

### Undiscoverable Facts

- The two motivating cases (#3075 commit `7354d78d`, #3068 "the only finding-id
  dedup source") are recorded only in the issue body and those PRs' reviews.

## Evidence

- `worker/deno/tests/system_behaviour_claims_3072_test.ts` has a new test. It
  loads the `pr_feedback` prompt's **Making Changes** section and pins ten
  phrases of the rule.
- Break check: with the new paragraph removed, the new test went red
  (`Making Changes is missing "Verify a claim about another component before
  you write it"`).
  It was restored and passes.
- `deno task test:unit tests/system_behaviour_claims_3072_test.ts
  tests/pr_claims_verified_3058_test.ts tests/new_path_keeps_guards_3087_test.ts`:
  12 passed.
- `./quality.sh < /dev/null`: see Test Plan.
- **Related existing rules checked**:
  - `CODING-STANDARDS.md` → Prompt Engineering Guidance, **Verify a claim about
    another component before you write it**: same rule; the new text points to
    it.
  - `prompts/issue/prompt.md` step 3 (#3072 wording): agrees.
  - `prompts/pr_feedback/prompt.md` → **Fix the defect everywhere it lives**,
    **Keep the PR summary true to the head**, **Every change-request finding
    ends fixed or rebutted**: these complement the new rule, with no conflict.
- **Docs sweep**: `section: docs/workflows/pr-feedback.md` → new subsection
  "Verify a claim about another component before rewriting it (Issue #3090)".
  Searched `README.md`, `docs/` (excluding archive) and `DESIGN-PRINCIPLES.md`
  for `true to the head` and `Fix the defect everywhere`. Only
  `docs/workflows/pr-feedback.md` describes these `pr_feedback` rules.

## Test Plan

- [x] `deno task test:unit tests/system_behaviour_claims_3072_test.ts`: green;
      red with the paragraph removed.
- [x] `./quality.sh < /dev/null`

## Security Self-Check

Prompt and docs text plus one test; no new input, secrets, shell, HTTP or path
handling.
