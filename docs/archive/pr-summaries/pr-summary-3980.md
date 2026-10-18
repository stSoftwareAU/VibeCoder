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

- The reproducible report, source snapshot, empty collection placeholder and
  eight-day comparable follow-up procedure are recorded in
  `docs/evidence/stabilisation-2026-10-18.md` and its adjacent JSON files.
- The checked-in report is byte-identical to the real CLI output for that
  snapshot. It preserves unknown cost, actual build/role gaps and safeguard
  measurements; no synthetic activity is presented as live fleet evidence.
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
- **clean** — Independent source/baseline review checked reuse, KISS/DRY, actual producer shapes, truthful evidence, named tests, unknown costs, preserved model roles and merge/security gates. Final evidence review is pending before PR creation.

## Test Plan

- Test-first assertion failures covered core reconciliation, real producer
  shapes, retry/roll-up history, safeguard provenance and missing targets before
  their fixes; failures were assertions, not missing imports or compiler errors.
- The report suite passes 28 tests; it and the existing lifecycle reconciliation
  and outcome suites pass 56 tests in total with type checking enabled.
- All 98 enumerated new decisions and logical operands were independently
  mutated. Each produced an actual AssertionError in its named test and was
  restored before the passing run. AND operands were neutralised to true and
  OR operands to false so other operands could not mask their requirement.
- CLI tests use actual temporary ledger/snapshot files and the real Deno entry
  point, including malformed-input exit status. They do not grep source code.
- There are no removed assertions from existing tests. Full local quality
  validation remains pending; no deployment or fleet saving is claimed.

<!-- vibe-branch-outcomes -->
