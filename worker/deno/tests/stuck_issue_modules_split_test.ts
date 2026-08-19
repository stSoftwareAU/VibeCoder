/**
 * Tests verifying the post-split modules (Issue #1530) are independently
 * importable and behave identically to the orchestrator surface.
 *
 * The original behavioural coverage continues to live in
 * stuck_issue_detector_test.ts — these tests just guard the boundaries
 * between heartbeat_storage.ts, stuck_detection.ts, and stuck_recovery.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";

// Direct imports from the split modules
import {
  clearHeartbeat,
  formatHeartbeatMarker,
  HEARTBEAT_MARKER_PREFIX,
  heartbeatFilePath,
  parseHeartbeatMarker,
  recordHeartbeat,
} from "../lib/heartbeat_storage.ts";
import {
  hasOpenLinkedPR,
  isIssueStuck,
  parseHeartbeatFilename,
  parseISODate,
  shouldSkipRecoveryForMarker,
  STUCK_ISSUE_DEFAULTS,
  type StuckIssueConfig,
} from "../lib/stuck_detection.ts";
import {
  detectAndRecoverStuckHeartbeats,
  detectAssignedWithClosedPr,
  detectAssignedWithoutHeartbeat,
  recoverStaleGithubAssignments,
} from "../lib/stuck_recovery.ts";

// And from the barrel for re-export parity
import * as barrel from "../lib/stuck_issue_detector.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "sid-split-" });
}

function testConfig(workDir: string): StuckIssueConfig {
  return {
    workDir,
    stuckIssueTimeout: STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
    assignedNoHeartbeatTimeout: STUCK_ISSUE_DEFAULTS.assignedNoHeartbeatTimeout,
    staleAssignmentTimeout: STUCK_ISSUE_DEFAULTS.staleAssignmentTimeout,
    repos: [],
  };
}

// ---------------------------------------------------------------------------
// heartbeat_storage.ts directly usable
// ---------------------------------------------------------------------------

Deno.test("split - heartbeat_storage record/clear roundtrip", async () => {
  const dir = await makeTempDir();
  try {
    const result = await recordHeartbeat(dir, "org/repo", 99, () => 1234567);
    assertEquals(result.ok, true);
    assertEquals(
      await Deno.readTextFile(heartbeatFilePath(dir, "org/repo", 99)),
      "1234567",
    );
    const cleared = await clearHeartbeat(dir, "org/repo", 99);
    assertEquals(cleared.ok, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("split - heartbeat_storage marker round-trips through format/parse", () => {
  const body = formatHeartbeatMarker("host-x", 1700000000);
  const parsed = parseHeartbeatMarker(body);
  assertEquals(parsed, {
    machineId: "host-x",
    epoch: 1700000000,
    cleared: false,
  });
  assertEquals(body.includes(HEARTBEAT_MARKER_PREFIX), true);
});

// ---------------------------------------------------------------------------
// stuck_detection.ts directly usable
// ---------------------------------------------------------------------------

Deno.test("split - stuck_detection isIssueStuck honours timeout", async () => {
  const dir = await makeTempDir();
  try {
    await recordHeartbeat(dir, "org/repo", 1, () => 1000);
    assertEquals(
      await isIssueStuck(dir, "org/repo", 1, 100, () => 1050),
      false,
    );
    assertEquals(await isIssueStuck(dir, "org/repo", 1, 100, () => 1200), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("split - stuck_detection parseHeartbeatFilename rejects garbage", () => {
  assertEquals(parseHeartbeatFilename("nope"), null);
  assertEquals(parseHeartbeatFilename(".heartbeat_only_one"), null);
  assertEquals(
    parseHeartbeatFilename(".heartbeat_org_repo_7"),
    { repo: "org/repo", issueNumber: 7 },
  );
});

Deno.test("split - stuck_detection parseISODate handles valid and invalid input", () => {
  assertEquals(parseISODate("2024-01-01T00:00:00Z"), 1704067200);
  assertEquals(Number.isNaN(parseISODate("not a date")), true);
});

Deno.test("split - stuck_detection hasOpenLinkedPR is independently importable", async () => {
  const ghFn = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify([{ number: 1 }]));
  assertEquals(await hasOpenLinkedPR("org/repo", 1, ghFn), true);
});

Deno.test("split - stuck_detection shouldSkipRecoveryForMarker false on no markers", async () => {
  const ghFn = (_args: string[]): Promise<string> => Promise.resolve("[]");
  assertEquals(
    await shouldSkipRecoveryForMarker(
      "org/repo",
      1,
      "host-me",
      1800,
      () => 0,
      ghFn,
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// stuck_recovery.ts directly usable
// ---------------------------------------------------------------------------

Deno.test("split - stuck_recovery scan returns 0 in empty workdir", async () => {
  const dir = await makeTempDir();
  try {
    const recovered = await detectAndRecoverStuckHeartbeats(
      testConfig(dir),
      "u",
    );
    assertEquals(recovered, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("split - stuck_recovery detectAssignedWithoutHeartbeat needs repos", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const ghFn = (_args: string[]): Promise<string> => Promise.resolve("");
    const recovered = await detectAssignedWithoutHeartbeat(
      config,
      "u",
      () => 0,
      ghFn,
    );
    assertEquals(recovered, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("split - stuck_recovery recoverStaleGithubAssignments needs repos", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const ghFn = (_args: string[]): Promise<string> => Promise.resolve("");
    const recovered = await recoverStaleGithubAssignments(
      config,
      "u",
      () => 0,
      ghFn,
    );
    assertEquals(recovered, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("split - stuck_recovery detectAssignedWithClosedPr needs repos", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const ghFn = (_args: string[]): Promise<string> => Promise.resolve("");
    const recovered = await detectAssignedWithClosedPr(
      config,
      "u",
      "planning",
      ghFn,
    );
    assertEquals(recovered, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Barrel re-exports preserved for backwards compatibility
// ---------------------------------------------------------------------------

Deno.test("split - barrel re-exports the same functions as the source modules", () => {
  // Identity check: re-exports point at the same function references
  assertEquals(barrel.recordHeartbeat, recordHeartbeat);
  assertEquals(barrel.clearHeartbeat, clearHeartbeat);
  assertEquals(barrel.heartbeatFilePath, heartbeatFilePath);
  assertEquals(barrel.formatHeartbeatMarker, formatHeartbeatMarker);
  assertEquals(barrel.parseHeartbeatMarker, parseHeartbeatMarker);
  assertEquals(barrel.isIssueStuck, isIssueStuck);
  assertEquals(barrel.parseHeartbeatFilename, parseHeartbeatFilename);
  assertEquals(barrel.hasOpenLinkedPR, hasOpenLinkedPR);
  assertEquals(barrel.shouldSkipRecoveryForMarker, shouldSkipRecoveryForMarker);
  assertEquals(
    barrel.detectAndRecoverStuckHeartbeats,
    detectAndRecoverStuckHeartbeats,
  );
  assertEquals(
    barrel.detectAssignedWithoutHeartbeat,
    detectAssignedWithoutHeartbeat,
  );
  assertEquals(
    barrel.recoverStaleGithubAssignments,
    recoverStaleGithubAssignments,
  );
  assertEquals(barrel.detectAssignedWithClosedPr, detectAssignedWithClosedPr);
  // Defaults shared
  assertEquals(barrel.STUCK_ISSUE_DEFAULTS, STUCK_ISSUE_DEFAULTS);
  // Sanity check: orchestrator is its own function, not re-exported from a sub-module
  assert(
    barrel.detectAndRecoverStuckIssues !==
      (detectAndRecoverStuckHeartbeats as unknown),
  );
});
