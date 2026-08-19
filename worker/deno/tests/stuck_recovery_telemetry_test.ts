/**
 * Telemetry tests for stuck_recovery.ts (Issue #1884).
 *
 * Verifies that `detectAssignedWithoutHeartbeat` and
 * `recoverStaleGithubAssignments` emit one structured
 * `RecoveryDecisionEvent` per scanned assigned issue with the correct
 * decision string, marker classification, and supporting fields.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertExists } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  __getRecoveryDecisions,
  __resetRecoveryDecisions,
  classifyMarkers,
  formatHeartbeatMarker,
  HEARTBEAT_MARKER_PREFIX,
} from "../lib/stuck_issue_detector.ts";
import {
  detectAssignedWithoutHeartbeat,
  recoverStaleGithubAssignments,
} from "../lib/stuck_recovery.ts";
import {
  heartbeatFilePath,
  STUCK_ISSUE_DEFAULTS,
  type StuckIssueConfig,
} from "../lib/stuck_issue_detector.ts";

async function makeTempDir(prefix = "rt-"): Promise<string> {
  return await Deno.makeTempDir({ prefix });
}

function testConfig(workDir: string, machineId?: string): StuckIssueConfig {
  return {
    workDir,
    stuckIssueTimeout: STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
    assignedNoHeartbeatTimeout: STUCK_ISSUE_DEFAULTS.assignedNoHeartbeatTimeout,
    staleAssignmentTimeout: STUCK_ISSUE_DEFAULTS.staleAssignmentTimeout,
    repos: ["org/repo"],
    ...(machineId ? { machineId } : {}),
  };
}

function buildIssue(num: number, updatedAt: string): Record<string, unknown> {
  return {
    number: num,
    title: `Issue ${num}`,
    assignees: [{ login: "testuser" }],
    labels: [],
    author: { login: "alice" },
    createdAt: updatedAt,
    updatedAt,
    url: `https://example/${num}`,
    milestone: null,
  };
}

// ============================================================================
// classifyMarkers — pure helper
// ============================================================================

Deno.test("recovery telemetry - classifyMarkers reports none when no markers", () => {
  const r = classifyMarkers([], "m1", 1_700_000_000, 1800);
  assertEquals(r.state, "none");
  assertEquals(r.latest, null);
  assertEquals(r.skip.skip, false);
});

Deno.test("recovery telemetry - classifyMarkers reports live for fresh peer marker", () => {
  const now = 1_700_000_000;
  const r = classifyMarkers(
    [{ machineId: "peer", epoch: now - 60 }],
    "m1",
    now,
    1800,
  );
  assertEquals(r.state, "live");
  assertEquals(r.skip.skip, true);
  if (r.skip.skip) assertEquals(r.skip.decision, "skipped:live_marker");
});

Deno.test("recovery telemetry - classifyMarkers reports own_machine for fresh self marker", () => {
  const now = 1_700_000_000;
  const r = classifyMarkers(
    [{ machineId: "m1", epoch: now - 99999 }],
    "m1",
    now,
    1800,
  );
  // Older than the timeout, but matches our machine — own_machine skip.
  assertEquals(r.skip.skip, true);
  if (r.skip.skip) assertEquals(r.skip.decision, "skipped:own_machine");
});

Deno.test("recovery telemetry - classifyMarkers reports stale when peer marker beyond timeout", () => {
  const now = 1_700_000_000;
  const r = classifyMarkers(
    [{ machineId: "peer", epoch: now - 10000 }],
    "m1",
    now,
    1800,
  );
  assertEquals(r.state, "stale");
  assertEquals(r.skip.skip, false);
});

Deno.test("recovery telemetry - classifyMarkers reports cleared when latest epoch is zero (no cleared suffix)", () => {
  // epoch=0 alone (legacy shape) — state is cleared but skip remains false.
  const r = classifyMarkers(
    [{ machineId: "peer", epoch: 0 }],
    "m1",
    1_700_000_000,
    1800,
  );
  assertEquals(r.state, "cleared");
  assertEquals(r.skip.skip, false);
});

// ============================================================================
// classifyMarkers — cleared marker (Issue #1886)
// ============================================================================

Deno.test("recovery telemetry - classifyMarkers reports skipped:cleared_marker for cleared marker", () => {
  const r = classifyMarkers(
    [{ machineId: "peer", epoch: 0, cleared: true }],
    "m1",
    1_700_000_000,
    1800,
  );
  assertEquals(r.state, "cleared");
  assertEquals(r.skip.skip, true);
  if (r.skip.skip) assertEquals(r.skip.decision, "skipped:cleared_marker");
});

Deno.test("recovery telemetry - classifyMarkers prefers cleared over a coexisting fresh peer marker", () => {
  // If both a cleared release signal AND a fresh peer marker are
  // present, the cleared signal wins — the previous worker finished
  // cleanly and the issue must not be recovered.
  const now = 1_700_000_000;
  const r = classifyMarkers(
    [
      { machineId: "peer", epoch: now - 60 }, // would otherwise be live
      { machineId: "peer", epoch: 0, cleared: true },
    ],
    "m1",
    now,
    1800,
  );
  assertEquals(r.state, "cleared");
  assertEquals(r.skip.skip, true);
  if (r.skip.skip) assertEquals(r.skip.decision, "skipped:cleared_marker");
});

Deno.test("recovery telemetry - detectAssignedWithoutHeartbeat emits 'skipped:cleared_marker' when a cleared marker is present", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.assignedNoHeartbeatTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(106, oldUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        // The shape clearHeartbeat writes when a worker releases a claim.
        return JSON.stringify([{
          body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:done-machine:0 --> ` +
            `<!-- cleared: claim released by machine done-machine -->`,
        }]);
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "skipped:cleared_marker");
    assertEquals(e.markerState, "cleared");
    assertEquals(e.markerMachineId, "done-machine");
    assertEquals(e.markerEpoch, 0);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// detectAssignedWithoutHeartbeat — telemetry per scanned issue
// ============================================================================

Deno.test("recovery telemetry - detectAssignedWithoutHeartbeat emits 'recovered' with elapsed + marker fields", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.assignedNoHeartbeatTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(101, oldUpdatedAt)]);
      }
      // open PR search → none
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      // marker scan → no markers
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return JSON.stringify([]);
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.source, "detectAssignedWithoutHeartbeat");
    assertEquals(e.issue, "org/repo#101");
    assertEquals(e.assignee, "testuser");
    assertEquals(e.elapsedSinceUpdate, elapsed);
    assertEquals(e.markerState, "none");
    assertEquals(e.markerMachineId, null);
    assertEquals(e.markerEpoch, null);
    assertEquals(e.linkedOpenPR, null);
    assertEquals(e.localHeartbeatPresent, false);
    assertEquals(e.decision, "recovered");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recovery telemetry - detectAssignedWithoutHeartbeat emits 'skipped:has_local_heartbeat' when heartbeat file exists", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.assignedNoHeartbeatTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();

    // Pre-create a heartbeat file
    await Deno.writeTextFile(
      heartbeatFilePath(workDir, "org/repo", 102),
      String(now),
    );

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(102, oldUpdatedAt)]);
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "skipped:has_local_heartbeat");
    assertEquals(e.localHeartbeatPresent, true);
    assertEquals(e.issue, "org/repo#102");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recovery telemetry - heartbeat short-circuits GraphQL pr-linkage check (Issue #1924)", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.assignedNoHeartbeatTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();

    // Pre-create a heartbeat file so the decision short-circuits.
    await Deno.writeTextFile(
      heartbeatFilePath(workDir, "org/repo", 999),
      String(now),
    );

    // Track every gh invocation so we can assert no GraphQL call was made.
    const calls: string[][] = [];
    const ghFn = (args: string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([buildIssue(999, oldUpdatedAt)]));
      }
      // Any other call (in particular `api graphql`) should not happen.
      return Promise.resolve("");
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "skipped:has_local_heartbeat");
    assertEquals(e.localHeartbeatPresent, true);
    // The GraphQL pr-linkage round-trip must be skipped when a local
    // heartbeat already determines the decision.
    const graphqlCalls = calls.filter((args) =>
      args[0] === "api" && args[1] === "graphql"
    );
    assertEquals(graphqlCalls.length, 0);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recovery telemetry - detectAssignedWithoutHeartbeat emits 'skipped:open_pr' when an open PR is linked", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.assignedNoHeartbeatTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(103, oldUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([{
          number: 555,
          title: "Fix bug (#103)",
          baseRefName: "main",
          headRefName: "h",
          mergedAt: null,
        }]);
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "skipped:open_pr");
    assertEquals(e.linkedOpenPR, "org/repo#555");
    assertEquals(e.localHeartbeatPresent, false);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recovery telemetry - detectAssignedWithoutHeartbeat emits 'skipped:live_marker' when a peer's marker is live", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.assignedNoHeartbeatTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();
    // Peer's marker, refreshed 60s ago — well within the timeout window.
    const peerEpoch = now - 60;

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(104, oldUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return JSON.stringify([{
          body: formatHeartbeatMarker("peer-machine", peerEpoch),
        }]);
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "skipped:live_marker");
    assertEquals(e.markerState, "live");
    assertEquals(e.markerMachineId, "peer-machine");
    assertEquals(e.markerEpoch, peerEpoch);
    assertExists(e.elapsedSinceUpdate);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recovery telemetry - detectAssignedWithoutHeartbeat emits 'skipped:within_threshold' for fresh assignment", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    // Updated 60 seconds ago — well within the threshold.
    const recentUpdatedAt = new Date((now - 60) * 1000).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(105, recentUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return JSON.stringify([]);
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "skipped:within_threshold");
    assertEquals(e.elapsedSinceUpdate, 60);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// recoverStaleGithubAssignments — also emits per-issue events
// ============================================================================

Deno.test("recovery telemetry - recoverStaleGithubAssignments emits 'recovered' for issues past staleAssignmentTimeout", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    const elapsed = config.staleAssignmentTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(201, oldUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return JSON.stringify([]);
      }
      return "";
    };

    const recovered = await recoverStaleGithubAssignments(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.source, "recoverStaleGithubAssignments");
    assertEquals(e.decision, "recovered");
    assertEquals(e.issue, "org/repo#201");
    assertEquals(e.elapsedSinceUpdate, elapsed);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recovery telemetry - HEARTBEAT_MARKER_PREFIX export is unchanged (smoke check for re-export)", () => {
  assertEquals(HEARTBEAT_MARKER_PREFIX, "VIBE_CODER_HEARTBEAT");
});

// ============================================================================
// Issue #1916: cleared-marker recovery skip must not strand re-assigned issues
// ============================================================================
//
// Issue #1886 added an unconditional `skipped:cleared_marker` short-circuit.
// In production this stranded three issues — assigned to `worker-bot`, no
// active heartbeat, no linked open PR, elapsed ~24h — because an old cleared
// marker from a previous successful worker run suppressed recovery forever.
//
// New rule: a cleared marker only suppresses recovery when one of the
// following is true:
//   - the marker was cleared by this same machine (sameMachine), or
//   - the issue's updatedAt is within the grace window (CLEARED_MARKER_GRACE_SECONDS).
// Otherwise fall through to the standard elapsed-vs-timeout decision.

Deno.test("recovery telemetry - cleared marker from different machine + no PR + no heartbeat + elapsed > grace → recovered (Issue #1916)", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    // 24 hours — beyond both the assignedNoHeartbeatTimeout and the
    // 1h cleared-marker grace window. Matches the live evidence in the
    // issue (elapsedSinceUpdate ~86_400).
    const elapsed = 86_400;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(1891, oldUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        // Cleared marker from a different machine (the previous worker run).
        return JSON.stringify([{
          body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:other-machine:0 --> ` +
            `<!-- cleared: claim released by machine other-machine -->`,
        }]);
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "recovered");
    assertEquals(e.markerState, "cleared");
    assertEquals(e.markerMachineId, "other-machine");
    assertEquals(e.markerEpoch, 0);
    assertEquals(e.linkedOpenPR, null);
    assertEquals(e.localHeartbeatPresent, false);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recovery telemetry - cleared marker from this machine still skips even when elapsed > grace (Issue #1886 preserved)", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    // Beyond grace window, but the cleared marker was written by THIS
    // machine — recovery must continue to skip (same-machine signal
    // preserves the original #1886 protection).
    const elapsed = 86_400;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(1892, oldUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return JSON.stringify([{
          body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:m1:0 --> ` +
            `<!-- cleared: claim released by machine m1 -->`,
        }]);
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    assertEquals(events[0]!.decision, "skipped:cleared_marker");
    assertEquals(events[0]!.markerMachineId, "m1");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recovery telemetry - cleared marker within grace window still skips even from a different machine (Issue #1916)", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    // 30 minutes — past the assignedNoHeartbeatTimeout default (1800s)
    // but inside the 1h cleared-marker grace window. The previous
    // worker just finished; do not race a still-completing peer.
    const elapsed = 1900;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(1893, oldUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return JSON.stringify([{
          body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:done-machine:0 --> ` +
            `<!-- cleared: claim released by machine done-machine -->`,
        }]);
      }
      return "";
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    assertEquals(events[0]!.decision, "skipped:cleared_marker");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("recovery telemetry - recoverStaleGithubAssignments unassigns when cleared marker is old + different machine (Issue #1916)", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir("rt-cache-");
  const workDir = await makeTempDir("rt-work-");
  try {
    const cache = new IssueCache(cacheDir);
    const config = testConfig(workDir, "m1");
    const now = 1_700_000_000;
    // Past staleAssignmentTimeout (default 14400s) and past the 1h
    // cleared-marker grace window.
    const elapsed = config.staleAssignmentTimeout + 100;
    const oldUpdatedAt = new Date((now - elapsed) * 1000).toISOString();

    const ghFn = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([buildIssue(2612, oldUpdatedAt)]);
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return JSON.stringify([]);
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return JSON.stringify([{
          body: `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-23-dff02c90:0 --> ` +
            `<!-- cleared: claim released by machine host-23-dff02c90 -->`,
        }]);
      }
      return "";
    };

    const recovered = await recoverStaleGithubAssignments(
      config,
      "testuser",
      () => now,
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.source, "recoverStaleGithubAssignments");
    assertEquals(e.decision, "recovered");
    assertEquals(e.markerState, "cleared");
    assertEquals(e.markerMachineId, "host-23-dff02c90");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});
