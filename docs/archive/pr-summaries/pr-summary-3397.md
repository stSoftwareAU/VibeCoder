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

<!-- vibe-spec-review inputs="diff+issue-body" -->
## Acceptance Criteria

- [x] "Behaviour matches whichever policy the owner confirms on this issue."
  No owner comment exists, so the default policy stated on the issue is
  implemented: opt-in list, `expected-value` only, a verbatim quote of at
  least 5 words in a linked issue's title or body, a positive fails-without
  statement, and no findings. Evidence: `auto_release.ts`
  `autoReleaseDecision` and `resolveAutoRelease`. reviewer: met
- [x] "With the opt-in off, behaviour is unchanged." Evidence: test
  `opt-in off: no hold release and gh is never called` and test
  `decideOutcome: no opts equals empty opts`. Both are in
  `worker/deno/tests/review_fleet_prs_auto_release_3397_test.ts`.
  reviewer: met
- [x] "Tests cover an auto-release, and a hold kept because one entry lacks a
  quoted criterion." Evidence: tests
  `auto-release: qualifying notes on an opted-in repo are approved` and
  `hold kept when one of two entries lacks a criterion quote`. reviewer: met
- [x] "`review-fleet-prs` SKILL.md and docs describe the rule." Evidence:
  `.claude/skills/review-fleet-prs/SKILL.md`, the new
  `docs/CONFIGURATION.md` section and `docs/THREAT-MODEL.md` R14.
  reviewer: met

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->
## Standards Review

- LogRecord.autoReleaseHeld comment contradicted code — reason: fixed in this
  diff
- The `failsWithout` negative check matched "no" inside words such as
  "notably". Fixed in this diff with a whole-word regex, and a test covers it.
- Regex on untrusted text: `NEGATIVE_LEADING_WORD` (`/^(?:no|false)\b/`) and
  `REPO_PATTERN` have no overlapping quantifiers. The quote is matched with
  `includes`, never compiled.
- Callers checked:
  - `decideOutcome` is called by `decidePostOutcome` and `resolveAutoRelease`.
    The new `opts` defaults to `{}`, so the existing behaviour is unchanged.
  - `reviewBody`, `postedResult` and `loadAutoReleaseRepos` are called only from
    `post.ts`.
  - `parseFableReview` still accepts the old note shape (test
    `parseFableReview accepts new and old note shapes`).
- Persisted shape: `log.jsonl` records gain two optional fields, and the note
  fields are optional. Old records parse unchanged, so no key bump is needed.

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
