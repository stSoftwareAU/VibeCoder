# PR Summary — Issue #3245

## Summary

The milestone summary PR's not-planned doc scan (`findNotPlannedDocReferences`)
now reads a member's `Depends on` / `Blocked by` dependency written as
`owner/repo#N` when it names the scanned repo (case-insensitive), as well as
bare `#N`. A dependency naming another repo is still skipped and never looked
up. Before this change only bare `#N` was read, so a same-repo dependency spelt
out in full was silently missed, although the same module's
`findIssueReferences` already accepts that form in doc lines.

Closes #3245

- [x] Failing tests first (same-repo qualified, same-repo different case,
      cross-repo skipped)
- [x] Filter detailed refs by repo in `milestone_not_planned_refs.ts`
- [x] Docs: `docs/workflows/milestones.md` and the module doc
- [x] Quality gate

## Spec

### Intent and Rationale

A sibling's dependency closed as not planned must be caught whichever same-repo
spelling the sub-issue used. Reading `owner/repo#N` in doc lines but not in
dependency lines made the scan inconsistent.

### Essential Design Decisions

- The filter mirrors the existing one in `milestone_deadlock_rollup.ts`:
  `ref.repo === undefined || ref.repo.toLowerCase() === repo.toLowerCase()`. The
  numbers are then deduplicated and sorted, as `extractDependencyReferences`
  did, so the lookup order is unchanged.
- The shared helper `extractDependencyReferences` (`issue_dependencies.ts`) is
  left unchanged. Its other caller, `milestone_dependency_hold.ts:143`, keeps
  its current bare-only behaviour, which is out of scope here.

### Undiscoverable Facts

None.

## Evidence

`./quality.sh` passed. `config integration` was skipped, as it is on every
worker host without that config.

**Docs sweep** — grep: `extractDependencyReferences`,
`findNotPlannedDocReferences`, "not planned", "Depends on", "owner/repo#N";
section: `docs/workflows/milestones.md` § "Docs citing issues closed as not
planned"; updated: `docs/workflows/milestones.md`, the module doc in
`worker/deno/lib/milestone_not_planned_refs.ts`. Left alone, each still true:
docs/INTERNALS.md:3037-3039 — still true because the shared helpers
`extractDependencyReferences` / `extractDependencyReferencesDetailed` are
unchanged; docs/workflows/issue-processing.md:375 — still true because it
describes discovery's dependency blocking, which this change does not touch;
docs/audits/security-sweep-2495-chain-promotion-wiring.md:30 — still true
because it audits chain promotion's use of the detailed helper, unchanged;
docs/workflows/milestones.md:295 — still true because it only names the
function, whose following sentence the diff updated;
docs/workflows/milestones.md:286 and docs/workflows/milestones.md:290 — still
true because the section heading and the not-planned premise are unchanged;
docs/workflows/milestones.md:186, docs/workflows/milestones.md:263 and
docs/workflows/milestones.md:283 — still true because they describe the
cross-milestone hold and `milestone_dependency_hold.ts`, which keeps its
bare-only helper; docs/workflows/milestones.md:303 — still true because doc
lines already accepted both forms; docs/LESSONS-LEARNT.md:70,
docs/GITHUB-ACTIONS-AUDIT-SCAN.md:1184 and DESIGN-PRINCIPLES.md:2756 — still
true because they use "not planned" in another sense;
docs/IDLE-TASK-FRAMEWORK.md:952 — still true because it describes the idle
census's own resolution, not this scan;
docs/audits/security-sweep-1880-ci-base-branch-check.md:55,
docs/audits/security-sweep-2103-pr-title-read.md:37,
docs/audits/security-sweep-3088-declared-handoff.md:23,
docs/workflows/ci-fix.md:168 and docs/workflows/issue-processing.md:1424 — still
true because they use `owner/repo#N` for other features (CI deferral, PR title
reads, declared handoff, the partial-rollup guard);
worker/deno/lib/apply_chain_promotions.ts:90,
worker/deno/lib/blocked_outcome.ts:204, worker/deno/lib/blocked_outcome.ts:234,
worker/deno/lib/blocked_outcome.ts:270,
worker/deno/lib/content_approval_tracker.ts:205,
worker/deno/lib/issue_dependencies.ts:403,
worker/deno/tests/dependency_code_span_regression_test.ts:9 and
worker/deno/tests/issue_dependencies_test.ts:305 — still true because they
describe the shared dependency helpers, which this change does not modify;
worker/deno/lib/milestone_not_planned_refs.ts:55,
worker/deno/tests/milestone_completion_test.ts:1158 and
worker/deno/tests/milestone_not_planned_refs_test.ts:26 — still true because
they only name the function; worker/deno/lib/milestone_not_planned_refs.ts:6,
worker/deno/lib/milestone_not_planned_refs.ts:34,
worker/deno/lib/milestone_not_planned_refs.ts:77 and
worker/deno/lib/milestone_not_planned_refs.ts:226 — still true because they say
what "not planned" means, not which dependency forms are read;
worker/deno/lib/milestone_not_planned_refs.ts:153 — still true because it
documents the doc-line matcher, which already accepted both forms.

Related existing rules checked: none. The change adds no prompt or standard
rule.

## Test Plan

The new tests are in `worker/deno/tests/milestone_not_planned_refs_test.ts`.
Before the fix the file ran 39 passed and 2 failed: tests (a) and (b) saw
`lookups` equal `[]`. After the fix all 41 pass.

- (a)
  `findNotPlannedDocReferences - same-repo dependency written owner/repo#N is looked up and reported`
- (b)
  `findNotPlannedDocReferences - same-repo dependency in a different case (Blocked by OWNER/REPO#N) is looked up`
- (c)
  `findNotPlannedDocReferences - cross-repo dependency is never looked up and not a candidate`.
  Its fake answers every lookup as closed not_planned and the doc line names
  `#96`, so dropping the filter would report #96.

Callers checked: the shared helper `extractDependencyReferences` is unchanged,
so `milestone_dependency_hold.ts:143` is unaffected.

**Branch outcomes:**

- `worker/deno/lib/milestone_not_planned_refs.ts:298`, `ref.repo` undefined
  (bare `#N`) is kept. Covered by the existing "declared dependency outside the
  milestone" tests. Flip check: dropping this clause turned 4 tests red.
- `worker/deno/lib/milestone_not_planned_refs.ts:299`, the same repo in any case
  is kept. Covered by (a) and (b). Flip check: removing the same-repo clause
  turned (a) and (b) red.
- `worker/deno/lib/milestone_not_planned_refs.ts:299`, another repo is skipped.
  Covered by (c). Flip check: removing the repo filter entirely turned (c) red.

## Pre-PR security self-check

- [x] Input validation: the repo comparison only selects refs. The lookup URL
      still uses the validated `repo` and an integer issue number.
- [x] Secrets: none staged.
- [x] Injection surface: no new shell, SQL or HTTP construction.
- [x] Dependencies: none added.
