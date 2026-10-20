## Summary

Closes #3980.

The read-only `stabilisation-report` task reports unique accepted issues delivered
to the default branch and their observed full rework cost using the existing
lifecycle ledger. Pending, failed, milestone-only and missing-evidence work stay
visible. The historical baseline and comparable follow-up procedure state the
missing live evidence explicitly; they establish no fleet improvement or winner.

## Spec

### Intent and Rationale

- Make delivery and the cost of all observed work visible without treating PR
  counts, relabelled failures, synthetic fixtures or unknown costs as success.

### Essential Design Decisions

- Reuse ledger reading, cutoff/deduplication, gated outcome classification and
  cost reconciliation. Operator snapshots supply acceptance, actual target and
  declared causes missing from schema-1 events; no new classifier or store.
- Select the active issue cohort in an explicit window, retain its full supplied
  history through the cutoff, and join follow-ons through their assignment IDs.
  An observed tracking roll-up can connect old child work to default delivery.
- Report actual recorded builds and all three role slots, keeping absent data
  null. Preserve every supplied structured category, including simultaneous
  causes. Review polling identifies blocking heads; full review rounds remain
  unknown because the ledger does not record review IDs.
- Keep net benefit, comparative winner and failure rate unknown without the
  required provenance. The manual command changes no model routing, gate,
  subscription or allocation policy.

### Undiscoverable Facts

- #3644's ledger and reporting facilities are merged. The separate #3645
  experiment prerequisite was cancelled; this report does not recreate it.
- No live host ledgers or deployed-build receipts were available for this
  baseline. Its empty ledger means missing collection, not zero fleet activity.
- The public #3690 selected corpus reported zero identical-sync repeats and
  zero expected reduction. This is no observed benefit in that corpus, with
  unknown check/time cost and net benefit.

## Evidence

- #3980: Measure stabilization by default-branch delivery and full rework cost using the existing lifecycle ledger
- #3644: Record end-to-end issue lifecycle, cohort attribution and fully loaded cost
- #3645: Run randomized fleet experiments and report merged issues per dollar
- #3690: Quantify and reduce avoidable milestone sync/conflict PR cycles without bypassing branch protection
- #3976: Prevent recurring branch-only sweptAt records at the audit-record producer
- #3977: Reconcile already-merged work before push recovery and failure labelling
- #3978: Stop formatting-only failures escaping the existing formatter-before-gate path
- #3979: Render Branch outcomes once from existing facts and remove duplicate summary evidence maintenance
- #3738: Fleet PRs add failure paths whose git or network errors classify as the branch's fault, so an outage uses a ladder attempt (VibeCoder#3095, #3716)
- #3954: Generate version-bump summaries that stay correct after CI auto-bumps
- #3910: Milestone completion raises an empty roll-up PR when the milestone branch is ahead only by main-sync merge commits
- #3961: Keep pending required CI and clean code review out of partial-delivery follow-ups

- The reproducible report, source snapshot, empty collection placeholder and
  eight-day comparable follow-up procedure are recorded in
  `docs/evidence/stabilisation-2026-10-18.md` and its adjacent JSON files.
- The checked-in report is byte-identical to the real CLI output for that
  snapshot. It preserves unknown cost, actual build/role gaps and safeguard
  measurements; no synthetic activity is presented as live fleet evidence.
- The first full gate exposed a missing CLI console-redaction installation and unregistered module coverage. Both are repaired using the existing shared hook and `recordSweepTopUp` producer; its claimed top-up records the actual default merge-base `60392646`, never a feature-only commit. The report plus both formerly failing checks pass 30 focused tests. All 98 facts now match current source and actual named assertion failures. The full rerun passed at `6776ab1a67468f71b4cdad7d87715aeafd91881b` on 2026-10-18: both unit passes, type checking, lint, formatting, completeness, documentation and security checks passed. Optional local configuration integration was skipped because this workspace has no `.config.json`.
- Docs sweep — grep: "improvement", "stabilisation", "lifecycle"; updated `.claude/skills/review-fleet-prs/SKILL.md`, `docs/MODEL-AND-CACHING.md` and the baseline manual; section: MODEL-AND-CACHING lifecycle reporting and review-fleet-prs principle 7; siblings: none — no existing routing, role, allocation or configuration set gained a member.


## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A reproducible report uses existing lifecycle/reporting facilities and gives its window, coverage and missing data. — evidence: `worker/deno/lib/stabilisation_report_cli.ts`, `worker/deno/lib/stabilisation_report.ts` and the baseline reproduction command. — reviewer: met
- **met** — Fixtures include failed/retried/pending work, milestone-then-default delivery and multiple PRs for one issue; successes and spend are not double-counted. — evidence: `worker/deno/tests/stabilisation_report_test.ts` exercises replay, producer-shaped follow-ons, old child roll-ups, retries, independent repository/PR proof and the cutoff. — reviewer: met
- **met** — A no-observed-benefit safeguard is reported as such; incomplete evidence cannot yield a winner or a claimed improvement. — evidence: observed zero and positive preventions, unknown observations and synthetic controls in `worker/deno/tests/stabilisation_report_test.ts`; the baseline keeps net benefit unknown. — reviewer: met
- **met** — A reviewed baseline and comparable follow-up procedure are recorded. State unavailable live evidence honestly without pretending a synthetic run proves fleet improvement. — evidence: `docs/evidence/stabilisation-2026-10-18.md`, its source snapshot/report and independent baseline review. — reviewer: met
- **met** — Sonnet manager / Haiku worker and the separate model experiment are unchanged. — evidence: read-only reporting consumes actual treatment records without editing routing, allocation or experiments. — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Redundant kind and cutoff tests obscured independently meaningful report decisions — evidence: `worker/deno/lib/stabilisation_report.ts` — reason: fixed by reusing schema-exclusive fields and matched receipts; tests retain old-child cost when target evidence is absent.
- **violation** — Missing target names and malformed safeguard provenance could be misrepresented — evidence: `worker/deno/lib/stabilisation_report.ts` and `worker/deno/lib/stabilisation_report_cli.ts` — reason: fixed with independent target/provenance controls; missing measurements remain null and equivalent merge instants compare correctly.
- **violation** — The new CLI omitted shared console redaction and the new modules lacked sweep registration — evidence: `worker/deno/lib/stabilisation_report_cli.ts:61` and `docs/audits/lib-sweep-coverage/top-up-3980.json` — reason: fixed using existing owners; actual CLI output is masked, the coverage and entry-point invariants pass, and omitting the hook makes the real CLI regression fail with AssertionError.
- **clean** — Independent source/baseline review checked reuse, KISS/DRY, actual producer shapes, truthful evidence, named tests, unknown costs, preserved model roles and merge/security gates. Final review independently verified all 98 current-source mutation records, named assertion failures and facts mappings; both final independent source reviews found no remaining material findings after the integration repairs.

## Test Plan

- Test-first assertion failures covered core reconciliation, real producer
  shapes, retry/roll-up history, safeguard provenance and missing targets before
  their fixes; failures were assertions, not missing imports or compiler errors.
- The integrated report, lifecycle reconciliation/outcome and two repaired
  invariant suites pass 103 tests with type checking enabled. The report itself
  retains 28 tests. After merging main `7bd0d619`, the same 103 tests pass again
  with type checking enabled. The manifest task also passes: 687 tests, one
  existing ignored.
- All 98 enumerated new decisions and logical operands were independently
  mutated. Each produced an actual AssertionError in its named test and was
  restored before the passing run. AND operands were neutralised to true and
  OR operands to false so other operands could not mask their requirement.
- CLI tests use actual temporary ledger/snapshot files and the real Deno entry
  point, including malformed-input exit status. They do not grep source code.
- There are no removed assertions from existing tests. Full local quality
  validation passed at the commit recorded above; no deployment or fleet saving
  is claimed.

<!-- vibe-branch-outcomes -->
