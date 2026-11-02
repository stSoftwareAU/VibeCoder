## Summary

The fleet reviewer's `{{PREVIOUS_FINDINGS}}` wording in
`.claude/skills/review-fleet-prs/SKILL.md` now says an unfixed earlier finding
stays out of `findings` "even where step 8 would make a `partial` or `missing`
closure entry a finding", and that the entry's verdict is still reported in
`closure`. The brief's step 8 ("Every `partial` or `missing` entry is also a
blocking **finding**") no longer makes the reviewer write a fresh finding beside
the gap `post.ts` already adds. Closes #4620.

```mermaid
flowchart LR
    C[closure entry partial] --> V[closure verdict still reported]
    E[earlierFindings verdict not fixed] --> G[post.ts adds one gap finding]
    C -. SKILL.md wording: no fresh finding .-> G
    G --> P[defect listed once per round]
```

## Spec

### Intent and Rationale

- Two instructions conflicted on re-review; the reviewer followed step 8, so
  each send-back added a copy. Rewording only, as the issue proposes, leaves the
  shared brief and the pre-PR verifier unchanged.

### Essential Design Decisions

- A `partial` criterion no earlier finding covers still becomes a fresh finding
  under step 8; only the covered case is routed to the gap.
- "Step 8" is the brief's numbered item 8, using the issue's wording verbatim.

### Undiscoverable Facts

- The agreement comment asked for a multi-round replay and for the closure
  verdict to stay reported; `post.ts` does not read `closure`, so the replay
  covers `reviewForPost` only.

## Evidence

Prompt wording plus tests, no UI. `worker/deno/lib/earlier_findings.ts` produces
one gap per not-`fixed` verdict, so a reply that leaves the defect out of
`findings` posts it once; the replay test shows one finding across rounds 1 and
2, none once `fixed`, and two when a fresh finding is also written (no dedupe in
`post.ts`, which is why the wording matters).

## Test Plan

- Added `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts` "fleet
  post - an unresolved closure defect stays one outstanding finding across
  rounds, then clears when fixed" (3-round replay plus contrast).
- Added `worker/deno/tests/pr_review_brief_shared_3395_test.ts` "SKILL.md
  resolves the brief's partial-or-missing closure rule…": red when the SKILL.md
  sentence is reverted (observed), green with it.
- Review fixes scope the wording checks to `1. Review` in SKILL.md and
  `Review Mode — one change against its linked issue` in the brief. Moving
  either pinned rule outside its section makes the test fail (observed).
- The closure step number is read from the brief. Changing its numbered item
  from 8 to 9 makes the SKILL.md reference check fail (observed, then restored).
- Deleting "Still report that entry's verdict in `closure`." makes the scoped
  instruction check fail (observed, then restored).
- The replay now asserts on the returned review's closure verdict and note.
  Making `reviewForPost` return `closure: undefined` fails that assertion
  (observed, then restored); the former input-only assertion was replaced.
- `deno task test:unit` on both files: 37 passed, 0 failed after restoration.
- The local quality gate passes formatter, linter, whole-tree type checking,
  Markdown lint, Mermaid and completeness checks. Its full test suite crashes
  in Deno with "pledge test permissions called before restoring previous
  pledge"; a separate full unit-suite run reproduces that runtime panic.
  Semgrep and Checkov cannot run: neither tool nor its container runtime/image
  is available. Config integration is skipped because `.config.json` is absent.
- Twin copies: the wording appears only in SKILL.md
  (`git grep "leave it out of"`); the brief is unchanged.

Not checked: the posted effect on a live fleet re-review.
