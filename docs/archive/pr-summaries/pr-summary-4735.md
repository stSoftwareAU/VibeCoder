## Summary

Removes the sentence "Name each remaining hit in the PR summary by `file:line`
with the reason it is still true." from the "Grep for the **stem**" bullet in
`CODING-STANDARDS.md` and from its twin in
`prompts/coding_guidelines/prompt.md`. Closes #4735.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

- A line number in a PR summary is true only when the grep runs; the PR's own
  later edits move it, so the list went stale and sent back PRs that delivered
  their issue (VibeCoder#3322, #4730, NEAT-AI-Discovery#2426).
- The docs themselves are what must be true, and a reviewer reads those
  directly, so only the line-numbered list goes.

### Essential Design Decisions

- The rest of the bullet stays: grep the stem, re-run the grep on the final
  head, read every passage in an updated file that mentions the changed surface.
- No check, gate or replacement wording is added, as the issue asks.

### Undiscoverable Facts

- None.

## Evidence

Documentation-only change.

- `git grep -n "remaining hit"` outside `docs/archive/` and the historical
  `evals/` snapshot finds no remaining copy of the sentence; the only two copies
  were the two files edited here.
- `deno task test:unit` on `tests/coding_guidelines_twin_drift_test.ts`,
  `tests/coding_guidelines_meaning_change_2904_test.ts`,
  `tests/coding_guidelines_additive_member_3137_test.ts`,
  `tests/coding_guidelines_overlay_test.ts`,
  `tests/coding_guidelines_layers_2574_test.ts` and
  `tests/coding_guidelines_v42_test.ts` (run from `worker/deno`): 38 passed, 0
  failed.

## Test Plan

- No test added: the change deletes one sentence of guidance, and no code reads
  it. The existing twin-drift tests above still pass, so the two copies stay in
  step.
- Rule-applied-to-own-diff: the removed sentence's nouns (`file:line`,
  "remaining hit") do not appear in this PR's summary as a list of line numbers.
- Related rules checked: the other "Grep for the stem" restatements in the issue
  prompt template say to name the section read and the doc files updated, not
  line numbers, so they agree with the removal.
- `deno fmt --check` on the two edited docs reports formatting differences in
  unrelated passages that are identical on the base branch; not touched.
- Full gate `./quality.sh`: not run here; CI runs the same checks on the PR.

Not done / risk: none beyond the above.
