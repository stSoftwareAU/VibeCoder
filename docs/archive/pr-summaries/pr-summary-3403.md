# PR Summary — Issue #3403

## Summary

Records the sub-agent tier (`sonnet` | `haiku`) each `issue`-phase run resolved,
so the Haiku trial (#3385) can be judged from fleet telemetry. Closes #3403.

- `fleet_telemetry.ts`: `IssuePhaseRun` carries a required `subAgentTier`.
  `IssuePhaseCounters` gains `issuePhaseSonnetRuns/Usd` and
  `issuePhaseHaikuRuns/Usd`, and `recordIssuePhaseRun` moves only the resolved
  tier's pair. `formatFleetSummary` adds
  `issue_tier_runs=sonnet=N,haiku=M issue_tier_usd=…` right after
  `issue_duration`, but only once a `haiku` run has been recorded, so a
  sonnet-only line is byte-identical to before.
- `fleet_telemetry_sidecar.ts`: the four counters are summed by
  `mergeCumulative`. A sidecar written before the split loads its runs and
  spend as `sonnet` (`max(0, runs − haiku)`), with no schema bump. A stored,
  finite sonnet value is read as stored.
- `measureIssuePhaseRun` passes the tier through. Both callers
  (`completion_phase.ts`, `handle_no_changes_phase.ts`) resolve it with
  `resolveIssueSubAgentTier`, so the `repo_config` override wins.
- PR body: `assemblePrBody` appends `<!-- vibe-sub-agent-tier: <tier> -->`
  after the summary-digest marker. Any copy of the marker quoted in the summary
  has its comment delimiters stripped first, so the body has exactly one real
  marker. `syncPrBodyFromSummary` carries over the marker the live body has. A
  legacy body with no marker gets none added.
- The branch also carries a cherry-pick of #3401's `issue_sub_agent_tier`
  resolver (`b022d265`). It is on `main` but not yet on the milestone branch,
  and this work consumes it.

## Evidence

Backend only, no UI file touched.

**Docs sweep** — grep: `issue_sub_agent_tier`, `vibe-sub-agent-tier`, `issue_tier_runs`, `issue_tier_usd`, `issue_usd`, `IssuePhaseCounters`, `recordIssuePhaseRun`, `measureIssuePhaseRun`, `assemblePrBody`, "hidden marker", "not read yet" over `README.md`, `*/README.md` and `docs/` (excluding `docs/archive/`, `docs/audits/`); section: `docs/INTERNALS.md#-fleet-telemetry--idle-blocked-and-success-rate-issue-855` (already documents the tier tokens), `docs/USAGE.md` PR-summary paragraph (the PR body's hidden markers), and the host and `repo_config` tables in `docs/CONFIGURATION.md`; updated: `docs/CONFIGURATION.md:453` and `:4488` ("Accepted and validated, but not read yet" was made false by this change; they now say the tier is read for telemetry and the PR-body marker, while executors still stay on Sonnet until #3402), `docs/USAGE.md` (names the tier marker beside the digest marker and says a re-sync carries it over). Hits read and still true: `docs/INTERNALS.md:369`, `docs/workflows/issue-processing.md:1048` (`assemblePrBody`'s `missing`-criterion behaviour, unchanged), and the digest-marker sentences in `docs/workflows/pr-feedback.md:205` and `docs/workflows/merge-conflicts.md:210`.

## Test Plan

- From `worker/deno`: `deno task test:unit` over the 12 touched test files (`fleet_telemetry_test.ts`, `fleet_telemetry_sidecar_test.ts`, `fleet_telemetry_redaction_test.ts`, `pr_body_test.ts`, `pr_body_sync_test.ts`, `issue_run_stats_comment_test.ts`, `completion_phase_run_stats_test.ts`, `completion_phase_evidence_urls_test.ts`, `handle_no_changes_phase_test.ts`, `issue_sub_agent_tier_test.ts`, `missing_criterion_close_guard_3177_test.ts`, `config_docs_consistency_test.ts`) → 301 passed, 0 failed at head `1716e3e8`. After the added sidecar test, the three telemetry files → 63 passed, 0 failed.
- Added `worker/deno/tests/fleet_telemetry_sidecar_test.ts::fleet_telemetry_sidecar - a sidecar carrying the tier split keeps its stored sonnet figures` so the stored-value arm of the sidecar backfill is reached (below).
- `measureIssuePhaseRun` now requires `subAgentTier` (#3403: every recorded run carries its resolved tier), so the old call shape no longer type-checks. Each assertion below was rewritten in place with `subAgentTier: "sonnet"` added and the same expected value; none was dropped:
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "grill_me", claudeResults: [claudeResult(["claude-opus-5"])], }), undefined, );` — #3403 makes `subAgentTier` required; re-added in the same test with `subAgentTier: "sonnet"`
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "issue", claudeResults: [{}] }), undefined, );` — #3403 makes `subAgentTier` required; re-added in the same test with `subAgentTier: "sonnet"`
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "issue", claudeResults: [] }), undefined, );` — #3403 makes `subAgentTier` required; re-added in the same test with `subAgentTier: "sonnet"`
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "issue", claudeResults, qualityGate: { status: "passed", attempt: 2 }, })?.gatePassedOnAttempt, 2, );` — #3403 makes `subAgentTier` required; re-added in the same test with `subAgentTier: "sonnet"`
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "issue", claudeResults, qualityGate: { status: "failed" }, })?.gatePassedOnAttempt, undefined, );` — #3403 makes `subAgentTier` required; re-added in the same test with `subAgentTier: "sonnet"`
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "issue", claudeResults }) ?.gatePassedOnAttempt, undefined, );` — #3403 makes `subAgentTier` required; re-added in the same test with `subAgentTier: "sonnet"`

**Branch outcomes:**
- `worker/deno/lib/fleet_telemetry.ts:544` — `sonnet` run moves only the sonnet pair — `worker/deno/tests/fleet_telemetry_test.ts::fleet_telemetry - a sonnet run moves only the sonnet counters` — flipped runs and USD to the haiku pair, test went red
- `worker/deno/lib/fleet_telemetry.ts:548` — `haiku` run moves only the haiku pair — `worker/deno/tests/fleet_telemetry_test.ts::fleet_telemetry - a haiku run moves only the haiku counters` — flipped runs and USD to the sonnet pair, test went red
- `worker/deno/lib/fleet_telemetry.ts:683` — no haiku run recorded → no tier tokens — `worker/deno/tests/fleet_telemetry_test.ts::fleet_telemetry - a sonnet-only fleet's summary is byte-identical to today's` — flipped to always shown, test went red
- `worker/deno/lib/fleet_telemetry.ts:683` — haiku run recorded → tier tokens after `issue_duration` — `worker/deno/tests/fleet_telemetry_test.ts::fleet_telemetry - a haiku run adds the tier tokens right after issue_duration` — flipped to never shown, test went red
- `worker/deno/lib/fleet_telemetry_sidecar.ts:157` — absent sonnet runs (legacy file) → backfilled `runs − haiku` — `worker/deno/tests/fleet_telemetry_sidecar_test.ts::fleet_telemetry_sidecar - a legacy sidecar (pre-split) loads its runs and spend as sonnet` — flipped backfill to 0, test went red
- `worker/deno/lib/fleet_telemetry_sidecar.ts:161` — absent sonnet USD (legacy file) → backfilled `usd − haiku usd` — `worker/deno/tests/fleet_telemetry_sidecar_test.ts::fleet_telemetry_sidecar - a legacy sidecar (pre-split) loads its runs and spend as sonnet` — flipped backfill to 0, test went red
- `worker/deno/lib/fleet_telemetry_sidecar.ts:155` — stored finite sonnet runs read as stored — `worker/deno/tests/fleet_telemetry_sidecar_test.ts::fleet_telemetry_sidecar - a sidecar carrying the tier split keeps its stored sonnet figures` — flipped to always backfill, test went red
- `worker/deno/lib/fleet_telemetry_sidecar.ts:159` — stored finite sonnet USD read as stored — `worker/deno/tests/fleet_telemetry_sidecar_test.ts::fleet_telemetry_sidecar - a sidecar carrying the tier split keeps its stored sonnet figures` — flipped to always backfill, test went red
- `worker/deno/lib/pr_body.ts:210` — unrecognised tier in a marker → skipped — `worker/deno/tests/pr_body_test.ts::pr_body - subAgentTierFromBody skips an occurrence naming an unknown tier` — flipped to accept any tier, test went red
- `worker/deno/lib/pr_body.ts:210` — several markers → last recognised wins — `worker/deno/tests/pr_body_test.ts::pr_body - subAgentTierFromBody reads the last occurrence` — flipped to first, test went red
- `worker/deno/lib/pr_body.ts:231` — quoted marker neutralised — `worker/deno/tests/pr_body_sync_test.ts::assemblePrBody - carries exactly one tier marker, even when the summary quotes a different one` — flipped to a no-op, test went red
- `worker/deno/lib/pr_body_sync.ts:166` — tier defined → one marker appended — `worker/deno/tests/completion_phase_evidence_urls_test.ts::completion - a host configured for haiku stamps exactly one haiku tier marker on the PR (Issue #3403)` — flipped to never append, test went red
- `worker/deno/lib/pr_body_sync.ts:166` — tier undefined (legacy body) → no marker — `worker/deno/tests/pr_body_sync_test.ts::assemblePrBody - carries no tier marker when subAgentTier is undefined`, `worker/deno/tests/pr_body_sync_test.ts::sync - a legacy body with no tier marker gets none added (Issue #3403)` — flipped to always append, tests went red
- `worker/deno/lib/pr_body_sync.ts:564` — live body's tier carried over on sync — `worker/deno/tests/pr_body_sync_test.ts::sync - a live body carrying the haiku tier marker rebuilds with exactly one haiku marker (Issue #3403)` — flipped to `undefined`, test went red
- `worker/deno/lib/phases/completion_phase.ts:1146` — resolved tier recorded on the run — `worker/deno/tests/completion_phase_run_stats_test.ts::completion - records the resolved sub-agent tier (Issue #3403)` — forced to `sonnet`, test went red
- `worker/deno/lib/phases/completion_phase.ts:1957` — `repo_config` tier wins on the PR body — `worker/deno/tests/completion_phase_evidence_urls_test.ts::completion - a repo_config override wins over the host-wide tier (Issue #3403)` — dropped the repo entry, test went red
- `worker/deno/lib/phases/handle_no_changes_phase.ts:323` — resolved tier recorded on the no-changes run — `worker/deno/tests/handle_no_changes_phase_test.ts::handle_no_changes_phase - records the resolved sub-agent tier (Issue #3403)` — forced to `sonnet`, test went red
- `worker/deno/lib/issue_sub_agent_tier.ts:44` (#3401 cherry-pick) — host unset → `sonnet` — `worker/deno/tests/issue_sub_agent_tier_test.ts::issue_sub_agent_tier - resolveHostIssueSubAgentTier: undefined resolves to sonnet without warning` — flipped to `haiku`, test went red
- `worker/deno/lib/issue_sub_agent_tier.ts:45` — valid host value returned — `worker/deno/tests/issue_sub_agent_tier_test.ts::issue_sub_agent_tier - resolveHostIssueSubAgentTier: haiku resolves to haiku` — flipped to the default, test went red
- `worker/deno/lib/issue_sub_agent_tier.ts:47-53` — invalid host value warns, default used — `worker/deno/tests/issue_sub_agent_tier_test.ts::issue_sub_agent_tier - an invalid host value falls back to the default` — removed the warning, test went red
- `worker/deno/lib/issue_sub_agent_tier.ts:80` — repo unset → host tier — `worker/deno/tests/issue_sub_agent_tier_test.ts::issue_sub_agent_tier - host haiku, repo unset or empty resolves to haiku` — flipped to `sonnet`, test went red
- `worker/deno/lib/issue_sub_agent_tier.ts:81` — valid repo value wins — `worker/deno/tests/issue_sub_agent_tier_test.ts::issue_sub_agent_tier - a valid repo value beats the host-wide value` — flipped to the host tier, test went red
- `worker/deno/lib/issue_sub_agent_tier.ts:83-89` — invalid repo value warns, host tier used — `worker/deno/tests/issue_sub_agent_tier_test.ts::issue_sub_agent_tier - an invalid repo value is refused loudly` — removed the warning, test went red
- `worker/deno/lib/config.ts:215` — repo key mapped — `worker/deno/tests/issue_sub_agent_tier_test.ts::issue_sub_agent_tier - loadConfig end-to-end resolves host and repo overrides` — removed the entry, test went red
- `worker/deno/lib/config_unknown_keys.ts:81` — key recognised — `worker/deno/tests/issue_sub_agent_tier_test.ts::issue_sub_agent_tier - is a recognised config key` — removed it, test went red

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A haiku issue run increments only the haiku counters; a sonnet run only the sonnet counters. — evidence: `worker/deno/tests/fleet telemetry test.ts::fleet telemetry - a haiku run moves only the haiku counters; worker/deno/tests/fleet telemetry test.ts::fleet telemetry - a sonnet run moves only the sonnet counters` — reviewer: met
- **met** — A sidecar file written before this change loads without error and counts as sonnet. — evidence: `worker/deno/tests/fleet telemetry sidecar test.ts::fleet telemetry sidecar - a legacy sidecar (pre-split) loads its runs and spend as sonnet` — reviewer: met
- **met** — A sonnet-only fleet summary is byte-identical to today's. — evidence: `worker/deno/tests/fleet telemetry test.ts::fleet telemetry - a sonnet-only fleet's summary is byte-identical to today's` — reviewer: met
- **met** — A PR opened by an issue run carries exactly one vibe-sub-agent-tier marker matching the run's tier. — evidence: `worker/deno/tests/completion phase evidence urls test.ts::completion - a host configured for haiku stamps exactly one haiku tier marker on the PR (Issue #3403); worker/deno/tests/pr body sync test.ts::assemblePrBody - carries exactly one tier marker, even when the summary quotes a different one` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Unit tests, Fast: a test asserts an absolute wall-clock threshold (Issue #786), and its own comment says there is no wall-clock threshold — evidence: `worker/deno/tests/pr body test.ts:290` — reason: not fixed: this line is added by this diff and still asserts elapsedMs < 5 000 ; this no-code turn cannot remove it, so a code-change pass must drop the assertion and keep assertEquals(result, undefined)
- **violation** — A Code Change Owes a Docs Change: the OPERATIONAL DEFAULTS.issueSubAgentTier JSDoc still says the key is "not read yet", but this diff now reads it for telemetry and the PR tier marker — evidence: `worker/deno/lib/config defaults.ts:484` — reason: not fixed: this JSDoc is added by this diff and still says "not read yet"; this no-code turn cannot edit it, so a code-change pass must update it to say the tier now drives the per-tier telemetry and the PR tier marker
- **clean** — Australian English (neutralise), TDD coverage for each criterion, legacy-sidecar backward compatibility, ReDoS-safe marker parsing, fail-loud tier validation, docs/CONFIGURATION.md rows updated
