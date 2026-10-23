# Report-only idle task listing every SIMPLE-ON-PURPOSE marker (#4027)

## Summary

Adds the `simple-on-purpose-ledger` idle task. Per monitored repository a
deterministic, network-free scanner (`worker/deno/lib/simple_on_purpose_scanner.ts`)
reads the git-tracked text files, lists every `SIMPLE-ON-PURPOSE:` marker with
`path:line`, its ceiling and its `upgrade when` condition, and flags markers
that carry no `upgrade when` clause. The template
(`worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts`)
posts or refreshes ONE report issue per repository, keyed on the finding id
`BP-SIMPLE-ON-PURPOSE-LEDGER`. It is report-only: no file edit, no commit, no
PR, nothing installed or fetched at run time. A scanner failure is `ok: false`
and files nothing, so an unreadable tree never reads as an empty ledger. The
twentieth wrapper is registered in every registry the nineteen siblings use.

Wrapped markers: the scanner joins the following same-opener comment lines (at
most `MAX_CONTINUATION_LINES`, stopping at a blank or non-comment line, the next
marker, a `*/` line or a closed `-->`/`*/` comment) until the marker carries an
`upgrade when` clause with a non-empty condition. The earlier dash/comma gating
cut markers that wrap mid-sentence after their first line, so the report gave a
wrong ceiling and a false `(missing)`. Run on this repository the scanner now
lists 24 markers and flags 1 (`worker/deno/lib/closure_criterion_match.ts:115`,
which genuinely has no `upgrade when`); `docs/SIMPLE-ON-PURPOSE-LEDGER.md`
documents the join rule. Stale counts and descriptions in
`docs/IDLE-TASK-FRAMEWORK.md`, `create_all_idle_task_wrappers.ts`,
`idle_task_backfill.ts` and `idle_task_claim_handler.ts` are corrected to the
twenty registered templates and to what the head code does.

Fix-up in this round: the template's `gh` argument shapes, label, wrapper body,
wrapper veto and unreadable-report path were unpinned (13 mutants survived).
They are now pinned by tests; the label description in the template matches
`content_label_definitions.ts`.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The idle task lists every marker in the repository with `path:line`, ceiling and upgrade condition — evidence: `worker/deno/tests/simple_on_purpose_scanner_test.ts::render - shows path:line, ceiling, condition and the flagged section`, `::scan - markers are sorted by path then line and flagged ones collected`, `::scan - the default lister reads git-tracked files only`, `::parse - the real idle_detect_diagnostics.ts marker joins across lines to its upgrade when`, `::parse - the real branch_conflict_pass.ts marker joins its second line`, `::parse - the real guidance.ts jsdoc marker joins its ` * ` lines to its upgrade when` — reviewer: met
- **met** — A marker without `upgrade when` is flagged — evidence: `worker/deno/tests/simple_on_purpose_scanner_test.ts::parse - a marker with no upgrade clause has upgradeWhen null`, `::parse - an empty upgrade clause has upgradeWhen null`, `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::renderSimpleOnPurposeLedgerTitle - counts markers and flagged markers` — reviewer: met
- **met** — The task is report-only: it makes no commits and opens no PR — evidence: `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - report-only: only issue commands reach gh, never a pull request or commit` — reviewer: met
- **met** — Tests cover marker parsing, including a malformed marker — evidence: `worker/deno/tests/simple_on_purpose_scanner_test.ts::parse - a malformed empty-body marker is reported, not thrown`, `::parse - a wrong-case keyword is not a marker` — reviewer: met
- **unrequested** — Registration, label, prompt, routing-allowlist and docs wiring for a new idle task (`worker/deno/lib/worker_label_guard.ts`, `worker/deno/setup/content_label_definitions.ts`, `worker/deno/lib/issue_create_routing_check.ts`, `prompts/simple_on_purpose_ledger/prompt.md`, `docs/SIMPLE-ON-PURPOSE-LEDGER.md`, `docs/audits/lib-sweep-coverage/top-up-4027.json`) — reviewer: unrequested — reason: required by the registry, label-guard, routing and docs conformance tests every idle task must pass; not behaviour beyond the issue

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Single source of truth: the label description differed between `simple_on_purpose_ledger_template.ts` and `content_label_definitions.ts` — evidence: `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:210` — reason: fixed in this diff
- **clean** — Australian English, KISS/DRY (follows the sibling template pattern), TDD (fail-loud paths, veto, wrapper body, gh argument shapes covered), Deno/TypeScript conventions (`deno fmt`/`deno lint` clean, git via the chokepoint, `Result` returns, no swallowed catches), commit safety and docs-with-code were checked and found compliant

## Test Plan

- Removed from `worker/deno/tests/idle_task_backfill_test.ts`: `assertEquals(IDLE_TASK_WRAPPER_TITLES.length, 19);`
  Required by: "Report-only idle task listing every SIMPLE-ON-PURPOSE marker"
  Replaced by: `assertEquals(IDLE_TASK_WRAPPER_TITLES.length, 20);`

The allowlist gains the twentieth wrapper title, so the exact-count assertion
moves from nineteen to twenty; the same test also gains an `includes` assertion
for `SIMPLE_ON_PURPOSE_LEDGER_ISSUE_TITLE`.

Run: `deno test --allow-all tests/simple_on_purpose_ledger_template_test.ts tests/simple_on_purpose_scanner_test.ts tests/idle_task_backfill_test.ts tests/idle_task_scan_dedup_conformance_test.ts tests/idle_task_wrapper_dedup_author_test.ts` → `ok | 267 passed | 0 failed` (with `tests/idle_task_claim_handler_test.ts` added to the run).

**Docs sweep** — grep: `nineteen`, `19 wrapper`, `twenty`, `simple-on-purpose-ledger`, `gate-skip-drift`; section: `docs/IDLE-TASK-FRAMEWORK.md` and `docs/ADD-REPO.md#` (seed all twenty idle-task wrappers); siblings: `gate-skip-drift` (`docs/GATE-SKIP-DRIFT-SCAN.md`, `README.md` documentation table, `DESIGN-PRINCIPLES.md`); updated: `docs/SIMPLE-ON-PURPOSE-LEDGER.md` (new), `docs/IDLE-TASK-FRAMEWORK.md`, `docs/ADD-REPO.md`, `README.md`, `DESIGN-PRINCIPLES.md`, `docs/CONFIGURATION.md`, `docs/REFERENCES.md`, `docs/PROMPT-HOUSE-VOCABULARY.md`, `docs/OWASP-TOP-10-2025-COVERAGE-MATRIX.md` and the sibling scan manuals

**Branch outcomes:**
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:137` — success (no flagged markers) / flagged title — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::renderSimpleOnPurposeLedgerTitle - counts markers and flagged markers` — flipped condition, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:165` — absent (body has no footer) / footer stripped — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simpleOnPurposeLedgerContentOf - strips the footer and its run id` — flipped, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:183` — error (view payload is not JSON) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - an unreadable open report fails loud and is not refreshed` — made the catch throw, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:187` — error (payload is `null`) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - an unreadable open report fails loud and is not refreshed` — flipped, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:188` — error (title/body missing) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - an unreadable open report fails loud and is not refreshed` — flipped, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:216` — fail-closed default (run id unset → `unknown`) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger buildIssueBody - substitutes the footer with this template and run id` — changed default, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:240` — error (create output has no issue URL) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - markers and no open report files one report` — flipped, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:266` — error (prompt fails to load) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger buildIssueBody - a prompt that fails to load throws naming the template` — flipped, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:307` — error (scanner failure files nothing) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - scanner failure surfaces and files nothing` — flipped, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:331` — absent (zero markers, no open report → nothing filed) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - zero markers and no open report files nothing` — flipped, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:343` — error (report could not be filed) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - markers and no open report files one report` — flipped, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:359` — error (open report unreadable) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - an unreadable open report fails loud and is not refreshed` — flipped, test went red
- `worker/deno/lib/idle_task_templates/simple_on_purpose_ledger_template.ts:367-376` — success (identical → unchanged, differing → refreshed) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - identical open report is a no-op despite a new run id` — covered by the unchanged/refreshed pair
- `worker/deno/lib/simple_on_purpose_scanner.ts:80` — absent (line is not a comment) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::parse - a keyword inside a string or mid-line is not a marker` — flipped, test went red
- `worker/deno/lib/simple_on_purpose_scanner.ts:80` — absent (wrong-case keyword) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::parse - a wrong-case keyword is not a marker` — flipped, test went red
- `worker/deno/lib/simple_on_purpose_scanner.ts:141` — absent (no `upgrade when` clause) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::parse - a marker with no upgrade clause has upgradeWhen null` — flipped, test went red
- `worker/deno/lib/simple_on_purpose_scanner.ts:127` — success (leading `:`/`,` stripped from the condition) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::parse - an empty upgrade clause has upgradeWhen null` — changed, test went red
- `worker/deno/lib/simple_on_purpose_scanner.ts:130` — absent (empty condition → null) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::parse - an empty upgrade clause has upgradeWhen null` — flipped, test went red
- `worker/deno/lib/simple_on_purpose_scanner.ts:246` — absent (Markdown skipped) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::scan - a markdown file is not scanned, so its prose marker is not counted` — changed, test went red
- `worker/deno/lib/simple_on_purpose_scanner.ts:216`, `:218`, `:256` — absent (oversized/binary skipped) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::scan - binary and oversized text is skipped, not failed` — flipped, test went red
- `worker/deno/lib/simple_on_purpose_scanner.ts:301` — absent (zero markers) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::render - zero markers says so plainly and has no table` — flipped, test went red
- `worker/deno/lib/simple_on_purpose_scanner.ts:307` — success (flagged section only when flagged) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::render - shows path:line, ceiling, condition and the flagged section` — flipped, test went red
- `worker/deno/lib/simple_on_purpose_scanner.ts:325` — absent (`(missing)` for a null condition) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::render - shows path:line, ceiling, condition and the flagged section` — flipped, test went red
- `worker/deno/lib/simple_on_purpose_scanner.ts:234-241` — error (file listing fails) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::scan - a listing failure returns ok:false with the cause` — fail-closed `ok:false`, covered by the named test
- `worker/deno/lib/simple_on_purpose_scanner.ts:250-254` — error (file read fails) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::scan - a read failure returns ok:false naming the file and the cause` — fail-closed `ok:false`, covered by the named test
- `worker/deno/lib/simple_on_purpose_scanner.ts:164` — success (join continues until the clause has a non-empty condition) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::parse - the real idle_detect_diagnostics.ts marker joins across lines to its upgrade when`, `::parse - the real branch_conflict_pass.ts marker joins its second line`, `::parse - the real guidance.ts jsdoc marker joins its ` * ` lines to its upgrade when`, `::parse - a marker that wraps mid-sentence reaches an upgrade when on a later line` — the old dash/comma rule left these markers flagged (red), the new rule passes
- `worker/deno/lib/simple_on_purpose_scanner.ts:162` — absent (a closed single-line block comment joins nothing) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::parse - a closed single-line block comment does not join the lines after it` — flipped, test went red
- `worker/deno/lib/simple_on_purpose_scanner.ts:164` — absent (no clause within the continuation cap, blank line or code → stays flagged) — `worker/deno/tests/simple_on_purpose_scanner_test.ts::parse - a clause-less marker stops at a blank comment line or code and stays flagged`, `::parse - a clause-less marker joins at most five continuation lines, however many follow` — covered by the named tests
- `worker/deno/lib/idle_task_backfill.ts` — success (new wrapper title rescued) — `worker/deno/tests/idle_task_backfill_test.ts::IDLE_TASK_WRAPPER_TITLES - allowlist contains exactly the twenty wrapper titles (Issues #2322, #2398, #2904, #2930, #3228, #3238, #3319, #3394, #3488, #3549, #3609, #664, #1597, #4027)` — table entry; dropping it fails the count and `includes` assertions
- `worker/deno/lib/issue_create_routing_check.ts` — success (template path allowlisted as not-yet-routed) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - creates the report in the target repo with the title and label` — exempt (untestable): a data-table entry consumed by the routing conformance gate, which runs in the quality gate rather than in a unit test; the existing `issue_create_routing_check` tests were searched and cover the check's mechanics, not individual entries

## Mutation check

The 13 surviving mutants are pinned by the new template tests:

- `simple_on_purpose_ledger_template.ts:184` (malformed view payload → `null`) — `worker/deno/tests/simple_on_purpose_ledger_template_test.ts::simple-on-purpose-ledger runTask - an unreadable open report fails loud and is not refreshed`
- `:228`–`:230` (`--repo`, repo, `--title` of the create call) — `::simple-on-purpose-ledger runTask - creates the report in the target repo with the title and label`
- `:255`–`:258` (`--repo`, repo, `--json`, `title,body` of the view call) — `::simple-on-purpose-ledger runTask - reads the open report from the target repo as title,body JSON`
- `:266` (prompt-load guard) — `::simple-on-purpose-ledger buildIssueBody - a prompt that fails to load throws naming the template`
- `:275` (footer `template`) — `::simple-on-purpose-ledger buildIssueBody - substitutes the footer with this template and run id`
- `:288` (`repo` of the wrapper veto) and `:290` (`context`) — `::simple-on-purpose-ledger shouldFile - vetoed by a fleet-authored wrapper in the same repo, allowed otherwise` and `::simple-on-purpose-ledger shouldFile - a malformed lookup is logged under the wrapper context`
- `:299` (`ensureLabelFn` call) — `::simple-on-purpose-ledger runTask - ensures the label exists in the target repo before filing`
