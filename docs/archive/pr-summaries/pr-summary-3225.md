# PR summary: review-fleet-prs on a backlog (Issue #3225)

## Summary

Closes #3225.

With many open fleet PRs the review skill burned rounds without landing
anything. Three causes, each fixed in the gate and post scripts and documented
in `SKILL.md`:

- **PRs another host had already handled came back.** `gate.ts` only recognised
  reviews by the signed-in login, so a PR the reviewer App on GRQ-25 had
  approved or sent back at its head was `ready` again on the laptop. A review
  carrying the skill's marker now counts as the skill's own review whichever
  login posted it (`already-reviewed`, `awaiting-fix`), and a PR anyone approved
  at its head is skipped as `approved`.
- **The per-round cap was the model's job.** The gate handed over every ready PR
  and the skill text asked the model to take five. The gate now applies
  `--limit` (default 5) itself, after every other skip, so a red, approved or
  already-reviewed PR never takes a slot; the rest are counted `over-limit` and
  no file list is read for them. The search is `sort:updated-asc`, so a PR whose
  head keeps moving cannot starve the quiet ones.
- **An approved PR stayed behind its base.** Every fleet PR is armed with
  auto-merge on CI green, approved and branch up to date, and nothing in the
  skill cleared the third condition. `post.ts` now follows an approval of a
  `BEHIND` fleet PR with `update-branch` at the reviewed head (review first,
  then update), and the gate does the same once per head for a fleet PR already
  approved at its head but still behind (`branch_update.ts`). Dependabot
  branches are never pushed to.

## Spec

### Intent and Rationale

- The owner's order of processing: approve first, then bring the branch up to
  date, so the approval and the update land in one pass instead of a round trip
  per PR.
- The owner's ask: skip PRs already approved, never let a non-green PR count
  towards the five, and update a PR that is not up to date.

### Essential Design Decisions

- "Approved" means an `APPROVED` review whose commit is the current head, by
  anyone. GitHub's `reviewDecision` is not used: it can be `APPROVED` on a stale
  approval in a repo without dismiss-on-push, which would break rule 8 (review
  each head commit once).
- The gate updates only PRs already approved at their head; an unapproved PR is
  reviewed as it is and updated by `post.ts` after the approval, so an approval
  is never of a head nobody read.
- `expected_head_sha` is passed to `update-branch`, so a fleet push between the
  review and the update makes GitHub refuse rather than update an unreviewed
  head. A refusal is reported in `upkeep` or `branchUpdateError` and not retried
  at that head.
- The update memory (`branch-update.json`) and failure memory live in the
  skill's state directory beside the Dependabot ones, so one request per head.

### Undiscoverable Facts

- Dry gate pass on 2026-10-05 (reviewer `nleck`, laptop): three ready PRs, all
  already handled by the App on GRQ-25 (GRQ-AutoTrader#2546 sent back at head,
  #2539 sent back at an earlier head, #2560 dismissed), all `BEHIND` with
  auto-merge armed. With this branch the same pass reports #2546 as
  `already-reviewed`; #2539 stays ready because a real fix was pushed since.
- `sort:updated-asc` in the GraphQL search query string was verified live: the
  first three results came back in ascending `updatedAt` order.
- The skill runs on GRQ-25 as the reviewer App (`run.sh`); the App's Contents
  write permission, already required for Dependabot auto-merge, also covers
  `update-branch`.

## Evidence

- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` was written first
  and failed on the missing exports (`approvedAtHead`, `limit`,
  `branch_update.ts`); it passes with the change, alongside the six existing
  `review_fleet_prs_*` test files (62 tests) and the two skill-text tests (24
  tests).
- **Docs sweep:** grepped `Take at most`, `per round`, `over-limit`,
  `already-reviewed`, `update-branch`, `up to date` over
  `.claude/skills/review-fleet-prs`, `docs/*.md`, `README.md` and
  `DESIGN-PRINCIPLES.md`; updated `.claude/skills/review-fleet-prs/SKILL.md`
  (rules 8 and 9, the loop, step 1 Review, step 2 Post, step 4 Report, Notes,
  the App permissions paragraph, a new "Approved fleet PRs that are behind"
  section) and `docs/CONFIGURATION.md`
  (`section: Reviewer App for
  fleet PR reviews`). Hits left in place:
  `docs/MERGE.md:643,651,676`, `docs/INTERNALS.md:1972` — still true because
  they describe the worker's own `update-branch` path in
  `merge_block_escalation.ts`, not this skill; `docs/MERGE.md:26,38,67`,
  `docs/SETUP.md:163`, `DESIGN-PRINCIPLES.md:831` — still true because they
  describe the rulesets' "branch up to date" condition this change relies on;
  `.claude/skills/review-fleet-prs/dependabot.ts:10` and `SKILL.md:189` — still
  true because Dependabot rebases its own branch.

## Test Plan

- Added `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`:
  `approvedAtHead`; `skipReason` for an owner approval (`approved`), the App's
  marker approval and send-back at head (`already-reviewed`), the App's
  send-back at an older head with a merge-only head (`awaiting-fix`), a stale
  approval and a stranger's change request (ready); `pass` with a limit (five of
  seven ready, a red and an approved PR not counted, five file lists read,
  `sort:updated-asc`, `limit: 10` lifts it); `needsBranchUpdate`; `updateBranch`
  (call shape and a reported refusal); `pass` updating an App-approved and an
  own-approved behind PR once per head, never a Dependabot one, leaving an
  unreviewed behind PR for the review; a refused update reported and not
  retried; `shouldUpdateBranch` and `postedResult`.
- Existing `review_fleet_prs_*` tests unchanged and passing.
