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
`worker/deno/lib/milestone_not_planned_refs.ts`.

The remaining hits are still true, because none of them describes this scan's
dependency forms:

- `docs/INTERNALS.md:1674` and `:1689` describe the dependency checker.
- `docs/TROUBLESHOOTING.md:682` and `:728` describe discovery.
- `docs/LESSONS-LEARNT.md:70`, `docs/GITHUB-ACTIONS-AUDIT-SCAN.md:1184` and
  `DESIGN-PRINCIPLES.md:2756` use "not planned" in another sense.
- `docs/audits/lib-sweep-coverage/top-up-3223.json:6` and `:9` only name the
  module file.
- `docs/workflows/milestones.md:303` already lists both forms for doc lines.

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
