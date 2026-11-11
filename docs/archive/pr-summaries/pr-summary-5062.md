## Summary

The cause of the execute-phase wedge on `GRQ-25` remains undiagnosed. This
summary records the investigation and independent reviews; no production code or
tests changed. A retained agent session was found locally, but the host's worker
log, boot logs and guest probes remain inaccessible. Part of #5062.

## Spec

### Intent and Rationale

- The requested fix depends on correlating the private worker log, agent tool
  call, boot logs and guest probes. Without those observations, changing timeout
  or process handling would be guesswork.

### Essential Design Decisions

- Preserve the diagnostics already delivered by merged PR #5067; this change
  does not repeat its reporting changes.
- Do not change production behaviour until the failure is attributed to guest
  scheduling, an agent subprocess, or shutdown.

### Undiscoverable Facts

- A local logs checkout retained an agent session for run
  `vibe-mwc7uss5-1071e3`, but not its hard-kill evidence record. `ssh GRQ-25`
  did not resolve from this network.

## Evidence

Backend-only investigation; no UI files. No private log or transcript text was
copied to the repository or posted to GitHub.

- `timeout 12 ssh -o BatchMode=yes -o ConnectTimeout=8 GRQ-25 '…'` failed with
  `ssh: Could not resolve hostname grq-25: Temporary failure in name
  resolution`
  (exit 255), before authentication or archive access.
- `/home/vibe/logs` contained no path matching the run id, container id, or
  `hard-kill-archive`; `/home/vibe/logs/hard-kill-archive/` does not exist.
- No Tailscale executable or `/etc/codex/network-policy.json` was present in
  this executor, and no environment-status or VPN-access tool was exposed.
- The retained session's last tool result was at `15:03:29Z`: a bounded quality
  command returned exit 143 (`Terminated`). This predates the issue's last
  worker-log timestamp, `16:53:16Z`, by almost two hours, so it does not
  identify the operation blocking at the watchdog reap. The local logs checkout
  contains no corresponding worker log, boot log or guest probes.
- The executor inspected `execute_phase.ts`, `claude_runner.ts`,
  `container_watchdog.ts` and `hard_kill_evidence.ts`. Existing execution
  deadlines, a wall-clock backstop, bounded post-kill handling and outer reaping
  do not establish which component stalled in this incident.
- The checkout is based on `8020adbf` (merged PR #5067), which already carries
  the guest-derived diagnostics. No change to those diagnostics was made.
- Manual read: `docs/workflows/resilience-and-concurrency.md`, **Wedged
  container watchdog**, including **Hard-kill evidence**. Only this summary
  changed.
- Issue provenance: #5062, **Hard kill: container wedged in execute
  (watchdog)**; merged PR #5067 has the same title with **(Issue #5062)**.

## Reproduction

- **symptom** — the launcher watchdog reaped the container during the execute
  phase after the worker log stopped at `agent turn`
- **status** — `not-run`
- **reason** — the private archive could not be reached, so the worker log,
  final agent tool call, boot logs and guest probes could not be correlated; no
  evidence-backed deterministic reproduction could be made

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **missing** — Hard kill: container wedged in execute (watchdog) — determine
  the cause of the wedge and implement its correction — reviewer: missing —
  reason: the retained session does not cover the later stall, and the host's
  diagnostic archive is inaccessible; no cause, correction or regression
  reproduction has been established

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, constrained documentation-only scope, removal
  of stale implementation claims, and no speculative production or test changes

## Test Plan

- No source or test files changed because the root cause could not be verified
  and a speculative production change would violate the reproduction
  requirement.
- The Spec reviewer read the branch diff and issue body and returned `missing`:
  the branch contains no cause attribution, correction or regression test. The
  Standards reviewer checked the summary against `CODING-STANDARDS.md`; its
  requested manual-section citation is included above.
- `deno task pr-summary-check --base main --issue-body-file
  /tmp/issue-5062-body.md --labels bug,top-priority
  ../../docs/archive/pr-summaries/pr-summary-5062.md < /dev/null`
  passed: 0 gates blocked, 0 not checked. Acceptance-criteria closure was
  `NOT_APPLICABLE` because the auto-filed issue has no explicit criteria block;
  this is not evidence that the incident criterion is met.
- Markdown lint passed on a temporary copy of this summary using the
  repository's rule selection and stdin from `/dev/null`. The repository's
  normal lint command excludes `docs/archive/**`, so the targeted check used a
  temporary configuration without that exclusion.
- `git diff --check` passed.
- The full quality gate is left to the worker's re-run after this turn.

Not done or not checked: the private archive correlation, failure attribution,
regression reproduction and production fix. The acceptance criterion remains
missing and the issue remains open.
