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
- PR body: `assemblePrBody` appends `<!-- vibe-sub-agent-tier tier="<tier>" -->`
  after the summary-digest marker. Any copy of the marker quoted in the summary
  has its comment delimiters stripped first, so the body has exactly one real
  marker. `syncPrBodyFromSummary` carries over the marker the live body has. A
  legacy body with no marker gets none added.
- The branch also carries a cherry-pick of #3401's `issue_sub_agent_tier`
  resolver (`b022d265`). It is on `main` but not yet on the milestone branch,
  and this work consumes it.

## Spec

### Intent and Rationale

- The Haiku trial (#3385) is judged by outcome per dollar, so each issue run's tier must be counted beside its spend and stamped on the PR for later outcome attribution
- The counters are additive pairs beside the existing totals, so no reader of the totals changes

### Essential Design Decisions

- `subAgentTier` is required on `IssuePhaseRun`, `measureIssuePhaseRun` and `assemblePrBody`, so a new caller cannot silently drop the tier
- The tier tokens print only after a `haiku` run, which keeps a sonnet-only summary line byte-identical
- The sidecar reads the old shape (sonnet = runs − haiku) rather than bumping the schema key, so a legacy file keeps its history

### Undiscoverable Facts

- #3401's resolver is on `main` but not on this milestone branch, so the branch carries a cherry-pick of `b022d265`
- #3402 (tier-aware executors) merged into a different milestone branch, so on this branch the executors still run on Sonnet whatever the tier is set to

## Evidence

Backend only, no UI file touched.

**Docs sweep** — grep: `issue_sub_agent_tier`, `vibe-sub-agent-tier`, `issue_tier_runs`, `issue_tier_usd`, `issue_usd`, `IssuePhaseCounters`, `recordIssuePhaseRun`, `measureIssuePhaseRun`, `assemblePrBody`, "hidden marker", "not read yet" over `README.md`, `*/README.md` and `docs/` (excluding `docs/archive/`, `docs/audits/`); section: `docs/INTERNALS.md#-fleet-telemetry--idle-blocked-and-success-rate-issue-855` (already documents the tier tokens), `docs/USAGE.md` PR-summary paragraph (the PR body's hidden markers), and the host and `repo_config` tables in `docs/CONFIGURATION.md`; updated: `docs/CONFIGURATION.md:453` and `:4488` ("Accepted and validated, but not read yet" was made false by this change; they now say the tier is read for telemetry and the PR-body marker, while executors still stay on Sonnet whatever it is set to); `worker/deno/lib/config_defaults.ts` `issueSubAgentTier` JSDoc rewritten the same way, `docs/USAGE.md` (names the tier marker beside the digest marker and says a re-sync carries it over). Hits read and still true: `docs/INTERNALS.md:369`, `docs/workflows/issue-processing.md:1048` (`assemblePrBody`'s `missing`-criterion behaviour, unchanged), and the digest-marker sentences in `docs/workflows/pr-feedback.md:205` and `docs/workflows/merge-conflicts.md:210`.

## Test Plan

- `measureIssuePhaseRun` now requires `subAgentTier` (#3403), so each assertion below was rewritten in place with `subAgentTier: "sonnet"` added and the same expected value; none was dropped:
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "grill_me", claudeResults: [claudeResult(["claude-opus-5"])], }), undefined, );` — re-added in the same test with `subAgentTier: "sonnet"`
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "issue", claudeResults: [{}] }), undefined, );` — re-added in the same test with `subAgentTier: "sonnet"`
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "issue", claudeResults: [] }), undefined, );` — re-added in the same test with `subAgentTier: "sonnet"`
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "issue", claudeResults, qualityGate: { status: "passed", attempt: 2 }, })?.gatePassedOnAttempt, 2, );` — re-added in the same test with `subAgentTier: "sonnet"`
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "issue", claudeResults, qualityGate: { status: "failed" }, })?.gatePassedOnAttempt, undefined, );` — re-added in the same test with `subAgentTier: "sonnet"`
  - Removed from `worker/deno/tests/issue_run_stats_comment_test.ts`: `assertEquals( measureIssuePhaseRun({ phase: "issue", claudeResults }) ?.gatePassedOnAttempt, undefined, );` — re-added in the same test with `subAgentTier: "sonnet"`
- (The removed-assertion lines sit first because the gate reads only the first 2,000 canonical characters of the Test Plan — #3438.)

- From `worker/deno`: `deno task test:unit` over the 12 touched test files (`fleet_telemetry_test.ts`, `fleet_telemetry_sidecar_test.ts`, `fleet_telemetry_redaction_test.ts`, `pr_body_test.ts`, `pr_body_sync_test.ts`, `issue_run_stats_comment_test.ts`, `completion_phase_run_stats_test.ts`, `completion_phase_evidence_urls_test.ts`, `handle_no_changes_phase_test.ts`, `issue_sub_agent_tier_test.ts`, `missing_criterion_close_guard_3177_test.ts`, `config_docs_consistency_test.ts`) → 302 passed, 0 failed at head `575c79a2`. After the added sidecar test, the three telemetry files → 63 passed, 0 failed.
- Added `worker/deno/tests/fleet_telemetry_sidecar_test.ts::fleet_telemetry_sidecar - a sidecar carrying the tier split keeps its stored sonnet figures` so the stored-value arm of the sidecar backfill is reached (below).

- `worker/deno/tests/pr_body_test.ts::pr_body - subAgentTierFromBody stays linear on an unterminated hostile marker prefix` replaces the earlier wall-clock (`elapsedMs < 5_000`) version with the `assertLinearGrowth` ratio helper; it pins current behaviour (the regex is already linear), so it is expected green on base of the change.

- `./quality.sh` was started on head `575c79a2` and killed by its 900s timeout (exit 143) during the parallel `deno test` stage, while another worker's full suite shared the host's CPU, so it gave no verdict. Instead, `deno fmt --check`, `deno lint` and `deno check` over the 24 changed `.ts` files and `markdownlint-cli2` all passed.

<!-- vibe-quality-gate-skipped reason="full gate timed out at 900s under host contention; fast checks passed; CI and the worker's pre-PR gate run the full suite" -->

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

- **met** — A `haiku` issue run increments only the haiku counters; a `sonnet` run only the sonnet counters. — evidence: `worker/deno/tests/fleet_telemetry_test.ts::fleet_telemetry - a haiku run moves only the haiku counters`, `worker/deno/tests/fleet_telemetry_test.ts::fleet_telemetry - a sonnet run moves only the sonnet counters` — reviewer: met
- **met** — A sidecar file written before this change loads without error and counts as sonnet. — evidence: `worker/deno/tests/fleet_telemetry_sidecar_test.ts::fleet_telemetry_sidecar - a legacy sidecar (pre-split) loads its runs and spend as sonnet` — reviewer: met
- **met** — A sonnet-only fleet summary is byte-identical to today's. — evidence: `worker/deno/tests/fleet_telemetry_test.ts::fleet_telemetry - a sonnet-only fleet's summary is byte-identical to today's` — reviewer: met
- **met** — A PR opened by an issue run carries exactly one `vibe-sub-agent-tier` marker matching the run's tier. — evidence: `worker/deno/tests/completion_phase_evidence_urls_test.ts::completion - a host configured for haiku stamps exactly one haiku tier marker on the PR (Issue #3403)`, `worker/deno/tests/pr_body_sync_test.ts::assemblePrBody - carries exactly one tier marker, even when the summary quotes a different one` — reviewer: met
- **unrequested** — the `issue_sub_agent_tier` config key and resolver (`issue_sub_agent_tier.ts`, `types.ts`, `config.ts`, `config_defaults.ts`, `config_unknown_keys.ts`, `validation.ts`, `issue_sub_agent_tier_test.ts`) — reviewer: unrequested — reason: cherry-pick of #3401 (merged to `main`, not yet on this milestone branch); this issue consumes it
- **unrequested** — `docs/audits/lib-sweep-coverage/top-up-3401.json` — reviewer: unrequested — reason: the coverage-ledger entry that came with the #3401 cherry-pick
- **unrequested** — the `issue_sub_agent_tier` rows in `docs/CONFIGURATION.md` — reviewer: unrequested — reason: they arrived with #3401; this diff only rewrites them so they no longer say the key is unread
- **unrequested** — `subAgentTierFromBody` and the marker carry-over in `syncPrBodyFromSummary` — reviewer: unrequested — reason: a later summary re-sync rebuilds the body, and without the carry-over it would drop the marker, breaking "exactly one … matching the run's tier"
- **unrequested** — `neutraliseSubAgentTierMarkers` applied to summary text in `assemblePrBody` — reviewer: unrequested — reason: a summary quoting the marker would otherwise give the PR body two markers, breaking "exactly one"
- **unrequested** — the `assertLinearGrowth` hostile-input test in `pr_body_test.ts` — reviewer: unrequested — reason: the standards require a hostile case for each new regex on agent-written text, here the marker regex in `subAgentTierFromBody`
- **unrequested** — `assemblePrBody`'s required (possibly `undefined`) `subAgentTier` parameter and the test edits it forces — reviewer: unrequested — reason: required on purpose so no caller silently drops the tier (standards: no behaviour-off default)

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Unit tests, Fast: a test asserted an absolute wall-clock threshold (`elapsedMs < 5_000`) — evidence: `worker/deno/tests/pr_body_test.ts:284` — reason: fixed in this diff (replaced by `assertLinearGrowth`; found by the previous run's reviewer)
- **violation** — A Code Change Owes a Docs Change: the `issueSubAgentTier` JSDoc said the key was "not read yet" — evidence: `worker/deno/lib/config_defaults.ts:484` — reason: fixed in this diff (now names the telemetry and PR-marker uses; found by the previous run's reviewer)
- **clean** — this run's reviewer reported no violations. Checked: the one review-enforced rule ("Check where you insert"), a new argument reaching every caller (`subAgentTier` required on `measureIssuePhaseRun`, `IssuePhaseRun`, `assemblePrBody`), persisted data (legacy sidecar read as sonnet, no schema bump), tests going red without their change, named tests existing, fail-loud tier validation, docs matching code, Australian English. It found no assertion dropped from an existing test: each was rewritten in place with `subAgentTier` added. Optional, not chased: the tier is resolved twice per completion run, so an invalid value warns twice
