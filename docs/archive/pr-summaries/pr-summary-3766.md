## Summary

Nothing checked a closure entry the agent marked `met` against the criterion it names. With this change, the pre-PR verifier owes a verdict on each such entry, and the code adds a blocking finding for any entry it rates `partial` or `missing` or leaves without a verdict. This uses the same mechanism #3594's review checklists use (`checklistState` / `checklistGapFindings`). Closes #3766.

- `worker/deno/lib/closure_met_check.ts` (new):
  - `metClosureItems` reads the summary's closure block through the existing `parseClosureEntries` and `subjectOf`, keeping only the entries marked `met`.
  - `renderClosureEntriesSection` lists those entries in the brief: the worker's instruction sentence outside the run's untrusted fence, the criteria inside it (PR #3890 review).
  - `parseClosureEntryVerdicts` reads the reply's `closure` array and drops a malformed entry instead of throwing, so the reply's other findings are kept and the listed item falls into the no-verdict finding (PR #3890 review).
  - `closureGapFindings` turns a `partial` or `missing` verdict, or a missing verdict, into a blocking finding on the PR summary.
- `worker/deno/lib/pre_pr_verifier.ts`:
  - The brief gains a sixth field, `{{CLOSURE_ENTRIES}}`.
  - `buildPrePrVerifierPrompt` takes `closureItems`, renders the section with its own boundary id and names "closure entries" in the boundary-integrity instruction.
  - `ReviewReply` gains a required `closure` array, which `parseReviewReply` fills (`[]` when the reply omits it).
  - `verifyInCheckout` appends the closure gap findings after the checklist gaps.
- `prompts/pr_review_brief/prompt.md`: a new step 8 asks for one verdict per listed entry. `met` is allowed only when the change delivers every case, path and test the criterion names. The reply JSON carries `closure`.
- `.claude/skills/review-fleet-prs/scripts/gate.ts`: reads the PR body in its search and renders `closureEntries` through `renderClosureEntriesSection(metClosureItems(body))`, so the fleet path gets the same redaction, fresh untrusted boundary and per-entry instruction as the worker.
- `.claude/skills/review-fleet-prs/SKILL.md`: copies that gate field verbatim into the brief, never raw criteria. `post.ts` does not check the array itself.
- Docs and the issue prompt say the verifier now re-judges each `met` entry.

## Spec

### Intent and Rationale

- The issue rules out a keyword or lint gate, because whether a diff delivers a criterion is a judgement. The judgement stays with a model, but an independent one, made entry by entry and enforced by code.
- The verifier already runs with the fleet brief in a disposable checkout. Adding a field to that brief reaches both the verifier and the fleet reviewer without a second prompt.

### Essential Design Decisions

- "No verdict" is never a pass. A reply without `closure`, or with a criterion that does not match a listed one, leaves the entry unreported, and that blocks the PR.
- The criterion text is bounded and neutralised by `gapText`. Both sides of the match are keyed the same way (`normaliseVerdictText(gapText(…))` after stripping zero-width characters, so `gapText`'s invisible space after `@` cannot make the keys differ), so differences in case, spacing, backticks or that space still match.
- A malformed verdict entry is dropped, never thrown on: a throw turned the whole reply, real findings included, into `not_checked`. The gap finding's fix offers delivery or an evidence-backed dispute only, matching the gate comment's procedure (PR #3890 review).
- Closure gaps are ordinary findings, so `prePrVerifierBlocked`, the block reason and the in-run recovery turn need no change.
- Trailing separators are stripped with a backwards scan rather than a trailing-run regex, so hostile input stays linear.

### Undiscoverable Facts

- The issue body has no `## Acceptance Criteria` heading, so no closure block or two-axis review block is required, and none is emitted.
- The original issue scoped PR-feedback rounds out. Main now runs the shared verifier on review-fix pushes too. The fleet's `post.ts` does not enforce the `closure` array in code.

## Evidence

Backend-only change, with no UI file touched. It is verified by unit and integration tests against real git, using a scripted model.

PR #3890's numbered-copy review fix strips every leading list prefix before
clipping the criterion. The new regression failed against target head
`d37fb603` with `No verdict was reported`, then passed after the change.
The closure, verifier and shared-brief suites pass 94 tests. No existing
test or assertion was removed. Full CI remains required on this follow-up.

Review 5556494507 exposed criteria whose own text is already numbered. The
new `rendered copies of already-numbered criteria match` regression parses
three real summary entries and copies the actual rendered list lines. With
the old single-prefix pattern it failed with `No verdict was reported for
3 of 3`; repeating the prefix match makes it pass. This is the mutation
proof for the repeated-prefix outcome. It also checks mixed dot/parenthesis
prefixes, an `@` criterion, clipping, direct copies, partial/missing verdicts
and an unrelated criterion. No existing assertion was changed or removed.
The closure, verifier, shared-brief and completion-phase suites pass 109 tests
on this follow-up; full CI is still required. Main at `65bdd763` is merged
as a second parent, preserving closure verdicts and earlier-findings checks.

Review 5556946831's fleet-path boundary fix is verified by 140 passing tests
across the fleet checklist, gate and audit suites plus the worker verifier
and closure suites. The added regression failed before implementation
(missing section) and when the section was mutated to raw criteria (missing
boundary). Removing the PR-body field from the GraphQL request also made it
fail. Fresh per-render boundaries, criteria placement, the external instruction,
and empty/no-met bodies are covered. No existing assertion was removed.
Main through `6effe8f3` is included; full CI remains required.

Review 5557514840 exposed cross-entry scrubbing: a forged BEGIN marker changed
the next entry's `content`, and a private-key header consumed the later entry.
Two new regressions failed against the joined-block scrub (26 passed, 2 failed).
The renderer now scrubs each criterion separately, as matching does, then puts
the already-scrubbed lines inside one fresh shared boundary without scrubbing
them again. Both regressions copy the actual displayed lines, assert that each
entry remains independently rendered and check that `met` verdicts cover them.
The 11 focused closure, verifier, fleet, brief, completion and manual-claim
suites passed 285 tests, then 292 after integrating current main; lint and
formatting pass for the touched TypeScript. No existing assertion was removed.
Main through `a4ce4146` is included, retaining PR #3894's correction/hold changes
and the subsequent main updates to them, with the completion/correction code
and tests identical to main. The earlier-findings regression is preserved.
Full CI is still required; no new local full
quality-gate pass is claimed.

```mermaid
flowchart LR
    S[PR summary] -->|parseClosureEntries, met only| M[metClosureItems]
    M -->|renderClosureEntriesSection, fenced| B["brief CLOSURE_ENTRIES"]
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

- Retain `runPrePrVerifier: earlier findings need complete fixed verdicts even when findings is empty` unchanged from the target branch. It checks that omitted and partial earlier-finding verdicts block, and a complete fixed verdict passes; the closure fixes do not replace this regression coverage.

- `review_fleet_prs_checklists_3594_test.ts`: `gate: closure criteria are fenced data in the fleet reviewer brief` exercises the real gate output and outbound search request; `gate: no met closure entries gives an empty fleet section` covers empty and partial-only bodies. Existing helper defaults remain empty and existing checklist assertions stay unchanged. Related rules checked: the shared brief, the worker renderer and the skill's existing field-fill instructions; the fleet now copies the shared renderer's output rather than maintaining a second rule. Applying the rule to this diff found no remaining raw-criteria fill instruction.
- Tests in `worker/deno/tests/closure_met_check_3766_test.ts` (28 tests) cover:
  - extraction, de-duplication, neutralising and clipping
  - each trailing separator kind
  - linear growth on hostile separator runs (`assertLinearGrowth`)
  - rendering (criteria inside the untrusted fence, instruction outside) and reply reading (malformed entries dropped, no throw)
  - each finding branch: partial, missing, worst-wins, no verdict, more than five, singular, no note, unlisted verdicts ignored, and normalised matching
  - numbered verdict copies (`1.` and `1)`), leading whitespace and a full-length criterion; a numbered partial verdict still blocks and an unrelated numbered criterion covers nothing
  - already-numbered criteria copied from the rendered list, including mixed repeated prefixes; partial/missing still block and unrelated verdicts cover nothing
- New tests in `worker/deno/tests/pre_pr_verifier_3395_test.ts`, run against real git:
  - `a met closure entry the verifier rates partial blocks, with a finding on the summary`
  - `a clean reply with no closure array blocks: no verdict on a met entry is never a pass`
  - `a clean reply with a met closure verdict is not blocked`
  - `parseReviewReply parses a closure array, defaults to [] and drops a bad verdict without throwing`
  - `a reply with a real finding and an out-of-vocabulary closure verdict is still checked and blocked`
  - `buildPrePrVerifierPrompt renders closure criteria inside the untrusted fence and names the block`
  - `the closure gap finding's fix agrees with the gate comment's procedure`
  - `runPrePrVerifier: a clean reply is checked and not blocked` gains an assertion that a summary without a closure block gets no closure section.
- New test in `worker/deno/tests/pr_review_brief_shared_3395_test.ts`: `renderReviewBrief fills {{CLOSURE_ENTRIES}} and the reply shape carries closure`.
- Removed or changed assertions, each required by this issue:
  - `assertEquals(REVIEW_BRIEF_FIELDS.length, 5);` becomes 6, because the issue adds a per-entry field to the shared brief. Red check: removing `"CLOSURE_ENTRIES"` from `REVIEW_BRIEF_FIELDS` turns `the brief carries six fields including {{REVIEW_CHECKLISTS}}, which the renderer fills` red (5 ≠ 6).
  - `assertEquals(parseFableReview(JSON.stringify(audit)), audit);`, `assertEquals(parseFableReview(JSON.stringify(reply)), reply);` and `assertEquals(parseFableReview(\`Review:\n${JSON.stringify(reply)}\n\`), reply);` now expect `closure: []`, because the shared parser now reads the `closure` array the issue asks for. Red check: deleting `closure: parseClosureEntryVerdicts(r.closure),` from `parseReviewReply` turns `the fleet reviewer's parser and audit send-back survive the shared parser` red.
  - `makeDeps(() => Promise.resolve(okRun({ output: REPLY_CLEAN })), []),` was replaced by a stub that also captures the prompt. Every assertion the test made is kept.
- Call site check: replacing `closureItems: metItems` with `[]` in `verifyInCheckout` turns `a met closure entry the verifier rates partial blocks, with a finding on the summary` red. Removing the `closureGapFindings` append turns both that test and `a clean reply with no closure array blocks…` red.
- Callers checked for the now-required `ReviewReply.closure` and `buildPrePrVerifierPrompt`'s required `closureItems`: the synthetic review in `pre_pr_verifier.ts`, `createMockDeps` in `lib/issue_worker_wiring.ts`, and `tests/completion_phase_pre_pr_verifier_3395_test.ts`. All three now pass `closure: []`. `deno check` over `lib/`, `tests/` and the fleet scripts passes.
- A dead operand (`matching.length === 0`) found by flip checks was removed.
- Targeted run at `3d880384` (before restoring the target branch's earlier-findings regression): `deno task test:unit tests/closure_met_check_3766_test.ts tests/pre_pr_verifier_3395_test.ts tests/pr_review_brief_shared_3395_test.ts tests/completion_phase_pre_pr_verifier_3395_test.ts tests/review_fleet_prs_checklists_3594_test.ts tests/review_fleet_prs_log_2678_test.ts tests/independent_review_gate_test.ts` passed: parallel pass 147 passed, 0 failed; serial pass 23 passed, 0 failed.
- `./quality.sh` at `3d880384`, before restoring the target branch's earlier-findings regression: Result PASSED (with skipped checks, as the gate reports them). CI must re-run the restored test on the updated head; no new local full-gate pass is claimed.

<!-- vibe-branch-outcomes -->
