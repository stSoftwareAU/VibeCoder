/**
 * Tests for the heartbeat comment sweep (Issue #3755).
 *
 * The sweep collapses the marker-only heartbeat comments on an issue/PR
 * down to at most one, without ever touching prose, a non-fleet comment,
 * or another machine's still-live claim.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  CLEARED_MARKER_GRACE_SECONDS,
  formatHeartbeatMarker,
  renderHeartbeatBody,
} from "../lib/heartbeat_storage.ts";
import {
  isHeartbeatOnlyBody,
  sweepHeartbeatComments,
} from "../lib/heartbeat_sweep.ts";
import { classifyMarkers } from "../lib/recovery_telemetry.ts";
import { shouldHonourClearedMarker } from "../lib/stuck_recovery.ts";
import { classifyEvent } from "../lib/heartbeat_recovery_classifier.ts";

const FLEET = ["vibe-bot", "vibe-bot-2"];
const NOW = 1_800_000_000;
const STUCK_TIMEOUT = 7200;

interface StubComment {
  id: number;
  body: string;
  author: string;
  updatedAt?: string;
}

interface GhCall {
  args: string[];
}

/** Build a recording `ghFn` that serves a fixed comment list. */
function makeGhFn(
  comments: StubComment[],
  options: { deleteFailsFor?: number[]; listJunk?: boolean } = {},
): { ghFn: (args: string[]) => Promise<string>; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push({ args });
    if (args.includes("DELETE")) {
      const id = parseInt(
        (args.find((a) => a.includes("issues/comments/")) ?? "").split("/")
          .pop() ?? "",
        10,
      );
      if (options.deleteFailsFor?.includes(id)) return Promise.resolve("");
      return Promise.resolve("HTTP/2.0 204 No Content\n");
    }
    if (options.listJunk) return Promise.resolve("{not json");
    return Promise.resolve(
      JSON.stringify(
        comments.map((c) => ({
          id: c.id,
          body: c.body,
          author: c.author,
          updatedAt: c.updatedAt ?? isoAt(NOW - 10 * 86400),
        })),
      ),
    );
  };
  return { ghFn, calls };
}

function isoAt(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

function deletedIds(calls: GhCall[]): number[] {
  return calls
    .filter((c) => c.args.includes("DELETE"))
    .map((c) =>
      parseInt(
        (c.args.find((a) => a.includes("issues/comments/")) ?? "").split("/")
          .pop() ?? "",
        10,
      )
    );
}

/** A cleared (released) marker body as written by `clearHeartbeat`. */
function clearedBody(machineId: string): string {
  return renderHeartbeatBody(
    { machineId, epoch: 0, released: true },
    () => NOW,
  );
}

/** A live marker body as written by `publishOrRefreshMarker`. */
function liveBody(machineId: string, epoch: number): string {
  return renderHeartbeatBody({ machineId, epoch }, () => NOW);
}

Deno.test("sweep keeps newest own marker, deletes only eligible", async () => {
  const { ghFn, calls } = makeGhFn([
    { id: 100, body: clearedBody("host-A"), author: "vibe-bot" },
    { id: 101, body: clearedBody("host-B"), author: "vibe-bot-2" },
    {
      id: 102,
      body: "Real prose from a reviewer — please rebase.",
      author: "human",
    },
    {
      id: 103,
      body: formatHeartbeatMarker("host-X", NOW - 60),
      author: "attacker",
    },
    {
      id: 104,
      body: liveBody("host-A", NOW - 30),
      author: "vibe-bot",
      updatedAt: isoAt(NOW - 30),
    },
  ]);

  const result = await sweepHeartbeatComments("org/repo", 42, ghFn, {
    allowedAuthors: FLEET,
    machineId: "host-A",
    stuckIssueTimeout: STUCK_TIMEOUT,
    nowFn: () => NOW,
  });

  assertEquals(result.keptCommentId, 104);
  assertEquals(result.deleted, [100, 101]);
  assertEquals(deletedIds(calls), [100, 101]);
  assertEquals(result.failed, []);
  // The prose comment and the forged non-fleet marker are never candidates.
  assertEquals(result.scanned, 3);
});

Deno.test("sweep never deletes another machine's live marker", async () => {
  const { ghFn, calls } = makeGhFn([
    {
      id: 200,
      body: liveBody("host-OTHER", NOW - 60),
      author: "vibe-bot-2",
      updatedAt: isoAt(NOW - 60),
    },
    {
      id: 201,
      body: liveBody("host-A", NOW - 90),
      author: "vibe-bot",
      updatedAt: isoAt(NOW - 90),
    },
  ]);

  const result = await sweepHeartbeatComments("org/repo", 42, ghFn, {
    allowedAuthors: FLEET,
    machineId: "host-A",
    keepCommentId: 201,
    stuckIssueTimeout: STUCK_TIMEOUT,
    nowFn: () => NOW,
  });

  assertEquals(result.keptCommentId, 201);
  assertEquals(result.deleted, []);
  assertEquals(result.retained, [200]);
  assertEquals(deletedIds(calls), []);
});

Deno.test("sweep - orphaned live marker past stuckIssueTimeout is swept and counted", async () => {
  const orphanEpoch = NOW - (STUCK_TIMEOUT + 60);
  const { ghFn, calls } = makeGhFn([
    {
      id: 300,
      body: formatHeartbeatMarker("host-DEAD", orphanEpoch),
      author: "vibe-bot-2",
      updatedAt: isoAt(orphanEpoch),
    },
    {
      id: 301,
      body: liveBody("host-A", NOW - 30),
      author: "vibe-bot",
      updatedAt: isoAt(NOW - 30),
    },
  ]);

  const result = await sweepHeartbeatComments("org/repo", 42, ghFn, {
    allowedAuthors: FLEET,
    machineId: "host-A",
    stuckIssueTimeout: STUCK_TIMEOUT,
    nowFn: () => NOW,
  });

  assertEquals(result.keptCommentId, 301);
  assertEquals(result.deleted, [300]);
  assertEquals(result.orphanedLiveMarkers, 1);
  assertEquals(deletedIds(calls), [300]);
});

Deno.test("sweep - an aged orphan is never chosen as the survivor", async () => {
  // The real backlog shape: every marker on the thread was either released
  // or orphaned long ago, so the thread must end with none rather than
  // keeping a dead claim alive (NEAT-AI PR #3644).
  const stale = NOW - (STUCK_TIMEOUT + 3600);
  const { ghFn } = makeGhFn([
    {
      id: 310,
      body: formatHeartbeatMarker("host-DEAD", stale),
      author: "vibe-bot",
      updatedAt: isoAt(stale),
    },
    {
      id: 311,
      body: formatHeartbeatMarker("host-DEAD-2", stale + 60),
      author: "vibe-bot-2",
      updatedAt: isoAt(stale + 60),
    },
  ]);

  const result = await sweepHeartbeatComments("org/repo", 42, ghFn, {
    allowedAuthors: FLEET,
    machineId: "host-A",
    stuckIssueTimeout: STUCK_TIMEOUT,
    nowFn: () => NOW,
  });

  assertEquals(result.keptCommentId, null);
  assertEquals(result.deleted, [310, 311]);
  assertEquals(result.orphanedLiveMarkers, 2);
});

Deno.test("sweep - dryRun issues zero DELETE calls", async () => {
  const { ghFn, calls } = makeGhFn([
    { id: 400, body: clearedBody("host-A"), author: "vibe-bot" },
    { id: 401, body: clearedBody("host-B"), author: "vibe-bot-2" },
    {
      id: 402,
      body: liveBody("host-A", NOW - 30),
      author: "vibe-bot",
      updatedAt: isoAt(NOW - 30),
    },
  ]);

  const result = await sweepHeartbeatComments("org/repo", 42, ghFn, {
    allowedAuthors: FLEET,
    machineId: "host-A",
    dryRun: true,
    stuckIssueTimeout: STUCK_TIMEOUT,
    nowFn: () => NOW,
  });

  assertEquals(result.dryRun, true);
  assertEquals(result.deleted, [400, 401]);
  assertEquals(deletedIds(calls), []);
});

Deno.test("sweep - DELETE failure does not abort the sweep of the rest", async () => {
  const { ghFn, calls } = makeGhFn([
    { id: 500, body: clearedBody("host-A"), author: "vibe-bot" },
    { id: 501, body: clearedBody("host-B"), author: "vibe-bot-2" },
    { id: 502, body: clearedBody("host-C"), author: "vibe-bot" },
  ], { deleteFailsFor: [501] });

  const result = await sweepHeartbeatComments("org/repo", 42, ghFn, {
    allowedAuthors: FLEET,
    machineId: "host-A",
    stuckIssueTimeout: STUCK_TIMEOUT,
    nowFn: () => NOW,
  });

  // Every cleared marker was attempted; nothing live remains, so the thread
  // legitimately ends with zero marker comments.
  assertEquals(result.keptCommentId, null);
  assertEquals(deletedIds(calls), [500, 501, 502]);
  assertEquals(result.deleted, [500, 502]);
  assertEquals(result.failed, [501]);
});

Deno.test("sweep - a freshly cleared marker is retained until the grace window passes", async () => {
  const { ghFn } = makeGhFn([
    {
      id: 600,
      body: clearedBody("host-B"),
      author: "vibe-bot-2",
      updatedAt: isoAt(NOW - (CLEARED_MARKER_GRACE_SECONDS - 60)),
    },
    {
      id: 601,
      body: clearedBody("host-C"),
      author: "vibe-bot",
      updatedAt: isoAt(NOW - (CLEARED_MARKER_GRACE_SECONDS + 60)),
    },
  ]);

  const result = await sweepHeartbeatComments("org/repo", 42, ghFn, {
    allowedAuthors: FLEET,
    machineId: "host-A",
    stuckIssueTimeout: STUCK_TIMEOUT,
    nowFn: () => NOW,
  });

  assertEquals(result.deleted, [601]);
  assertEquals(result.retained, [600]);
});

Deno.test("sweep - an empty fleet allow-list deletes nothing", async () => {
  const { ghFn, calls } = makeGhFn([
    { id: 700, body: clearedBody("host-A"), author: "vibe-bot" },
    { id: 701, body: clearedBody("host-B"), author: "vibe-bot" },
  ]);

  const result = await sweepHeartbeatComments("org/repo", 42, ghFn, {
    allowedAuthors: [],
    machineId: "host-A",
    nowFn: () => NOW,
  });

  assertEquals(result.scanned, 0);
  assertEquals(result.deleted, []);
  assertEquals(deletedIds(calls), []);
});

Deno.test("sweep - unparseable comment list deletes nothing", async () => {
  const { ghFn, calls } = makeGhFn([], { listJunk: true });
  const result = await sweepHeartbeatComments("org/repo", 42, ghFn, {
    allowedAuthors: FLEET,
    machineId: "host-A",
    nowFn: () => NOW,
  });
  assertEquals(result.scanned, 0);
  assertEquals(deletedIds(calls), []);
});

Deno.test("isHeartbeatOnlyBody - marker-only shapes versus prose", () => {
  // Bare marker (pre-Issue #3752 shape).
  assertEquals(isHeartbeatOnlyBody(formatHeartbeatMarker("host-A", 123)), true);
  // Rendered live body with a progress log (Issues #3752, #3753).
  assertEquals(
    isHeartbeatOnlyBody(
      renderHeartbeatBody({
        machineId: "host-A",
        epoch: NOW,
        workerId: "worker-1",
        startedEpoch: NOW - 600,
        milestones: [{ epoch: NOW - 300, text: "Ran the quality gate" }],
      }, () => NOW),
    ),
    true,
  );
  // Rendered released body.
  assertEquals(isHeartbeatOnlyBody(clearedBody("host-A")), true);
  // A claim comment carries worker prose — never sweepable.
  assertEquals(
    isHeartbeatOnlyBody(
      "<!-- CLAIM_LOCK:worker-1 -->\nClaimed by `worker-1` on host `h1`\n" +
        formatHeartbeatMarker("host-A", 123),
    ),
    false,
  );
  // Prose alongside a marker is never sweepable.
  assertEquals(
    isHeartbeatOnlyBody(
      `${formatHeartbeatMarker("host-A", 123)}\n\nPlease review this PR.`,
    ),
    false,
  );
  // No marker at all.
  assertEquals(isHeartbeatOnlyBody("Just a human comment"), false);
});

Deno.test("recovery treats an absent comment and an aged cleared comment identically (Issue #3755 precondition)", () => {
  const absent = classifyMarkers([], "host-A", NOW, STUCK_TIMEOUT);
  const cleared = classifyMarkers(
    [{ machineId: "host-B", epoch: 0, cleared: true }],
    "host-A",
    NOW,
    STUCK_TIMEOUT,
  );

  // "No markers" never skips recovery — the caller falls back to updatedAt.
  assertEquals(absent.skip.skip, false);
  // A cleared marker does propose a skip, but only survives the grace gate
  // while the thread is fresh. Past the grace window it falls through to the
  // very same updatedAt path, so deleting it changes nothing.
  assertEquals(cleared.skip.skip, true);
  const elapsedPastGrace = CLEARED_MARKER_GRACE_SECONDS + 1;
  assertEquals(
    shouldHonourClearedMarker(cleared, "host-A", elapsedPastGrace),
    false,
  );
  // Inside the grace window it is still honoured — which is exactly why the
  // sweep refuses to delete a cleared marker younger than the window.
  assertEquals(
    shouldHonourClearedMarker(cleared, "host-A", 60),
    true,
  );

  // The post-hoc audit classifier is unaffected in the crash case: with no
  // open PR and no follow-up completion, both shapes stay non-crash/crash as
  // documented rather than changing any recovery action.
  assertEquals(
    classifyEvent({
      markerState: "absent",
      openLinkedPRAtRecovery: false,
      completedWithinFollowUp: false,
    }),
    "legitimate-crash",
  );
});
