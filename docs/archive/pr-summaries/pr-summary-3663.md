## Summary

The review-fleet-prs gate no longer posts `@dependabot rebase`. Dependabot
refuses that command from the reviewer App, but the gate recorded it as done
and never asked again at that head, so bump PRs stayed behind. Now a behind
Dependabot PR that is approved at its head is brought up to date with the same
`update-branch` call fleet PRs use, both from the gate pass and from `post.ts`
right after an approval. Both paths arm auto-merge on a Dependabot PR before
they update it, where the repo allows auto-merge. A conflicting Dependabot PR gets no comment and no
push, and upkeep reports `<repo>#<n> conflicting, waiting on Dependabot`.
`dependabot-rebase.json` and the `rebase` action are removed. Closes #3663.

## Spec

### Intent and Rationale

- Dependabot only obeys users with push access, so no App-posted command can
  work. The App already has Contents write, so `update-branch` (which fleet PRs
  already use) is a path that works.
- The `kind` parameter of `needsBranchUpdate` and `shouldUpdateBranch` existed
  only to exclude Dependabot, so it is removed rather than kept unused.

### Essential Design Decisions

- A behind Dependabot PR approved by the reviewer at its head and not yet armed
  has auto-merge armed **before** the branch update in the same pass. The update
  creates a merge commit the approval does not cover, so arming afterwards would
  wait for a re-review. BEHIND no longer blocks the auto-merge decision in
  `dependabotAction`.
- `post.ts` does the same after it approves a behind Dependabot PR that is not
  yet armed. It reads the repo's `autoMergeAllowed`, `squashMergeAllowed` and
  `mergeCommitAllowed` (GraphQL, as the gate's search does), arms with the
  method `dependabotAction` would pick (`autoMergeMethod`, now shared), and only
  then updates. It prints `autoMergeArmed: <method>`. When GitHub refuses to arm
  it, it prints `autoMergeError` and skips the update: the PR stays at the
  approved head, so the next gate pass tries to arm it again, then updates it. In a repo
  that does not allow auto-merge nothing is armed and the PR is updated, as the
  gate does. `armAutoMerge` holds the `gh pr merge --auto` call for both paths.
- Dependabot PRs use the fleet rule unchanged: approved at the head by anyone
  (any host or by hand), behind, not a draft, not conflicting, once per head
  (`branch-update.json`). A refusal is reported as `branch update failed: …` and
  is not retried at that head.
- The conflicting line is reported on every pass, with no once-per-head memory.
  No action is taken, so there is nothing to repeat or suppress.

### Undiscoverable Facts

- PR #3639's comments show the refusal three times:
  `stsoftware-pr-reviewer[bot]: @dependabot rebase` followed by
  `dependabot[bot]: Sorry, only users with push access can use that command.`
  (`gh api repos/stSoftwareAU/VibeCoder/issues/3639/comments`).
- `gh repo view --json` has no `autoMergeAllowed` field (checked with gh on
  this host), so `post.ts` reads the merge settings through `gh api graphql`.
- Grill-Me Round 1 accepted the trade-off: Dependabot stops self-rebasing a PR
  once someone else commits to it. If such a PR later conflicts, upkeep still
  says `waiting on Dependabot`, and a human closes it or comments
  `@dependabot recreate`.
- `dependabot-rebase.json` files left on existing hosts are no longer read.
  They are harmless and are not deleted.

## Evidence

Backend/CLI only (the review-fleet-prs skill scripts). No UI file is touched.

```mermaid
flowchart TD
    P[Open Dependabot PR into default branch] --> D{draft?}
    D -- yes --> N[no upkeep]
    D -- no --> C{CONFLICTING?}
    C -- yes --> W["upkeep: conflicting, waiting on Dependabot<br/>(no comment, no push)"]
    C -- no --> A{approved by reviewer at head<br/>and not armed?}
    A -- yes --> M[arm auto-merge]
    A -- no --> B
    M --> B{BEHIND and approved at head,<br/>not asked at this head?}
    S["post.ts approves a BEHIND Dependabot PR"] --> SA{"armed, or repo<br/>forbids auto-merge?"}
    SA -- no --> SM[arm auto-merge]
    SM -- armed --> SU[update-branch]
    SM -- refused --> SE["autoMergeError, no update<br/>(next gate pass tries to arm again, then updates)"]
    SA -- yes --> SU
    B -- yes --> U["update-branch (expected_head_sha)<br/>upkeep: branch update requested / failed"]
    B -- no --> R[normal review gate]
    U --> R
```

- Gate pass: `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`
  ("pass: a fleet or Dependabot PR approved at its head but behind is brought up
  to date once per head (Issue #3225, #3663)" and "pass: a Dependabot PR behind
  and approved by the reviewer gets auto-merge armed before it is updated
  (Issue #3663)").
- Post-approval path: `worker/deno/tests/review_fleet_prs_dependabot_test.ts`
  ("post.ts end to end: an approved, behind Dependabot PR gets auto-merge armed,
  then is updated, and is never commented on (Issue #3663)" and "post.ts end to
  end: a Dependabot PR whose auto-merge is refused is not updated, so the next
  gate pass can arm it at the approved head (Issue #3663)"), plus the
  `armDependabotAutoMerge` unit tests (allowed method, a repo that forbids
  auto-merge, a refusal). The `gh` stub follows GitHub REST "Update a pull
  request branch" (`PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch`,
  202 with `message`/`url`; <https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch>)
  and the GraphQL repository fields `autoMergeAllowed`, `squashMergeAllowed`
  and `mergeCommitAllowed` (`--jq .data.repository`). It answers only the calls
  `post.ts` makes on this path (`pr view`, `pr review`, `api graphql`,
  `pr merge --auto --squash`, the update-branch `api` call) and exits 1 on any
  other call.
- Issue numbers cited: #3663: Dependabot refuses the reviewer App's
  @dependabot rebase; bump PRs stay behind. #3225: review-fleet-prs gets stuck
  on a backlog … never brings an approved PR up to date. #3639: chore(actions):
  bump the github-actions group with 4 updates.

**Docs sweep** — grep: "@dependabot rebase", "rebase requested",
`dependabot-rebase`, `REBASE_FILE`, "rebase failed", "never pushed",
`approved-fleet-prs-that-are-behind`, "rebas\w* request", `needsBranchUpdate`,
`shouldUpdateBranch`, `dependabotAction`; section:
`.claude/skills/review-fleet-prs/references/edge-cases.md#dependabot-prs`
(and `#approved-prs-that-are-behind`, renamed from
`#approved-fleet-prs-that-are-behind`); siblings: "auto-merge failed",
"branch update requested" (the upkeep-line set gained
`conflicting, waiting on Dependabot`; the edge-cases list names it, and SKILL.md's
upkeep pointer lists it); updated: `.claude/skills/review-fleet-prs/SKILL.md`,
`.claude/skills/review-fleet-prs/references/edge-cases.md`,
`.claude/skills/review-fleet-prs/references/running-unattended.md`,
`docs/CONFIGURATION.md`, and the header comments of `scripts/dependabot.ts`,
`scripts/branch_update.ts`, `scripts/post.ts` and `scripts/gate.ts`; grep
"rebase/auto-merge" found two comments outside the diff that named the removed
rebase upkeep: `scripts/run.sh:272` and
`worker/deno/tests/review_fleet_prs_runner_test.ts:334`, both now say
"auto-merge/branch update"; grep "autoMergeArmed", "branchUpdateError" found
SKILL.md's post.ts output list and round-report rule, both now name
`autoMergeArmed`/`autoMergeError`;
`docs/HUMAN-PR-POLICY.md:179` — still true because it describes the worker's own
bot-PR path, which never posts `@dependabot rebase`;
`worker/deno/lib/pr_branch_update.ts:543` — still true for the same reason;
`worker/deno/tests/review_fleet_prs_escalate_test.ts:293` — still true because
it is a redaction fixture string, not a gate behaviour.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The reviewer App posts no `@dependabot rebase` (or any `@dependabot`) comment: a gate pass over a BEHIND or CONFLICTING Dependabot PR posts zero comments on it — evidence: `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts::pass: a fleet or Dependabot PR approved at its head but behind is brought up to date once per head (Issue #3225, #3663)` — reviewer: met
- **met** — A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head gets the `update-branch` endpoint with `expected_head_sha` — evidence: `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` (pass test, #34 and #37) and `worker/deno/tests/review_fleet_prs_dependabot_test.ts::post.ts end to end: an approved, behind Dependabot PR is updated and never commented on (Issue #3663)` — reviewer: met
- **met** — A BEHIND Dependabot PR not yet approved at its head gets no action; the review runs first — evidence: `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` (#35 has no update and no upkeep line, and is in `ready`) — reviewer: met
- **met** — A CONFLICTING Dependabot PR gets no comment and no push; upkeep reports `conflicting, waiting on Dependabot` — evidence: `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` (#36), `worker/deno/tests/review_fleet_prs_dependabot_test.ts::a conflicting Dependabot PR is left to Dependabot, approved or not (Issue #3663)` — reviewer: met
- **met** — `dependabot-rebase.json` and the `rebase` action are removed; `references/edge-cases.md` and the header comments in `scripts/dependabot.ts`, `scripts/branch_update.ts` and `scripts/post.ts` describe the new behaviour — evidence: `.claude/skills/review-fleet-prs/scripts/gate.ts`, `.claude/skills/review-fleet-prs/references/edge-cases.md` — reviewer: met
- **met** — Tests cover: BEHIND + approved → update requested; BEHIND + unapproved → no action; CONFLICTING → no comment, waiting line; no code path emits `@dependabot` — evidence: `worker/deno/tests/review_fleet_prs_dependabot_test.ts`, `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` — reviewer: met
- **unrequested** — Auto-merge is armed before the branch update for a behind, approved, unarmed Dependabot PR, in the gate pass and in `post.ts` (which skips the update when arming is refused) — reviewer: unrequested — reason: without it, the update's new merge-commit head would not be covered by the approval and would need a second review before auto-merge could be armed
- **unrequested** — SKILL.md rule 9 and pointers, `running-unattended.md` and `docs/CONFIGURATION.md` reworded; the anchor renamed to `#approved-prs-that-are-behind` — reviewer: unrequested — reason: those docs said Dependabot branches are never updated, which the change makes false
- **unrequested** — The `kind` parameter is removed from `needsBranchUpdate` and `shouldUpdateBranch`, and `review_fleet_prs_app_reviewer_test.ts` is updated for the two-argument `dependabotAction` — reviewer: unrequested — reason: the parameter only carried the exclusion the issue removes, so keeping it would leave it unused

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — A stub must mirror the real callee's contract: the new end-to-end test's `gh` stub answered every call with exit 0 — evidence: `worker/deno/tests/review_fleet_prs_dependabot_test.ts:137` — reason: fixed in this diff (the stub now answers only `pr view`, `pr review` and the update-branch call, exits 1 otherwise, and names the REST contract)
- **clean** — Checked: docs owed by the change (old-wording grep), Australian English (review-enforced), fail-loud handling (refusals still reported), log levels (review-enforced), no test-only members, every caller of the narrowed helpers updated (`gate.ts`, `post.ts`), each changed call site has a red test, persisted data (`dependabot-rebase.json` is only dropped; the remaining keys are unchanged), labels and shared state untouched (review-enforced), negative tests have fixtures that would trip them, test host-state isolation (temp `HOME` and `--state-dir`)

## Test Plan

- `deno task test:unit $(ls tests/review_fleet_prs_*test.ts) < /dev/null`: passed (191 passed, 0 failed) on the head.
- `deno task test:unit tests/review_fleet_prs_dependabot_test.ts tests/review_fleet_prs_backlog_3225_test.ts tests/review_fleet_prs_app_reviewer_test.ts tests/review_fleet_prs_upkeep_failure_2891_test.ts tests/review_fleet_prs_checklists_3594_test.ts tests/review_fleet_prs_gate_audit_3116_test.ts < /dev/null`: passed (61 passed, 0 failed) on the head.
- `./quality.sh < /dev/null`: passed on the final tree (`Result: PASSED (with skipped checks)`; only `config integration` skipped, as on every run without a host config).

Red checks (each restored afterwards):

- Re-excluding Dependabot at the gate's `needsBranchUpdate` call: the backlog pass test (#34) and the arm-before-update test went red.
- Replacing the `post.ts` `shouldUpdateBranch` call with `false`: the post.ts end-to-end Dependabot test went red (`branchUpdated` was `undefined`).
- Never arming in `post.ts` (the `pr.kind === "dependabot"` condition replaced with `false`): both post.ts end-to-end Dependabot tests went red.
- Updating even when arming was refused (the `autoMerge?.armed === false` check replaced with `false`): the refused-auto-merge end-to-end test went red.
- `dependabotAction` returning `none` for CONFLICTING: the unit conflicting test and the backlog pass test's waiting-line assertion went red.
- Re-adding a `pr comment … "@dependabot rebase"` for CONFLICTING in `gate.ts`: the backlog pass test's no-comment assertion went red.

Assertions removed from existing tests, each with the requirement that makes it
untrue (an assertion kept with a narrower signature is still listed, since its
lines changed):

- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(needsBranchUpdate(behind, "dependabot", undefined), false);` — #3663 requires Dependabot PRs to be updated, so this is untrue
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(shouldUpdateBranch("approved", "dependabot", "BEHIND"), false);` — #3663 requires `post.ts` to update an approved, behind Dependabot PR, so this is untrue
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(shouldUpdateBranch("approved", undefined, "BEHIND"), true);` — #3663 removes the `kind` argument of `shouldUpdateBranch`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; the same case is kept as `shouldUpdateBranch("approved", "BEHIND")` → `true`
- Removed from `worker/deno/tests/review_fleet_prs_app_reviewer_test.ts`: `assertEquals(dependabotAction(pr, BOT, undefined).kind, "auto-merge");` — #3663 removes the `rebase` action and its `dependabot-rebase.json` memory, so `dependabotAction` no longer takes the `rebaseAskedFor` argument and this three-argument call no longer type-checks; the same case is kept as `assertEquals(dependabotAction(pr, BOT).kind, "auto-merge")`
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(needsBranchUpdate(behind, "fleet", undefined), true);` — #3663 removes the `kind` argument of `needsBranchUpdate`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept as `needsBranchUpdate(behind, undefined)` → `true`
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(needsBranchUpdate(behind, "fleet", "head-20"), false);` — #3663 removes the `kind` argument of `needsBranchUpdate`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept as `needsBranchUpdate(behind, "head-20")` → `false`
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(needsBranchUpdate(behind, "fleet", "head-19"), true);` — #3663 removes the `kind` argument of `needsBranchUpdate`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept as `needsBranchUpdate(behind, "head-19")` → `true`
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals( needsBranchUpdate( { ...behind, mergeStateStatus: "CLEAN" }, "fleet", undefined, ), false, );` — #3663 removes the `kind` argument of `needsBranchUpdate`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept without the argument
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals( needsBranchUpdate( { ...behind, mergeStateStatus: "BLOCKED" }, "fleet", undefined, ), false, );` — #3663 removes the `kind` argument of `needsBranchUpdate`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept without the argument
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals( needsBranchUpdate({ ...behind, isDraft: true }, "fleet", undefined), false, );` — #3663 removes the `kind` argument of `needsBranchUpdate`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept without the argument
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals( needsBranchUpdate( { ...behind, mergeable: "CONFLICTING" }, "fleet", undefined, ), false, );` — #3663 removes the `kind` argument of `needsBranchUpdate`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept without the argument
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals( needsBranchUpdate( { ...behind, reviews: { nodes: [review("owner", "APPROVED", "old")] } }, "fleet", undefined, ), false, );` — #3663 removes the `kind` argument of `needsBranchUpdate`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept without the argument
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(updates.map((c) => c[3]), [ "repos/acme/app/pulls/30/update-branch", "repos/acme/app/pulls/31/update-branch", ]);` — #3663 requires an approved, behind Dependabot PR to be updated, so #34 is now updated too; the list is now `30`, `31`, `34`
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals( result.upkeep.filter((u) => u.includes("branch")), [ "acme/app#30 branch update requested", "acme/app#31 branch update requested", ], );` — #3663 requires upkeep to report `branch update requested` for an updated Dependabot PR, so the list now ends with `acme/app#34 branch update requested`
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(result.ready.map((p) => p.number), [33]);` — the test now also has a behind, unapproved Dependabot PR (#35), which #3663 says is reviewed first, so `ready` is now `[33, 35]`
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals( calls.some((c) => c[0] === "pr" && c[1] === "comment" && c[2] === "34"), true, );` — #3663 requires zero comments on a Dependabot PR, so this is untrue; replaced by "no `pr comment` call and no `@dependabot` argument"
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(shouldUpdateBranch("approved", "fleet", "BEHIND"), true);` — #3663 removes the `kind` argument of `shouldUpdateBranch`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept as `shouldUpdateBranch("approved", "BEHIND")` → `true`
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(shouldUpdateBranch("approved", "fleet", "CLEAN"), false);` — #3663 removes the `kind` argument of `shouldUpdateBranch`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept as `shouldUpdateBranch("approved", "CLEAN")` → `false`
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(shouldUpdateBranch("approved", "fleet", undefined), false);` — #3663 removes the `kind` argument of `shouldUpdateBranch`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept as `shouldUpdateBranch("approved", undefined)` → `false`
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals( shouldUpdateBranch("changes_requested", "fleet", "BEHIND"), false, );` — #3663 removes the `kind` argument of `shouldUpdateBranch`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept as `shouldUpdateBranch("changes_requested", "BEHIND")` → `false`
- Removed from `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: `assertEquals(shouldUpdateBranch("held", "fleet", "BEHIND"), false);` — #3663 removes the `kind` argument of `shouldUpdateBranch`, which only existed to exclude Dependabot, so this three-argument call no longer type-checks; kept as `shouldUpdateBranch("held", "BEHIND")` → `false`
- Removed from `worker/deno/tests/review_fleet_prs_dependabot_test.ts`: `assertEquals( dependabotAction(pr({ mergeStateStatus: "BEHIND" }), "nleck", undefined) .kind, "rebase", );` — #3663 removes the `rebase` action, so this is untrue; the behind, unapproved case is now asserted as `{ kind: "none", reason: "not approved" }`
- Removed from `worker/deno/tests/review_fleet_prs_dependabot_test.ts`: `assertEquals( dependabotAction(pr({ mergeable: "CONFLICTING" }), "nleck", "older").kind, "rebase", );` — #3663 removes the `rebase` action and posts no comment on a conflicting PR, so this is untrue; a conflicting PR is now asserted as `conflicting`, approved or not
- Removed from `worker/deno/tests/review_fleet_prs_dependabot_test.ts`: `assertEquals( dependabotAction(pr({ mergeStateStatus: "BEHIND" }), "nleck", "head").kind, "none", );` — #3663 removes the rebase memory this checked (`rebase already requested`), so the case no longer exists
- Removed from `worker/deno/tests/review_fleet_prs_dependabot_test.ts`: `assertEquals( dependabotAction(pr({ reviews: approved }), "nleck", undefined), { kind: "auto-merge", method: "squash" }, );` — #3663 removes the `rebase` action and its `dependabot-rebase.json` memory, so `dependabotAction` no longer takes the `rebaseAskedFor` argument and this three-argument call no longer type-checks; kept without the argument
- Removed from `worker/deno/tests/review_fleet_prs_dependabot_test.ts`: `assertEquals( dependabotAction( pr({ reviews: approved, repository: { ...pr().repository, squashMergeAllowed: false }, }), "nleck", undefined, ), { kind: "auto-merge", method: "merge" }, );` — #3663 removes the `rebase` action and its `dependabot-rebase.json` memory, so `dependabotAction` no longer takes the `rebaseAskedFor` argument and this three-argument call no longer type-checks; kept without the argument
- Removed from `worker/deno/tests/review_fleet_prs_dependabot_test.ts`: `assertEquals(dependabotAction(pr(), "nleck", undefined).kind, "none");` — #3663 removes the `rebase` action and its `dependabot-rebase.json` memory, so `dependabotAction` no longer takes the `rebaseAskedFor` argument and this three-argument call no longer type-checks; kept as `dependabotAction(pr(), "nleck").kind` → `"none"`
- Removed from `worker/deno/tests/review_fleet_prs_dependabot_test.ts`: `assertEquals( dependabotAction(pr({ reviews: stale }), "nleck", undefined).kind, "none", );` — #3663 removes the `rebase` action and its `dependabot-rebase.json` memory, so `dependabotAction` no longer takes the `rebaseAskedFor` argument and this three-argument call no longer type-checks; kept without the argument
- Removed from `worker/deno/tests/review_fleet_prs_dependabot_test.ts`: `assertEquals( dependabotAction( pr({ reviews: approved, autoMergeRequest: { enabledAt: "t" } }), "nleck", undefined, ).kind, "none", );` — #3663 removes the `rebase` action and its `dependabot-rebase.json` memory, so `dependabotAction` no longer takes the `rebaseAskedFor` argument and this three-argument call no longer type-checks; kept without the argument
- Removed from `worker/deno/tests/review_fleet_prs_dependabot_test.ts`: `assertEquals( dependabotAction( pr({ reviews: approved, repository: { ...pr().repository, autoMergeAllowed: false }, }), "nleck", undefined, ).kind, "none", );` — #3663 removes the `rebase` action and its `dependabot-rebase.json` memory, so `dependabotAction` no longer takes the `rebaseAskedFor` argument and this three-argument call no longer type-checks; kept without the argument
- Removed from `worker/deno/tests/review_fleet_prs_dependabot_test.ts`: `assertEquals( dependabotAction( pr({ isDraft: true, mergeStateStatus: "BEHIND" }), "nleck", undefined, ).kind, "none", );` — #3663 removes the `rebase` action and its `dependabot-rebase.json` memory, so `dependabotAction` no longer takes the `rebaseAskedFor` argument and this three-argument call no longer type-checks; kept without the argument

<!-- vibe-branch-outcomes -->
