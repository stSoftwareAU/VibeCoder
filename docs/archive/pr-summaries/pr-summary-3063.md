## Summary

The `review-fleet-prs` gate no longer re-reviews a PR it sent back when the
only commits since then are base-branch merges that leave the PR's own diff
unchanged. It now counts such a PR as `awaiting-fix` until the fleet pushes
its fix, which saves a 55–90k-token xhigh review that could only repeat "still
not fixed". Closes #3063.

## Spec

### Intent and Rationale

- After a send-back, an "Update branch" or a `Merge branch 'Develop'` moved the
  head, so `reviewedAtHead` reported the PR ready, even though the earlier
  findings were bound to still stand
- The gate compares the PR's merge-base diff (`compare/{base}...{X}` against
  `compare/{base}...{head}`) rather than trusting commit messages. A merge that
  resolved a conflict therefore still gets a fresh review

### Essential Design Decisions

- `awaiting-fix` needs three things: the reviewer's latest counted review is
  `CHANGES_REQUESTED` at a commit `X` that is not the head; `X...head` is
  `ahead` and contains only commits with two or more parents; and both
  merge-base diffs hold the same files, statuses and patches. Hunk-header line
  numbers are ignored in the patch comparison
- If any check cannot be confirmed (a compare error such as a 404 after a
  force-push, a binary file without a patch, a truncated list of 250+ commits
  or 300+ files), `ownDiffUnchanged` logs one line to stderr and returns
  `false`. The PR then gets a fresh review, as it did before, and the pass is
  never blocked
- A latest review in state `DISMISSED` does not trigger `awaiting-fix`. GitHub
  cannot tell a stale-dismissed approval from a change request the worker has
  claimed, so the PR gets a fresh review as before
- `skipReason` is now async and takes the checker as a parameter. It calls the
  checker only after every cheap check has passed. The three compare calls
  repeat on each pass while a PR is awaiting its fix; this is marked
  `SIMPLE-ON-PURPOSE`

### Undiscoverable Facts

- The examples in the issue (GRQ-AutoTrader #2213, #2210, #2218) each had a
  single `Merge branch 'Develop'` commit between the send-back and the repeated
  review

## Evidence

Backend/CLI change only (a gate script under `.claude/skills/`). It is covered
by unit tests that call the real `skipReason`, `sentBackAt` and
`ownDiffUnchanged` functions against a fake `gh` returning GitHub-shaped
compare JSON.

```mermaid
flowchart TD
    A[Green, mergeable, not reviewed at head] --> B{Latest review by reviewer<br/>CHANGES_REQUESTED at X != head?}
    B -- no --> R[ready: review]
    B -- yes --> C{X...head ahead and<br/>every commit a merge?}
    C -- no --> R
    C -- yes --> D{base...X diff ==<br/>base...head diff?}
    D -- no --> R
    D -- yes --> S[skipped: awaiting-fix]
```

`./quality.sh` passed (the config-integration check was skipped, as usual on
this host).

**Docs sweep**: searched for `already-reviewed`, `ci-cancelled`, "A new push
gets a fresh review" and `review-fleet-prs`. Updated
`.claude/skills/review-fleet-prs/SKILL.md` (rule 8). The other hits
(`docs/workflows/ci-fix.md`, `docs/CONFIGURATION.md`, `docs/SETUP.md`,
`docs/THREAT-MODEL.md`) do not describe the re-review rule.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Add an `awaiting-fix` skip reason — evidence: `.claude/skills/review-fleet-prs/gate.ts` (`Skip`, `skipReason`) — reviewer: met
- **met** — Applies when the latest review is CHANGES_REQUESTED at X and the merge-base diff is unchanged — evidence: `worker/deno/tests/review_fleet_prs_gate_2675_test.ts::skipReason: a merge-only head after a send-back is awaiting-fix (Issue #3063)` — reviewer: met
- **met** — Every commit after X must be a two-parent merge with no conflict-resolution edits — evidence: `ownDiffUnchanged` in `gate.ts` — reviewer: met
- **met** — A conflict-resolving merge or any non-merge commit still gets a fresh review — evidence: `worker/deno/tests/review_fleet_prs_gate_2675_test.ts::skipReason: a merge with conflict-resolution edits is a fresh review (Issue #3063)` and `::skipReason: a fix commit is a fresh review and skips the merge-base compares (Issue #3063)` — reviewer: met
- **met** — Rule 8 reads "a new push that changes the PR's own diff" — evidence: `.claude/skills/review-fleet-prs/SKILL.md` rule 8 — reviewer: met
- **met** — Unit tests for `skipReason`: merge-only → `awaiting-fix`; conflict edits → null; fix commit → null; approved PR moved by a base merge unaffected — evidence: `worker/deno/tests/review_fleet_prs_gate_2675_test.ts::skipReason: an approved PR whose head moved by a base merge never calls the checker (Issue #3063)` and the three tests above — reviewer: met
- **partial** — Later rounds' `log.jsonl` shows no repeated "not fixed" reviews, and `skipped` counts show `awaiting-fix` — evidence: `pass()` counts every `Skip` in `skipped` — reviewer: partial — reason: this can only be observed in live review rounds after merge, not from the diff
- **unrequested** — `countsAsReview()` extracted from `reviewedAtHead`, and `firstLine()` moved up the file — reviewer: unrequested — reason: lets `sentBackAt` share the counted-review rule (DRY), and defines `firstLine` before its new caller; no change in behaviour
- **unrequested** — 300-file cap on the own-diff comparison — reviewer: unrequested — reason: the compare API truncates at 300 files, so a list at the cap cannot prove the diff unchanged; the PR falls back to a fresh review

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — tests call real code with injected fakes and no wall-clock waits; every error path of `ownDiffUnchanged` is tested; `SIMPLE-ON-PURPOSE` marker is in the required form; the catch block logs with context and does not hide the error; the docs change ships in the same diff; Australian English throughout. Optional notes (an inline sort comparator, the moved `firstLine`) were not acted on

## Test Plan

- `worker/deno/tests/review_fleet_prs_gate_2675_test.ts`: existing
  `skipReason` tests now `await` the async function. New tests:
  - `sentBackAt: the latest counted review decides the verdict`
  - four `skipReason … (Issue #3063)` cases
  - `ownDiffUnchanged returns false rather than throwing (Issue #3063)`
- Ran `deno test` on `review_fleet_prs_gate_2675_test.ts` and
  `review_fleet_prs_upkeep_failure_2891_test.ts` (18 passed), then the full
  `./quality.sh` (passed)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
