## Summary

Closes #5632. The duplicated-knowledge scan works inside the target checkout.
Workers save candidate decisions on the wrapper and pause after two unfinished
attempts at the same stage. Manual and fleet pickups use the same claim path.

## Spec

### Intent and Rationale

A recovery notice proves the assignment was released. It cannot identify the
last operation or establish whether the model ran. The wrapper now records
each stage before it starts and each completed review batch afterwards.

### Essential Design Decisions

- Each batch contains up to five candidates. The commit identifies which
  checkout the saved verdicts describe. A single filing pass ranks retained
  candidates alongside findings from the independent search.
- The fleet trusts checkpoint comments from its own accounts. A confirmed
  comment write precedes the corresponding paid work.
- Scan calls share one deadline. Native discovery yields to heartbeat timers.

### Undiscoverable Facts

The operator observed repeated recovery notices without a timeout report.
The cause of those individual interruptions is unknown.

## Evidence

The two-checkout fixture finds one duplicate from the parent and zero from the
target checkout. The interrupted six-candidate fixture completes the first
five, interrupts the final batch and makes one model call on resume.

Read and updated the operator manual in `docs/DUPLICATED-KNOWLEDGE-SCAN.md`.

## Test Plan

- `duplicate_scan_checkpoint_test.ts` covers cross-host retry limits, trusted
  comments, incomplete verdicts, checkout isolation and batch resumption.
- `idle_task_process_issue_route_test.ts` checks that a missing refresh timer
  stops a paid scan.
- `idle_task_claude_budget_test.ts` exercises overlapping scans with different
  deadlines.
- The affected worker suites passed 246 tests using a local dependency mirror.
  The live incident has not been rerun.
