## Summary

Workflow auditing now requires root-project evidence for templates whose tools
run from the checkout root. Workflow sync and purge close trusted generated
requests for known root-project specs whose manifests are absent, even after
GitHub stops reporting their language. A complete root file inventory preserves
legitimate npm requests when Deno and web assets coexist with `package.json`.
Closure comments explain the missing prerequisite, and their authenticated
markers allow a new request when the root marker returns. Comments name the
command that closed the request, and setup help describes automatic closures.
The purge command's
dry run reports the would-close candidates; setup workflow-sync has no dry run.
Existing workflow files remain untouched.
Closes #4693.

Version bump: no version file was changed for this update.

## Spec

### Intent and Rationale

- GitHub's language byte counts can include nested fixtures, so they do not by
  themselves show that a root-level project tool can run.
- Applicability is declared on each workflow spec and resolved by the auditor;
  repository-wide scans keep their nested-project coverage.
- Reconciliation must outlive a language's presence in the API response while
  preserving legitimate, unknown and human-authored requests.

### Essential Design Decisions

- The detector preserves its existing language selection, including Deno's
  precedence over Node, and also returns the complete root file inventory.
  Root-project applicability uses that inventory, independently of selected
  language markers. Older language results without the optional inventory
  trigger a root-contents fetch; a failed fetch fails the audit.
- Required workflows still follow language and visibility selection. The
  inapplicable set checks root prerequisites across the known catalogue,
  independently of current language presence.
- Only known workflow-sync requests verified as fleet-authored are reconciled.
  An unresolved fleet identity cannot authorise closure. The purge dry run
  reports the same trusted root-marker candidates without closing them.
- Filing dedup checks closed matches for fleet-authored missing-root-project
  comments. Other closed requests still suppress duplicates; a failed comment
  lookup skips filing that spec and logs the failure.
- Universal specs and repository-wide scans have no root-project requirement.
  Existing workflow files are not removed when a language stops qualifying.

### Undiscoverable Facts

- The issue identifies VibeCoder's nested Rust fixtures as the motivating case;
  the repository root has no `Cargo.toml`.
- The template contracts distinguish root commands from recursive scans: Cargo
  runs at the checkout root, ShellCheck uses `scandir: .`, Java Dependency Check
  uses `path: .`, and Java dependency updates use Dependabot's root `/`.

## Evidence

Backend and CLI change; no visual surface changed. Read the workflow catalogue
and purge command sections of `docs/EXTENDING.md` and the workflow-sync
operator entry in `docs/SETUP.md`. They describe root evidence, reconciliation
after language disappearance, purge dry-run candidates, and close conditions.

The reported baseline failure was reproduced: 39 tests passed and three Cargo
capability regressions failed across the five named suites. Marker fixtures in
the alternative-groups and local-path-fallback suites now carry root manifest
evidence while retaining their original detection assertions.

The new hybrid and disappeared-language probes failed against the incoming head.
Restoring only the old auditor also made all six caller-level hybrid regressions
fail: single-repo sync, fleet sync, single-repo purge, fleet purge, the
command's single/fleet modes, and action-reference selection. Temporarily
replacing the reconciliation helper's author selector with
`const trusted = tagged` made both new sync author-verification cases fail. The
author selector and final applicability logic were restored before the final
test run.

## Deno regression avoided

- Used Deno tooling; no Node tooling or dependencies were added.
- The additive optional root inventory supports older callers through a live
  fetch rather than assuming missing metadata proves a missing manifest.

## Test Plan

- `worker/deno/tests/workflow_auditor_test.ts`: API-only Rust excludes Cargo;
  root Cargo retains all three specs; mixed languages and recursive scans remain
  eligible; web assets alone do not satisfy npm; legacy language data fetches
  complete root evidence; lookup failures fail the audit; vanished languages
  retain all known absent root prerequisites in reconciliation.
- `worker/deno/tests/language_detector_test.ts`: complete root inventory keeps
  `package.json` despite Deno precedence and excludes directories.
- `worker/deno/tests/purge_stale_workflow_issues_test.ts`: missing/partial
  requests, unknown specs, human authors, root projects, dry runs and close
  failures; hybrid npm preservation and disappeared Cargo reconciliation through
  single/fleet helpers and both actual command modes; an empty language response
  with only `README.md`; direct reconciliation result shapes, malformed/unknown
  tags, dry-run writes, and exact close-failure causes.
- `worker/deno/tests/setup_workflow_sync_test.ts`: reconciliation with no gaps;
  the reconciliation comment identifies `setup workflow-sync`;
  listing/close failures; logged dry-run candidates; hybrid npm preservation;
  disappeared-language reconciliation; human-authored matching requests and
  unresolved fleet identity; fleet wrapper coverage; complete error results for
  failed and thrown reconciliation, including non-Error throws.
- `worker/deno/tests/setup_workflow_sync_test.ts::syncWorkflowsForRepo - files Cargo again after a missing root marker returns`:
  the former permanent suppression after an applicability closure is obsolete;
  ordinary closed requests still deduplicate, covered by the Issue #1829 test
  below, while this test closes the request then files again after Cargo returns.
- `worker/deno/tests/workflow_sync_actions_test.ts`: API-only versus root Cargo
  actions and hybrid-project npm action references with the universal Markdown
  workflow already present, so it cannot supply a false-positive Node action.
- Root applicability has one evaluator in `workflow_auditor.ts`; sync and purge
  consume its result. No twinned applicability rule was found.
- Existing Cargo alternative-implementation and local workflow/API fallback
  assertions are retained. Inapplicable-set expectations now reflect the whole
  known root catalogue. The old expectation that every issue listing uses all
  states is obsolete: reconciliation lists open requests. Filing dedup must
  still search all states, covered by
  `worker/deno/tests/setup_workflow_sync_test.ts::syncWorkflowsForRepo - issue search uses '--state all' so closed issues dedupe (Issue #1829)`,
  which checks all three universal dedup searches.
- `deno task test:unit` over all auditor suites, alternative-groups, purge,
  sync, action references, language detection, template audit conformance and
  `spawn_timeout_bounds_1228_test.ts` — passed, 181 tests.
- Mutation-driven cleanup removes a repeated tag guard already proved by the
  preceding filter and redundant config forwarding to an already-built runner.
- Diff-scoped mutation check of the branch's production changes in a disposable
  checkout — completed: 87 candidates, 85 killed, two rejected as invalid
  syntax, zero survivors. All importing-test baselines passed. No mutation
  exemptions or repository skip setting were used.
- Targeted `deno check --frozen --lock=deno.lock`, `deno lint`, and
  `deno fmt
  --check` on changed source/test files — passed; Markdown lint —
  passed.
- The earlier full `timeout 900 ./quality.sh < /dev/null` reached the parallel
  test stage and timed out with exit 124. The worker reruns the full gate after
  this repair.
