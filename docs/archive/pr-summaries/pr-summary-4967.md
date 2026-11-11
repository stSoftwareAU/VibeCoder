## Summary

A milestone roll-up PR now names the issues the reviewer's test-change policy
can use. `buildMilestoneSummaryBody` writes anchored `Part of #N` lines directly
under `Closes #<tracking>`: one for the parent issue (the leading `#N` of the
milestone title) and one for each claimed delivered child, up to 62. The
reviewer's candidate cap rises from 5 to 64 so it reads the tracking issue, the
parent and all 62 children. Both limits live in
`worker/deno/lib/governing_issue_limits.ts`, which the worker and the reviewer
import, so they cannot drift. No trust rule changes, and `Part of` never closes
anything. Closes #4967.

## Spec

### Intent and Rationale

- Roll-ups were sent back on "no usable governing issue" and "requirement quote
  is not found" findings because the only linked issue was the service-account
  tracking issue. The parent and the delivered children carry
  `work-on`/`top-priority`, so the #4763 claim rule already accepts them once
  they are linked.
- Children are linked as well as the parent, because a quote held only in a
  delivered child is not fixed by the parent link (a control test pins this).

### Essential Design Decisions

- Numbers come only from the title (`trackingIssueFromMilestoneTitle`) and the
  worker's own `closedIssues`; flagged (`claimProblem`) issues get no line.
  Children are linked whether or not the title leads with `#N`; a title with no
  `#N` and no claimed children keeps today's body byte for byte.
- `MAX_GOVERNING_ISSUES` 5 → 64 (tracking + parent +
  `MILESTONE_PROVENANCE_MAX_CHILDREN` = 62), held with the child limit in
  `governing_issue_limits.ts`. It still bounds per-PR `gh` reads. The repo's
  largest milestone has 40 issues, so every claimed child of a realistic
  milestone is linked (PR #5054 review: the first iteration linked only 10, so a
  quote held in a later child was still sent back). A milestone with more than
  62 claimed children links the 62 lowest-numbered; the rest stay in "Issues
  addressed".
- The fingerprint tag `rollup-provenance-v2` is unchanged by the cap change: it
  is new in this PR, so no released body carries a v2 stamp built under a
  smaller cap.
- The rollup fingerprint is stamped in the live PR body, so the body shape is
  persisted data. The payload now leads with `rollup-provenance-v2`: a body
  stamped with the old fingerprint is refreshed once and gains the lines. This
  chooses bump-the-key over reading the old shape.

### Undiscoverable Facts

- The evidence PRs are in a private fleet repository. No runtime output from it
  was inspected here; the fix follows from the issue's reading of
  `resolveGoverningIssues`.

## Evidence

Backend-only change; no UI files. Tests (all under `worker/deno/tests/`):

- `milestone_completion_test.ts`: body lines, no fabricated parent, children
  rules and cap (including a 40-child milestone), a roll-up body fed through the
  real `resolveGoverningIssues`/`assessTestChanges` (including a 15-child
  roll-up whose quote is held only in the fifteenth child), two controls, and
  the old-fingerprint refresh.
- `review_fleet_prs_test_policy_4655_test.ts`: the raised cap, with a
  roll-up-shaped body.

```mermaid
flowchart LR
    M["milestone '#42 Retry policy'"] --> B[buildMilestoneSummaryBody]
    B --> C["Closes #99 (tracking, ignored by reviewer)"]
    B --> P["Part of #42 (parent)"]
    B --> K["Part of #77 ... (claimed children)"]
    P --> R[resolveGoverningIssues]
    K --> R
    R --> G["#4763 claim rule decides trust"]
```

## Acceptance Criteria

The issue states no acceptance-criteria heading, so no reviewer block is
required. The one limit that remains is the 62-child cap described above, which
no milestone in this repo reaches (the largest has 40 issues).

## Test Plan

- `milestone_completion_test.ts`: leading `#42` gives a line reading exactly
  `Part of #42` straight after `Closes #99` and no closing keyword for 42;
  titles `v1.0 release` and `Fix #42 later` give no `Part of` line and the body
  is byte-identical to today's; claimed children ascending, deduplicated,
  flagged and unsafe numbers excluded; `MILESTONE_PROVENANCE_MAX_CHILDREN`
  children for that many plus three claimed (lowest numbers kept) and all 40 for
  a 40-child milestone; production-path test where tracking #99 is ignored,
  parent #42 and child #77 are accepted and the child-only quote is found;
  control: without the child line the quote is not found; control: an untrusted
  fleet-filed child is still ignored; old-fingerprint rollup refreshed once, not
  again on the next scan.
- `milestone_completion_test.ts`: a 15-child roll-up whose requirement quote is
  held only in the fifteenth child (#215) is assessed with no finding and lists
  #215 among the governing issues; at the old cap of 12 it is red.
- `review_fleet_prs_test_policy_4655_test.ts`: renamed `at most five are read`
  to `at most MAX_GOVERNING_ISSUES are read` (`MAX_GOVERNING_ISSUES + 2` refs,
  `MAX_GOVERNING_ISSUES` reads; the invalid-input half is unchanged), and added
  a roll-up body test (tracking, parent and 62 children read, the 63rd child not
  read).
- Mutation check (survivors on the `Part of` guards): the parent and child
  guards now share one `isLinkable` predicate (safe integer, positive, not the
  tracker); the old `parentNumber !== null` and `parentNumber > 0` operands were
  dead (`isSafeInteger(null)` is false; the title parser only returns positive
  numbers) and were removed. New tests pin the rest: a parent equal to the
  tracker, a parent beyond the safe-integer range, and zero or negative child
  numbers each get no `Part of` line. Dropping `isSafeInteger`, `n > 0` or the
  tracker check from the predicate turns a test red.
- Red checks: no child lines → children, cap, production-path, untrusted-child
  and fingerprint tests red; no parent line → leading-`#N`, children and
  production-path tests red; fingerprint tag removed → refresh test red;
  reviewer cap set to 12 → the cap, 15-child and 40-child tests red.
- Edited expectation: the cap test's expectation 5 → `MAX_GOVERNING_ISSUES` (64)
  goes red when the reviewer's `candidates.length >= MAX_GOVERNING_ISSUES` check
  is removed (both cap tests fail).
- Callers/siblings: the only production caller of `buildMilestoneSummaryBody` is
  `milestone_completion.ts` (passes the title and `closedIssues`);
  `security_untrusted_ingestion_1249_test.ts` still passes.
- Docs read and updated: `docs/INTERNALS.md` (summary PR body paragraph),
  `docs/workflows/milestones.md` (Final PR step and fingerprint bullet).
  `CONFIGURATION.md`'s test-change section concerns the reviewer only and names
  no count.
- `./quality.sh < /dev/null` on the final head: PASSED (config integration and
  checkov skipped: no config, no checkov). New module
  `governing_issue_limits.ts` is claimed by
  `docs/audits/lib-sweep-coverage/top-up-4967.json`.

Not done or not checked: the real review path against a private fleet PR; the
62-child cap means a milestone with more than 62 claimed children links only its
62 lowest-numbered (none in this repo is that large). #4763: Reviewer's
test-change policy refuses an owner-approved, fleet-filed issue as the governing
issue.
