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
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildIdleDecisionCensus,
  type CensusIssue,
  formatIdleDecisionCensus,
  type RepoCensusInput,
} from "../lib/idle_decision_census.ts";
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
  assertEquals(entry.unblocked.lowPriority, 1);
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
