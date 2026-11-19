## Summary

Shortened the "Changing what a shared helper returns, refuses or finds changes
every caller" rule in `CODING-STANDARDS.md` and
`prompts/coding_guidelines/prompt.md`. Both files now carry the issue's proposed
wording, identical in each. Three things are gone: the sentence saying the
pre-PR verifier's caller verdicts block the PR (advisory since #4234), the
"List the callers checked in the PR summary" demand together with the clause
saying such a list does not count, and the two parenthetical case lists. The
per-caller decision, the remedy (keep the helper or change the caller), the test
through each touched caller and the blocking self-review finding all stay.
Closes #5235.

## Spec

### Intent and Rationale

- The paragraph promised a verifier block that #4234 removed. It also asked for a
  callers list that the paragraph itself said is no evidence. Removing both
  makes the rule true again and shorter, and relaxes no testing requirement.
- The case lists are gone because #3779 found that readers took such lists as
  the rule's scope. The issue deliberately does not widen the rule again.

### Essential Design Decisions

- The wording is the issue's proposed text, verbatim. Both surfaces stay word
  for word identical, and the drift test still asserts that.
- The drift test now also asserts that the retired phrases ("blocks the PR",
  "List the callers checked in the PR summary", "a callers-checked list alone
  does not count") are absent from the paragraph. That stops the false
  verifier claim and the self-contradicting list from coming back.
- `caller_checks.ts`, the verifier's caller verdicts and every gate are
  untouched, as the issue's "Not proposed" section asks.

### Undiscoverable Facts

- `docs/workflows/issue-processing.md` ("Pre-PR verifier (Issue #3395)")
  confirms the verifier's findings are advisory at completion (Issue #4234),
  which is why the removed sentence was false.

## Evidence

Documentation and rule text only; no runtime code changed.

- Twinned copies: the paragraph exists on exactly two surfaces,
  `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`, and
  `worker/deno/tests/narrowing_shared_helper_3100_test.ts` pins them. A grep
  for `callers checked`, `callers-checked` and `whose body the diff changes`
  outside `docs/archive/` finds no other copy. No operator doc restated the
  removed verifier sentence.
- Related existing rules checked for agreement: **Observe the real tool before
  you rely on it** (the new text still points to it), **Every changed call site
  needs a test that goes red without it**, and **A new argument or behaviour
  reaches every caller that needs it**. None contradicts the shortened rule, and
  none needed a change.
- Rule applied to this PR's own diff: the diff changes no shared helper, and the
  only test it edits is the drift test, so the rule flags nothing in it.
- Issue numbers cited: #5235: Shorten the #3779 shared-helper rule after
  recurrence: it promises a verifier block that #4234 removed and demands a
  callers list it says does not count (VibeCoder#4650, #4745, #5060 and private
  fleet PRs); #4234: Completion gates fail runs that delivered their issue: make
  them advisory or delete them.

## Test Plan

- `worker/deno/tests/narrowing_shared_helper_3100_test.ts` (edited):
  - **Removed:** the old `KEY_PHRASES` that pinned the case lists, the callers
    list and the verifier-block sentence. The issue removes that text ("What
    goes"), so those assertions no longer hold.
  - **Kept:** the per-caller decision, the remedy, the test through each
    touched caller, the blocking finding, and the identical-surfaces
    `assertEquals`. They are now pinned by the new `KEY_PHRASES`.
  - **Added:** `RETIRED_PHRASES`, asserting the removed claims are absent.
  - **Result:** `deno task test:unit tests/narrowing_shared_helper_3100_test.ts`
    passed (1 passed). The new key phrases are not in the base text, so this
    test fails against the base docs.
- Other test files that read either surface and mention this rule's terms all
  passed (33 passed): `documentation_drift_policy_test.ts`,
  `timeout_cmd_portability_3675_test.ts`,
  `completion_phase_pre_pr_verifier_3395_test.ts` and
  `pr_claims_verified_3058_test.ts`, all under `worker/deno/tests/`.
- `./quality.sh` on the head: every stage passed except `deno tests`, where
  35238 tests passed and 1 failed. The failure was
  `worker/deno/tests/pr_summary_ci_workflow_3768_test.ts`, which failed with
  `dns error: failed to lookup address information: Temporary failure in name
  resolution` while fetching `registry.npmjs.org`. That test runs `deno task`
  with `clearEnv: true`, which drops the sandbox's proxy, so it can only use
  the default deno cache, and that cache lacked `commonmark`. The test reads
  neither changed document. After the default cache was filled through the
  proxy (an environment change, not a repo change), it passed when run alone
  (11 passed), and the pre-push gate passed.

Not checked: the full `./quality.sh` was not re-run after the cache was filled.
Only the one failing test was re-run. Remaining risk: none known.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
