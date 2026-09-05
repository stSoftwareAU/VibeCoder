/**
 * Regression tests for the heartbeat sweep versus the maintenance lane
 * (Issue #391).
 *
 * The slot-aware sweep (Issue #4178) was fed `heldIssues()`, which excludes
 * maintenance-lane holds on purpose (Issue #213). A merge-conflict / CI /
 * PR-feedback / spelling pass therefore had its *live* heartbeat swept by the
 * next issue slot going to claim, and the assigned-without-heartbeat recovery
 * (Issue #632) could hand its work to another worker mid-edit.
 *
 * The sweep now takes `heldHeartbeatKeys()` — every hold that owns a
 * heartbeat, maintenance included — and heartbeats are keyed by kind as well
 * as number (`issue:42` vs `pr:42`) so the two namespaces cannot alias.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  type HeartbeatHandle,
  type HeartbeatOptions,
  isHeartbeatRunning,
  startHeartbeat,
  stopHeartbeat,
  stopHeartbeatsExcept,
} from "../lib/heartbeat.ts";
import { InFlightRepoRegistry } from "../lib/in_flight_repos.ts";

/** Start a heartbeat, asserting it started, and return the handle. */
async function startOrFail(
  options: HeartbeatOptions,
): Promise<HeartbeatHandle> {
  const result = await startHeartbeat(options);
  if (!result.ok) {
    throw new Error(
      `Expected startHeartbeat to succeed: ${result.error.message}`,
    );
  }
  return result.value;
}

/** A no-op heartbeat over a throwaway work directory. */
async function options(
  repo: string,
  issueNumber: number,
  kind?: "issue" | "pr",
): Promise<HeartbeatOptions> {
  return {
    repo,
    issueNumber,
    ...(kind ? { kind } : {}),
    workDir: await Deno.makeTempDir({ prefix: "hb-391-" }),
    intervalMs: 60_000,
    recordFn: async () => ({ ok: true, value: undefined }),
    clearFn: async () => ({ ok: true, value: undefined }),
  };
}

// ---------------------------------------------------------------------------
// The registry's heartbeat-owning view
// ---------------------------------------------------------------------------

Deno.test("in_flight_repos - heldHeartbeatKeys includes the maintenance lane while heldIssues still excludes it (Issue #391)", () => {
  const registry = new InFlightRepoRegistry();
  registry.tryAcquire("o/a", 42, "s1");
  registry.tryAcquire("o/b", 4408, "m1", { maintenance: true });

  // The finder's claim-shaped view is untouched (Issue #213).
  assertEquals(registry.heldIssues(), [
    { repo: "o/a", issueNumber: 42, milestone: "" },
  ]);

  // The sweep's view counts every hold that owns a heartbeat, tagged by kind.
  assertEquals(registry.heldHeartbeatKeys(), [
    { repo: "o/a", issueNumber: 42, kind: "issue" },
    { repo: "o/b", issueNumber: 4408, kind: "pr" },
  ]);
});

// ---------------------------------------------------------------------------
// The sweep itself
// ---------------------------------------------------------------------------

Deno.test("heartbeat - a live merge-conflict resolution survives an issue slot's sweep (Issue #391)", async () => {
  const registry = new InFlightRepoRegistry();
  registry.tryAcquire("o/slot", 372, "s2");
  registry.tryAcquire("o/grq", 4408, "m1", { maintenance: true });

  const slot = await options("o/slot", 372);
  const lane = await options("o/grq", 4408, "pr");
  const slotHandle = await startOrFail(slot);
  const laneHandle = await startOrFail(lane);
  try {
    const swept = await stopHeartbeatsExcept(registry.heldHeartbeatKeys());
    assertEquals(swept, [], "nothing on this host was leaked");
    assertEquals(
      isHeartbeatRunning("o/grq", 4408, "pr"),
      true,
      "the maintenance lane's heartbeat must survive — its pass is mid-run",
    );
    assertEquals(isHeartbeatRunning("o/slot", 372), true);
  } finally {
    await stopHeartbeat(slotHandle);
    await stopHeartbeat(laneHandle);
    await Deno.remove(slot.workDir, { recursive: true });
    await Deno.remove(lane.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - a genuinely orphaned heartbeat is still swept beside a live maintenance hold (Issue #391)", async () => {
  const registry = new InFlightRepoRegistry();
  registry.tryAcquire("o/grq", 4408, "m1", { maintenance: true });

  const lane = await options("o/grq", 4408, "pr");
  const orphan = await options("o/orphan", 9, "pr");
  const laneHandle = await startOrFail(lane);
  await startOrFail(orphan); // handle deliberately dropped: the leak
  try {
    const swept = await stopHeartbeatsExcept(registry.heldHeartbeatKeys());
    assertEquals(swept.map((h) => `${h.repo}#${h.issueNumber}`), [
      "o/orphan#9",
    ]);
    assertEquals(isHeartbeatRunning("o/orphan", 9, "pr"), false);
    assertEquals(isHeartbeatRunning("o/grq", 4408, "pr"), true);
  } finally {
    await stopHeartbeat(laneHandle);
    await Deno.remove(lane.workDir, { recursive: true });
    await Deno.remove(orphan.workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Kind keying — `issue:N` and `pr:N` cannot alias
// ---------------------------------------------------------------------------

Deno.test("heartbeat - issue:N and pr:N are distinct heartbeats, not one shared key (Issue #391)", async () => {
  const asIssue = await options("o/a", 4408);
  const asPr = await options("o/a", 4408, "pr");
  const issueHandle = await startOrFail(asIssue);
  const prHandle = await startOrFail(asPr);
  try {
    assertEquals(
      issueHandle.id === prHandle.id,
      false,
      "the PR's heartbeat must not reuse the issue's key",
    );
    assertEquals(issueHandle.kind, "issue");
    assertEquals(prHandle.kind, "pr");
    assertEquals(isHeartbeatRunning("o/a", 4408, "issue"), true);
    assertEquals(isHeartbeatRunning("o/a", 4408, "pr"), true);

    // A live set naming only the PR must not keep the issue's heartbeat alive.
    const swept = await stopHeartbeatsExcept([
      { repo: "o/a", issueNumber: 4408, kind: "pr" },
    ]);
    assertEquals(swept.map((h) => h.kind), ["issue"]);
    assertEquals(isHeartbeatRunning("o/a", 4408, "issue"), false);
    assertEquals(isHeartbeatRunning("o/a", 4408, "pr"), true);
  } finally {
    await stopHeartbeat(issueHandle);
    await stopHeartbeat(prHandle);
    await Deno.remove(asIssue.workDir, { recursive: true });
    await Deno.remove(asPr.workDir, { recursive: true });
  }
});

Deno.test("heartbeat - a live set with no kind still means the issue namespace (Issue #391)", async () => {
  const asIssue = await options("o/a", 7);
  const asPr = await options("o/a", 7, "pr");
  const issueHandle = await startOrFail(asIssue);
  await startOrFail(asPr); // no live hold: the leak
  try {
    const swept = await stopHeartbeatsExcept([{ repo: "o/a", issueNumber: 7 }]);
    assertEquals(swept.map((h) => h.kind), ["pr"]);
    assertEquals(isHeartbeatRunning("o/a", 7, "issue"), true);
    assertEquals(isHeartbeatRunning("o/a", 7, "pr"), false);
  } finally {
    await stopHeartbeat(issueHandle);
    await Deno.remove(asIssue.workDir, { recursive: true });
    await Deno.remove(asPr.workDir, { recursive: true });
  }
});
