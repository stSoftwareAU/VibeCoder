# Update approved Dependabot branches through GitHub

## Summary

Closes #3663.

The gate now brings a behind Dependabot PR up to date through the existing
`update-branch` endpoint, with `expected_head_sha` set to the approved head.
It requires the reviewer's approval at that head, skips drafts and conflicts,
and shares successful or refused update memory with the post path until the
head changes.
Conflicting Dependabot PRs produce a waiting line without a comment or push.
The post-approval path also updates Dependabot PRs and checks live draft and
conflict state. The obsolete rebase action and rebase-cache reads/writes are
removed; existing obsolete cache files are left untouched and unused.

## Spec

### Intent and Rationale

- The reviewer App's posted rebase command was accepted as a comment but
  refused by Dependabot; the gate incorrectly treated that as successful upkeep.
- Use the existing leased GitHub update after approval and expose its refusal.

### Essential Design Decisions

- Fleet approvals may still come from any reviewer; Dependabot upkeep requires
  the configured reviewer's approval. REST and GraphQL bot-login spelling
  differences use the existing `sameLogin` helper.
- Branch updates retain their existing API and failure-cache shape. No new
  persisted shape is introduced; the old rebase cache is no longer consulted.
  The shared upkeep-memory module retains existing PR and action keys; both
  gate and post consult them and preserve unrelated entries. Reuse the
  existing cross-process file lock per PR and atomic, locked entry merges;
  no stale whole-map snapshots are written back at pass end.
- The post helper no longer takes a kind discriminator: both authors follow
  the same approval, behind, draft and conflict checks.

- Supporting quality repair: recognise the observed `gh` connection diagnostic
  as an existing network-error category, so an unreachable release-ruleset
  check reports SKIPPED with its cause. Unknown failures still fail; this
  does not claim that any remote ruleset was compared.

### Undiscoverable Facts

- No live Dependabot branch was mutated during local verification. The unchanged
  update API is exercised through the existing injected command boundary.

## Evidence

Three added gate regressions failed against the prior behaviour (3 passed,
3 failed), reporting rebase requests instead of the required updates or waits.
The focused Dependabot, backlog, App-reviewer and upkeep-failure suites now pass
all 39 tests, including a real `post.ts` subprocess with a recording `gh` shim.
A post-to-gate regression also failed on a repeated same-head request before
the shared-memory fix; it now covers success and refusal in both directions,
new heads, and unrelated/action-specific entry preservation. Deterministic
overlapping-post regressions reproduce lost keys and prove same-head request
deduplication. Actual lock-timeout regressions prove an unsent request remains
retryable while a post-request persistence failure stays loud. A subprocess
smoke runs with the documented granular permissions, without `--allow-all`. Twenty-eight isolated
guard mutations each caused an assertion failure; restored
production code passed again. The full review-fleet suite passed 243 tests;
the manifest gate passed 687 tests with one existing ignored test. Changed TypeScript files passed lint, and Markdown lint reported no errors.
The quality-repair regressions first failed (57 passed, 2 failed), then all
67 related classifier/ruleset tests passed. Full local quality validation and
hosted CI remain pending.

Docs sweep — grep: `"Dependabot branches are never pushed"`, `"rebase requested"`,
`"dependabot-rebase"`; updated the skill's Rules and references/edge-cases.md;
section: `.claude/skills/review-fleet-prs/references/edge-cases.md` — Dependabot
PRs and Approved fleet PRs that are behind; siblings: none — the existing
update path now accepts an additional author kind, with no new registry member.
The related rule-9 and header restatements were updated together and applied
to this diff; no conflicting restatement remains in the skill's instructions.
The forwarding shims delegate to these scripts and need no duplicate edit.

## Test Plan

- `worker/deno/tests/review_fleet_prs_dependabot_test.ts`: approved exact-head
  updates, per-head deduplication, ignored legacy cache, reviewer/stale/draft/
  conflict exclusions, refusal cause and retry suppression, post ordering, and
  persisted success/refusal handoff between gate and post in both directions,
  concurrent different/same PRs, lock contention and restricted permissions.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts`: retain fleet behaviour
  and include Dependabot in the requested-update and zero-comment expectations.
- `worker/deno/tests/review_fleet_prs_app_reviewer_test.ts`: retain the App approval
  assertion after removing the obsolete rebase-cache parameter.
- Existing auto-merge and failure-continuation assertions remain covered.

The following assertion replacements remove obsolete helper arguments or change
only issue-required author/rebase expectations. The added end-to-end post case
also proves the Dependabot path itself; draft and conflict exclusions add checks.
The final full-context audit records 21 replacements. Three helper-signature
replacements now include an explicit merge-fallback message or the complete
no-action reason; isolated fallback, repository-policy and draft guard mutations
prove those retained assertions still fail when their guard is removed.

- `worker/deno/tests/review_fleet_prs_app_reviewer_test.ts` — removed `assertEquals(dependabotAction(pr, BOT, undefined).kind, "auto-merge");`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals(dependabotAction(pr, BOT).kind, "auto-merge");`.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` — removed `assertEquals(updates.map((c) => c[3]), [ "repos/acme/app/pulls/30/update-branch", "repos/acme/app/pulls/31/update-branch", ]);`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals(updates.map((c) => c[3]), [ "repos/acme/app/pulls/30/update-branch", "repos/acme/app/pulls/31/update-branch", "repos/acme/app/pulls/34/update-branch", ]);`.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` — removed `assertEquals( result.upkeep.filter((u) => u.includes("branch")), [ "acme/app#30 branch update requested", "acme/app#31 branch update requested", ], );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals( result.upkeep.filter((u) => u.includes("branch")), [ "acme/app#30 branch update requested", "acme/app#31 branch update requested", "acme/app#34 branch update requested", ], );`.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` — removed `assertEquals( calls.some((c) => c[0] === "pr" && c[1] === "comment" && c[2] === "34"), true, );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals( calls.some((c) => c[0] === "pr" && c[1] === "comment" && c[2] === "34"), false, );`.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` — removed `assertEquals(shouldUpdateBranch("approved", "fleet", "BEHIND"), true);`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals(shouldUpdateBranch("approved", "BEHIND"), true);`.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` — removed `assertEquals(shouldUpdateBranch("approved", undefined, "BEHIND"), true);`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals(shouldUpdateBranch("approved", "BEHIND"), true);`.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` — removed `assertEquals(shouldUpdateBranch("approved", "fleet", "CLEAN"), false);`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals(shouldUpdateBranch("approved", "CLEAN"), false);`.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` — removed `assertEquals(shouldUpdateBranch("approved", "fleet", undefined), false);`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals(shouldUpdateBranch("approved", undefined), false);`.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` — removed `assertEquals(shouldUpdateBranch("approved", "dependabot", "BEHIND"), false);`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals(shouldUpdateBranch("approved", "BEHIND"), true);`.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` — removed `assertEquals( shouldUpdateBranch("changes_requested", "fleet", "BEHIND"), false, );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals( shouldUpdateBranch("changes_requested", "BEHIND"), false, );`.
- `worker/deno/tests/review_fleet_prs_backlog_3225_test.ts` — removed `assertEquals(shouldUpdateBranch("held", "fleet", "BEHIND"), false);`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals(shouldUpdateBranch("held", "BEHIND"), false);`.
- `worker/deno/tests/review_fleet_prs_dependabot_test.ts` — removed `assertEquals( dependabotAction(pr({ mergeStateStatus: "BEHIND" }), "nleck", undefined) .kind, "rebase", );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals( dependabotAction(pr({ mergeStateStatus: "BEHIND" }), "nleck") .kind, "none", );`.
- `worker/deno/tests/review_fleet_prs_dependabot_test.ts` — removed `assertEquals( dependabotAction(pr({ mergeable: "CONFLICTING" }), "nleck", "older").kind, "rebase", );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals( dependabotAction(pr({ mergeable: "CONFLICTING" }), "nleck").kind, "none", );`.
- `worker/deno/tests/review_fleet_prs_dependabot_test.ts` — removed `assertEquals( dependabotAction(pr({ mergeStateStatus: "BEHIND" }), "nleck", "head").kind, "none", );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals( dependabotAction(pr({ mergeStateStatus: "BEHIND" }), "nleck").kind, "none", );`.
- `worker/deno/tests/review_fleet_prs_dependabot_test.ts` — removed `assertEquals( dependabotAction(pr({ reviews: approved }), "nleck", undefined), { kind: "auto-merge", method: "squash" }, );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals( dependabotAction(pr({ reviews: approved }), "nleck"), { kind: "auto-merge", method: "squash" }, );`.
- `worker/deno/tests/review_fleet_prs_dependabot_test.ts` — removed `assertEquals(dependabotAction(pr(), "nleck", undefined).kind, "none");`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals(dependabotAction(pr(), "nleck").kind, "none");`.
- `worker/deno/tests/review_fleet_prs_dependabot_test.ts` — removed `assertEquals( dependabotAction(pr({ reviews: stale }), "nleck", undefined).kind, "none", );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals( dependabotAction(pr({ reviews: stale }), "nleck").kind, "none", );`.
- `worker/deno/tests/review_fleet_prs_dependabot_test.ts` — removed `assertEquals( dependabotAction( pr({ reviews: approved, autoMergeRequest: { enabledAt: "t" } }), "nleck", undefined, ).kind, "none", );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals(dependabotAction(pr({ reviews: approved, autoMergeRequest: { enabledAt: "t" } }), "nleck"), { kind: "none", reason: "auto-merge armed" });`.

- `worker/deno/tests/review_fleet_prs_dependabot_test.ts` — removed `assertEquals( dependabotAction( pr({ reviews: approved, repository: { ...pr().repository, squashMergeAllowed: false }, }), "nleck", undefined, ), { kind: "auto-merge", method: "merge" }, );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals( dependabotAction( pr({ reviews: approved, repository: { ...pr().repository, squashMergeAllowed: false }, }), "nleck", ), { kind: "auto-merge", method: "merge" }, "uses merge when the repository disables squash", );`.
- `worker/deno/tests/review_fleet_prs_dependabot_test.ts` — removed `assertEquals( dependabotAction( pr({ reviews: approved, repository: { ...pr().repository, autoMergeAllowed: false }, }), "nleck", undefined, ).kind, "none", );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals( dependabotAction( pr({ reviews: approved, repository: { ...pr().repository, autoMergeAllowed: false }, }), "nleck", ), { kind: "none", reason: "repo does not allow auto-merge" }, );`.
- `worker/deno/tests/review_fleet_prs_dependabot_test.ts` — removed `assertEquals( dependabotAction( pr({ isDraft: true, mergeStateStatus: "BEHIND" }), "nleck", undefined, ).kind, "none", );`. Required by: "A Dependabot PR that is BEHIND, not CONFLICTING, not a draft, and approved by the reviewer at its head". Replaced by: `assertEquals( dependabotAction( pr({ isDraft: true, mergeStateStatus: "BEHIND" }), "nleck", ), { kind: "none", reason: "draft" }, );`.

<!-- vibe-branch-outcomes -->
