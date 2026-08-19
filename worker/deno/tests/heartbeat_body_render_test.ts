/**
 * Tests for the visible heartbeat comment body (Issue #3752).
 *
 * A heartbeat marker used to be a bare HTML comment, so it rendered as a
 * completely blank comment box on GitHub. `renderHeartbeatBody` now adds
 * visible status text while keeping the marker machine-readable — these
 * tests pin that both halves stay true.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  clearHeartbeat,
  formatHeartbeatMarker,
  HEARTBEAT_MARKER_PREFIX,
  markerStateFilePath,
  parseHeartbeatMarker,
  publishOrRefreshMarker,
  renderHeartbeatBody,
} from "../lib/heartbeat_storage.ts";
import {
  classifyEvent,
  parseMarkerStateFromBody,
} from "../lib/heartbeat_recovery_classifier.ts";

const MACHINE_ID = "host-25-7c9330ff-8c78-4dfc-ae0e-bece49815566";
const STARTED = 1785722760; // 02:06 UTC
const BEAT = 1785723420; // 02:17 UTC
const NOW = BEAT + 60; // one minute after the last beat

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "hb-body-test-" });
}

// ---------------------------------------------------------------------------
// Round-trip: marker survives the visible body
// ---------------------------------------------------------------------------

Deno.test("renderHeartbeatBody - live body round-trips through parseHeartbeatMarker", () => {
  const body = renderHeartbeatBody({
    machineId: MACHINE_ID,
    epoch: BEAT,
    host: "host-25",
    workerId: "stsvcbot-1785734608851",
    startedEpoch: STARTED,
  }, () => NOW);

  assertEquals(parseHeartbeatMarker(body), {
    machineId: MACHINE_ID,
    epoch: BEAT,
    cleared: false,
  });
  // The marker must remain the first thing in the body.
  assertEquals(
    body.startsWith(formatHeartbeatMarker(MACHINE_ID, BEAT)),
    true,
  );
});

Deno.test("renderHeartbeatBody - live body names host, worker, start and last beat", () => {
  const body = renderHeartbeatBody({
    machineId: MACHINE_ID,
    epoch: BEAT,
    host: "host-25",
    workerId: "stsvcbot-1785734608851",
    startedEpoch: STARTED,
  }, () => NOW);

  assertStringIncludes(body, "🤖 **Vibe Coder working**");
  assertStringIncludes(body, "host `host-25`");
  assertStringIncludes(body, "worker `stsvcbot-1785734608851`");
  assertStringIncludes(body, "Started 02:06 UTC");
  assertStringIncludes(body, "last beat 02:17 UTC (1 min ago)");
});

Deno.test("renderHeartbeatBody - released body round-trips and is cleared", () => {
  const body = renderHeartbeatBody({
    machineId: MACHINE_ID,
    epoch: 0,
    host: "host-25",
    released: true,
  }, () => 1785724680); // 02:38 UTC

  // Both signals of Issue #1886 must live in the same body.
  assertEquals(parseHeartbeatMarker(body), {
    machineId: MACHINE_ID,
    epoch: 0,
    cleared: true,
  });
  assertStringIncludes(body, "✅ **Vibe Coder released this claim**");
  assertStringIncludes(body, "host `host-25`, finished 02:38 UTC");
  assertEquals(body.startsWith(`<!-- ${HEARTBEAT_MARKER_PREFIX}:`), true);
});

Deno.test("renderHeartbeatBody - legacy bare-marker bodies still parse", () => {
  const legacyLive = formatHeartbeatMarker("host-A", 1700000000);
  assertEquals(parseHeartbeatMarker(legacyLive), {
    machineId: "host-A",
    epoch: 1700000000,
    cleared: false,
  });

  const legacyReleased = `<!-- ${HEARTBEAT_MARKER_PREFIX}:host-A:0 --> ` +
    `<!-- cleared: claim released by machine host-A -->`;
  assertEquals(parseHeartbeatMarker(legacyReleased), {
    machineId: "host-A",
    epoch: 0,
    cleared: true,
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation and determinism
// ---------------------------------------------------------------------------

Deno.test("renderHeartbeatBody - omits worker clause when workerId is unknown", () => {
  const body = renderHeartbeatBody({
    machineId: MACHINE_ID,
    epoch: BEAT,
    startedEpoch: STARTED,
  }, () => NOW);

  assertEquals(body.includes(", worker `"), false);
  // Host falls back to the hostname segment of the machine id.
  assertStringIncludes(body, "host `host-25`");
});

Deno.test("renderHeartbeatBody - omits start clause when startedEpoch is unknown", () => {
  const body = renderHeartbeatBody({
    machineId: MACHINE_ID,
    epoch: BEAT,
  }, () => NOW);

  assertEquals(body.includes("Started "), false);
  assertStringIncludes(body, "Last beat 02:17 UTC (1 min ago)");
});

Deno.test("renderHeartbeatBody - is deterministic under an injected nowFn", () => {
  const fields = {
    machineId: MACHINE_ID,
    epoch: BEAT,
    startedEpoch: STARTED,
    workerId: "w-1",
  };
  const first = renderHeartbeatBody(fields, () => NOW);
  const second = renderHeartbeatBody(fields, () => NOW);
  assertEquals(first, second);

  // A later clock changes only the elapsed phrase, never the marker.
  const later = renderHeartbeatBody(fields, () => BEAT + 7200);
  assertStringIncludes(later, "(2 h ago)");
  assertEquals(parseHeartbeatMarker(later)?.epoch, BEAT);
});

Deno.test("renderHeartbeatBody - elapsed phrase covers seconds, hours and days", () => {
  const base = { machineId: "host-A", epoch: BEAT };
  assertStringIncludes(renderHeartbeatBody(base, () => BEAT + 5), "just now");
  assertStringIncludes(
    renderHeartbeatBody(base, () => BEAT + 90),
    "(1 min ago)",
  );
  assertStringIncludes(
    renderHeartbeatBody(base, () => BEAT + 3 * 86400),
    "(3 d ago)",
  );
  // A clock that runs backwards must not render a negative duration.
  assertStringIncludes(renderHeartbeatBody(base, () => BEAT - 30), "just now");
});

// ---------------------------------------------------------------------------
// Recovery classifier compatibility
// ---------------------------------------------------------------------------

Deno.test("heartbeat classifier - new-format live body classifies as live", () => {
  const body = renderHeartbeatBody({
    machineId: MACHINE_ID,
    epoch: BEAT,
    workerId: "w-1",
    startedEpoch: STARTED,
  }, () => NOW);

  assertEquals(parseMarkerStateFromBody(body), "live");
  assertEquals(
    classifyEvent({
      markerState: "live",
      openLinkedPRAtRecovery: false,
      completedWithinFollowUp: false,
    }),
    "false-positive:other",
  );
});

Deno.test("heartbeat classifier - new-format released body classifies as cleared", () => {
  const body = renderHeartbeatBody({
    machineId: MACHINE_ID,
    epoch: 0,
    released: true,
  }, () => NOW);

  assertEquals(parseMarkerStateFromBody(body), "cleared");
  assertEquals(
    classifyEvent({
      markerState: "cleared",
      openLinkedPRAtRecovery: false,
      completedWithinFollowUp: false,
    }),
    "false-positive:cleared-marker",
  );
});

// ---------------------------------------------------------------------------
// Storage integration — the published comment carries the visible body
// ---------------------------------------------------------------------------

Deno.test("publishOrRefreshMarker - first publish posts a visible body and records the start", async () => {
  const dir = await makeTempDir();
  try {
    let postedBody = "";
    const ghFn = (args: string[]): Promise<string> => {
      const idx = args.findIndex((a) => a.startsWith("body="));
      if (args.includes("POST")) {
        postedBody = idx >= 0 ? args[idx]!.substring("body=".length) : "";
        return Promise.resolve("4242");
      }
      return Promise.resolve("");
    };

    const result = await publishOrRefreshMarker(
      dir,
      "org/repo",
      7,
      { machineId: MACHINE_ID, ghFn, workerId: "w-9" },
      () => BEAT,
    );
    assertEquals(result.ok, true);

    assertEquals(parseHeartbeatMarker(postedBody), {
      machineId: MACHINE_ID,
      epoch: BEAT,
      cleared: false,
    });
    assertStringIncludes(postedBody, "🤖 **Vibe Coder working**");
    assertStringIncludes(postedBody, "worker `w-9`");

    const state = JSON.parse(
      await Deno.readTextFile(markerStateFilePath(dir, "org/repo", 7)),
    );
    assertEquals(state.startedEpoch, BEAT);
    assertEquals(state.workerId, "w-9");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publishOrRefreshMarker - refresh keeps the original start time", async () => {
  const dir = await makeTempDir();
  try {
    await Deno.writeTextFile(
      markerStateFilePath(dir, "org/repo", 7),
      JSON.stringify({
        commentId: 55,
        lastRefresh: STARTED,
        startedEpoch: STARTED,
        workerId: "w-9",
      }),
    );
    let patchedBody = "";
    const ghFn = (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        const idx = args.findIndex((a) => a.startsWith("body="));
        patchedBody = idx >= 0 ? args[idx]!.substring("body=".length) : "";
        return Promise.resolve("55");
      }
      return Promise.resolve("");
    };

    await publishOrRefreshMarker(
      dir,
      "org/repo",
      7,
      { machineId: MACHINE_ID, ghFn, minRefreshSeconds: 300 },
      () => BEAT,
    );

    assertStringIncludes(patchedBody, "Started 02:06 UTC");
    assertStringIncludes(patchedBody, "last beat 02:17 UTC");
    assertStringIncludes(patchedBody, "worker `w-9`");
    assertEquals(parseHeartbeatMarker(patchedBody)?.epoch, BEAT);

    const state = JSON.parse(
      await Deno.readTextFile(markerStateFilePath(dir, "org/repo", 7)),
    );
    assertEquals(state.startedEpoch, STARTED);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publishOrRefreshMarker - marker state written before Issue #3752 omits the start clause", async () => {
  const dir = await makeTempDir();
  try {
    // Legacy state file: no startedEpoch, no workerId.
    await Deno.writeTextFile(
      markerStateFilePath(dir, "org/repo", 7),
      JSON.stringify({ commentId: 55, lastRefresh: STARTED }),
    );
    let patchedBody = "";
    const ghFn = (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        const idx = args.findIndex((a) => a.startsWith("body="));
        patchedBody = idx >= 0 ? args[idx]!.substring("body=".length) : "";
        return Promise.resolve("55");
      }
      return Promise.resolve("");
    };

    await publishOrRefreshMarker(
      dir,
      "org/repo",
      7,
      { machineId: MACHINE_ID, ghFn, minRefreshSeconds: 300 },
      () => BEAT,
    );

    assertEquals(patchedBody.includes("Started "), false);
    assertStringIncludes(patchedBody, "Last beat 02:17 UTC");
    assertEquals(parseHeartbeatMarker(patchedBody)?.epoch, BEAT);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("clearHeartbeat - invalidated comment renders a visible released line", async () => {
  const dir = await makeTempDir();
  try {
    await Deno.writeTextFile(
      markerStateFilePath(dir, "org/repo", 11),
      JSON.stringify({ commentId: 77, lastRefresh: STARTED }),
    );
    let patchedBody = "";
    const ghFn = (args: string[]): Promise<string> => {
      if (args.includes("PATCH")) {
        const idx = args.findIndex((a) => a.startsWith("body="));
        patchedBody = idx >= 0 ? args[idx]!.substring("body=".length) : "";
        return Promise.resolve("77");
      }
      return Promise.resolve("");
    };

    await clearHeartbeat(
      dir,
      "org/repo",
      11,
      { machineId: MACHINE_ID, ghFn, host: "host-25" },
      () => 1785724680, // 02:38 UTC
    );

    assertEquals(parseHeartbeatMarker(patchedBody), {
      machineId: MACHINE_ID,
      epoch: 0,
      cleared: true,
    });
    assertStringIncludes(patchedBody, "✅ **Vibe Coder released this claim**");
    assertStringIncludes(patchedBody, "finished 02:38 UTC");
    assertEquals(parseMarkerStateFromBody(patchedBody), "cleared");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
