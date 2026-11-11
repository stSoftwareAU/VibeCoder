## Summary

The cause of the execute-phase wedge on `GRQ-25` remains undiagnosed, so this
change makes no speculative production-code or test changes. The host archive
could not be reached from this run. Part of #5062.

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

- The archive for run `vibe-mwc7uss5-1071e3` was not present on this executor.
  `ssh GRQ-25` did not resolve from this network.

## Evidence

Backend-only investigation; no UI files. No private run evidence was copied to
the repository or posted to GitHub.

- `timeout 12 ssh -o BatchMode=yes -o ConnectTimeout=8 GRQ-25 '…'` failed with
  `ssh: Could not resolve hostname grq-25: Temporary failure in name
  resolution` (exit 255), before authentication or archive access.
- `/home/vibe/logs` contained no path matching the run id, container id, or
  `hard-kill-archive`; `/home/vibe/logs/hard-kill-archive/` does not exist.
- No Tailscale executable or `/etc/codex/network-policy.json` was present in
  this executor, and no environment-status or VPN-access tool was exposed.
- The checkout is based on `8020adbf` (merged PR #5067), which already carries
  the guest-derived diagnostics. No change to those diagnostics was made.

## Reproduction

- **symptom** — the launcher watchdog reaped the container during the execute
  phase after the worker log stopped at `agent turn`
- **status** — `not-run`
- **reason** — the private archive could not be reached, so the worker log,
  final agent tool call, boot logs and guest probes could not be correlated; no
  evidence-backed deterministic reproduction could be made

## Acceptance Criteria

- **missing** — Hard kill: container wedged in execute (watchdog) — determine
  the cause of the wedge and implement its correction — reason: the run archive
  was inaccessible from this executor, leaving guest scheduling, subprocess
  hang and shutdown failure indistinguishable

## Test Plan

- No source or test files changed because the root cause could not be verified
  and a speculative production change would violate the reproduction
  requirement.
- `deno task pr-summary-check --base main --issue-body-file
  /tmp/issue-5062-body.md --labels bug,top-priority
  ../../docs/archive/pr-summaries/pr-summary-5062.md` passed: 0 gates blocked,
  0 not checked.
- `timeout 900 ./quality.sh < /dev/null` failed only at the Deno test unit-time
  budget: 88 tests exceeded 1.00s; the gate reported
  `worker/deno/tests/auto_merge_ensure_draft_heal_wiring_4952_test.ts` at 1.20s.
  The parallel and serial test suites passed; lint, type check and formatting
  passed. Config integration and Checkov were skipped by the gate.

Not done or not checked: the private archive correlation, failure attribution,
regression reproduction and production fix. The quality gate's unit-test time
budget failure remains unresolved; no unrelated test was changed.
