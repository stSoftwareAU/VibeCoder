/**
 * Unit tests for the idle-decision claimable-work census (Issue #2811).
 *
 * Covers:
 *   1. Per-repo unblocked counts for every priority label.
 *   2. Blocking-label and assignee exclusion from the unblocked counts.
 *   3. `degraded-model` / `lang:rust` issues still count (the lead
 *      hypothesis is wrong — those are not blocking labels).
 *   4. The inversion signal: ≥1 unblocked priority issue sets the flag;
 *      `idle-task` alone does NOT; a non-monitored repo with work does
 *      not raise `inversionDetected`.
 *   5. Availability verdict (`available` / `busy` / `empty`).
 *   6. Skip-reason passthrough / default.
 *   7. The formatter emits greppable lines and the `ALERT inversion`
 *      line only when the signal fired.
 *   8. Tier-3 suppression (Issue #499): a repo holding a suppressing open
 *      `work-on` issue contributes no `low-priority` candidate to the scan,
 *      so the census reports that backlog as `low_priority_suppressed`
 *      rather than claimable — with the same carve-outs the scan applies for
 *      dependency-blocked (#2610) and permanently merged-PR-blocked (#499)
 *      `work-on` issues.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildIdleDecisionCensus,
  CENSUS_SCAN_GATE_COVERAGE,
  type CensusIssue,
  formatIdleDecisionCensus,
  type RepoCensusInput,
} from "../lib/idle_decision_census.ts";
import { SKIP_REASONS } from "../lib/issue_finder_logger.ts";
import type { ClosedPR, OpenPR } from "../lib/issue_query.ts";

function issue(
  number: number,
  labels: string[],
  assignees: string[] = [],
  milestone = "",
): CensusIssue {
  return { number, labels, assignees, milestone };
}

function openPR(
  number: number,
  baseRefName: string,
  headRefName: string,
): OpenPR {
  return { number, title: `PR ${number}`, baseRefName, headRefName };
}

function repoInput(
  partial: Partial<RepoCensusInput> & { repo: string },
): RepoCensusInput {
  return {
    repo: partial.repo,
    monitored: partial.monitored ?? true,
    scannedThisCycle: partial.scannedThisCycle ?? true,
    nice: partial.nice ?? 0,
    skipReason: partial.skipReason,
    issues: partial.issues ?? [],
    openPRs: partial.openPRs,
    mergedPRs: partial.mergedPRs,
    runLocalHolds: partial.runLocalHolds,
  };
}

Deno.test("census - counts unblocked issues per priority label", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [
          issue(1, ["top-priority"]),
          issue(2, ["work-on"]),
          issue(3, ["work-on"]),
          issue(4, ["low-priority"]),
          issue(5, ["idle-task"]),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.topPriority, 1);
  assertEquals(entry.unblocked.workOn, 2);
  // Issue #499 (business-logic change): #4 carries `low-priority` in a repo
  // that also holds suppressing `work-on` issues, so `selectHighestPriority`
  // drops it from the tier-3 pool and the census now reports it as suppressed
  // rather than claimable. Before #499 this asserted `lowPriority === 1`.
  assertEquals(entry.unblocked.lowPriority, 0);
  assertEquals(entry.lowPrioritySuppressed, 1);
  assertEquals(entry.unblocked.idleTask, 1);
  assert(entry.inversionSignal);
});

Deno.test("census - blocking label excludes an issue from unblocked counts", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "selection",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [
          issue(1, ["work-on", "needs-human"]),
          issue(2, ["work-on", "planning"]),
          issue(3, ["work-on", "failed"]),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 0);
  assert(!entry.inversionSignal);
});

Deno.test("census - assigned issue is not counted as unblocked", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["work-on"], ["some-human"])],
      }),
    ],
  });
  assertEquals(census.perRepo[0]!.unblocked.workOn, 0);
  assert(!census.inversionDetected);
});

Deno.test("census - degraded-model and lang:rust issues still count (lead hypothesis is wrong)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/private-repo-13",
        issues: [
          issue(1365, ["work-on", "degraded-model", "lang:rust"]),
          issue(1366, ["work-on", "lang:rust"]),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 2);
  assert(entry.inversionSignal);
  assert(census.inversionDetected);
  assertEquals(census.inversionRepos, ["org/private-repo-13"]);
});

Deno.test("census - idle-task alone does not raise the inversion signal", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["idle-task"])],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.idleTask, 1);
  assert(!entry.inversionSignal);
  assert(!census.inversionDetected);
});

Deno.test("census - non-monitored repo with work does not raise inversionDetected", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/external",
        monitored: false,
        issues: [issue(1, ["work-on"])],
      }),
    ],
  });
  // The per-repo signal is still computed...
  assert(census.perRepo[0]!.inversionSignal);
  // ...but a non-monitored repo never raises the fleet-level alert.
  assert(!census.inversionDetected);
  assertEquals(census.inversionRepos, []);
});

Deno.test("census - availability verdict reflects work-stream occupancy", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "selection",
    workerUser: "vibe-bot",
    repos: [
      // Empty: no open issues.
      repoInput({ repo: "org/empty", issues: [] }),
      // Available: an unassigned issue exists.
      repoInput({
        repo: "org/available",
        issues: [issue(1, ["work-on"])],
      }),
      // Busy: the only stream is fully assigned to the worker.
      repoInput({
        repo: "org/busy",
        issues: [issue(1, ["work-on"], ["vibe-bot"])],
      }),
    ],
  });
  assertEquals(census.perRepo[0]!.availability, "empty");
  assertEquals(census.perRepo[1]!.availability, "available");
  assertEquals(census.perRepo[2]!.availability, "busy");
});

Deno.test("census - skip reason defaults and passthrough", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({ repo: "org/scanned", scannedThisCycle: true }),
      repoInput({
        repo: "org/skipped",
        scannedThisCycle: false,
        skipReason: "cooldown_cross_worker",
      }),
      // Skipped with no explicit reason → "unknown".
      repoInput({ repo: "org/mystery", scannedThisCycle: false }),
    ],
  });
  assertEquals(census.perRepo[0]!.skipReason, "scanned");
  assertEquals(census.perRepo[1]!.skipReason, "cooldown_cross_worker");
  assertEquals(census.perRepo[2]!.skipReason, "unknown");
});

Deno.test("formatter - emits a header, per-repo lines, and an inversion ALERT", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/private-repo-13",
        nice: 5,
        issues: [issue(1365, ["work-on"])],
      }),
      repoInput({ repo: "org/quiet", issues: [] }),
    ],
  });
  const lines = formatIdleDecisionCensus(census, "host1:42");

  // Header line.
  assert(lines[0]!.includes("[idle-census]"));
  assert(lines[0]!.includes("decision_point=filing"));
  assert(lines[0]!.includes("repos=2"));
  assert(lines[0]!.includes("inversion=true"));
  assert(lines[0]!.includes("host=host1:42"));

  // Per-repo line carries nice + counts.
  const neatLine = lines.find((l) => l.includes("repo=org/private-repo-13"))!;
  assert(neatLine.includes("nice=5"));
  assert(neatLine.includes("work_on=1"));
  assert(neatLine.includes("inversion_signal=true"));

  // ALERT line names the offending repo.
  const alert = lines.find((l) => l.includes("ALERT inversion"))!;
  assert(alert.includes("repos=org/private-repo-13"));
});

Deno.test("formatter - no ALERT line when the inversion signal did not fire", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "selection",
    workerUser: "vibe-bot",
    repos: [
      repoInput({ repo: "org/quiet", issues: [issue(1, ["idle-task"])] }),
    ],
  });
  const lines = formatIdleDecisionCensus(census);
  assert(!lines.some((l) => l.includes("ALERT inversion")));
  assert(lines[0]!.includes("inversion=false"));
  // No host field when none supplied.
  assert(!lines[0]!.includes("host="));
});

// ---------------------------------------------------------------------------
// Issue #3526: PR-blocking awareness
// ---------------------------------------------------------------------------
// The Priority 2 scan refuses to claim a non-milestone issue while any
// non-milestone PR is open in the repo (`getBlockingPRForIssue`). The census
// must apply the same rule when counting "unblocked" work, otherwise a
// PR-blocked backlog raises the inversion signal and starves the idle-task
// filer (the host-23 private-repo-22 #357–360 incident).

Deno.test("census - non-milestone issue blocked by an open non-milestone PR is not counted (Issue #3526)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/scorer",
        issues: [
          issue(357, ["low-priority"]),
          issue(358, ["low-priority"]),
        ],
        openPRs: [openPR(362, "Develop", "issue-356-fix")],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.lowPriority, 0);
  assertEquals(entry.prBlocked, 2);
  assert(!entry.inversionSignal);
  assert(!census.inversionDetected);
});

Deno.test("census - ignore-open-prs label bypasses PR blocking (Issue #3526)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/scorer",
        issues: [issue(357, ["low-priority", "ignore-open-prs"])],
        openPRs: [openPR(362, "Develop", "issue-356-fix")],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.lowPriority, 1);
  assertEquals(entry.prBlocked, 0);
  assert(entry.inversionSignal);
});

Deno.test("census - milestone issue is only blocked by a PR targeting its milestone branch (Issue #3526)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      // A non-milestone PR does not block a milestone issue.
      repoInput({
        repo: "org/a",
        issues: [issue(10, ["work-on"], [], "OIDC Authentication")],
        openPRs: [openPR(5, "Develop", "feat-branch")],
      }),
      // A PR targeting the issue's milestone branch does block it.
      repoInput({
        repo: "org/b",
        issues: [issue(11, ["work-on"], [], "OIDC Authentication")],
        openPRs: [openPR(6, "milestone/oidc-authentication", "feat-branch")],
      }),
    ],
  });
  assertEquals(census.perRepo[0]!.unblocked.workOn, 1);
  assertEquals(census.perRepo[0]!.prBlocked, 0);
  assertEquals(census.perRepo[1]!.unblocked.workOn, 0);
  assertEquals(census.perRepo[1]!.prBlocked, 1);
});

Deno.test("census - milestone-merge PR does not block non-milestone issues (Issue #3526)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(20, ["work-on"])],
        openPRs: [openPR(7, "Develop", "milestone/oidc-authentication")],
      }),
    ],
  });
  assertEquals(census.perRepo[0]!.unblocked.workOn, 1);
  assertEquals(census.perRepo[0]!.prBlocked, 0);
  assert(census.perRepo[0]!.inversionSignal);
});

Deno.test("census - omitted openPRs behaves as no PR blocking (Issue #3526)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(30, ["low-priority"])],
      }),
    ],
  });
  assertEquals(census.perRepo[0]!.unblocked.lowPriority, 1);
  assertEquals(census.perRepo[0]!.prBlocked, 0);
  assert(census.inversionDetected);
});

Deno.test("formatter - per-repo line carries the pr_blocked count (Issue #3526)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/scorer",
        issues: [issue(357, ["low-priority"])],
        openPRs: [openPR(362, "Develop", "issue-356-fix")],
      }),
    ],
  });
  const line = formatIdleDecisionCensus(census).find((l) =>
    l.includes("repo=org/scorer")
  )!;
  assert(line.includes("pr_blocked=1"));
  assert(line.includes("low_priority=0"));
});

// ---------------------------------------------------------------------------
// Issue #3852: milestone-stream occupancy awareness
// ---------------------------------------------------------------------------
// The Priority 2 scan refuses to claim an issue whose work stream already
// hosts a worker-assigned open issue (`isMilestoneOccupied` →
// `milestone-occupied`), and `classifyIssues` mirrors that gate as
// `stream_occupied`. The census did not, so a repo whose only backlog sat
// behind an in-flight claim raised the inversion signal on every cycle:
// stSoftwareAU/NEAT-AI logged `work_on=4 inversion_signal=true` while the
// scan logged `milestone-occupied=4` and the audit logged
// `claimable=0 reason=stream_occupied`.

Deno.test("census - work-on issues behind an in-flight claim in the same stream are not counted (Issue #3852)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/neat",
        issues: [
          issue(3849, ["work-on"], ["vibe-bot"]),
          issue(3850, ["work-on"]),
          issue(3851, ["work-on"]),
          issue(3852, ["low-priority"]),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 0);
  assertEquals(entry.unblocked.lowPriority, 0);
  assertEquals(entry.streamOccupied, 3);
  assert(!entry.inversionSignal);
  assert(!census.inversionDetected);
});

Deno.test("census - occupancy is per work stream, not per repo (Issue #3852)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/neat",
        issues: [
          // Default-branch stream is occupied by an in-flight claim.
          issue(10, ["work-on"], ["vibe-bot"]),
          issue(11, ["work-on"]),
          // The v2 milestone stream is free, so its work is still claimable.
          issue(12, ["work-on"], [], "v2"),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 1);
  assertEquals(entry.streamOccupied, 1);
  assert(entry.inversionSignal);
});

Deno.test("census - a sibling worker's assignment does not occupy the stream (Issue #3852)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/neat",
        issues: [
          issue(20, ["work-on"], ["other-bot"]),
          issue(21, ["work-on"]),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 1);
  assertEquals(entry.streamOccupied, 0);
  assert(entry.inversionSignal);
});

Deno.test("census - stream occupancy is attributed ahead of PR blocking (Issue #3852)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/neat",
        issues: [
          issue(30, ["work-on"], ["vibe-bot"]),
          issue(31, ["work-on"]),
        ],
        openPRs: [openPR(32, "Develop", "issue-30-fix")],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 0);
  assertEquals(entry.streamOccupied, 1);
  assertEquals(entry.prBlocked, 0);
  assert(!entry.inversionSignal);
});

Deno.test("census - idle-task counts ignore stream occupancy (Issue #3852)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/neat",
        issues: [
          issue(40, ["work-on"], ["vibe-bot"]),
          issue(41, ["idle-task"]),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.idleTask, 1);
  assertEquals(entry.streamOccupied, 0);
  assert(!entry.inversionSignal);
});

Deno.test("formatter - per-repo line carries the stream_occupied count (Issue #3852)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/neat",
        issues: [
          issue(50, ["work-on"], ["vibe-bot"]),
          issue(51, ["work-on"]),
        ],
      }),
    ],
  });
  const line = formatIdleDecisionCensus(census).find((l) =>
    l.includes("repo=org/neat")
  )!;
  assert(line.includes("stream_occupied=1"));
  assert(line.includes("work_on=0"));
  assert(line.includes("inversion_signal=false"));
});

// ---------------------------------------------------------------------------
// Merged-PR permanent block (GRQ#4419 / VibeCoder#429)
// ---------------------------------------------------------------------------

function mergedPR(number: number, title: string): ClosedPR {
  return {
    number,
    title,
    closedAt: "2026-08-23T07:52:58Z",
    merged: true,
  };
}

Deno.test("census - a merged fleet PR permanently blocks the issue it names (GRQ#4419)", () => {
  // GRQ#4326: open, `work-on`, no assignee, no blocking label, no open PR —
  // yet merged PR #4336 names it, so the scan refuses it under
  // `merged-pr-permanent` on every cycle, for ever.
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/GRQ",
        issues: [issue(4326, ["work-on", "bug"])],
        mergedPRs: [
          mergedPR(
            4336,
            "bug: Learn threw away most of its seeds — the #4326 collapses " +
              "(Issue #4326) (#4336)",
          ),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 0);
  assertEquals(entry.mergedPrBlocked, 1);
  assert(!entry.inversionSignal);
  assert(!census.inversionDetected);
});

Deno.test("census - a merged PR naming a different issue does not block (GRQ#4419)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/GRQ",
        issues: [issue(4405, ["work-on"])],
        mergedPRs: [mergedPR(4415, "Something else entirely (Issue #4406)")],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 1);
  assertEquals(entry.mergedPrBlocked, 0);
  assert(entry.inversionSignal);
});

Deno.test("census - a closed-unmerged PR does not raise mergedPrBlocked (GRQ#4419)", () => {
  // Closed-unmerged is a cooldown-windowed retry path, not a permanent
  // strand — it clears itself, so the census keeps counting the issue.
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/GRQ",
        issues: [issue(4405, ["work-on"])],
        mergedPRs: [{
          number: 4415,
          title: "Retry later (Issue #4405)",
          closedAt: "2026-08-26T07:00:00Z",
          merged: false,
        }],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 1);
  assertEquals(entry.mergedPrBlocked, 0);
  assert(entry.inversionSignal);
});

Deno.test("census - stream occupancy is attributed ahead of a merged PR (GRQ#4419)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/GRQ",
        issues: [
          issue(60, ["work-on"], ["vibe-bot"], "M1"),
          issue(61, ["work-on"], [], "M1"),
        ],
        mergedPRs: [mergedPR(62, "Done (Issue #61)")],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.streamOccupied, 1);
  assertEquals(entry.mergedPrBlocked, 0);
});

Deno.test("census - idle-task counts ignore the merged-PR gate (GRQ#4419)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/GRQ",
        issues: [issue(70, ["idle-task"])],
        mergedPRs: [mergedPR(71, "Done (Issue #70)")],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.idleTask, 1);
  assertEquals(entry.mergedPrBlocked, 0);
});

Deno.test("formatter - per-repo line carries the merged_pr_blocked count (GRQ#4419)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/GRQ",
        issues: [issue(4326, ["work-on"])],
        mergedPRs: [mergedPR(4336, "Fixed (Issue #4326)")],
      }),
    ],
  });
  const line = formatIdleDecisionCensus(census).find((l) =>
    l.includes("repo=stSoftwareAU/GRQ")
  )!;
  assert(line.includes("merged_pr_blocked=1"));
  assert(line.includes("work_on=0"));
  assert(line.includes("inversion_signal=false"));
});

// ---------------------------------------------------------------------------
// Issue #437: escalation needs a scan that actually refused the work
// ---------------------------------------------------------------------------
// The claim scan stops before its next claim whenever the cycle deadline /
// claim-runway floor is reached, a shutdown is requested, or the pool is
// draining. It never evaluated the backlog on such a cycle, so "the claim
// scan keeps refusing this work" is not a conclusion the census may draw.

Deno.test("census - an unscanned repo's inversion is deferred, not escalated (Issue #437)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/VibeCoder",
        scannedThisCycle: false,
        skipReason: "cycle_deadline",
        issues: [issue(426, ["work-on"]), issue(425, ["work-on"])],
      }),
    ],
  });
  // The work is real, so the filer must still be suppressed (Issue #2813).
  assertEquals(census.inversionDetected, true);
  assertEquals(census.inversionRepos, ["stSoftwareAU/VibeCoder"]);
  // But nothing refused it, so it is not evidence for the Issue #321 streak.
  assertEquals(census.escalationRepos, []);
  assertEquals(census.deferredInversionRepos, ["stSoftwareAU/VibeCoder"]);
});

Deno.test("census - a scanned repo's inversion is escalation-worthy (Issue #437)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/scanned",
        scannedThisCycle: true,
        issues: [issue(1, ["work-on"])],
      }),
    ],
  });
  assertEquals(census.escalationRepos, ["org/scanned"]);
  assertEquals(census.deferredInversionRepos, []);
});

Deno.test("census - escalation is decided per repo, not per cycle (Issue #437)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/scanned",
        scannedThisCycle: true,
        issues: [issue(1, ["work-on"])],
      }),
      repoInput({
        repo: "org/deadline",
        scannedThisCycle: false,
        skipReason: "cycle_deadline",
        issues: [issue(2, ["top-priority"])],
      }),
      // Unscanned but with nothing claimable: neither list may name it.
      repoInput({
        repo: "org/quiet",
        scannedThisCycle: false,
        skipReason: "cycle_deadline",
        issues: [issue(3, ["idle-task"])],
      }),
    ],
  });
  assertEquals(census.inversionRepos, ["org/scanned", "org/deadline"]);
  assertEquals(census.escalationRepos, ["org/scanned"]);
  assertEquals(census.deferredInversionRepos, ["org/deadline"]);
});

Deno.test("census - a non-monitored unscanned repo appears in neither list (Issue #437)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/external",
        monitored: false,
        scannedThisCycle: false,
        skipReason: "cycle_deadline",
        issues: [issue(1, ["work-on"])],
      }),
    ],
  });
  assertEquals(census.inversionDetected, false);
  assertEquals(census.escalationRepos, []);
  assertEquals(census.deferredInversionRepos, []);
});

Deno.test("formatter - reports a deferred inversion instead of dropping it (Issue #437)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/VibeCoder",
        scannedThisCycle: false,
        skipReason: "cycle_deadline",
        issues: [issue(426, ["work-on"])],
      }),
    ],
  });
  const lines = formatIdleDecisionCensus(census, "host1:42");
  const repoLine = lines.find((l) =>
    l.includes("repo=stSoftwareAU/VibeCoder")
  )!;
  assert(repoLine.includes("scanned=false"));
  assert(repoLine.includes("skip_reason=cycle_deadline"));
  const note = lines.find((l) => l.includes("NOTE inversion_not_escalated"))!;
  assert(note.includes("repos=stSoftwareAU/VibeCoder"));
  assert(note.includes("host=host1:42"));
  // The inversion itself is still alerted — the work is real.
  assert(lines.some((l) => l.includes("ALERT inversion")));
});

Deno.test("formatter - no deferral note when every inverted repo was scanned (Issue #437)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({ repo: "org/scanned", issues: [issue(1, ["work-on"])] }),
    ],
  });
  const lines = formatIdleDecisionCensus(census);
  assert(!lines.some((l) => l.includes("NOTE inversion_not_escalated")));
});

// ===========================================================================
// Issue #460 — the census must model the scan's dependency gate
// ===========================================================================
//
// GRQ#4465: the census modelled three of the claim scan's gates
// (`pr_blocked`, `stream_occupied`, `merged_pr_blocked`) while
// `collect_work_on_candidates.ts` also refuses `dependency-blocked` work via
// `isDependencyBlocked`. Every gate present in one side and missing from the
// other is a manufactured inversion: the census calls the issue claimable,
// the scan skips it, and after three cycles a human is handed an issue about
// a bug nobody has.

function depIssue(
  number: number,
  labels: string[],
  body: string,
): CensusIssue {
  return { number, labels, assignees: [], milestone: "", body };
}

Deno.test("#460 - an issue blocked by an open same-repo dependency is not claimable", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    repos: [repoInput({
      repo: "o/r",
      issues: [
        depIssue(10, ["work-on"], "Depends on #11"),
        issue(11, []),
      ],
    })],
  });
  const entry = census.perRepo[0];
  assert(entry);
  assertEquals(entry.unblocked.workOn, 0, "the scan refuses it, so must we");
  assertEquals(entry.dependencyBlocked, 1);
  assertEquals(entry.inversionSignal, false);
});

Deno.test("#460 - a closed dependency does not block", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    // #11 is absent from the open-issue list, so it is closed.
    repos: [repoInput({
      repo: "o/r",
      issues: [depIssue(10, ["work-on"], "Depends on #11")],
    })],
  });
  const entry = census.perRepo[0];
  assert(entry);
  assertEquals(entry.unblocked.workOn, 1);
  assertEquals(entry.dependencyBlocked, 0);
  assertEquals(entry.inversionSignal, true);
});

Deno.test("#460 - 'blocked by' is honoured alongside 'depends on'", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    repos: [repoInput({
      repo: "o/r",
      issues: [depIssue(10, ["top-priority"], "Blocked by #11"), issue(11, [])],
    })],
  });
  assertEquals(census.perRepo[0]?.dependencyBlocked, 1);
});

Deno.test("#460 - a cross-repo dependency blocks: the scan fails safe, so does the census", () => {
  // `isDependencyBlocked` returns true when it cannot resolve the dependency.
  // Matching that here keeps the census on the under-counting side, which at
  // worst files an idle-task beside real work — the bounded-harm direction
  // this module already prefers — rather than manufacturing an inversion.
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    repos: [repoInput({
      repo: "o/r",
      issues: [depIssue(10, ["work-on"], "Depends on other/repo#3")],
    })],
  });
  assertEquals(census.perRepo[0]?.dependencyBlocked, 1);
  assertEquals(census.perRepo[0]?.unblocked.workOn, 0);
});

Deno.test("#460 - a dependency named inside a code span is not a dependency", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    repos: [repoInput({
      repo: "o/r",
      issues: [
        depIssue(10, ["work-on"], "the fix is to write `Depends on #11`"),
        issue(11, []),
      ],
    })],
  });
  assertEquals(census.perRepo[0]?.dependencyBlocked, 0);
  assertEquals(census.perRepo[0]?.unblocked.workOn, 1);
});

Deno.test("#460 - no body means no dependency modelling, as before", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    repos: [repoInput({
      repo: "o/r",
      issues: [issue(10, ["work-on"]), issue(11, [])],
    })],
  });
  assertEquals(census.perRepo[0]?.dependencyBlocked, 0);
  assertEquals(census.perRepo[0]?.unblocked.workOn, 1);
});

Deno.test("#460 - a more fundamental gate keeps its reason", () => {
  // PR-blocked wins over dependency-blocked, matching the scan's order and
  // the existing `pr_blocked` / `merged_pr_blocked` precedence.
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    repos: [repoInput({
      repo: "o/r",
      issues: [depIssue(10, ["work-on"], "Depends on #11"), issue(11, [])],
      openPRs: [openPR(7, "main", "issue-10")],
    })],
  });
  const entry = census.perRepo[0];
  assert(entry);
  assertEquals(entry.prBlocked, 1);
  assertEquals(entry.dependencyBlocked, 0);
});

Deno.test("#460 - the census line reports dependency_blocked", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    repos: [repoInput({
      repo: "o/r",
      issues: [depIssue(10, ["work-on"], "Depends on #11"), issue(11, [])],
    })],
  });
  const lines = formatIdleDecisionCensus(census, "host:1");
  const repoLine = lines.find((l) => l.includes("repo=o/r"));
  assert(repoLine, "a per-repo line is emitted");
  assert(
    repoLine.includes("dependency_blocked=1"),
    `the deferral must stay observable; got: ${repoLine}`,
  );
});

Deno.test("#460 - the census exposes which issues it counted as claimable", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    repos: [repoInput({
      repo: "o/r",
      issues: [issue(10, ["work-on"]), issue(12, ["top-priority"])],
    })],
  });
  assertEquals(census.perRepo[0]?.claimableIssues, [10, 12]);
});

// ===========================================================================
// Issue #460 — a repo the scan claimed from is not a repo it refused
// ===========================================================================

Deno.test("#460 - a repo the scan claimed from does not escalate", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    claimedRepos: ["o/served"],
    repos: [
      repoInput({ repo: "o/served", issues: [issue(1, ["work-on"])] }),
      repoInput({ repo: "o/refused", issues: [issue(2, ["work-on"])] }),
    ],
  });
  assertEquals(census.escalationRepos, ["o/refused"]);
});

Deno.test("#460 - a served repo still raises the inversion signal", () => {
  // The signal suppresses the idle-task filer (Issue #2813) and must keep
  // doing so: unclaimed work beside a filed idle-task is still an inversion.
  // Only the *escalation* — "the scan keeps refusing this" — is withdrawn.
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    claimedRepos: ["o/served"],
    repos: [repoInput({ repo: "o/served", issues: [issue(1, ["work-on"])] })],
  });
  assertEquals(census.inversionDetected, true);
  assertEquals(census.inversionRepos, ["o/served"]);
  assertEquals(census.escalationRepos, []);
});

Deno.test("#460 - a served repo is reported, not silently dropped", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    claimedRepos: ["o/served"],
    repos: [repoInput({ repo: "o/served", issues: [issue(1, ["work-on"])] })],
  });
  assertEquals(census.servedInversionRepos, ["o/served"]);
  const lines = formatIdleDecisionCensus(census, "host:1");
  assert(
    lines.some((l) => l.includes("inversion_not_escalated_served")),
    `the withdrawal must stay visible in the log; got:\n${lines.join("\n")}`,
  );
});

Deno.test("#460 - omitting claimedRepos preserves the old behaviour", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "worker",
    repos: [repoInput({ repo: "o/r", issues: [issue(1, ["work-on"])] })],
  });
  assertEquals(census.escalationRepos, ["o/r"]);
  assertEquals(census.servedInversionRepos, []);
});

// ===========================================================================
// Issue #460 — the regression guard
// ===========================================================================
//
// The recurring failure is not any one missing gate; it is that a gate can be
// added to the claim scan and forgotten in the census. That has now happened
// three times (#3526 pr_blocked, #3852 stream_occupied, GRQ#4419
// merged_pr_blocked) and each cost a human an issue about a bug nobody had.
//
// `CENSUS_SCAN_GATE_COVERAGE` is a total map over the scan's own
// `SkipReason` union, so a new skip reason fails the type check until
// somebody classifies it. These tests pin the classifications that matter.

Deno.test("#460 - every scan skip reason has a census verdict", () => {
  for (const reason of SKIP_REASONS) {
    assert(
      CENSUS_SCAN_GATE_COVERAGE[reason] !== undefined,
      `${reason} has no census verdict — classify it in ` +
        `CENSUS_SCAN_GATE_COVERAGE, do not leave it to be discovered in a log`,
    );
  }
});

Deno.test("#460 - the gates that manufactured GRQ#4465 are modelled", () => {
  for (
    const reason of [
      "pr-blocked",
      "merged-pr-permanent",
      "milestone-occupied",
      "dependency-blocked",
    ] as const
  ) {
    assertEquals(
      CENSUS_SCAN_GATE_COVERAGE[reason],
      "modelled",
      `${reason} excludes work from the scan, so the census must exclude it too`,
    );
  }
});

Deno.test("#460 - no gate is left unclassified", () => {
  const unclassified = SKIP_REASONS.filter(
    (r) => CENSUS_SCAN_GATE_COVERAGE[r] === "unclassified",
  );
  assertEquals(
    unclassified,
    [],
    "an unclassified gate is exactly how #3526, #3852 and GRQ#4419 happened",
  );
});

// ---------------------------------------------------------------------------
// Tier-3 suppression (Issue #499)
// ---------------------------------------------------------------------------
// `selectHighestPriority` drops every `low-priority` candidate from a repo
// holding a *suppressing* open `work-on` issue (`reposWithOpenWorkOn`), so a
// suppressed backlog is not work the scan refused — it is work the scan is
// deliberately serialising behind higher-tier work. The census must model the
// same gate or it manufactures an inversion alert against a scan that is right.

Deno.test("census - a suppressing work-on issue removes the low-priority backlog from the claimable count (Issue #499)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [
          issue(1, ["work-on"]),
          issue(2, ["low-priority"]),
          issue(3, ["low-priority"]),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 1);
  assertEquals(entry.unblocked.lowPriority, 0);
  assertEquals(entry.lowPrioritySuppressed, 2);
  // The work-on issue is itself claimable, so the repo is still inverted —
  // the signal is now attributed to the issue the scan can actually claim.
  assertEquals(entry.claimableIssues, [1]);
  assert(entry.inversionSignal);
});

Deno.test("census - with no work-on issue the low-priority backlog stays claimable (Issue #499)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(2, ["low-priority"]), issue(3, ["low-priority"])],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.lowPriority, 2);
  assertEquals(entry.lowPrioritySuppressed, 0);
  assert(entry.inversionSignal);
});

Deno.test("census - a permanently merged-PR-blocked work-on issue does not suppress the backlog (Issue #499)", () => {
  // The NEAT-AI-Rebase case: #48 is `work-on` but named by merged PR #49, so
  // the scan refuses it for ever. It must not strand the 28-issue backlog, and
  // the census must keep reporting that backlog as claimable so the two agree.
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "stSoftwareAU/NEAT-AI-Rebase",
        issues: [
          issue(48, ["work-on"]),
          issue(43, ["low-priority"]),
          issue(42, ["low-priority"]),
        ],
        mergedPRs: [
          mergedPR(49, "Emit population-candidate.json (Issue #48)"),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 0);
  assertEquals(entry.mergedPrBlocked, 1);
  assertEquals(entry.unblocked.lowPriority, 2);
  assertEquals(entry.lowPrioritySuppressed, 0);
  assertEquals(entry.claimableIssues, [43, 42]);
});

Deno.test("census - a purely dependency-blocked work-on issue does not suppress the backlog (Issue #2610)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [
          { ...issue(1, ["work-on"]), body: "Depends on #2" },
          issue(2, ["low-priority"]),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.dependencyBlocked, 1);
  // The dependency is the low-priority issue itself — suppressing it would
  // deadlock the chain, which is exactly why #2610 carved it out.
  assertEquals(entry.unblocked.lowPriority, 1);
  assertEquals(entry.lowPrioritySuppressed, 0);
});

Deno.test("census - a stream-occupied work-on issue still suppresses the backlog (Issue #499)", () => {
  // Occupancy clears by itself once the in-flight claim lands, so waiting is
  // the scan's correct behaviour (the issue survives `filterAndSort` and keeps
  // raising `hasSuppressingWorkOn`). The census must agree rather than
  // counting the backlog as work the scan refused.
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [
          issue(1, ["work-on"], ["vibe-bot"], "M1"),
          issue(2, ["work-on"], [], "M1"),
          issue(3, ["low-priority"], [], ""),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.streamOccupied, 1);
  assertEquals(entry.unblocked.workOn, 0);
  assertEquals(entry.unblocked.lowPriority, 0);
  assertEquals(entry.lowPrioritySuppressed, 1);
  assert(!entry.inversionSignal);
});

Deno.test("census - a blocked-label work-on issue does not suppress the backlog (Issue #2751)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [
          issue(1, ["work-on", "needs-human"]),
          issue(2, ["low-priority"]),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 0);
  assertEquals(entry.unblocked.lowPriority, 1);
  assertEquals(entry.lowPrioritySuppressed, 0);
});

Deno.test("formatter - per-repo line carries the low_priority_suppressed count (Issue #499)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["work-on"]), issue(2, ["low-priority"])],
      }),
    ],
  });
  const line = formatIdleDecisionCensus(census).find((l) =>
    l.includes("repo=org/a")
  )!;
  assert(line.includes("low_priority_suppressed=1"));
  assert(line.includes("low_priority=0"));
});

// ---------------------------------------------------------------------------
// Run-local holds (Issue #655)
// ---------------------------------------------------------------------------
// `find_oldest_issue.ts` drops every candidate `isIssueInCooldown` names —
// the persisted retry cooldown and the per-run processed-issue registry —
// *after* the collectors have passed it. The census did not model that gate,
// so an issue this run had already finished with kept counting as claimable
// on every later cycle: the registry lives as long as the process does.

Deno.test("census - an issue this run is holding back is not claimable (Issue #655)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["work-on"]), issue(2, ["work-on"])],
        runLocalHolds: new Set([1, 2]),
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 0);
  assertEquals(entry.runLocalHold, 2);
  assertEquals(entry.claimableIssues, []);
  assert(
    !entry.inversionSignal,
    "the scan refused this work for a reason the census can now see",
  );
  assertEquals(census.escalationRepos, []);
});

Deno.test("census - a run-local hold only removes the issues it names (Issue #655)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["work-on"]), issue(2, ["work-on"])],
        runLocalHolds: new Set([1]),
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 1);
  assertEquals(entry.runLocalHold, 1);
  assertEquals(entry.claimableIssues, [2]);
  assert(entry.inversionSignal);
});

Deno.test("census - a more fundamental gate keeps its own attribution (Issue #655)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["work-on"], [], "")],
        openPRs: [openPR(9, "main", "fix/thing")],
        runLocalHolds: new Set([1]),
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.prBlocked, 1);
  assertEquals(entry.runLocalHold, 0);
});

Deno.test("census - the idle-task count honours run-local holds (Issue #655)", () => {
  // The scan applies the same cooldown filter to idle-task candidates, so a
  // held wrapper is not idle work the filer can claim either.
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["idle-task"]), issue(2, ["idle-task"])],
        runLocalHolds: new Set([1]),
      }),
    ],
  });
  assertEquals(census.perRepo[0]!.unblocked.idleTask, 1);
});

Deno.test("census - omitted runLocalHolds behaves as no holds (Issue #655)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [repoInput({ repo: "org/a", issues: [issue(1, ["work-on"])] })],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 1);
  assertEquals(entry.runLocalHold, 0);
});

Deno.test("census - a held work-on issue still serialises the lower tiers (Issue #655)", () => {
  // The scan increments its suppression count inside the collector, before
  // the cooldown filter runs, so the repo stays serialised behind the held
  // work-on issue. The census must agree or it manufactures the inversion
  // one tier down.
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["work-on"]), issue(2, ["low-priority"])],
        runLocalHolds: new Set([1]),
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.runLocalHold, 1);
  assertEquals(entry.unblocked.lowPriority, 0);
  assertEquals(entry.lowPrioritySuppressed, 1);
  assert(!entry.inversionSignal);
});

Deno.test("formatter - per-repo line carries the run_local_hold count (Issue #655)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [
      repoInput({
        repo: "org/a",
        issues: [issue(1, ["work-on"])],
        runLocalHolds: new Set([1]),
      }),
    ],
  });
  const line = formatIdleDecisionCensus(census).find((l) =>
    l.includes("repo=org/a")
  )!;
  assert(line.includes("run_local_hold=1"));
  assert(line.includes("work_on=0"));
});

Deno.test("#655 - the cooldown gate is modelled, not silently over-counted", () => {
  assertEquals(
    CENSUS_SCAN_GATE_COVERAGE["cooldown"],
    "modelled",
    "the run-local cooldown filter refused VibeCoder#622/#623 on cycle " +
      "after cycle while the census called them claimable",
  );
});

// --- The scan's own account set (Issue #753) -------------------------------
//
// The claim scan refuses a stream held by **any** trusted account
// (`isMilestoneOccupied` over `workerUser ∪ allowedAuthors`); the census
// counted only the worker's own assignments. On stSoftwareAU/VibeCoder a
// human took two unmilestoned issues — occupying the default-branch stream —
// and the scan then refused every other unmilestoned `work-on` issue with
// `milestone-occupied`, while the census reported `work_on=3` and raised an
// inversion on three consecutive cycles. Neither instrument was wrong about
// its own rule; they were applying different ones.

Deno.test("census - a trusted author's assignment occupies the stream, as the scan says it does (Issue #753)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    allowedAuthors: ["nleck"],
    repos: [
      repoInput({
        repo: "org/neat",
        issues: [
          // A human holds one issue in the milestone…
          issue(40, ["work-on"], ["nleck"], "v2"),
          // …so its siblings are what the scan calls milestone-occupied.
          issue(41, ["work-on"], [], "v2"),
          issue(42, ["work-on"], [], "v2"),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.unblocked.workOn, 0);
  // The held issue itself is not counted at all — an assigned issue is
  // already refused by the label/assignee gate — so what is attributed to
  // occupancy is its two siblings.
  assertEquals(entry.streamOccupied, 2);
  assertEquals(entry.inversionSignal, false);
  assertEquals(census.inversionRepos, []);
});

Deno.test("census - the reported inversion is not raised once the sets agree (Issue #753)", () => {
  // The filed case, in shape: a human holds two unmilestoned issues, which
  // occupies the default-branch stream for the scan, and three other
  // unmilestoned `work-on` issues are refused `milestone-occupied` while the
  // census calls them claimable.
  const issues = [
    issue(750, ["bug"], ["nleck"]),
    issue(751, ["bug"], ["nleck"]),
    issue(743, ["work-on"]),
    issue(745, ["work-on"]),
    issue(747, ["work-on"]),
  ];

  const before = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    repos: [repoInput({ repo: "stSoftwareAU/VibeCoder", issues })],
  });
  // Without the scan's set, the human's assignments are invisible and all
  // three read as claimable — `work_on=3`, the alert as filed.
  assertEquals(before.perRepo[0]!.unblocked.workOn, 3);
  assertEquals(before.perRepo[0]!.streamOccupied, 0);
  assert(before.perRepo[0]!.inversionSignal);

  const after = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    allowedAuthors: ["nleck"],
    repos: [repoInput({ repo: "stSoftwareAU/VibeCoder", issues })],
  });
  assertEquals(after.perRepo[0]!.unblocked.workOn, 0);
  assertEquals(after.perRepo[0]!.streamOccupied, 3);
  assertEquals(after.perRepo[0]!.inversionSignal, false);
  assertEquals(after.escalationRepos, []);
});

Deno.test("census - an account the scan does not honour still does not occupy (Issue #753)", () => {
  // The narrow set existed so a sibling host's claim could not silence this
  // host's signal. Honouring exactly the configured set keeps that: an
  // account nobody trusts occupies nothing here, because it blocks nothing
  // in the scan either.
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    allowedAuthors: ["nleck"],
    repos: [
      repoInput({
        repo: "org/neat",
        issues: [
          issue(50, ["work-on"], ["stranger"], "v2"),
          issue(51, ["work-on"], [], "v2"),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.streamOccupied, 0);
  assertEquals(entry.unblocked.workOn, 1);
  assert(entry.inversionSignal);
});

Deno.test("census - the account set is matched case-insensitively, as the scan matches it (Issue #753)", () => {
  const census = buildIdleDecisionCensus({
    decisionPoint: "filing",
    workerUser: "vibe-bot",
    allowedAuthors: ["NLeck"],
    repos: [
      repoInput({
        repo: "org/neat",
        issues: [
          issue(60, ["bug"], ["nleck"], "v2"),
          issue(61, ["work-on"], [], "v2"),
        ],
      }),
    ],
  });
  const entry = census.perRepo[0]!;
  assertEquals(entry.streamOccupied, 1);
  assertEquals(entry.unblocked.workOn, 0);
});
