## Summary

Nothing checked a closure entry the agent marked `met` against the criterion it names. With this change, the pre-PR verifier owes a verdict on each such entry, and the code adds a blocking finding for any entry it rates `partial` or `missing` or leaves without a verdict. This uses the same mechanism #3594's review checklists use (`checklistState` / `checklistGapFindings`). Closes #3766.

- `worker/deno/lib/closure_met_check.ts` (new):
  - `metClosureItems` reads the summary's closure block through the existing `parseClosureEntries` and `subjectOf`, keeping only the entries marked `met`.
  - `renderClosureEntriesSection` lists those entries in the brief.
  - `parseClosureEntryVerdicts` validates the reply's `closure` array.
  - `closureGapFindings` turns a `partial` or `missing` verdict, or a missing verdict, into a blocking finding on the PR summary.
- `worker/deno/lib/pre_pr_verifier.ts`:
  - The brief gains a sixth field, `{{CLOSURE_ENTRIES}}`.
  - `ReviewReply` gains a required `closure` array, which `parseReviewReply` fills (`[]` when the reply omits it).
  - `verifyInCheckout` appends the closure gap findings after the checklist gaps.
- `prompts/pr_review_brief/prompt.md`: a new step 8 asks for one verdict per listed entry. `met` is allowed only when the change delivers every case, path and test the criterion names. The reply JSON carries `closure`.
- `.claude/skills/review-fleet-prs/SKILL.md`: the fleet reviewer fills the new field from the PR body, so it gets the same per-entry instruction. `post.ts` does not check the array itself.
- Docs and the issue prompt say the verifier now re-judges each `met` entry.

## Spec

### Intent and Rationale

- The issue rules out a keyword or lint gate, because whether a diff delivers a criterion is a judgement. The judgement stays with a model, but an independent one, made entry by entry and enforced by code.
- The verifier already runs with the fleet brief in a disposable checkout. Adding a field to that brief reaches both the verifier and the fleet reviewer without a second prompt.

### Essential Design Decisions

- "No verdict" is never a pass. A reply without `closure`, or with a criterion that does not match a listed one, leaves the entry unreported, and that blocks the PR.
- The criterion text is bounded and neutralised by `gapText`. Both sides of the match are keyed the same way (`normaliseVerdictText(gapText(…))`), so differences in case, spacing or backticks still match.
- Closure gaps are ordinary findings, so `prePrVerifierBlocked`, the block reason and the in-run recovery turn need no change.
- Trailing separators are stripped with a backwards scan rather than a trailing-run regex, so hostile input stays linear.

### Undiscoverable Facts

- The issue body has no `## Acceptance Criteria` heading, so no closure block or two-axis review block is required, and none is emitted.
- The issue scopes pr_feedback rounds out, and they still do not run the verifier. The fleet's `post.ts` does not enforce the `closure` array in code; the issue scopes code enforcement to the pre-PR verifier.

## Evidence

Backend-only change, with no UI file touched. It is verified by unit and integration tests against real git, using a scripted model.

```mermaid
flowchart LR
    S[PR summary] -->|parseClosureEntries, met only| M[metClosureItems]
    M -->|renderClosureEntriesSection| B["brief CLOSURE_ENTRIES"]
    B --> V[verifier model]
    V -->|"closure: verdict per entry"| P[parseReviewReply]
    P --> G[closureGapFindings]
    M --> G
    G -->|partial / missing / no verdict| F[blocking finding on the summary]
    F --> R[existing recovery turn]
```

- **Corpus run** over `docs/archive/pr-summaries/` (1017 summaries): 518 carry `met` entries, and their 2728 `met` entries produced 2725 items. The three not produced were exact duplicates, merged by design, so the false-negative count is 0. No item kept a status word, a trailing separator or an `evidence:` tail (0 false positives in criterion extraction).
- **Docs sweep** — grep: `REVIEW_BRIEF_FIELDS`, "five fields", "five {{FIELDS}}", `{{REVIEW_CHECKLISTS}}`, "pre-PR verifier", "Do not inflate", `subjectOf`, `gapText`, `verdictKey`; section: `docs/workflows/issue-processing.md#pre-pr-verifier-issue-3395`; siblings: `REVIEW_CHECKLISTS`, `checklist`; updated: `docs/workflows/issue-processing.md`, `docs/MODEL-AND-CACHING.md`, `prompts/issue/prompt.md`, `prompts/pr_review_brief/prompt.md`, `.claude/skills/review-fleet-prs/SKILL.md`; `docs/review-checklists.md:144` — still true because `{{REVIEW_CHECKLISTS}}` is still the brief's fifth field (of six)
- Related existing rules checked: "Do not inflate a status" and "Demonstrate a criterion; do not assert it" (`prompts/issue/prompt.md`). The new sentences agree with both: `partial` when in doubt, and one untested case makes it `partial`. `CODING-STANDARDS.md` has no conflicting rule. I applied the new brief step to this PR's own diff and found nothing to fix: the summary marks no entry `met`.
- Issue numbers cited as provenance: #3766: Nothing independent checks a closure entry marked `met`: fleet PRs claim criteria the diff only partly delivers (VibeCoder#3676 and two private fleet PRs).
- Lib sweep: the new module is claimed by `docs/audits/lib-sweep-coverage/top-up-3766.json`, and its growth test is listed in `WALL_CLOCK_TEST_FILES`.

## Test Plan

- New tests in `worker/deno/tests/closure_met_check_3766_test.ts` (19 tests) cover:
  - extraction, de-duplication, neutralising and clipping
  - each trailing separator kind
  - linear growth on hostile separator runs (`assertLinearGrowth`)
  - rendering and reply validation
  - each finding branch: partial, missing, worst-wins, no verdict, more than five, singular, no note, unlisted verdicts ignored, and normalised matching
- New tests in `worker/deno/tests/pre_pr_verifier_3395_test.ts`, run against real git:
  - `a met closure entry the verifier rates partial blocks, with a finding on the summary`
  - `a clean reply with no closure array blocks: no verdict on a met entry is never a pass`
  - `a clean reply with a met closure verdict is not blocked`
  - `parseReviewReply parses a closure array, defaults to [] and rejects a bad verdict`
  - `runPrePrVerifier: a clean reply is checked and not blocked` gains an assertion that a summary without a closure block gets no closure section.
- New test in `worker/deno/tests/pr_review_brief_shared_3395_test.ts`: `renderReviewBrief fills {{CLOSURE_ENTRIES}} and the reply shape carries closure`.
- Removed or changed assertions, each required by this issue:
  - `assertEquals(REVIEW_BRIEF_FIELDS.length, 5);` becomes 6, because the issue adds a per-entry field to the shared brief. Red check: removing `"CLOSURE_ENTRIES"` from `REVIEW_BRIEF_FIELDS` turns `the brief carries six fields including {{REVIEW_CHECKLISTS}}, which the renderer fills` red (5 ≠ 6).
  - `assertEquals(parseFableReview(JSON.stringify(audit)), audit);`, `assertEquals(parseFableReview(JSON.stringify(reply)), reply);` and `assertEquals(parseFableReview(\`Review:\n${JSON.stringify(reply)}\n\`), reply);` now expect `closure: []`, because the shared parser now reads the `closure` array the issue asks for. Red check: deleting `closure: parseClosureEntryVerdicts(r.closure),` from `parseReviewReply` turns `the fleet reviewer's parser and audit send-back survive the shared parser` red.
  - `makeDeps(() => Promise.resolve(okRun({ output: REPLY_CLEAN })), []),` was replaced by a stub that also captures the prompt. Every assertion the test made is kept.
- Call site check: replacing `closureEntries: renderClosureEntriesSection(metItems)` with `""` in `verifyInCheckout` turns `a met closure entry the verifier rates partial blocks, with a finding on the summary` red. Removing the `closureGapFindings` append turns both that test and `a clean reply with no closure array blocks…` red.
- Callers checked for the now-required `ReviewReply.closure` and `buildPrePrVerifierPrompt`'s required `closureEntries`: the synthetic review in `pre_pr_verifier.ts`, `createMockDeps` in `lib/issue_worker_wiring.ts`, and `tests/completion_phase_pre_pr_verifier_3395_test.ts`. All three now pass `closure: []`. `deno check` over `lib/`, `tests/` and the fleet scripts passes.
- A dead operand (`matching.length === 0`) found by flip checks was removed.
- Targeted run on the final head: `deno task test:unit tests/closure_met_check_3766_test.ts tests/pre_pr_verifier_3395_test.ts tests/pr_review_brief_shared_3395_test.ts tests/completion_phase_pre_pr_verifier_3395_test.ts tests/review_fleet_prs_checklists_3594_test.ts tests/review_fleet_prs_log_2678_test.ts` passed: parallel pass 110 passed, 0 failed; serial pass 18 passed, 0 failed.
- `./quality.sh` on commit `553c6f34`: Result PASSED (config integration skipped). Later commits change only tests, a dead operand and the `closure` field's optionality, and the targeted run above covers them.

<!-- vibe-branch-outcomes -->
