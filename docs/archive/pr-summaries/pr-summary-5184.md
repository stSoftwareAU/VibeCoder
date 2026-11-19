# PR Summary — Issue #5184

## Summary

This PR retires the redundant per-ask reply list and sentence-count step from
the PR-feedback prompt. It deletes the **Answer every ask in a finding, not only
the finding** paragraph from `prompts/pr_feedback/prompt.md`, along with the
clause in its Response Message section that asked `.pr_response_message` to list
"the asks under each finding with the commit, test or line that settles each
one". It also removes the matching operator-manual section from
`docs/workflows/pr-feedback.md` and the docs test that pinned only that prose.
The adjacent fixed-or-rebutted rule, **Fix the defect everywhere it lives**, and
the independent per-finding review all stay. Closes #5184.

## Spec

### Intent and Rationale

- The paragraph repeated the adjacent **Every change-request finding ends fixed
  or rebutted** obligation. Its sentence-count comparison treated counting as
  evidence of semantic completeness. The independent per-finding review that
  #3784 introduced already judges whether each earlier ask was met.

### Essential Design Decisions

- This change only removes text. As the issue asks, it adds no gate, recovery
  trigger, lint rule, test-plan field or replacement reporting obligation.
- The reviewer-side "every ask" wording stays, because it is the per-finding
  review the issue asks to keep:
  - `worker/deno/lib/earlier_findings.ts` (`TEXT_GAP_FIX`)
  - the `earlierFindings` note in `prompts/pr_review_brief/prompt.md`
  - the earlier-findings line in `worker/deno/lib/pre_pr_verifier.ts`

### Undiscoverable Facts

None.

## Evidence

Backend/prompt-only change; there are no UI files. Related existing rules
checked, all kept:

- **Every change-request finding ends fixed or rebutted** and **"No change" is
  not an answer to a change request**: they stay adjacent, and neither refers to
  the deleted paragraph.
- **Fix the defect everywhere it lives** (prompt and manual): unchanged.
- The Response Message per-finding "other paths and copies" clause: unchanged.

I applied the issue's rule to this PR's own diff by grepping the final head.
Outside `docs/archive/`, there are no hits for `Answer every ask`,
`asks under each finding`, `count the asks`, `asks it listed`,
`answer-every-ask` or `every_ask_3348`. The archived PR summaries that still
quote the old rule are historical records and are left unchanged.

## Test Plan

- Removed `worker/deno/tests/pr_feedback_every_ask_3348_docs_test.ts`. This
  removes three documentation-drift tests:
  - Removed from `worker/deno/tests/pr_feedback_every_ask_3348_docs_test.ts`:
    `assert(start >= 0, "could not locate the 'answer every ask' rule");` and
    the phrase checks on that paragraph
    - Required by: "Delete the separate **Answer every ask in a finding, not
      only the finding** paragraph from `prompts/pr_feedback/prompt.md`,
      including the mandatory per-ask reply list and sentence-count comparison."
  - Removed from `worker/deno/tests/pr_feedback_every_ask_3348_docs_test.ts`:
    the Response Message check for
    `"the asks under each finding with the commit, test or line that settles each one"`
    - Required by: "including the mandatory per-ask reply list and
      sentence-count comparison"
  - Removed from `worker/deno/tests/pr_feedback_every_ask_3348_docs_test.ts`:
    the manual phrase checks (`"break each finding into its asks"`,
    `"counts the asks it listed"`, `"leaves the finding partly fixed"`)
    - Required by: "Update or remove only tests that pin the deleted prose."
- `cd worker/deno && deno task test:unit <the 32 test files that read prompts/pr_feedback/prompt.md or docs/workflows/pr-feedback.md> < /dev/null`
  passed on head `59016dd83`: `ok | 161 passed | 0 failed`.
- `./quality.sh < /dev/null` on head `59016dd83`:
  `Result: PASSED (with skipped checks)`. Config-integration and checkov are
  skipped on this host.
  - The first gate run failed only in
    `worker/deno/tests/pr_summary_ci_workflow_3768_test.ts` with
    `Failed caching npm package 'entities@3.0.1'` (`dns error`). That test runs
    `deno task` with a cleared environment, so it uses the default
    `~/.cache/deno`, and this host has no network. I re-seeded that cache from
    the worker's warm `DENO_DIR` (outside the repo). The test then passed 11/11
    and the full gate passed. This is a host environment fault, unrelated to
    this diff.
