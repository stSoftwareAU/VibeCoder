# PR Summary — Issue #3397

## Summary

`review-fleet-prs` can now auto-release a test-change hold when the repo opts
in. The reviewing host's `.config.json` key `pr_reviewer_auto_release` lists
`owner/repo` names. For a listed repo, a PR held only for a meaningful test
change is approved instead, provided every `testChangeNotes` entry:

- is a changed expected value;
- quotes, verbatim, an acceptance criterion from an issue the PR closes; and
- states that the edited test fails without the code change.

Otherwise the review stays held, and the log records the reason. With the key
absent or empty, behaviour is unchanged. Closes #3397 ("review-fleet-prs:
opt-in auto-release of issue-required test-change holds").

## Spec

### Intent and Rationale

- A PR whose issue requires a changed expected value was always held for the
  owner, even when the issue text already authorised the change. This lets an
  owner who opts in skip that manual step, and only that step.
- The issue asks for the policy the owner confirms. No owner comment exists, so
  this implements the default policy stated on the issue. That policy is the
  narrowest one: only `expected-value` changes are released, and every doubt
  keeps the hold.

### Essential Design Decisions

- The policy check lives in a new `scripts/auto_release.ts`.
  `decideOutcome(review, removed, opts = {})` only gains an `autoRelease`
  flag. With no flag, every existing caller gets the old outcome.
- The check fails closed. A fetch error, no linked issue, a quote under 5
  words, a quote not found, a negative or missing fails-without statement, or
  any finding keeps the hold or the change request.
- The quote is compared as a plain substring after whitespace normalisation.
  No pattern is built from it. Only the issue title and body count; comments
  are never requested, because they are untrusted text.
- Auto-release approves without `needs-human`, and the approval body lists each
  change with its quote. The log record gets `autoReleased: true`, and
  `summary.md` shows an "auto-released" marker. An opted-in repo whose hold is
  kept logs `autoReleaseHeld` with the reasons.

### Undiscoverable Facts

- Linked issues come from `gh pr view N --json closingIssuesReferences`. Each
  entry names its own repository, so a cross-repo closing reference is fetched
  from that repo.
- The key is read by the skill's `auto_release.ts`, not the worker, so it is
  added to `KNOWN_CONFIG_KEYS` to keep the unknown-key check quiet.

## Evidence

Backend-only change: no UI files are touched, so no screenshot.

The `closingIssuesReferences` shape the code relies on was observed with
`gh pr view 3417 -R stSoftwareAU/VibeCoder --json closingIssuesReferences`.
PR #3417 is "Merge milestone '#3265 .claude skills: skills guide:
review-fleet-prs' to main":

```json
{"closingIssuesReferences":[{"id":"I_kwDOT463Jc8AAAABVyM_aA","number":3416,"repository":{"id":"R_kgDOT463JQ","name":"VibeCoder","owner":{"id":"...","login":"stSoftwareAU"}},"url":"https://github.com/stSoftwareAU/VibeCoder/issues/3416"}]}
```

`fetchLinkedIssues` reads `number`, `repository.owner.login` and
`repository.name` from each entry. #3416 is "Milestone: #3265 .claude skills:
skills guide: review-fleet-prs".

- Issue numbers this diff adds as provenance: #3397, "review-fleet-prs: opt-in
  auto-release of issue-required test-change holds".

**Docs sweep** — grep: `pr_reviewer_auto_release`, `autoReleas`, `decideOutcome`, `testChangeNotes`, `held only for`; section: `docs/CONFIGURATION.md#-auto-release-of-issue-required-test-changes`; updated: `.claude/skills/review-fleet-prs/SKILL.md`, `docs/CONFIGURATION.md`, `docs/THREAT-MODEL.md`

Where each hit stands:

- **`SKILL.md`.** L58, L254 (guidance on `kind`), L295, L324 and L346–351
  describe the rule and the new note fields.
- **`docs/CONFIGURATION.md`.** L418–445 is the new section.
- **`docs/THREAT-MODEL.md`.** R14 (L247) now names the opt-in exception to the
  hold.

All other hits outside `docs/archive/` describe the hold for repos that are not
opted in, so they are still true.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — "Behaviour matches whichever policy the owner confirms on this issue."
  No owner comment exists, so the default policy stated on the issue is the
  one implemented — evidence: `auto_release.ts` (`autoReleaseDecision`,
  `quoteFound`, `fetchLinkedIssues`, `resolveAutoRelease`),
  `review_log.ts` (`decideOutcome`, `reviewBody`, `renderSummary`),
  `post.ts::decidePostOutcome` — reviewer: met
- **met** — Opt-in is "a list of `owner/repo` names in the reviewing host's
  `.config.json`" — evidence:
  `worker/deno/tests/review_fleet_prs_auto_release_3397_test.ts::config: isAutoReleaseRepo, autoReleaseRepos and loadAutoReleaseRepos`
  — reviewer: met
- **met** — "With the opt-in off, behaviour is unchanged." For a repo not in
  the list, `decideOutcome` returns exactly what it returns today, and a test
  proves it — evidence: `T::opt-in off: no hold release and gh is never called`,
  `T::decideOutcome: no opts equals empty opts` — reviewer: met — reason
  (reviewer's note): the opt-in-off path through `decidePostOutcome` is
  tested only for the meaningful-change case
- **met** — "Findings still mean request changes, and a removed test file
  still means a test-change hold." — evidence:
  `T::findings on an opted-in repo are still changes_requested`,
  `T::hold kept when test files were removed` — reviewer: met
- **met** — Each `testChangeNotes` entry gains three fields: a change kind, a
  verbatim criterion quote, and a fails-without-the-code statement — evidence:
  `review_log.ts` `TestChangeNote`, SKILL.md rule 5 and reply JSON,
  `T::parseFableReview accepts new and old note shapes` — reviewer: met
- **met** — Only "changed expected value or behaviour" can be auto-released.
  A removed case, an added skip, or a deleted or weakened assertion keeps the
  hold — evidence: `T::hold kept for non-releasable kinds` — reviewer: met
- **met** — Linked issues come from `closingIssuesReferences`, and a quote may
  match the title or body but never the comments — evidence:
  `auto_release.ts::fetchLinkedIssues`,
  `T::hold kept when the quote is absent, too short, and comments are never fetched`
  — reviewer: met
- **met** — Each quote is at least 5 words long and must appear in a linked
  issue, with whitespace runs treated as one space — evidence:
  `T::auto-release: quote matches across different whitespace and case of the repo name`,
  `T::hold kept when the quote is absent, too short, and comments are never fetched`
  — reviewer: met — reason (reviewer's note): no test shows that a quote of
  exactly 5 words is accepted
- **met** — No linked issue, a failed fetch, a short quote or a quote that is
  not found keeps the hold, and a test proves the quote-not-found case —
  evidence: `T::hold kept when no linked issue or gh fails`,
  `T::hold reasons: fetch failures and missing links are named`,
  `T::hold kept when the quote is absent, too short, and comments are never fetched`
  — reviewer: met
- **met** — A missing or negative fails-without statement keeps the hold —
  evidence: `T::failsWithoutChange: only a positive statement releases`,
  `T::hold reasons: kind and fails-without are named` — reviewer: met
- **met** — When every entry qualifies and there are no findings, the PR is
  approved, and a test proves it ("Tests cover an auto-release") — evidence:
  `T::auto-release: qualifying notes on an opted-in repo are approved` —
  reviewer: met
- **met** — "Tests cover … a hold kept because one entry lacks a quoted
  criterion." — evidence:
  `T::hold kept when one of two entries lacks a criterion quote`,
  `T::decidePostOutcome: autoReleaseHeld only for an opted-in held PR` —
  reviewer: met
- **met** — The approving review lists each auto-released change with its
  quote, and the `log.jsonl` record carries `autoReleased: true` for the
  `summary.md` audit trail — evidence: `review_log.ts::reviewBody`,
  `T::renderSummary marks an auto-released approval only`,
  `T::postedResult: autoReleased appears only when true` — reviewer: met
- **met** — `tightened` and `trivial` keep approving as they do today —
  evidence: `T::opted-in repo with no hold: no release and gh is never called`,
  `T::autoReleaseDecision names each whole-review reason` — reviewer: met —
  reason (reviewer's note): `tightened` and `trivial` are not driven through
  `decidePostOutcome` on an opted-in repo
- **met** — "`review-fleet-prs` SKILL.md and docs describe the rule." —
  evidence: `.claude/skills/review-fleet-prs/SKILL.md` (rule 4 exception,
  rule 5 fields, reply JSON, Post section), `docs/CONFIGURATION.md` new
  section, `docs/THREAT-MODEL.md` R14 — reviewer: met
- **unrequested** — Opt-in repo matching ignores case (`isAutoReleaseRepo`) —
  reviewer: unrequested — reason: tolerates an `owner/repo` written in a
  different case; harmless
- **unrequested** — `autoReleaseHeld` reasons in the `post.ts` output and
  `LogRecord` — reviewer: unrequested — reason: shows why a hold on an
  opted-in repo was kept
- **unrequested** — A malformed `pr_reviewer_auto_release` makes `post.ts`
  throw — reviewer: unrequested — reason: follows the `app_token.ts`
  fail-loud convention; a bad value stops all posting, not only auto-release
- **unrequested** — The negative fails-without heuristic (a leading
  "no"/"false" word plus a phrase list) — reviewer: unrequested — reason:
  the issue says only "missing or negative"; how to read "negative" is the
  author's own choice
- **unrequested** — Extra note kinds `removed-file` and `other` — reviewer:
  unrequested — reason: catch-alls so that any unlisted edit fails closed
- **unrequested** — `pr_reviewer_auto_release` added to `KNOWN_CONFIG_KEYS` —
  reviewer: unrequested — reason: a supporting change, so the worker does not
  flag the new key as unknown
- **unrequested** — The SKILL.md frontmatter `description` edit — reviewer:
  unrequested — reason: keeps the skill summary accurate; falls within
  "SKILL.md describes the rule"

`T` is `worker/deno/tests/review_fleet_prs_auto_release_3397_test.ts`.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

The reviewer reported eleven violations. None is fixed in this diff: this
retry only corrects the PR summary, and the code on the branch is unchanged.
Each is recorded below as the reviewer stated it, with the line numbers
mapped to the files at HEAD.

- **violation** — Every changed call site needs a test that goes red without
  it — evidence: `.claude/skills/review-fleet-prs/scripts/post.ts:273-289`,
  `post.ts:344-345`, `post.ts:370-376` — reason: open, not fixed in this
  diff; no test drives `main()`, so reverting the `loadAutoReleaseRepos()`
  call, the `{ autoReleased }` passed to `reviewBody`, the log-record fields
  or the new `postedResult` arguments leaves the suite green
- **violation** — A gate over text must fail closed and have an evasion
  table — evidence: `.claude/skills/review-fleet-prs/scripts/auto_release.ts:41-57`
  — reason: open, not fixed in this diff; `failsWithout` accepts any
  non-empty string that avoids a short denylist, so "would still pass", "it
  would not fail without the change", "not sure" and "N/A" all count as
  positive and release the hold
- **violation** — Prose about the PR's own change must name each condition
  — evidence: `docs/CONFIGURATION.md:437-440`,
  `.claude/skills/review-fleet-prs/SKILL.md:52-60` and `SKILL.md:260` —
  reason: open, not fixed in this diff; the docs omit that no notes at all
  keeps the hold (`auto_release.ts:74`), and "states that the edited test
  still fails" overstates the denylist check above
- **violation** — An absolute word needs code that guarantees it — evidence:
  `docs/THREAT-MODEL.md:247` (R14 "removing, skipping or loosening a test
  still keeps the hold") — reason: open, not fixed in this diff; the hold is
  kept only for notes the reviewer model itself labels with a kind other than
  `expected-value` (`auto_release.ts:77`), so the claim rests on the model's
  classification, not on code
- **violation** — A new behaviour-carrying parameter must not default to off
  — evidence: `.claude/skills/review-fleet-prs/scripts/review_log.ts:236`,
  `review_log.ts:257`, `post.ts:149-155` — reason: open, not fixed in this
  diff; `opts = {}` on `decideOutcome`/`reviewBody` and the optional
  `postedResult` parameters silently default to off. The production callers
  do pass them. Author's note: the default was chosen because the issue
  requires `decideOutcome` to return exactly today's result for every repo
  that is not opted in; the reviewer's verdict stands as recorded
- **violation** — DRY: single source of truth — evidence:
  `auto_release.ts:185` and `post.ts:171-172` — reason: open, not fixed in
  this diff; the sentinel string `"repo not opted in"` is duplicated across
  two modules and compared by value
- **violation** — DRY: reuse an in-repo helper — evidence:
  `auto_release.ts:15` and `review_log.ts:96` — reason: open, not fixed in
  this diff; `DEFAULT_CONFIG` is redefined rather than exported from
  `review_log.ts` (minor; `gate.ts` and `app_token.ts` already do the same)
- **violation** — KISS: avoid over-engineering — evidence: `post.ts:186`,
  `post.ts:201`, `auto_release.ts:66` — reason: open, not fixed in this
  diff; `autoReleaseReasons` is read only by tests, and the
  `"review has findings"` reason cannot be reached through
  `resolveAutoRelease` (minor)
- **violation** — One hostile-input test per regex on untrusted text —
  evidence: `auto_release.ts:25` (`/\s+/g`), `auto_release.ts:41`
  (`/^(?:no|false)\b/`) — reason: open, not fixed in this diff; both
  patterns are linear and safe, so only the test is missing
- **violation** — A negative test must be able to fail — evidence:
  `worker/deno/tests/review_fleet_prs_auto_release_3397_test.ts:139-141` —
  reason: open, not fixed in this diff; the test calls
  `syncNeedsHumanLabel("approved", …)` directly, so its no-`--add-label`
  assertion holds with or without auto-release
- **violation** — Deno/TypeScript conventions: use `Result<T, E>` —
  evidence: `auto_release.ts:130` — reason: open, not fixed in this diff;
  `fetchLinkedIssues` returns an ad-hoc `LinkedIssue[] | { error }` told
  apart with `Array.isArray` (minor; the sibling `BranchUpdateResult` uses a
  similar local shape)
- **clean** — Australian English in added lines; fail loud (a malformed key
  throws, other read errors are rethrown, a fetch failure keeps the hold with
  a logged reason); persisted shape (the new `LogRecord` and `TestChangeNote`
  fields are optional and additive, with old-shape tests); a test for every
  outcome of each added branch; regex safety by construction (`quoteFound`
  uses a plain substring match); compare like with like (both sides
  whitespace-normalised); unit-test classification (self-contained,
  parallel-safe, no sleeps); fake the external service (`fakeGh`); config key
  registration in `KNOWN_CONFIG_KEYS` and `docs/CONFIGURATION.md`; docs sweep
  (the remaining "held for the owner" statements in
  `docs/GITHUB-ACTIONS-AUDIT-SCAN.md` and `DESIGN-PRINCIPLES.md` still hold);
  insertion points; secret redaction (no new public sink); Deno TypeScript
  for new logic; `deno fmt --check`, `deno lint`, `deno task check:manifests`
  and the new test file (22 passed) all clean; prompt and markdown precision

### Author's own checks (not from the independent reviewer)

- The `LogRecord.autoReleaseHeld` doc comment contradicted the code. Fixed in
  this diff.
- The `failsWithout` negative check matched "no" inside words such as
  "notably". Fixed in this diff with a whole-word regex, and a test covers it.
- Callers checked: `decideOutcome` is called by `decidePostOutcome` and
  `resolveAutoRelease`; `reviewBody`, `postedResult` and
  `loadAutoReleaseRepos` are called only from `post.ts`; `parseFableReview`
  still accepts the old note shape.

## Test Plan

- 22 tests in `worker/deno/tests/review_fleet_prs_auto_release_3397_test.ts`
  pass.
- Each branch below was flipped in a scratch worktree. At least one test went
  red for every flip, and all pass with the code restored.
- `./quality.sh < /dev/null`: see the final line of this section.

Paths are relative to the repository root. `AR` is
`.claude/skills/review-fleet-prs/scripts/auto_release.ts`, `PO` is
`.claude/skills/review-fleet-prs/scripts/post.ts`, `RL` is
`.claude/skills/review-fleet-prs/scripts/review_log.ts`, and `T` is
`worker/deno/tests/review_fleet_prs_auto_release_3397_test.ts`.

Branch outcomes:

- AR:33 — quote under 5 words → not found — T `hold kept when the quote is absent, too short, and comments are never fetched` — flip went red
- AR:36 — quote in title or body → found — T `hold kept when the quote is absent, too short, and comments are never fetched` — flip went red
- AR:52 — `failsWithoutChange: true` → positive — T `auto-release: qualifying notes on an opted-in repo are approved` — flip went red
- AR:53 — non-string, non-true → not positive — T `failsWithoutChange: only a positive statement releases` — flip went red
- AR:55 — empty string → not positive — T `failsWithoutChange: only a positive statement releases` — flip went red
- AR:56 — leading "no"/"false" word → not positive — T `failsWithoutChange: only a positive statement releases` — flip went red
- AR:57 — negative phrase → not positive — T `failsWithoutChange: only a positive statement releases` — flip went red
- AR:66 — findings → hold reason — T `autoReleaseDecision names each whole-review reason` — flip went red
- AR:67 — not meaningful → hold reason — T `autoReleaseDecision names each whole-review reason` — flip went red
- AR:70 — removed test files → hold — T `hold kept when test files were removed` — flip went red
- AR:71 — no readable linked issue → hold reason — T `autoReleaseDecision names each whole-review reason` — flip went red
- AR:74 — no notes → hold reason — T `autoReleaseDecision names each whole-review reason` — flip went red
- AR:77 — kind other than `expected-value` → hold — T `hold kept for non-releasable kinds` — flip went red
- AR:81 — missing quote → hold — T `hold kept when one of two entries lacks a criterion quote` — flip went red
- AR:84 — quote not found → hold — T `hold kept when the quote is absent, too short, and comments are never fetched` — flip went red
- AR:87 — no positive fails-without → hold — T `hold reasons: kind and fails-without are named` — flip went red
- AR:97 — key absent → `[]` — T `config: isAutoReleaseRepo, autoReleaseRepos and loadAutoReleaseRepos` — flip went red
- AR:99 — not an array → throws — T `config: isAutoReleaseRepo, autoReleaseRepos and loadAutoReleaseRepos` — flip went red
- AR:100 — bad `owner/repo` entry → throws — T `config: isAutoReleaseRepo, autoReleaseRepos and loadAutoReleaseRepos` — flip went red
- AR:116 — config missing → `[]` — T `config: isAutoReleaseRepo, autoReleaseRepos and loadAutoReleaseRepos` — flip went red
- AR:117 — other read error → rethrown — T `loadAutoReleaseRepos rethrows a read error other than NotFound` — flip went red
- AR:148 — no closing reference → error — T `hold reasons: fetch failures and missing links are named` — flip went red
- AR:169 — gh failure → error — T `hold reasons: fetch failures and missing links are named` — flip went red
- AR:184 — repo not opted in → no release, gh not called — T `opt-in off: no hold release and gh is never called` — flip went red
- AR:187 — no hold → no release, gh not called — T `opted-in repo with no hold: no release and gh is never called` — flip went red
- AR:192 — fetch error → hold — T `hold kept when no linked issue or gh fails` — flip went red
- PO:166 — `autoReleased` only when true — T `postedResult: autoReleased appears only when true` — flip went red
- PO:167 — `autoReleaseHeld` only when given — T `postedResult: autoReleaseHeld appears only when given` — flip went red
- PO:200 — `autoReleased` only on approval — T `opted-in repo with no hold: no release and gh is never called` — flip went red
- PO:202 — `autoReleaseHeld` only for an opted-in held PR — T `decidePostOutcome: autoReleaseHeld only for an opted-in held PR` — flip went red
- RL:243 — `autoRelease` → approved — T `auto-release: qualifying notes on an opted-in repo are approved` — flip went red
- RL:243 — no `autoRelease` → held — T `decideOutcome: no opts equals empty opts` — flip went red
- RL:288 — auto-released approval body lists quotes — T `auto-release: qualifying notes on an opted-in repo are approved` — flip went red
- RL:447 — summary marker only for auto-released — T `renderSummary marks an auto-released approval only` — flip went red

- `./quality.sh < /dev/null` on the final head: `Result: PASSED (with skipped checks)`, `exit=0`. The only skipped check is config integration, because this host has no `.config.json`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
