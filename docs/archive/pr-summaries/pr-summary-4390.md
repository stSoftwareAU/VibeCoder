# PR Summary — Issue #4390

## Summary

Addresses #4390. Running agents and mutation/discrimination processes may
consume the disk headroom required when they started. Their periodic disk
watch still stops them at the existing host floor. New build steps still
require the full floor plus 25 GB where work-volume trim is refused, and
retain the existing bounded pruning of idle target directories.

A recognised host-disk failure also keeps its first outcome without the
in-process infrastructure retry. A later scheduled cycle re-probes the
host; a genuine shortage remains an infrastructure failure. Configured floors,
new-step admission budgets, failure categories, claim outcomes and cleanup
ownership rules remain unchanged.

## Evidence

The local worker log for 2026-10-26 records a 75.9 GB host reading before
admission, then active agents stopped at 66.4 GB free with a 46 GB floor.
Their watcher demanded the full 25 GB again, even though the admitted work
had begun consuming it. The same run retried the unchanged budget refusal,
then filed the follow-up to #4390 at 03:43:13Z. No ENOSPC or read-only
filesystem is needed to reproduce this occurrence.

The initial filing at 02:27:08Z was a new-step admission refusal at 62.5 GB
free, below the required 71 GB. That real capacity constraint still refuses
new work; this change fixes premature active-process kills and the useless
same-process retry, rather than claiming to create more disk capacity.

- Red: the new agent completion, mutation-process survival and host-disk
  retry regressions all failed against the original code.
- Green: the focused disk admission, active-watch and infrastructure-retry
  suites passed (77 tests). The existing low-floor stop and gate-quotation
  protections remain covered.
- No existing test assertions were removed or weakened; one test title now
  accurately calls its pre-start check build-step admission.

## Reproduction

- Symptom: an admitted process is killed when free space drops from
  75.9 GB to 66.4 GB, despite remaining above the 46 GB stop floor.
- Status: verified with injected readings and a real stub child process.
- Regression: `claude_runner_host_disk_4390_test.ts` exercises successful
  agent completion, a subsequent genuine floor stop, and mutation-runner
  survival through repeated polls. `issue_worker_infra_retry_test.ts`
  verifies that recognised disk failures do not sleep or retry and that
  declared categories and worker-gate quoted ENOSPC remain authoritative.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — reuses the existing floor judge, park reason and category-aware
  host-fault adapter. No dependencies, cleanup policy or persisted formats
  change.

## Test Plan

- [x] Focused suites: `claude_runner_host_disk_4390_test.ts`,
  `issue_worker_infra_retry_test.ts`, `heavy_build_gate_3178_test.ts`,
  `host_disk_inflight_4360_test.ts` (77 passed).
- [x] Deno formatting and lint; manifest checks (867 passed, 1 ignored).
- [ ] Full `quality.sh` on the integrated branch.
- Twinned rules checked: both active-process watchers now call the same
  floor-only judge. Agent preflight, quality, mutation and discrimination
  admission retain `parkInFlightBuild`; maintenance retains
  `heavyBuildAdmission`. Both operator-guide descriptions in
  `docs/CONTAINER.md` distinguish admission headroom from the active floor.
