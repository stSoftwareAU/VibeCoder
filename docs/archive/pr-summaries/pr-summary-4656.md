## Summary

Replace the babysitter's permanent attempted bit with durable retry state,
bounded cooldowns, legacy migration and post-push reconciliation. Temporary
provider, authentication, capability and lock failures can recover without
manual state deletion. Part of #4656; automated recovery remains partial.

Babysitter comments use `vibe-babysitter-attempt`, separate from CI escalation
markers, so a repair never authorises other lanes to lift a person's hold.
Only consecutive substantive failures or no-change outcomes spend the
no-progress budget. Successful pushes reset it. Exhausting the runner's
90-minute budget is substantive; external kills remain infrastructure failures.
Moved heads bypass old cooldowns without discarding attempt history.

Repeated no-progress persists redacted evidence and posts a CI cap marker for
the stall self-repair ladder or a separate marker for other handoffs. A babysitter handoff
does not claim ownership of a human label. Eligible red-CI stalls use the existing ladder; other incidents pause until the head or review changes;
no separate escalation issue can remain open after the PR resolves. Terminal
PRs lose their retry records, and parked closed records cause no further
GitHub reads.

Version bump: none; no release version or external extension contract changed.

## Spec

### Intent and Rationale

- Recover naturally through the existing scan and branch-lock workflow.
- Bound repeated no-progress while preserving explicit human decisions.
- Reuse the shared auto-merge policy when arming repair candidates.

### Essential Design Decisions

- Version 2 host-local state retains cooldowns and reconciliation; a legacy
  attempt file migrates to a bounded five-minute retry.
- A separate fleet-authored marker family shares the consecutive no-progress
  tally. It reuses strict attribute validation, with author verification.
- Trusted runner sessions restart before read-token expiry. The agent receives
  no runner write token or App key. On restart, the runner clears the response
  in its protected exchange directory before launching the next session.
- The stall ladder cap marker owns eligible red-CI recovery; green review and conflict incidents stop sessions until the head or review changes. Evidence is redacted,
  marker-neutralised and fenced before publication.

### Undiscoverable Facts

- The current PR checks were all successful when review repair began; there
  were no failing check logs to diagnose and no inline review comments.
- Issue #4656 assigns git-timeout plumbing to #4734 and body publication,
  validation and review-dismissal work to their existing owners. This change
  retains those boundaries.

## Evidence

Backend/CLI change. The real `fix()` is exercised through in-memory GitHub,
git and agent boundaries in `babysitter_fix_orchestration_test.ts`.
Regressions reproduced before their fixes: two pushes followed by one
no-change exhausted the old tally; SIGTERM at the runner deadline remained
infrastructure; a moved head remained blocked; common git transport messages
were classified as code. Diagnostic marker injection also failed its new
regression before neutralisation was added.

The operator manual's retry and reconciliation section in
`docs/workflows/fleet-pr-babysitter.md` now describes the separate markers,
consecutive budget, stall-ladder handoff and terminal-record pruning.
The direct issue-creation allowlist entry is removed because that route no
longer exists.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Transient failure -> unchanged-head cooldown -> retry -> checked
  repair -> CI -> independent review -> merge observed. — evidence:
  `babysitter_fix_orchestration_test.ts::transient failure, cooldown, retry, checked repair, CI, review and merge observed`
  — reviewer: met
- **met** — Restart, legacy migration, two hosts, head movement, capability
  recovery, credential expiry and repeated no-progress. — evidence:
  `babysitter_fix_orchestration_test.ts` covers each scenario, including a
  bounded tool/disk cooldown followed by a successful retry without deleting
  state, real git timeout/spawn/disk diagnostics through the default clone path,
  moved-head retry after a
  pending-CI observation and runner-budget escalation. — reviewer: met
- **met** — Waits release locks, incidents deduplicate, and human gates remain
  paused. — evidence: orchestration lock assertions, fleet-author handoff
  deduplication across records with different stale pushed heads,
  `stall_repair_test.ts::babysitter attempts and cap handoffs never lift an owner's needs-human hold`
  and `conflict_needs_human_gate_test.ts::babysitter attempts and handoffs leave the conflict human gate closed`
  — reviewer: met
- **partial** — Repeated no-progress persists evidence and bounds sessions:
  eligible red-CI stalls use the existing automated repair mechanism;
  green review and conflict incidents pause until the head or review changes.
  — evidence: `escalateStuckRepair` posts the
  existing cap marker; `stall_repair_test.ts::babysitter cap handoff goes straight to the existing second-trip recovery`
  exercises the real red-CI ladder. Orchestration verifies bounded green-review
  and conflict sessions. Those lanes do not use the ladder or claim automated
  recovery after handoff; non-blocking red-CI incidents also lack automated
  recovery. No independent issue is filed. — reviewer: partial

## Test Plan

- Orchestration: retries, cooldowns, legacy migration, locks, head movement,
  repaired tool/disk failures, token restart, consecutive no-progress, runner
  deadline, deduplicated handoff and closed-record reads.
- Retry-state: transport classification, strict markers, trusted authors,
  push-reset tally and ignored CI-lane markers.
- Stall repair and conflict gate: babysitter attempts and cap handoffs preserve
  manual holds; cap handoff enters the existing recovery ladder.
- Production App fixture retains credential-boundary assertions and now
  expects the separate babysitter marker.
- Existing expectations changed deliberately: a push leaves zero consecutive
  no-progress attempts; a closed PR clears records; escalation assertions
  exercise a deduplicated PR handoff instead of the removed issue filer.
  Every other assertion in those scenarios is retained.
- Related babysitter, App, supervisor, audit-hook, stall, conflict-gate and
  routing suites: **205 passed, 0 failed**.
- `deno task check:manifests`: **847 passed, 0 failed, 1 ignored**.
- Full-repository formatting, lint, type checks, Markdown, Mermaid,
  completeness and chokepoint checks passed through `./quality.sh`.
- The full parallel test pass hit a host Deno 2.9.5/macOS runtime panic:
  `pledge test permissions called before restoring previous pledge`.
  Its serial pass consequently did not run. This is not a full-suite pass.
  The base commit `0a4d803a` is the merge of PR #4715, whose Quality run
  [41555343824](https://github.com/stSoftwareAU/VibeCoder/actions/runs/41555343824)
  passed all four unit shards and the gate; PR #4747's current CI also passes.
- Semgrep and Checkov were unavailable on this host (neither installed nor
  present as cached container images). Config integration was skipped because
  this checkout has no `.config.json`.
- `deno task pr-summary-check --base origin/main` reported zero blocked gates;
  criteria/review checks were not checked without an issue-body file, and
  reproduction status was not checked without labels. Summary freshness
  remains a pushed-commit check because this repair is uncommitted.

## Merge verification

The babysitter commits and pushes this working tree. CI must validate that
commit, including the archived-summary freshness check.

## Current review repair

Git transport classification now recognises the chokepoint's anchored
`TIMEOUT: git clone/fetch/push` diagnostic. Real disk-full and wrapped spawn
failures are capability failures for every git operation. Orchestration uses
the actual diagnostic forms, including a push timeout after a checked session
and a disk-full clone, and checks zero substantive attempts and no marker.
The retry scenario resets the simulated checkout's commit state because a
push timeout now occurs after a real simulated commit.

Non-actionable scans preserve an escalated incident's handoff head until the
repair consumes the changed diagnosis. A pending-CI scan on a new head therefore
cannot hide that move; the regression passes eligibility, runs one new session
with fenced prior evidence and then pauses again. Handoff deduplication uses
the incident's observed head, so hosts with different stale pushed heads share
one comment. All three defects reproduced before their guards were added.
No twinned classifier rule was found.

The six focused orchestration, retry-state, App, babysitter, stall and conflict
gate suites passed **141 tests, zero failures**. Closure entries above now name
the new evidence and explicitly distinguish ladder recovery for eligible
red-CI stalls from bounded pauses for green review and conflict incidents.

Final `./quality.sh` validation passed formatting, lint, type checking,
Markdown, Mermaid, completeness and all static chokepoints. The full parallel
test pass reproduced the Deno 2.9.5/macOS permission-pledge panic quoted above;
the serial pass consequently did not run. Base PR #4715 Quality run
41555343824 again verified successful across all four unit shards and its
gate. Current PR CI reports 22 passed, zero failed, two skipped. Semgrep and
Checkov are unavailable on this host; config integration has no config file.
The summary CLI reports zero blocked gates and three missing-input checks
not checked. Commit-history freshness runs after the babysitter commits.

## Follow-up review repair

Local git diff checks, staging, merge and commit failures declare code at the
operation boundary. Transport operations recognise git transport phrases, never
bare path keywords. A leftover marker in `worker/deno/lib/git_timeout.ts` now
spends the substantive budget, posts an attempt marker and reaches the cap.

After handoff the unchanged incident starts no more sessions, even after its
cooldown expires. A changed review has its own identity; a changed head permits
one new diagnosis with fenced prior evidence while retaining attempt history.
Failed handoffs retry publication without running another repair session.
The existing max-two test now expects two sessions/evidence lines rather than
three: the requested bound makes the former third session invalid. Its prompt
assertion now checks prior evidence on the second session; changed-diagnosis
coverage remains on the moved-head scenario. No twinned classifier rule found.

Validation for this follow-up: all six focused babysitter, retry-state, App,
stall-repair and conflict-gate suites passed (**139 tests, zero failures**).
Removing the classification and pause guards made the local-validation,
repeated-no-progress and green-review regressions fail; the guards were
restored before the final passing run. The complete local gate passed
formatting, lint, type checking, Markdown, Mermaid, completeness and all
chokepoints. Its parallel suite again hit the Deno 2.9.5/macOS permission-pledge
runtime panic quoted above, so the serial pass did not run. Base PR #4715
Quality run 41555343824 passed all unit shards and its gate (verified with gh).
Semgrep and Checkov remain unavailable; config integration has no config file.
The summary CLI reports zero blocked gates; its three missing-input checks
remain not checked. Commit-history freshness runs after the babysitter commits.

## Merge conflict repair

The Gitleaks configuration retains both the PR’s synthetic redaction fixture
exception and the base branch’s credential-channel fixture exceptions. The
combined TOML configuration parses successfully; its exceptions remain scoped
to the exact historical fixture lines.

The later merge retains the base's single-push flow: every repair merges the
base before the agent runs, carries its whitespace baseline into validation,
and arms auto-merge. Retry tracking, refreshed read tokens and the full head
identity remain in place. The offline fixture and injected boundaries cover
both flows together.

## Current review follow-up

Git mirror fetch timeouts and multiline disk exhaustion diagnostics are classified
as infrastructure and capability failures. Review and conflict handoffs use
separate deduplication markers, so later red-CI stalls get their first repair
trip. Automated recovery remains partial: only eligible blocking red-CI stalls
enter the ladder; other incidents pause until their head or review changes.

Validation: 111 focused tests passed, including default clone-path failures and
a later red-CI first trip; the revised orchestration suite passed again after
the final test change. Deno formatting, lint and type checks passed. The full
quality gate hit the host Deno permission-pledge panic in the parallel test
pass; base Quality run 41555343824 passed all test shards. Semgrep and the
pinned Checkov were unavailable locally; CI runs them. Summary freshness
requires the babysitter commit before it can be checked.

## Latest review repair

Git HTTP ref-discovery errors and SSH connection drops remain infrastructure
failures through clone, fetch and push; mirror maintenance timeouts do too. A
stale conflict now records and logs a five-minute mergeability recheck.
`worker/deno/tests/babysitter_fix_orchestration_test.ts::git transport outages and maintenance timeout do not spend repair attempts`
and `worker/deno/tests/babysitter_fix_orchestration_test.ts::stale conflict defers until GitHub recomputes mergeability`
cover these paths. Automated recovery for review, conflict and non-blocking CI
handoffs remains outstanding. The published body still has closing references;
the current review proposes removing them.

Validation: the 28 orchestration tests and seven merged push-flow tests pass.
The local gate passed formatting, lint, type checking and completeness. Its
parallel test pass hit the host Deno permission-pledge panic; serial tests did
not run. Base Quality run 41555343824 passed. Semgrep and the pinned Checkov
were unavailable; config integration lacked configuration. Summary freshness
requires the babysitter commit. No twinned transport classifier was found.

## Transport classification review repair

Clone and fetch failures now default to infrastructure after capability checks;
push failures do too unless a ref rejection identifies a race or a server rule
rejects the change. The obsolete phrase-list classification treated unknown
download failures as code; local validation and server rule failures remain
substantive. `worker/deno/tests/babysitter_fix_orchestration_test.ts::git transport outages and maintenance timeout do not spend repair attempts`
covers the reported macOS, TLS, fetch and HTTP/2 diagnostics, unknown failures,
push races and rule rejections. The local-validation test retains coverage of
substantive local failures. No twinned operation-boundary classifier was found.
The earlier proposal identified #4656 as partial work, but the runner restored
the dropped closing references. The current proposal removes them again for the
babysitter to apply after validation.

## Stderr and description review repair

The obsolete scratch-file write had no consumer and could follow an agent's
symlink. The runner now forwards stderr to its log and classifies a bounded
tail in memory; the adapter's redacted message and category reach the failure.
`worker/deno/tests/babysitter_fix_orchestration_test.ts::agent stderr preserves the symlink target and reports authentication`
covers the removal and remaining diagnostic path;
`worker/deno/tests/babysitter_fix_orchestration_test.ts::agent stderr forwards all chunks and retains a bounded tail`
covers forwarding and the bound. The existing green-review handoff test covers
bounded sessions. The complete PR body proposal removes the closing references
because issue #4656 remains only partially addressed.

Validation: all 32 orchestration tests passed, as did repository-wide Deno
formatting, lint and type checks. The quality gate passed completeness,
Markdown, Mermaid and chokepoint checks; its parallel tests hit the host Deno
permission-pledge panic and the serial pass did not run. Base Quality run
41555343824 passed. Semgrep, pinned Checkov and config integration were not
available locally. Summary freshness requires the babysitter's commit.

## Provider failure review follow-up

Codex stderr is classified by the existing output adapter, and reported quota
reset and retry-after times inform the cooldown. Empty diagnostics on a failed
session are infrastructure. The shared transient-network classifier also
covers GitHub CLI connection failures. The operator manual now describes both
provider failures and the transport-operation defaults and push exceptions.
The previous exit-1 test treated an empty diagnostic as code; that behaviour is
obsolete. Explicit task failures still spend the substantive budget, covered by
`worker/deno/tests/babysitter_fix_orchestration_test.ts::a failed marker write keeps the retry record and the repair's real error`.
Provider and GitHub CLI failures are covered by
`worker/deno/tests/babysitter_fix_orchestration_test.ts::provider and gh network failures do not spend repair attempts`.
Empty diagnostics and provider retry timing are covered by
`worker/deno/tests/babysitter_fix_orchestration_test.ts::an empty agent diagnostic retries and a reported retry-after is honoured`.
The spawn fixture's inherited-stderr expectation is obsolete because the
session now captures diagnostics; its credential and sandbox assertions remain
covered by `worker/deno/tests/fleet_pr_babysitter_test.ts::codex agent gets its own read-only token instead of the runner's GH_TOKEN`.

The 28 orchestration tests pass. The local quality gate passes formatting,
lint, type checking, completeness and static checks; its parallel test pass
again hits the Deno permission-pledge panic, before the serial pass. Base
Quality run 41555343824 passed all test shards. Semgrep and pinned Checkov
are unavailable locally; summary freshness requires the babysitter's commit.

## CI orchestration fixture repair

The simulated agent now writes its completion response to the runner-provided
exchange path, matching the isolated response contract introduced for #4731.
The obsolete fixture wrote into the clone, where the runner no longer reads it.
The existing orchestration tests still cover successful repairs, retry and
escalation, including
`worker/deno/tests/babysitter_fix_orchestration_test.ts::transient failure, cooldown, retry, checked repair, CI, review and merge observed`.
# Review follow-up: shared retry budget and diagnostics

The shared marker history now determines the consecutive no-progress tally;
only locally unpublished attempts are added. A push on another host therefore
resets the shared budget. Existing version 2 state remains readable: records
without the optional unpublished count default to zero. Infrastructure and
capability deferrals retain the redacted diagnosis in the recorded outcome.
The proposed PR body removes the issue-closing references because automated
recovery for review, conflict and non-blocking CI incidents remains partial.

The obsolete behaviour was treating a host's already-published local count as
authoritative after another host pushed. The remaining behaviour retains
unpublished attempts and shares published attempts across hosts. Coverage:
`worker/deno/tests/babysitter_fix_orchestration_test.ts::a push on another host resets the shared no-progress budget`
and `worker/deno/tests/babysitter_fix_orchestration_test.ts::a failed marker write keeps the retry record and the repair's real error`.
The moved-head fixtures explicitly model unpublished attempts; their changed
diagnosis and bounded handoff assertions remain intact. Authentication
diagnostics are covered by
`worker/deno/tests/babysitter_fix_orchestration_test.ts::agent stderr preserves the symlink target and reports authentication`.
