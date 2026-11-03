## Summary

Replace the babysitter's permanent attempted bit with durable retry state,
bounded cooldowns, legacy migration and post-push reconciliation. Temporary
provider, authentication, capability and lock failures can recover without
manual state deletion. Closes #4656.

Babysitter comments use `vibe-babysitter-attempt`, separate from CI escalation
markers, so a repair never authorises other lanes to lift a person's hold.
Only consecutive substantive failures or no-change outcomes spend the
no-progress budget. Successful pushes reset it. Exhausting the runner's
90-minute budget is substantive; external kills remain infrastructure failures.
Moved heads bypass old cooldowns without discarding attempt history.

Repeated no-progress persists redacted evidence and posts the existing
auto-fix cap marker for the stall self-repair ladder. A babysitter handoff
does not claim ownership of a human label. Eligible red-CI stalls use the existing ladder; other incidents pause until the head or review changes;
no separate escalation issue can remain open after the PR resolves. Terminal
PRs lose their retry records, and parked closed records cause no further
GitHub reads.

Version bump: none; no release version or external extension contract changed.

## Spec

### Intent and Rationale

- Recover naturally through the existing scan and branch-lock workflow.
- Bound repeated no-progress while preserving explicit human decisions.
- Keep merge authority in the worker's existing auto-merge sweep.

### Essential Design Decisions

- Version 2 host-local state retains cooldowns and reconciliation; a legacy
  attempt file migrates to a bounded five-minute retry.
- A separate fleet-authored marker family shares the consecutive no-progress
  tally. It reuses strict attribute validation, with author verification.
- Trusted runner sessions restart before read-token expiry. The agent receives
  no runner write token or App key.
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
  state, real git timeout/spawn/disk diagnostics, moved-head retry after a
  pending-CI observation and runner-budget escalation. — reviewer: met
- **met** — Waits release locks, incidents deduplicate, and human gates remain
  paused. — evidence: orchestration lock assertions, fleet-author handoff
  deduplication across records with different stale pushed heads,
  `stall_repair_test.ts::babysitter attempts and cap handoffs never lift an owner's needs-human hold`
  and `conflict_needs_human_gate_test.ts::babysitter attempts and handoffs leave the conflict human gate closed`
  — reviewer: met
- **met** — Repeated no-progress persists evidence and bounds sessions:
  eligible red-CI stalls use the existing automated repair mechanism;
  green review and conflict incidents pause until the head or review changes.
  — evidence: `escalateStuckRepair` posts the
  existing cap marker; `stall_repair_test.ts::babysitter cap handoff goes straight to the existing second-trip recovery`
  exercises the real red-CI ladder. Orchestration verifies bounded green-review
  and conflict sessions. Those lanes do not use the ladder or claim automated
  recovery after handoff. No independent issue is filed. — reviewer: met

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
