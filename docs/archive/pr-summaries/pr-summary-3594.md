# Repo-owned review checklists reach the fleet reviewer and the pre-PR verifier

## Summary

A repo can declare path-scoped review checklists in `review-checklists.json` at
the PR's base ref (and, for a PR that edits it, the PR's own copy). One shared loader feeds them to the fleet PR reviewer
(`gate.ts`) and the pre-PR verifier (#3395). Each checklist whose paths match
the diff gets a per-item verdict: `met`, `missing` or `not applicable`. A
`missing` item makes the fleet outcome `changes_requested`.

- **One loader.** `worker/deno/lib/review_checklists.ts` parses the file,
  matches globs and renders the brief section. Both reviewers call it.
- **Fleet reviewer.** `gate.ts` reads the file from the base ref
  (`repos/{repo}/contents/review-checklists.json?ref={baseRef}`), and from the
  head SHA too when the PR edits it, and lists the
  changed files. `review_log.ts` turns a `missing` item into `changes_requested`
  and renders a "Repository review checklists" section.
- **Pre-PR verifier.** `pre_pr_verifier.ts` adds `REVIEW_CHECKLISTS` to the
  brief (step 7 of `prompts/pr_review_brief/prompt.md`) and reads a `checklist`
  array from the reply; an absent or null array parses as `[]`.
  `prePrVerifierBlocked` blocks on any finding or any `missing` verdict, so a
  `missing` item blocks even when the reply has no finding.
  `prePrVerifierBlockReason` and `buildPrePrVerifierGateComment` name the
  missing items. `verifyInCheckout` also adds the code-owed findings below.
- **Unsafe globs rejected.** `parseReviewChecklists` drops a leading `./` from
  each `paths` glob and then rejects it if it starts with `/` or has an empty
  (`//`, trailing `/`) or `..` segment. The error names the checklist and index,
  so the file loads as malformed and renders the BLOCKING section. Before this,
  such a glob loaded and the checklist was silently never applied.
  `matchesPathGlob` now drops a leading `./` from the glob as well as the path.
- **A PR's own copy of the file (PR #3695 review, second round).** Reading only
  the base copy let a PR that adds a malformed `review-checklists.json` merge
  (the base had no file), after which every PR in the repo was blocked,
  including the repair, which was itself judged on the broken base copy.
  `effectiveChecklistLoad(base, head)` in `review_checklists.ts` is the one
  rule both consumers call, and `mustReadHeadChecklists` says when the head copy
  is read (the file is among the changed paths, or the list is unknown):
  a malformed or unreadable head copy is the result (a code-added blocking
  finding naming the parse error); a malformed or unreadable base copy with a
  usable head copy (or a head that removes the file) is judged on the head copy,
  so the repair is not blocked by the problem it fixes; a usable base copy
  always governs, so a PR still cannot weaken its checklist; a failed fetch of
  either copy is `fetch_failed` (retried / not checked). `gate.ts` fetches the
  head copy at `headRefOid` (`loadChecklistsAtRef`) and `verifyInCheckout` runs
  `git show <headSha>:review-checklists.json` (`readChecklistsAt`). The finding's
  fix text no longer says to fix the base branch. `docs/review-checklists.md`
  (Where it lives, Failure behaviour, the table) and the `SKILL.md` Post section
  (outcome bullet and exit-code 2) were corrected.
- **Visible failures, decided by the code (PR #3695 review).** A malformed or
  undecodable file, or a changed-file list passed as `null`, still renders a
  BLOCKING instruction into the brief, and now also sets
  `ChecklistState.problem`. `checklistState` also lists the `(checklist, item)`
  pairs the section rendered. `checklistGapFindings` turns a problem, and every
  expected item the reply gave no verdict, into blocking findings on
  `review-checklists.json` line 1. The fleet path carries the state in
  `ReadyPr.checklistState` to `post.ts` (`reviewForPost` → `withChecklistGaps`),
  so the outcome is `changes_requested` and the body names the problem even for
  a reply with no findings and no `checklist`. The pre-PR verifier adds the same
  findings in `verifyInCheckout`, so `prePrVerifierBlocked` and the gate comment
  see them. `gate.ts` (`changedPaths`) passes `null` when the list has 3000 or
  more entries (`CHECKLIST_FILE_LIST_LIMIT`). The pre-PR verifier does not use
  that limit: it passes `null` only when the list is unknown. An absent file or
  no matching path renders nothing and owes nothing.
- **A failed fetch is retried, not reviewed.** A gh error other than not-found
  (timeout, HTTP 5xx, rate limit) is now `fetch_failed`. The fleet gate skips
  that PR for the pass (`skipped["checklist-unreadable"]`, a line in `upkeep`),
  so the next pass retries it and a transient error never becomes a send-back in
  a repo with no checklist file. The pre-PR verifier returns `not_checked` for a
  failed `git show`, as it does for any run it cannot complete. A read-but-
  undecodable reply stays a loud, blocking problem.
- **Docs.** `docs/review-checklists.md` documents the location, format and
  path-glob mapping. Pointers sit in `docs/workflows/issue-processing.md` and
  `docs/MODEL-AND-CACHING.md`.

```mermaid
flowchart LR
    F["review-checklists.json<br/>(base ref)"] --․> L["review_checklists.ts<br/>loader + matchesPathGlob"]
    D["changed files"] --․> L
    L --․>|"no match"| N["no section"]
    L --․>|"malformed / undecodable / list ≥ 3000"| B["BLOCKING instruction +<br/>code-added finding"]
    L --․>|"fetch failed"| R["fleet: skip, retry next pass<br/>pre-PR: not checked"]
    L --․>|"matched"| V["per-item verdicts<br/>(missing verdict ⇒ finding)"]
    V --․> G["gate.ts → post.ts → review_log.ts<br/>missing / no verdict ⇒ changes_requested"]
    V --․> P["pre_pr_verifier.ts<br/>missing / no verdict ⇒ blocked"]
```

Closes #3594

## Spec

### Intent and Rationale

Repo-specific review rules, such as money or release policy on a path, were only
enforced when a human remembered them. Declaring them next to the code, at the
base ref, lets both automated reviewers check them on every PR. Reading from the
base ref stops a PR from weakening its own checklist.

### Essential Design Decisions

- One loader for both reviewers, so the file format, glob semantics and failure
  rendering cannot drift apart.
- The glob matcher is hand-written DP over tokens with no dynamic `RegExp`. It
  refuses to match when the glob or the path has a `..` segment, an empty
  segment or a leading `/`, after dropping a leading `./` from both. The parser
  rejects such a glob up front, so it fails loudly instead of matching nothing.
- A malformed, undecodable or truncated input never reads as "no checklist": it
  renders a BLOCKING instruction for the model, and the code adds the blocking
  finding itself, so an obedient or ignoring model gives the same outcome. The
  same goes for an expected item with no verdict: absence of a verdict is not a
  pass. A verdict is matched to its item by checklist name and item text,
  ignoring case, spacing, backticks and a leading `1.`; the section tells the
  reviewer to copy both verbatim.
- A change that edits the checklist file is also judged on its own copy where
  that is the only way to review it: a broken file cannot merge, and a repair of
  a broken base file is not blocked by the problem it fixes (see
  `effectiveChecklistLoad`). A usable base copy still governs.
- A fetch failure is not a finding about the file: it is retried (fleet) or
  not-checked (pre-PR), never a send-back.
- An absent file is quiet by design, as documented in
  `docs/review-checklists.md`.

### Undiscoverable Facts

- `gh api repos/{repo}/contents/…?ref=` returns HTTP 404 for a missing file, and
  the 404 branch in `gate.ts` matches `HTTP 404|Not Found` on the error message.
  Any other gh failure is `fetch_failed` (retried next pass), not absent.
- Refs containing `/` are passed through literally, so a branch such as
  `milestone/x` is read at the right ref.

## Evidence

- Targeted, on this head: `deno test --allow-all < /dev/null` from `worker/deno`
  over `tests/review_fleet_prs_*.ts`, `tests/pre_pr_verifier_3395_test.ts`,
  `tests/review_checklists_3594_test.ts`,
  `tests/pr_review_brief_shared_3395_test.ts`,
  `tests/completion_phase_pre_pr_verifier_3395_test.ts` and
  `tests/lib_sweep_coverage_test.ts` — 354 passed, 0 failed. `deno lint` and
  `deno fmt --check` are clean on `worker/deno/lib`, the touched tests and
  `.claude/skills/review-fleet-prs/scripts`.
- PR #3695 review, new observation: a gh failure other than not-found used to
  reach the reviewer as a BLOCKING instruction; the test
  `gate: a non-404 gh failure is retried next pass: the PR is skipped, not handed to the reviewer`
  feeds HTTP 502, HTTP 403 rate-limit and timeout messages and asserts the PR is
  not in `ready` and `skipped["checklist-unreadable"]` is 1.

Docs sweep: grep `review-checklists`, `REVIEW_CHECKLISTS`,
`Repository review checklists`, `reviewChecklists`; section:
`docs/review-checklists.md` (new); siblings: `testChangeNotes`,
`unrelatedIssues`, `PREVIOUS_FINDINGS` (the existing reply fields and brief
placeholders the new `checklist` field and `｛｛REVIEW_CHECKLISTS｝｝` joined);
updated: `README.md:519`, `docs/workflows/issue-processing.md:1191-1199`,
`docs/MODEL-AND-CACHING.md:777`, `.claude/skills/review-fleet-prs/SKILL.md` (the
`{{REVIEW_CHECKLISTS}}` bullet and the step-3 skipped reasons),
`docs/review-checklists.md` (Failure behaviour, Who consumes it),
`prompts/pr_review_brief/prompt.md:48`. Second review round (PR's own copy of the file): grep `base ref`, `base
branch`, `base copy`, `readBaseChecklists`, `loadBaseChecklists`, `Exit code 2`,
`request changes`; section: `docs/review-checklists.md` "Where it lives" and
"Failure behaviour"; siblings: `Malformed JSON or invalid schema`,
`Changed-file list unavailable or truncated` (existing rows of the situation
table, which gained two sibling rows); updated: `docs/review-checklists.md`
(Where it lives, flowchart, Failure behaviour, table),
`docs/workflows/issue-processing.md` (the reply-fields bullet),
`.claude/skills/review-fleet-prs/SKILL.md` (the `{{REVIEW_CHECKLISTS}}` bullet,
the Post outcome bullet, the exit-code-2 sentence), `README.md` (docs-table
row), and the doc comments in `review_checklists.ts` and `gate.ts`. Remaining
hits: `prompts/pr_review_brief/prompt.md:71` — still true: it is about reading a
file at the base ref to tell a pre-existing problem from a new one, not about the
checklist file. Remaining hits:

- `docs/workflows/issue-processing.md:1191` — still true: lists the reply fields
  and names the `checklist` array beside `testChangeNotes` and
  `unrelatedIssues`.
- `prompts/pr_review_brief/prompt.md:53-55` — still true: it tells the model to
  report a malformed, unreadable or not-checked file as a blocking finding; the
  code now adds one too, which the brief does not need to say.
- `docs/MODEL-AND-CACHING.md:777` — still true: a pointer only.

## Acceptance Criteria

<․!-- vibe-spec-review inputs="diff+issue-body" --․>

- **met** — The location and format are documented, with path globs mapped to
  checklist items. — evidence: `docs/review-checklists.md`,
  `worker/deno/lib/review_checklists.ts` `parseReviewChecklists` — reviewer: met
- **met** — A test fixture repo, with a checklist on one path and a diff that
  touches it, produces a review listing each item with a verdict. — evidence:
  `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts` (applicable path,
  `reviewBody`) — reviewer: met — reason: the reviewer model is mocked in the
  fixture; a live reviewer run is not covered.
- **met** — A diff that doesn't touch the path produces no checklist section. —
  evidence: `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts`
  (non-matching or absent file gives an empty section) — reviewer: met
- **met** — A missing or malformed checklist file fails visibly in the review
  output and is never silently ignored. — evidence:
  `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts`
  (`a malformed base file plus a reply with no findings and no checklist is not approved and names the problem`,
  `post.ts end to end: a malformed base file and a clean reply posts request-changes naming the problem`),
  `worker/deno/tests/pre_pr_verifier_3395_test.ts`
  (`a malformed base checklist blocks even when the model replies with no findings and no checklist`)
  — reviewer: met — reason: the code adds the blocking finding itself, so the
  outcome does not depend on the model obeying the brief. An absent file is
  quiet by design.

## Standards Review

<․!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" --․>

- **clean** — Checked: fail loud (malformed, undecodable and truncated inputs
  render BLOCKING and add a code-owed finding; an item with no verdict is a
  finding; a fetch failure is retried or not-checked, never read as clean), path
  confinement (`..`, `//` and leading `/` rejected on glob and path, with
  negative tests), branch outcomes (each flipped, see below), docs sweep, no
  test-only members, and regex safety (no dynamic `RegExp`). Two pre-existing
  `fmt` and `require-await` issues in `review-fleet-prs` were left alone as out
  of scope.

## Test Plan

Added:

- `worker/deno/tests/review_checklists_3594_test.ts` (39 tests): parse shape and
  rejections, `matchesPathGlob` cases including evasion and hostile input,
  loader, `renderChecklistSection`, `parseChecklistVerdicts`, the unsafe-glob
  tests from the verifier review, and seven from PR #3695:
  `checklistState: every load that cannot be applied carries a problem; absent and non-matching carry none`,
  `checklistState: expected holds exactly the items the section renders, one per item of each matched checklist`,
  `renderChecklistSection renders a failed fetch as a blocking problem, never as no checklist`,
  `checklistGapFindings: none when every expected item has a verdict or nothing applies`,
  `checklistGapFindings: a problem and unreported items are each a blocking finding on the checklist file`,
  `checklistGapFindings: a verdict for another checklist's identically worded item does not cover this one, and a long gap list is capped`
  and `checklistGapFindings: hostile text cannot carry markup or a mention`.
- In `worker/deno/tests/pre_pr_verifier_3395_test.ts` (55 tests in the file):
  `a missing checklist verdict blocks even with no findings, and is named in the reason and comment`,
  `met and not-applicable checklist verdicts alone do not block`,
  `runPrePrVerifier: a failed run that also changed the issue checkout reports a review with an empty checklist`,
  `createMockDeps' unscripted pre-PR verifier is clean with an empty checklist`,
  and five from PR #3695:
  `a malformed base checklist blocks even when the model replies with no findings and no checklist`,
  `an unknown changed-file list blocks a repo that declares checklists, even on a clean reply`,
  `a reply that omits the checklist, or covers only some items, blocks and names the unreported item`,
  `a full set of verdicts is not blocked, including a numbered or re-cased item text`
  and
  `no checklist file, or no matching path, owes no verdict and does not block`.
- `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts` (22 tests): gate
  applicable path, base-ref read with slash refs, non-matching or absent file,
  malformed file, changed-file list at the limit, `decideOutcome`, `reviewBody`,
  post path, and from PR #3695: the non-404 skip (replacing the old
  non-404-is-unreadable test), the undecodable reply, `checklistState` carried
  by the gate, malformed state plus a clean reply, omitted and partial verdicts,
  a full set approved, `reviewForPost` refusing a bad entry, hostile text, and
  `post.ts end to end: a malformed base file and a clean reply posts request-changes naming the problem`
  (runs `post.ts` as a subprocess with a fake `gh` on `PATH`).
- `worker/deno/tests/review_fleet_prs_gate_audit_3116_test.ts`: one added
  assertion pair in the audit send-back test (entry carries an empty
  `checklistState` and passes `reviewForPost` with its one finding).

Added in PR #3695's second review round (the PR's own copy of the file):

- In `worker/deno/tests/review_checklists_3594_test.ts` (6 tests):
  `mustReadHeadChecklists: the file among the changed paths, or an unknown list`,
  `effectiveChecklistLoad: a change that adds or leaves a broken file is judged on that broken copy`,
  `effectiveChecklistLoad: a repair of a broken base copy is judged on its own copy, not the base problem`,
  `effectiveChecklistLoad: a usable base copy governs, so a change cannot weaken its checklist`,
  `effectiveChecklistLoad: a failed fetch of either copy is passed on for a retry`
  and
  `a repairable base problem tells the author how: the fix text no longer says to fix the base branch`.
- In `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts` (5 tests):
  `gate: a PR that adds a malformed checklist file is judged on it and blocked, naming the parse error`,
  `gate: a PR that repairs a malformed base file is not blocked by the base problem`
  (with a control that does not edit the file, and a still-broken "repair"),
  `gate: a PR cannot weaken a valid base checklist by editing the file`,
  `gate: a failed fetch of the head copy is retried next pass, not reviewed`
  and
  `post: the base-problem fix text no longer sends the author to the base branch`.
- In `worker/deno/tests/pre_pr_verifier_3395_test.ts` (4 tests):
  `a PR that adds a malformed checklist file blocks, naming the parse error`,
  `a PR that repairs a malformed base file is not blocked by the base problem, and is judged on its own copy`
  (with a control that does not edit the file, an omitted-verdict case, and a
  still-broken "repair"),
  `a PR that edits a valid base checklist file is still judged on the base copy`
  and
  `a git failure reading the head copy makes the verifier not checked`.
- No existing expectation was edited except the rename of `readBaseChecklists`
  to `readChecklistsAt` in the one test that calls it.

Replaced:

- `worker/deno/tests/pre_pr_verifier_3395_test.ts`
  `an unreadable base checklist (git show fails otherwise) is a loud section` →
  `an unreadable base checklist (git show fails otherwise) is not checked, never asked of the model or read as clean`,
  and `readBaseChecklists: spawn failure is unreadable; …` →
  `readChecklistsAt: a git failure is fetch_failed; missing file variants are absent`
  (the function was also renamed from `readBaseChecklists`, since it now reads
  either commit).
  The expectation changed because a failed `git show` is no longer handed to the
  model (PR #3695 review). Guard: `a malformed base checklist blocks …` covers
  the loud path for a file that was read; red-check below.
- `worker/deno/tests/review_fleet_prs_checklists_3594_test.ts`
  `gate: a non-404 gh failure or an undecodable reply is a loud unreadable section, not absent`
  → the skip test and the undecodable-reply test above. A non-404 failure is no
  longer a loud section, by the same review finding; the undecodable reply keeps
  its loud, blocking assertions.

Removed:

- Removed from `worker/deno/tests/pr_review_brief_shared_3395_test.ts`:
  `assertThrows( () => renderReviewBrief(extra, { REVIEW_CONTEXT: "c", NO_TEST_ADDED_NOTE: "n", TEST_CHANGES: "t", PREVIOUS_FINDINGS: "p", }), Error, "EXTRA_FIELD", );`
  — #3594 adds `REVIEW_CHECKLISTS` as a required fifth `ReviewBriefFields` key,
  so the four-field call no longer type-checks. The same test
  (`an extra placeholder in the template is caught`) now makes the call with all
  five fields and still asserts the `EXTRA_FIELD` throw.

Extended: `worker/deno/tests/pre_pr_verifier_3395_test.ts`,
`worker/deno/tests/pr_review_brief_shared_3395_test.ts`.

Mutation check (the four surviving mutants, each applied alone, then restored;
RED both with type checking and with `--no-check`; code unchanged since, lines
renumbered on this head):

- `worker/deno/lib/issue_worker_wiring.ts:1211` delete `checklist` — killed by
  `createMockDeps' unscripted pre-PR verifier is clean with an empty checklist`.
- `worker/deno/lib/pre_pr_verifier.ts:537` delete `checklist` — killed by
  `runPrePrVerifier: a failed run that also changed the issue checkout reports a review with an empty checklist`.
- `worker/deno/lib/review_checklists.ts:101` negate the ternary condition —
  killed by
  `parseReviewChecklists reports the JSON parser's own message for bad JSON`,
  which asserts the exact message (`String(error)` would add a `SyntaxError:`
  prefix).
- `worker/deno/lib/review_checklists.ts:219` `let seen = false` to `true` —
  killed by
  ``matchesPathGlob: `**/` matches only after a position the prefix reached``
  (`x**/y` against `a/y`).

Every flip below was applied alone, run from `worker/deno` with `< /dev/null`
over the test files named, then restored. `T` =
`review_checklists_3594_test.ts`, `F` =
`review_fleet_prs_checklists_3594_test.ts`, `P` =
`pre_pr_verifier_3395_test.ts`, all under `worker/deno/tests/`.

Branch outcomes:

- `worker/deno/lib/review_checklists.ts:297-300` `mustReadHeadChecklists`, one
  operand each: `changedFiles === null` (unknown list) — `T:515` — dropped,
  RED (1 failed); `changedFiles.includes(…)` — `T:515`, `F:495`, `P:1319` —
  dropped, RED (7 failed).
- `worker/deno/lib/review_checklists.ts:321` base `fetch_failed` → returned —
  `T:564` — deleted, RED (1 failed). `:323` head `fetch_failed` → returned —
  `T:564`, `F:552` — deleted, RED (3 failed).
- `worker/deno/lib/review_checklists.ts:322` no head copy → base — `T:535`
  (control), `F:512` (control that leaves the file alone) — the head-read
  ternaries below forced off, RED.
- `worker/deno/lib/review_checklists.ts:324` malformed or unreadable head copy →
  the result — `T:522`, `F:495`, `P:1319` — condition forced false, RED (5
  failed).
- `worker/deno/lib/review_checklists.ts:327-328` broken base with a usable head
  copy (or one that removes the file) → the head copy — `T:535`, `F:512`,
  `P:1340` — condition forced false, RED (3 failed); `:330` a usable base copy
  governs — `T:553`, `F:541`, `P:1381`.
- `worker/deno/lib/review_checklists.ts:271` `fileLabel` names the change's copy
  — `T:522`, `F:495`, `P:1319` — forced to the base wording, RED.
  `:411` the brief says the change's own copy was used — `T:535`, `F:512` —
  forced to "read at the base ref", RED.
- `.claude/skills/review-fleet-prs/scripts/gate.ts:917` the head copy is read
  only when `mustReadHeadChecklists` — `F:495` asserts the `?ref=head-7` read,
  `F:512` asserts it is not read for a PR that leaves the file alone — forced
  off, RED. `:920` the combined load feeds the entry — `F:495`, `F:512` —
  replaced by the base load, RED. A head `fetch_failed` skips the PR — `F:552`.
- `worker/deno/lib/pre_pr_verifier.ts:670` the head copy is read only when
  `mustReadHeadChecklists` — `P:1319`, `P:1340` — forced off, RED. `:673` the
  combined load is used — `P:1319`, `P:1340` — replaced by the base load, RED.
  A head read failure → `not_checked` — `P:1395`.

- `worker/deno/lib/pre_pr_verifier.ts:754` a `missing` verdict with no findings
  → blocked — `P:1116` — flipped to `false` in the earlier round, RED; code
  unchanged.
- `worker/deno/lib/review_checklists.ts:122` unsafe `paths` glob → malformed —
  `T:357` — RED (earlier round; code unchanged).
- `worker/deno/lib/review_checklists.ts:190` leading `./` dropped from the glob
  — `T:382` — RED (earlier round; code unchanged).
- `worker/deno/lib/review_checklists.ts:191` path operand `hasUnsafeSegment(p)`
  → no match — `T:124`; glob operand `hasUnsafeSegment(g)` → no match — `T:141`
  — each RED (earlier round; code unchanged).
- `worker/deno/lib/review_checklists.ts:80` empty list → rejected — `T:38`,
  `T:68` — RED (earlier round; code unchanged).
- `worker/deno/lib/review_checklists.ts:387` malformed, unreadable or
  fetch_failed → BLOCKING section — `T:263` — `blockingInstruction` returning
  `""` went RED (earlier round). This push added the `fetch_failed` operand,
  reached by `T:432`; removing it fails type checking, so it cannot be a green
  mutant.
- `worker/deno/lib/review_checklists.ts:401` changed-file list null → "NOT
  checked" section — `T:296` — RED (earlier round).
- `worker/deno/lib/review_checklists.ts:359` a load problem → state carries the
  problem — `T:398`, `F:191` — `if (problem !== null)` deleted, RED.
- `worker/deno/lib/review_checklists.ts:360` `load.kind !== "loaded"` → no
  problem, no items — `T:398` — deleting the line fails type checking (the union
  is then unnarrowed), so it cannot be a green mutant.
- `worker/deno/lib/review_checklists.ts:361` changed-file list null → state
  problem — `T:398`, `F:212` — flipped to `if (false)` (with `--no-check`, since
  the branch then fails type checking), RED.
- `worker/deno/lib/review_checklists.ts:475` `state.problem !== null` → problem
  finding — `T:459`, `F:332`, `P:1237` — flipped to `false`, RED.
- `worker/deno/lib/review_checklists.ts:492` `unreported.length > 0` →
  unreported finding — `T:459`, `F:345`, `P:1262` — flipped to `false`, RED.
- `worker/deno/lib/review_checklists.ts:496`
  `unreported.length > MAX_GAPS_NAMED` → "and N more" — `T:474` — flipped to
  `false`, RED.
- `worker/deno/lib/review_checklists.ts:460` verdict key lower-cases — `T`,
  `F:368`, `P:1283` — `.toLowerCase()` removed, RED; the leading-number strip
  removed, RED (same tests).
- `worker/deno/lib/review_checklists.ts:458` verdict key includes the checklist
  name — `T:474` — name removed from the key, RED.
- `.claude/skills/review-fleet-prs/scripts/review_log.ts:221`
  `gaps.length === 0` → review returned unchanged — `F:332`, `F:345` — flipped
  to `true`, RED (3 failed, with `F:415`).
- `.claude/skills/review-fleet-prs/scripts/review_log.ts:233` a `missing` item →
  `changes_requested` — `F:255`, `F:288` — RED (earlier round; code unchanged).
- `.claude/skills/review-fleet-prs/scripts/post.ts:212` `post.ts` main calls
  `reviewForPost` — `F:415` (end to end, subprocess) — call replaced by plain
  `parseFableReview`, RED.
- `.claude/skills/review-fleet-prs/scripts/post.ts:75-77` a gate entry without a
  valid `checklistState` is refused, one operand each:
  `typeof state !== "object"` (flipped with `--no-check`, since removal fails
  type checking), `state === null`, `!Array.isArray(state.expected)`,
  `state.problem !== null &&
  typeof state.problem !== "string"` (flipped to
  `false`, and to its first half alone) — `F:384` — each RED.
- `.claude/skills/review-fleet-prs/scripts/gate.ts:884` audit send-back entry
  carries an empty `checklistState` — removing it fails type checking; the value
  is asserted in `worker/deno/tests/review_fleet_prs_gate_audit_3116_test.ts`
  (the send-back test in the file).
- `.claude/skills/review-fleet-prs/scripts/gate.ts:921` `fetch_failed` → PR
  skipped, counted in `skipped["checklist-unreadable"]` — `F:157` — the
  `continue` removed so the PR falls through to review, RED.
- `.claude/skills/review-fleet-prs/scripts/gate.ts:978` HTTP 404 → absent, empty
  section — `F:139` — RED (earlier round; code unchanged).
- `.claude/skills/review-fleet-prs/scripts/gate.ts:988` and `:1000` an
  undecodable reply → unreadable with cause, checklist problem — `F:181` —
  reached by the undecodable-reply test.
- `.claude/skills/review-fleet-prs/scripts/gate.ts:1010` list at the limit → null
  (not checked) — `F:212` — RED (earlier round; code unchanged).
- `worker/deno/lib/pre_pr_verifier.ts:674` `fetch_failed` → `not_checked`, model
  never asked — `P:1045` — replaced with a log line, RED.
- `worker/deno/lib/pre_pr_verifier.ts:724-727` gap findings appended to the
  parsed review — `P:1237`, `P:1251`, `P:1262` — `review: gaps.length === 0`
  forced to `true`, RED (3 failed).
- `worker/deno/lib/pre_pr_verifier.ts:602`, `:614` `readChecklistsAt` git
  failure → `fetch_failed`, and `:606-607` the not-in-base stderr → absent —
  `P:1078` — both asserted.

Callers and siblings checked:

- `ReadyPr.checklistState` is required (no default). Producers: the `ready` push
  (`gate.ts:946`) and the `auditBlocked` push (`gate.ts:884`); the only consumer
  is `post.ts` (`reviewForPost`), which refuses an entry without it. `run.sh`
  forwards the whole entry (`jq -c '{pr: del(.review), review}'`).
- `readChecklistsAt` (was `readBaseChecklists`) / `loadChecklistsAtRef` (was
  `loadBaseChecklists`) returned `unreadable` for a failed
  fetch; their callers are `verifyInCheckout` (now `not_checked`) and `pass()`
  (now skips). `renderChecklistSection` and `checklistState` both handle
  `fetch_failed`, so a future caller that forgets still gets a blocking problem.
- `worker/deno/lib/pre_pr_verifier.ts`: `buildPrePrVerifierPrompt` takes a
  required `reviewChecklists` option. The reply's `checklist` is optional:
  `parseChecklistVerdicts` reads an absent or null value as `[]`
  (`worker/deno/lib/review_checklists.ts:513`), and the gap findings then name
  every expected item.
- `worker/deno/lib/issue_worker_wiring.ts` mock reply: `checklist: []`.
- `worker/deno/tests/completion_phase_pre_pr_verifier_3395_test.ts`,
  `worker/deno/tests/review_fleet_prs_log_2678_test.ts`,
  `worker/deno/tests/review_fleet_prs_needs_human_2927_test.ts`: fixtures given
  `checklist: []`.
- Deviation: the `gate.ts:883` `auditBlocked` push sets `reviewChecklists: ""`
  and `checklistState` empty and makes no `gh` call. Audit-blocked PRs get no
  model review, so no checklist section is rendered or owed. This is
  intentional.

Guards kept by the new paths (the code-added findings reach the same outcomes as
a model finding): fleet — `post.ts` still re-checks the head commit and the PR
state before posting, and the `needs-human` label, log record, summary and
notification follow `decideOutcome` as before; pre-PR — the findings flow
through `prePrVerifierBlocked`, so the existing block reason, gate comment and
retry accounting apply unchanged. Nothing is skipped.

Self-review: every test path above was checked with `git ls-files` from the repo
root; each docs-sweep hit was re-read at the cited line on this head; each
branch outcome was flipped alone and restored; the Acceptance Criteria were
re-read against the issue body.

Pre-PR Security Self-Check:

- [x] Input validation: `parseReviewChecklists` rejects a `paths` glob with a
      `..` segment, an empty segment (`//` or a trailing `/`) or a leading `/`,
      after dropping a leading `./`. `matchesPathGlob` refuses to match such a
      glob or changed path.
- [x] Secrets: no key or token files staged.
- [x] Injection surface: no shell interpolation and no dynamic `RegExp`; the
      glob matcher is hand-written DP.
- [x] Output encoding: `plain()` in `review_log.ts` flattens whitespace, bounds
      length, and replaces only a backtick (with `'`), `<` and `>` (with a
      space) and `@` (with `@` plus a zero-width space) in the posted review.
      Other markdown characters such as `*`, `_`, `[`, `]` and `#` pass through.
      `inlineSafe()` only flattens whitespace, swaps backticks and bounds length
      for text placed inside a code span in the brief.
- [x] Authorisation: a usable base copy of the checklist always governs, so a PR
      cannot weaken its own checklist; the PR's own copy is used only when it is
      broken (blocked) or when the base copy is broken (the repair).
- [x] Error handling: non-404 failures are reported with their cause line, not
      as absent.
- [x] Dependencies: none added.
- [x] Path confinement: the guard rejects unsafe segments on both glob and path,
      with negative tests for each side.

## Disclosure of unrequested additions

- `docs/audits/lib-sweep-coverage/top-up-3594.json`, a lib-sweep ledger slice at
  full SHA `7638942f380cabff8505d3a0a129849f45875937`, needed by
  `lib_sweep_coverage_test.ts` for the new module.
- Docs pointers in `docs/workflows/issue-processing.md` and
  `docs/MODEL-AND-CACHING.md`, and the `README.md` docs-table row.
- The unsafe-glob test added during the red-check, listed above.
- `matchesPathGlob` now drops a leading `./` from the glob too. Without it, a
  `./src/**` glob would pass the new parse check but never match.
- The original code and test edits were made by executor sub-agents. The fixes
  after the pre-PR verifier review (missing verdicts block, unsafe globs
  rejected, the mutation-killing tests and the doc corrections) were made by the
  lead.
