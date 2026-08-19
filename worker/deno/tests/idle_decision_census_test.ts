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
import type { OpenPR } from "../lib/issue_query.ts";

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
        repo: "org/neat",
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
  assertEquals(census.inversionRepos, ["org/neat"]);
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
        repo: "org/neat",
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
  const neatLine = lines.find((l) => l.includes("repo=org/neat"))!;
  assert(neatLine.includes("nice=5"));
  assert(neatLine.includes("work_on=1"));
  assert(neatLine.includes("inversion_signal=true"));

  // ALERT line names the offending repo.
  const alert = lines.find((l) => l.includes("ALERT inversion"))!;
  assert(alert.includes("repos=org/neat"));
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
// filer (the host-23 NEAT-AI-scorer #357–360 incident).

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
