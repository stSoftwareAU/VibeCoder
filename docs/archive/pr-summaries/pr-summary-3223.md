# PR summary: flag forward references to another issue's unbuilt work (Issue #3223)

## Summary

Closes #3223.

Fleet PRs added docs that describe work owned by **another issue** as if it
already ships. That issue was a sibling sub-issue, a milestone's planned issue
or a follow-up, and its code was not on the branch (GRQ-AutoTrader#2464,
GRQ-AutoTrader#2506, VibeCoder#3156).

- [x] `CODING-STANDARDS.md` has a new paragraph, **Behaviour another issue
      delivers is not described as present**, next to **Prose about the PR's
      own change**. Such work may be named only as planned ("not yet: #N
      will …") and only while #N is open. Before writing the sentence, run
      `gh issue view N` and grep the head for the deliverable. When the issue's
      plan names a sibling, grep the touched docs for that sibling's `#N`. The
      paragraph adds to the docs-must-match-head rule and does not relax it.
- [x] The docs step (step 3) of `prompts/issue/prompt.md` carries the same
      rule and points to the `CODING-STANDARDS.md` paragraph.
- [x] Milestone guardrail: when `createMilestoneSummaryPr()` raises the
      summary PR into the default branch, `findNotPlannedDocReferences()`
      (new `worker/deno/lib/milestone_not_planned_refs.ts`) finds the
      milestone's issues and their declared `Depends on`/`Blocked by` issues
      that were closed as not planned. It then reads the compare diff and lists
      each added Markdown line that names one of those issues in the PR body.
      Markdown files with no diff text, and the compare API's 300-file cap, are
      reported as not checked. A lookup failure swaps in a "not checked" note.
      The check never blocks PR creation.
- [x] `buildMilestoneSummaryBody()`'s optional fifth parameter is renamed from
      `dependencyNote` to `extraSections`. It now carries the #3014
      pending-dependencies hold and the new not-planned section, joined with a
      blank line.
- [x] `docs/workflows/milestones.md` documents the guardrail in a new section,
      **Docs citing issues closed as not planned (Issue #3223)**.

## Evidence

**Docs sweep** — grep: `dependencyNote`, `extraSections`, `buildMilestoneSummaryBody`, `createMilestoneSummaryPr`, `findNotPlannedDocReferences`, `renderNotPlannedDocSection`, `NOT_PLANNED_DOCS_UNVERIFIED_NOTE`, `milestone_not_planned_refs`, "not planned", "summary PR body", "Issues addressed", "Review notes", "pending dependencies" across `README.md`, `*/README.md` and `docs/` (excluding `docs/archive/`); section: `docs/workflows/milestones.md#️-pending-dependencies-hold-the-summary-pr-issue-3014` and `docs/workflows/milestones.md#️-docs-citing-issues-closed-as-not-planned-issue-3223`, plus `docs/INTERNALS.md` (milestone completion flow and the Milestone management module table); updated: `docs/workflows/milestones.md`

- The renamed parameter `dependencyNote` and the helper
  `buildMilestoneSummaryBody` appear in no doc outside the archive.
- `docs/workflows/milestones.md:273-280` (the #3014 hold section) is still
  true. The summary PR body still gains the `### ⏸️ Held: pending
  dependencies` section. The not-planned section is added after it, and the
  new section below documents it.
- The new `docs/workflows/milestones.md` section (lines 286-305, ending before `## 🔄 Periodic milestone branch sync`) was checked
  against `milestone_not_planned_refs.ts`. Its claims hold at the head:
  `Depends on`/`Blocked by` (the `extractDependencyReferences` pattern), the
  compare is read only when a candidate exists, `#N` and `owner/repo#N` for
  this repo, patch-less files listed as not checked, the 300-file note, the
  lookup-failure note, and no re-check at merge time.
- `docs/INTERNALS.md:2895` ("`build_milestone_summary_body()` — list all
  closed issues") and `docs/INTERNALS.md:2911` (the `Closes #N` reference)
  are still true. The Milestone management table at
  `docs/INTERNALS.md:5315` lists only some milestone modules, and none of
  its rows is made false.
- The other "not planned" hits (`docs/LESSONS-LEARNT.md:70`,
  `docs/GITHUB-ACTIONS-AUDIT-SCAN.md:1184`) are unrelated uses of the phrase.

## Test Plan

- No assertion was removed from an existing test. The diff only adds lines to
  `worker/deno/tests/milestone_completion_test.ts`, and the other two test
  files are new.
- Added `worker/deno/tests/milestone_not_planned_refs_test.ts`. It covers
  `findNotPlannedDocReferences`, `findIssueReferences`, `addedLines`,
  `renderNotPlannedDocSection` and `NOT_PLANNED_DOCS_UNVERIFIED_NOTE`.
- Added three `checkAndHandleMilestoneCompletions` tests to
  `worker/deno/tests/milestone_completion_test.ts`. They cover the summary PR
  body when a doc line cites a not-planned issue, when the compare fails, and
  when a Markdown file has no patch.
- Added `worker/deno/tests/forward_reference_rule_3223_docs_test.ts`. Both of
  its tests fail when run against `origin/main`'s `CODING-STANDARDS.md` and
  `prompts/issue/prompt.md`, and pass with the change.
- `deno test -A tests/milestone_not_planned_refs_test.ts
  tests/milestone_completion_test.ts tests/forward_reference_rule_3223_docs_test.ts`
  (from `worker/deno`): 105 passed, 0 failed.
- Entry point checked: `createMilestoneSummaryPr()` (reached through
  `checkAndHandleMilestoneCompletions`). Dropping `notPlannedNote` from the
  `extraSections` join turns all three new completion tests red.

**Branch outcomes:**
- `worker/deno/lib/milestone_not_planned_refs.ts:86` — skip (non-object item in the issues page) — no test reaches it — flipped to return an empty list, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:88` — skip (non-integer `number`) — no test reaches it — guard removed, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:89` — skip (pull request in the issues list) — no test reaches it — guard removed, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:107` — closed as not planned vs closed completed — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - completed-closed member is ignored` — flipped to accept any closed state, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:133` — hunk header sets the new-file line — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - member closed not_planned, doc names it` — flipped to always start at line 1, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:137` — absent (line before the first hunk) — `worker/deno/tests/milestone_not_planned_refs_test.ts::addedLines - lines before the first hunk are ignored` — flipped to count it, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:139` — added (`+`) line recorded — `worker/deno/tests/milestone_not_planned_refs_test.ts::addedLines - removed and context lines are not matched as added` — flipped to drop the text, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:142` — context line advances the counter but is not recorded — `worker/deno/tests/milestone_not_planned_refs_test.ts::addedLines - removed and context lines are not matched as added` — flipped to record it, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:175` — reject (hex colour `#2303ff`) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findIssueReferences - rejects cross-repo, hex colour, HTML entity and bare 'foo#N'` — guard disabled, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:179` — reject (HTML entity `&#8212;`) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findIssueReferences - rejects cross-repo, hex colour, HTML entity and bare 'foo#N'` — guard disabled, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:186` — bounded backward walk over the repo slug — `worker/deno/tests/milestone_not_planned_refs_test.ts::findIssueReferences - accepts bare, parenthesised and spelt-out same-repo refs` — bound cut to 2, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:195` — accept (bare `#N`) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findIssueReferences - accepts bare, parenthesised and spelt-out same-repo refs` — flipped to reject, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:198` — accept this repo / reject another repo (`owner/repo#N`) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findIssueReferences - rejects cross-repo, hex colour, HTML entity and bare 'foo#N'` — flipped to accept any repo, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:200` — reject (`foo#N`) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findIssueReferences - rejects cross-repo, hex colour, HTML entity and bare 'foo#N'` — flipped to accept, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:206` — de-duplicate a repeated `#N` on one line — no test reaches it — guard removed, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:237` — error (invalid repo) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - invalid repo is ok:false` — guard disabled, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:240` — error (invalid milestone number) — no test reaches it — guard disabled, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:246` — error (invalid default branch) — no test reaches it — guard disabled, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:252` — error (invalid milestone branch) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - invalid branch is ok:false` — guard disabled, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:267` — error (member list unreadable) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - member-list failure is ok:false` — flipped to an empty ok scan, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:281` — candidate (member closed as not planned) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - member closed not_planned, doc names it` — flipped to never a candidate, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:294` — skip (self dependency) — no test reaches it — guard removed, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:295` — skip (dependency inside the milestone) — no test reaches it — guard removed, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:296` — skip (dependency already a candidate) — no test reaches it — guard removed, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:299` — cached lookup of a repeated dependency — no test reaches it — cache bypassed, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:306` — candidate (outside dependency closed as not planned) / not a candidate (closed completed) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - declared dependency outside the milestone, closed not_planned` — condition inverted, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:314` — error (dependency lookup fails) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - dependency-lookup failure is ok:false` — flipped to skip the dependency, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:334` — empty (no candidates, compare never read) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - no candidates means compare is never called` — guard disabled, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:345` — error (compare has no `files` array) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - compare non-array files is ok:false` — guard disabled, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:355` — error (compare call fails) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - compare failure is ok:false` — flipped to an empty ok scan, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:368` — unchecked (300-file cap reached) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - 300 files triggers a truncation entry` — guard disabled, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:380` — skip (non-Markdown file) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - non-Markdown file ignored` — extension check removed, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:381` — skip (removed Markdown file) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - removed Markdown file is not scanned` — guard removed, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:383` — unchecked (Markdown file without a patch) — `worker/deno/tests/milestone_not_planned_refs_test.ts::findNotPlannedDocReferences - Markdown file without patch is unchecked` — flipped to skip silently, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:392` — skip (line names an issue that is not a candidate) — no test reaches it — guard disabled, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:395` — merge a second hit for the same (issue, file) into one entry — no test reaches it — merge removed, every test stayed green
- `worker/deno/lib/milestone_not_planned_refs.ts:424` — empty (nothing to report renders "") — `worker/deno/tests/milestone_not_planned_refs_test.ts::renderNotPlannedDocSection - empty scan renders nothing` — guard removed, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:426` — "cite" vs "not checked" heading — `worker/deno/tests/milestone_not_planned_refs_test.ts::renderNotPlannedDocSection - lists issue, file and lines` — condition inverted, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:432` — references listed — `worker/deno/tests/milestone_not_planned_refs_test.ts::renderNotPlannedDocSection - lists issue, file and lines` — guard disabled, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:452` — unchecked files listed — `worker/deno/tests/milestone_not_planned_refs_test.ts::renderNotPlannedDocSection - unchecked-only scan still renders` — guard disabled, test went red
- `worker/deno/lib/milestone_not_planned_refs.ts:453` — blank line between references and the unchecked list — no test reaches it — separator removed, every test stayed green
- `worker/deno/lib/milestone_completion.ts:1013` — scan succeeded — `worker/deno/tests/milestone_completion_test.ts::checkAndHandleMilestoneCompletions - summary PR body cites a doc line naming a not-planned issue` — flipped to the failure arm, test went red
- `worker/deno/lib/milestone_completion.ts:1015` — section added (hits or unchecked files) — `worker/deno/tests/milestone_completion_test.ts::checkAndHandleMilestoneCompletions - summary PR body notes an unchecked Markdown file with no patch` — flipped to never add, test went red
- `worker/deno/lib/milestone_completion.ts:1015` — absent (clean scan leaves the PR body unchanged) — no test reaches it — flipped to always add the section, and separately to add the unverified note on a clean scan; every test stayed green
- `worker/deno/lib/milestone_completion.ts:1018` — warning logged when hits exist — `worker/deno/tests/milestone_completion_test.ts::checkAndHandleMilestoneCompletions - summary PR body cites a doc line naming a not-planned issue` — guard disabled, test went red
- `worker/deno/lib/milestone_completion.ts:1034` — fail-open (scan error swaps in the unverified note, PR still created) — `worker/deno/tests/milestone_completion_test.ts::checkAndHandleMilestoneCompletions - summary PR body notes the not-planned scan could not run when compare fails` — note removed, test went red
- `worker/deno/lib/milestone_completion.ts:1037` — both sections joined into `extraSections` — `worker/deno/tests/milestone_completion_test.ts::checkAndHandleMilestoneCompletions - summary PR body cites a doc line naming a not-planned issue` — `notPlannedNote` dropped from the join, test went red; the `"\n\n"` separator itself is reached by no test (changed to `"\n"`, every test stayed green)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
