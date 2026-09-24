# Give the best-practices scan a cost, speed and reliability lens (Issue #2579)

## Summary

Closes #2579.

The daily best-practices scan reviewed almost entirely for correctness,
security and hygiene, and its 6-finding cap meant a cost or reliability
finding rarely survived even where a bucket noticed one. This change:

1. Adds a `## Cost, speed and reliability` section to the
   `aws-cloudformation`, `terraform`, `rust`, `typescript`, `react`, `java`
   and `general` bucket guides. Every check is concrete and cited from source,
   states its estimated effect and risk, and gives a stable id title. Checks
   are appended at the end of each guide so no existing check is renumbered.
2. Adds Phase 3 rule 7: one of the 6 slots is reserved for such a finding
   when one survives, below `severity:high`. The Deno capper models the same
   rule through a `costSpeedReliability` flag.
3. Shows `**Estimated effect:** … (estimated)` and `**Risk:** …` in the
   Phase 4 body-template annotations.
4. Adds a small deterministic pre-scan, `cfn_cost_checks.ts`, for the two
   mechanical CloudFormation checks (Lambda not on arm64, Lambda logs with no
   retention). An `aws-cloudformation` run lists its hits under
   `## Deterministic pre-scan candidates` for Claude to confirm and triage; it
   files nothing itself.

Additions to `prompt.md` are one triage rule and one annotation bullet, to stay
out of #2574's way.

### Checks added per bucket

| Bucket | Checks |
| ------ | ------ |
| `aws-cloudformation` | 9 Lambda on x86_64 · 10 memory/timeout sizing · 11 log retention · 12 provisioned capacity without scaling · 13 always-on non-prod resources · 14 S3 lifecycle rules · 15 no failure alarm / DLQ |
| `terraform` | 10–16: the same seven, with Terraform resource names |
| `rust` | 33 Lambda release profile (`strip`; `lto`/`codegen-units` fold into 27) · 34 serial awaits · 35 HTTP client timeout / per-call construction · 36 unbounded growth |
| `typescript` | 29 serial awaits · 30 N+1 fetches · 31 timeouts and unsafe retries · 32 unbounded cache · 33 browser bundle size |
| `react` | 15 request waterfalls · 16 N+1 list-item fetches · 17 fetch without timeout · 18 bundle size / eager loading |
| `java` | 14 serial remote calls · 15 JPA N+1 · 16 HTTP client timeouts and retries · 17 unbounded cache |
| `general` | 20 external calls without timeout · 21 retries without backoff or idempotency · 22 polling that could be event-driven · 23 work repeated per request |

## Acceptance Criteria

- **met** — The seven bucket guides each carry a "Cost, speed and reliability" section with concrete checks and stable id recipes; the numbering and docs checks pass — evidence: `worker/deno/tests/best_practices_cost_speed_reliability_test.ts` (`<bucket> guide carries a cost, speed and reliability section with id-reciped checks`, plus a negative control per bucket); `bucket_check_numbering_test.ts` and `bucket_docs_test.ts` pass
- **met** — Phase 3 reserves 1 of the 6 slots for such a finding below `severity:high`, pinned by a prompt test — evidence: `Phase 3 reserves one of the six slots …` and its negative control; `best_practices_capper_test.ts` reserved-slot cases (takes the slot from medium surplus, never displaces `severity:high`, only one slot)
- **met** — Each finding body carries an estimated effect and a stated risk; the template shows both — evidence: every guide check states `Effect:` and `Risk:`; `the Phase 4 body template shows an estimated effect and a risk line` and its negative control
- **met** — `docs/BEST-PRACTICES-SCAN.md` documents the check family and the reserved slot — evidence: new `### Cost, speed and reliability` section and the reserved-slot paragraph under `## 6-issue cap and priority order`; `the operator manual documents the check family and the reserved slot`
- **met** — Regression check: a 3008 MB x86 Lambda with no log retention yields both findings; arm64 with retention yields neither; existing bucket tests unchanged — evidence: `worker/deno/tests/cfn_cost_checks_test.ts` (YAML and CDK-style JSON, both directions); `runTask - aws-cloudformation run passes the CloudFormation cost pre-scan` / `typescript run skips …`; no existing test was edited
- **missing** — After merge, raise the best-practices scan on the monitored repos and link the findings on the issue — reason: a post-merge operator step (`raise-single-idle-task`, see `docs/IDLE-TASK-FRAMEWORK.md`); it cannot run before the guides are on `main`

## Test Plan

- New tests written first and observed failing (type errors on the missing
  exports, then assertion failures on the prose) before the implementation.
- Every test file referencing the touched modules, guides and docs: 32 files,
  704 passed, 0 failed; plus the documentation-drift, markdown-table,
  idle-task-template and prompt-policy suites: 64 passed.
- `lib_sweep_coverage_test.ts` with the top-up-2579 slice and
  `docs/audits/security-sweep-2579-cfn-cost-checks.md`.
- `deno fmt`, `deno lint`, `deno check` on the changed TypeScript and
  `markdownlint-cli2` on the changed Markdown: clean. The full `./quality.sh`
  is left to CI.
