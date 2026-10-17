# Lifecycle ledger and attribution — milestone 105

## Summary

Record a stable issue assignment, each issue-agent attempt, and subsequent PR
maintenance in an append-only per-host ledger. Replayed events dedupe on read;
missing usage and prices remain unknown instead of looking like free work.

Closes #3751. Closes #3752. Closes #3753. Closes #3754. Closes #3755.
Closes #3756. Closes #3719. Closes #3720.

## Spec

### Intent and Rationale

- Join attempts and follow-on costs to one issue assignment across hosts,
  restarts and multiple PRs, without storing prompt text or account details.
- Reuse the foundation requested in the split #3718 issues, with the
  per-host assignment key and strict label validation their criteria require.
- Keep existing fleet counters, pricing tables and daily credit limits intact.

### Essential Design Decisions

- The issue marker contains only ID and cohort. Its trusted comment timestamp
  supplies assignment time. Read/post errors propagate; execute logs them and
  continues, recording later invocation attribution as unknown.
- Async-local context isolates concurrent claims. Each new claim receives a
  new run ID; explicit replay of the same ID/index dedupes. The single-spawn
  wrapper records retries, failures and timeouts before the retry ladder returns.
- API-equivalent costs reuse existing model attribution and prices. Unknown
  totals omit USD; unobservable additional model roles are explicitly
  `sub-agent (unattributed)`.
- PR creation and refresh carry the assignment marker. Follow-ons use PR,
  kind, durable cycle and attempt identity. Gate/outcome types are available
  for later writers; this milestone emits assignment, invocation and follow-on.

### Undiscoverable Facts

- Issues #3751–#3756 explicitly request lifting the unmerged #3718 foundation
  at `0d13c218`; its previous run-scoped assignment key needed correction.
- Marker syntax follows the repository's attribute-based HTML-comment grammar.
- Local GitHub CLI networking fails with `error connecting to api.github.com`
  even outside the sandbox. The connected GitHub API supplied live ruleset
  responses, which the unmodified `checkReleaseTagRuleset` comparison accepted
  with status `ok` and no findings.
- The schema is new on main. No persisted deployed ledger migration is needed.

## Evidence

Assignment/config/ledger tests exercise real writers and readers in temporary
directories. The execute-phase harness proves append-before-invocation ordering
and one error log on recording failure. Invocation tests exercise the real retry
runner with an agent stub; follow-on tests exercise both processor entry points.
Existing tier-counter assertions are retained.

The final focused runs passed 34 assignment/execute tests and 77 invocation,
follow-on, PR-refresh and tier-counter tests. A further invocation run passed all
7 tests, including the nested allowlist checks. Earlier ledger/config/redaction
checks passed with the foundation. Nineteen targeted mutations produced failing
tests in an isolated copy and were restored; the adjacent facts file records
the exact outcomes and test names. This is targeted mutation evidence, not a
claim of exhaustive mutation coverage.

Full quality validation passed completeness, formatting, lint, Markdown,
diagrams and type checking. The release-tag CLI check could not reach GitHub;
its live comparison passed through the connected API as described above.
Semgrep and config integration were reported skipped by the local gate.
The full unit pass stalled at the orphan-process rendezvous in
`claude_runner_killed_test.ts` even outside the sandbox. Its filtered test on
unchanged main also timed out after 45 seconds. No complete local unit-suite
pass is claimed; GitHub CI must establish that result before merge.

Docs sweep — grep: "lifecycle_ledger", "vibe-assignment", "subscription_allocation_label"; updated `docs/INTERNALS.md` and `docs/CONFIGURATION.md`; section: `docs/INTERNALS.md` → Lifecycle ledger and issue assignment, and `docs/CONFIGURATION.md` → issue-agent settings; siblings: "vibe-sub-agent-tier", "recordCiFixTierRun", "recordFeedbackTierRun" in the PR body and maintenance processors. `docs/INTERNALS.md:1021` remains true because existing tier counters retain their inputs and default. `worker/deno/lib/pr_body.ts:182` and `worker/deno/lib/pr_body.ts:218` remain true because the sibling tier marker is unchanged. The audit coverage record registers the four new library modules and anchors
`sweptAt` to the main-branch merge base, correcting the stale foundation
reference detected by CI.

## Test Plan

- `config_subscription_allocation_label_3718_test.ts`: accepted, absent,
  unknown-key registration and rejected labels.
- `lifecycle_ledger_test.ts` and `lifecycle_ledger_redaction_test.ts`: five-kind
  round trips, deterministic keys, duplicate reads, corrupt lines and refusals.
- `issue_assignment_test.ts` and `execute_phase_assignment_3718_test.ts`:
  trusted reuse, races, read/post/append failures, treatment and execution order.
- `lifecycle_invocation_3719_test.ts`: split prices, unknowns, concurrent claims,
  retries, failed/timed-out attempts, nested allowlists and replay.
- `lifecycle_follow_on_3720_test.ts`, `pr_body_sync_test.ts` and the existing
  CI/feedback tier-telemetry suites: marker preservation, two-PR attribution,
  cycle deduplication and unchanged counter assertions.
- Public ledger types, validation, writer and reader are the requested library
  interface; gate/outcome writers are deliberately outside milestone 105.

<!-- vibe-branch-outcomes -->
