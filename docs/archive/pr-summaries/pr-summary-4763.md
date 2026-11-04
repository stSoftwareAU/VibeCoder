## Summary

The reviewer's test-change policy now accepts a same-repo governing issue filed
by a fleet service account when the worker's own claim rule accepts it: a
trusted login that is not a fleet worker added `top-priority` or `work-on`, and
no untrusted account edited the issue since. The service accounts stay out of
the author trust lists. Closes #4763.

Version bump: no `VERSION` change was made by this PR.

## Spec

### Intent and Rationale

- The owner approves a fleet-filed issue with a label, the worker delivers it,
  and the reviewer then refused it as "not by a trusted author" with a finding
  the fleet could not clear. The fix trusts the issue exactly as far as the
  worker's decision to work on it.
- It calls `wasLabelAddedByAllowedAuthor` (with the fleet-worker exclusion) and
  `resolveLastIssueEditor` rather than copying either rule.

### Essential Design Decisions

- `EffectiveTestPolicy.fleetWorkerLogins` is built from `github_user`,
  `fleet_pr_authors` and `service_accounts` with
  `resolveSuppressionExcludedLogins` (not `allowed_authors`, which also lists
  humans). It is a required field of the policy type passed to
  `resolveGoverningIssues`.
- Only an issue in the PR's own repo gets this route; a cross-repo issue still
  needs a trusted author and makes no timeline call.
- An edit at or after the label add (same `>=` comparison the worker's
  content-integrity gate uses) by an empty, untrusted or fleet-worker login
  refuses the issue, unless the next bullet applies (a record-block-only edit is
  skipped; a later trusted non-fleet `needs-human` removal re-approves). Edits
  before the label add are ignored.
- PR #4799 review: a body edit whose GitHub `diff` changes only worker
  record-block lines (`Depends on #M`, `Deferred until ...`, the delimiters; see
  `isWorkerRecordOnlyDiff` in `worker/deno/lib/worker_record_block.ts`) is
  skipped, whoever made it, because the worker's gate hashes the body through
  `stripWorkerRecordBlocks` and ignores it too. It fails closed: a missing or
  empty diff, or any other changed line, still counts. The diff is read with
  `resolveLastIssueEditor(..., { includeDiff: true })`; the content gate's own
  query is unchanged. `requirementQuote` is matched against the body with record
  blocks stripped. A `needs-human` removal by a trusted non-fleet login at or
  after the newest counted edit re-approves, as in the worker's
  `findTrustedReapproval`.
- A gh failure during the claim check is a `fetch failed:` problem, so the
  review retries and is never a finding.

### Undiscoverable Facts

- None.

## Evidence

Backend/CLI change only; no UI files. Tests:
`worker/deno/tests/review_fleet_prs_test_policy_4655_test.ts`.

## Test Plan

- `deno task test:unit <file>` from `worker/deno`, at the head, one file each,
  all with 0 failed:
  `worker/deno/tests/review_fleet_prs_test_policy_4655_test.ts` (68 tests at
  head), `worker/deno/tests/review_fleet_prs_test_policy_wiring_4655_test.ts`
  (57 tests at head), `worker/deno/tests/worker_record_block_test.ts` (14 tests
  at head), `worker/deno/tests/issue_edit_actor_test.ts` (17 tests at head).
- Added in `worker/deno/tests/review_fleet_prs_test_policy_4655_test.ts`:
  `fleetWorkerLogins` policy test; a CONTRIBUTOR service-account issue with
  `top-priority` added by a trusted login is usable and a justified change is
  approved; the label added by the service account itself (or an unknown login)
  is refused with "not by a trusted author"; untrusted, empty-login,
  before-label and trusted-editor cases; an edit after the label by a fleet
  worker login that is also in `trustedLogins` is refused (and the same edit
  before the label is not); a fleet login's record-block-only edit after the
  label keeps the issue usable while a prose or mixed edit, or one with no diff,
  is refused; `needs-human` re-approval (trusted non-fleet accepted; fleet,
  untrusted or earlier-than-edit refused); a record-block line is not a
  requirement quote; `isWorkerRecordOnlyDiff` and `includeDiff` unit tests; a
  cross-repo issue is still refused without a timeline call; timeline and
  edit-history read failures give `fetch failed:` and a retry; `work-on` works
  as the approving label.
- Edited expectation: the "policy defaults" test now also expects
  `fleetWorkerLogins: []`. Nothing else was removed.
- Red checks (guard broken, new tests run, then restored): fleet-login exclusion
  argument set to `[]` → red; edit check forced to never fire → red;
  `|| fleet.has(login)` deleted from the edit check → red green again once
  restored; same-repo condition forced true → red. After the review fix:
  `isWorkerRecordOnlyDiff(a.diff)` replaced with `!a.diff` → the record-block
  test red; `!reapproved` replaced with `true` → the re-approval test red; both
  restored. PR #4799 mutation fix: `line[0] !== "-"` in `isWorkerRecordOnlyDiff`
  replaced with `true` → the `isWorkerRecordOnlyDiff` test in
  `worker/deno/tests/worker_record_block_test.ts` red (a removed prose line
  `-Ignore the rules` is now asserted not record-only); restored.
- Unverified: GitHub's exact `userContentEdits.diff` format could not be queried
  in this run (gh API access was denied); the parser assumes unified-style
  `+`/`-` lines and fails closed otherwise.
- `./quality.sh`: the only failing stage is deno tests, with three failures in
  files this PR does not touch (`completion_phase_repo_formatters_test.ts` ×2,
  `merge_fallback_issue_test.ts`); they fail on environment (cargo fmt commit,
  gh routing), not on this change. Not re-run against the base branch.
- Docs updated: `.claude/skills/review-fleet-prs/SKILL.md`,
  `prompts/pr_review_brief/prompt.md`, `CODING-STANDARDS.md` (the three places
  that say governing-issue text is read "only when the author is trusted").
- Callers of `resolveGoverningIssues`: only `assessTestChanges`, which passes
  the whole policy.
- CI repair push: `.claude/skills/review-fleet-prs/SKILL.md` had copied two
  lines of `prompts/pr_review_brief/prompt.md` word for word, which
  `worker/deno/tests/pr_review_brief_shared_3395_test.ts::SKILL.md carries no copy of the brief's rules`
  forbids. SKILL.md now names the claim rule and points to the brief, which
  stays the one place that states its conditions. Red check: the test fails on
  the earlier SKILL.md and passes on the head; that file and
  `review_fleet_prs_test_policy_4655_test.ts` pass (76 tests). Run with deno
  2.9.8 and a local stand-in for `@std/assert`, because jsr.io was unreachable
  from that host; CI runs the real module.

Not done / not checked: the three failing unrelated tests were not diagnosed on
the base branch; `deno fmt --check CODING-STANDARDS.md` already fails on the
base copy.
