## Summary

Rewrote the "Adding a member owes a docs change too" rule so it sends the agent to re-read the lists on the item it changed and in text it wrote, not only to grep for sibling names. Removed the issue prompt's restatement and the test that pinned it. Closes #4960.

Version bump: no `VERSION` change made in this PR; the merged commit records the final version.

## Spec

### Intent and Rationale

- The old wording triggered only on a named member (field, variant, kind, flag, column, row element) and told the agent to grep other files. The stale lists the issue cites sit in the doc comment or header of the item the PR changed, or in text the PR wrote, and are often lists of behaviour or counts with no sibling name to grep.
- The new bullet widens the trigger to anything a comment or doc lists or counts (adds case, exit, refusal, output), and adds a re-read of the changed item's doc comment, its file's header and every list the diff wrote or edited, against the final code. The sibling grep stays, scoped to named sets listed in other files.

### Essential Design Decisions

- No new gate, check or summary obligation: the "name the siblings in the PR summary" requirement and the private-repo PR citation are dropped, as the issue proposes.
- The wording in the issue is used verbatim in substance. The bullet keeps the four phrases `coding_guidelines_additive_member_3137_test.ts` pins (`existing sibling members`, `not the new one`, `reads as complete`, `enum variant`).

### Undiscoverable Facts

- Success is measured by the review-fleet-prs guidance ledger, 30 days after this lands (pattern `added-member-list-one-short`); if still `recurring`, the next step is to remove the bullet.

## Evidence

Prompt and standards text only; no UI. Changed files:

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`: the bullet is replaced, identical in both.
- `prompts/issue/prompt.md`: the restatement inside docs step 3 is deleted; the preceding and following sentences are untouched.
- `worker/deno/tests/coding_guidelines_additive_member_3137_test.ts`: the issue-prompt test is deleted, and the unused `assertStringIncludes` import with it.

Existing related rules checked: the other bullets in "A Code Change Owes a Docs Change" (rename/signature, meaning change, "Every restatement of a rule gives the same answer", "Check where you insert") and issue prompt step 3's docs sweep. None conflicts; the new bullet says to re-read lists, which agrees with them. Grep of `docs/` (outside the archive), `README.md`, `prompts/` and `worker/deno/tests/` for `sibling members`, `Name those siblings`, `siblings you grepped` and `GRQ-AutoTrader#2460` finds the new bullet only, plus archived summaries and an eval result file (`evals/capability_security/comparison-20261026.json`, a recorded output, left alone).

I applied the new rule to this PR's own diff: the deleted issue-prompt restatement is the only other list of the rule, and no remaining place states the old "name the siblings in the PR summary" obligation.

## Acceptance Criteria

The issue states no acceptance-criteria heading and nothing it asks is left undone (all three numbered changes are made), so no reviewer was dispatched.

## Test Plan

- Removed from `worker/deno/tests/coding_guidelines_additive_member_3137_test.ts`: test "issue prompt's docs step asks for a sibling-member grep on an additive change (Issue #3137)"
  - Required by: "delete the test "issue prompt's docs step asks for a sibling-member grep on an additive change". The restatement it pins is gone"
- Still covered by `worker/deno/tests/coding_guidelines_additive_member_3137_test.ts::both surfaces carry the additive-member bullet, word for word (Issue #3137)`, which asserts both surfaces carry the bullet with the four phrases and are identical.
- `deno task test:unit tests/coding_guidelines_additive_member_3137_test.ts tests/coding_guidelines_twin_drift_test.ts`: 10 passed, 0 failed.
- The 69 test files that read `prompts/issue/prompt.md` or its Instructions section: passed (341 parallel plus 20 serial).
- `./quality.sh < /dev/null`: PASSED (config integration and checkov skipped by the gate itself).
- No new test added: the change is wording, and the remaining twin-drift test keeps the two copies identical. The surviving test's red check: changing one copy's `existing sibling members` phrase is caught by its phrase loop; not separately run on this head.
