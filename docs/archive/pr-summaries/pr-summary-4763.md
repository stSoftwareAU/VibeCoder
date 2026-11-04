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
- Edits before the label add are ignored. A body edit at or after the label
  is skipped only when consecutive GitHub `userContentEdits.diff` body
  snapshots are equal after `stripWorkerRecordBlocks`. Missing snapshots,
  including a predecessor outside the newest 100, count as edits. Renames count
  as edits. An untrusted or fleet editor then refuses the issue unless a
  trusted non-fleet `needs-human` removal at or after the newest counted edit
  re-approves it. `requirementQuote` also excludes worker record blocks.
- A gh failure during the claim check is a `fetch failed:` problem, so the
  review retries and is never a finding.

### Undiscoverable Facts

- None.

## Evidence

Backend/CLI change only; no UI files. Tests:
`worker/deno/tests/review_fleet_prs_test_policy_4655_test.ts`.

## Test Plan

- `worker/deno/tests/review_fleet_prs_test_policy_4655_test.ts::claim rule: a fleet worker's record-block edit after the label keeps the issue usable; a prose edit does not` covers full body snapshots, a worker record edit, a malicious prose rewrite with a dependency bullet, and missing snapshots. The snapshot fixture failed before the fix and passed afterwards.
- `worker/deno/tests/review_fleet_prs_test_policy_4655_test.ts::claim rule: newest body edits are checked beyond the 100-edit window` models GitHub's newest-first pagination and rejects both a concealed prose rewrite and incomplete post-label history, even when the oldest returned editor is trusted. The old `last:100` query missed the newest edits; the claim query now requests `first:100` and `totalCount`. The regression failed before the fix.
- The obsolete `isWorkerRecordOnlyDiff` test assumed unified diff lines, which
  GitHub does not return. The remaining requirement is to ignore only changes
  inside strict worker record blocks; the claim-rule test above and
  `worker/deno/tests/worker_record_block_test.ts` cover snapshot comparison and
  stripping. The original policy default expectation also includes
  `fleetWorkerLogins: []`.
- Other coverage includes re-approval, quote matching, trusted editors,
  cross-repo issues and failed lookups in
  `worker/deno/tests/review_fleet_prs_test_policy_4655_test.ts`.
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
