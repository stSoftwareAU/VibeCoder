/**
 * Tests for heartbeat marker adoption (Issue #3751).
 *
 * A processor run must reuse the heartbeat marker comment already on the
 * issue/PR instead of posting a fresh one whenever the local marker state
 * file is missing (new host, cleared claim, wiped /tmp).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  clearHeartbeat,
  findExistingMarkerComment,
  formatHeartbeatMarker,
  markerStateFilePath,
  publishOrRefreshMarker,
} from "../lib/heartbeat_storage.ts";

const FLEET = ["vibe-bot", "vibe-bot-2"];

interface GhCall {
  args: string[];
  body: string | null;
}

/** Build a stub `ghFn` that serves a fixed comment list and records calls. */
function makeGhFn(
  comments: Array<{ id: number; body: string; author: string }>,
  options: { patchFails?: boolean; listThrows?: boolean; listJunk?: boolean } =
    {},
): { ghFn: (args: string[]) => Promise<string>; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const ghFn = (args: string[]): Promise<string> => {
    const bodyIdx = args.findIndex((a) => a.startsWith("body="));
    calls.push({
      args,
      body: bodyIdx >= 0 ? args[bodyIdx]!.substring("body=".length) : null,
    });
    if (args.includes("POST")) return Promise.resolve("55501");
    if (args.includes("PATCH")) {
      if (options.patchFails) return Promise.resolve("");
      const match = (args[1] ?? "").match(/issues\/comments\/(\d+)/);
      return Promise.resolve(match ? match[1]! : "");
    }
    // Comment list
    if (options.listThrows) return Promise.reject(new Error("gh exploded"));
    if (options.listJunk) return Promise.resolve("{not json");
    return Promise.resolve(JSON.stringify(comments));
  };
  return { ghFn, calls };
}

function counts(calls: GhCall[]): { posts: number; patches: number } {
  return {
    posts: calls.filter((c) => c.args.includes("POST")).length,
    patches: calls.filter((c) => c.args.includes("PATCH")).length,
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "hb-adopt-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("findExistingMarkerComment returns the newest fleet-authored marker", async () => {
  const { ghFn } = makeGhFn([
    {
      id: 10,
      body: formatHeartbeatMarker("host-A", 1700000000),
      author: "vibe-bot",
    },
    { id: 20, body: "just a human comment", author: "someone" },
    {
      id: 30,
      body: formatHeartbeatMarker("host-B", 1700000900),
      author: "vibe-bot-2",
    },
  ]);
  const found = await findExistingMarkerComment("org/repo", 42, ghFn, FLEET);
  assertEquals(found?.commentId, 30);
  assertEquals(found?.machineId, "host-B");
  assertEquals(found?.epoch, 1700000900);
  assertEquals(found?.cleared, false);
});

Deno.test("findExistingMarkerComment ignores non-fleet authors (Issue #3164)", async () => {
  const { ghFn } = makeGhFn([
    {
      id: 10,
      body: formatHeartbeatMarker("host-X", 1700000000),
      author: "attacker",
    },
  ]);
  assertEquals(
    await findExistingMarkerComment("org/repo", 42, ghFn, FLEET),
    null,
  );
});

Deno.test("adoption - missing state file with existing marker PATCHes, never POSTs", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn([
      {
        id: 777,
        body: formatHeartbeatMarker("host-A", 1700000000),
        author: "vibe-bot",
      },
    ]);
    const result = await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn, allowedAuthors: FLEET },
      () => 1700009999,
    );
    assertEquals(result.ok, true);
    assertEquals(counts(calls), { posts: 0, patches: 1 });
    const state = JSON.parse(
      await Deno.readTextFile(markerStateFilePath(dir, "org/repo", 42)),
    );
    assertEquals(state.commentId, 777);
    assertEquals(state.lastRefresh, 1700009999);
  });
});

Deno.test("adoption - missing state file and no marker comment POSTs once", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn([
      { id: 5, body: "unrelated comment", author: "vibe-bot" },
    ]);
    const result = await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn, allowedAuthors: FLEET },
      () => 1700009999,
    );
    assertEquals(result.ok, true);
    assertEquals(counts(calls), { posts: 1, patches: 0 });
  });
});

Deno.test("adoption - marker from a non-fleet author is not adopted", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn([
      {
        id: 900,
        body: formatHeartbeatMarker("host-A", 1700000000),
        author: "attacker",
      },
    ]);
    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn, allowedAuthors: FLEET },
      () => 1700009999,
    );
    assertEquals(counts(calls), { posts: 1, patches: 0 });
  });
});

Deno.test("adoption - cleared marker is adopted and revived", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn([
      {
        id: 640,
        body: `${formatHeartbeatMarker("host-B", 0)} ` +
          `<!-- cleared: claim released by machine host-B -->`,
        author: "vibe-bot-2",
      },
    ]);
    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn, allowedAuthors: FLEET },
      () => 1700009999,
    );
    assertEquals(counts(calls), { posts: 0, patches: 1 });
    const patch = calls.find((c) => c.args.includes("PATCH"))!;
    // The body also carries visible status text (Issue #3752); what matters
    // here is that the revived marker names this machine at the new epoch.
    assertEquals(
      (patch.body ?? "").startsWith(
        formatHeartbeatMarker("host-A", 1700009999),
      ),
      true,
    );
    const state = JSON.parse(
      await Deno.readTextFile(markerStateFilePath(dir, "org/repo", 42)),
    );
    assertEquals(state.commentId, 640);
  });
});

Deno.test("adoption - live marker from another machine is not adopted", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn([
      {
        id: 641,
        body: formatHeartbeatMarker("host-OTHER", 1700000000),
        author: "vibe-bot-2",
      },
    ]);
    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn, allowedAuthors: FLEET },
      () => 1700009999,
    );
    assertEquals(counts(calls), { posts: 1, patches: 0 });
  });
});

Deno.test("adoption - own claim comment keeps its CLAIM_LOCK prefix", async () => {
  await withTempDir(async (dir) => {
    const prefix =
      "<!-- CLAIM_LOCK:worker-1 -->\nClaimed by `worker-1` on host `h1`";
    const { ghFn, calls } = makeGhFn([
      {
        id: 812,
        body: `${prefix}\n${formatHeartbeatMarker("host-A", 1700000000)}`,
        author: "vibe-bot",
      },
    ]);
    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn, allowedAuthors: FLEET },
      () => 1700009999,
    );
    const patch = calls.find((c) => c.args.includes("PATCH"))!;
    assertEquals(
      (patch.body ?? "").startsWith(
        `${prefix}\n${formatHeartbeatMarker("host-A", 1700009999)}`,
      ),
      true,
    );
    // The visible body (Issue #3752) must not displace the CLAIM_LOCK prefix.
    assertStringIncludes(patch.body ?? "", "🤖 **Vibe Coder working**");
  });
});

Deno.test("adoption - lookup throwing falls back to POST with ok result", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn([], { listThrows: true });
    const result = await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn, allowedAuthors: FLEET },
      () => 1700009999,
    );
    assertEquals(result.ok, true);
    assertEquals(counts(calls), { posts: 1, patches: 0 });
  });
});

Deno.test("adoption - junk lookup response falls back to POST with ok result", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn([], { listJunk: true });
    const result = await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn, allowedAuthors: FLEET },
      () => 1700009999,
    );
    assertEquals(result.ok, true);
    assertEquals(counts(calls), { posts: 1, patches: 0 });
  });
});

Deno.test("adoption - adopted PATCH failure falls back to POST", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn([
      {
        id: 777,
        body: formatHeartbeatMarker("host-A", 1700000000),
        author: "vibe-bot",
      },
    ], { patchFails: true });
    const result = await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn, allowedAuthors: FLEET },
      () => 1700009999,
    );
    assertEquals(result.ok, true);
    assertEquals(counts(calls), { posts: 1, patches: 1 });
  });
});

Deno.test("clearHeartbeat keeps a released marker state that the next claim revives", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      markerStateFilePath(dir, "org/repo", 11),
      JSON.stringify({ commentId: 77, lastRefresh: 1700000000 }),
    );
    const { ghFn, calls } = makeGhFn([]);
    await clearHeartbeat(dir, "org/repo", 11, {
      machineId: "host-A",
      ghFn,
      allowedAuthors: FLEET,
    });
    const state = JSON.parse(
      await Deno.readTextFile(markerStateFilePath(dir, "org/repo", 11)),
    );
    assertEquals(state.commentId, 77);
    assertEquals(state.released, true);

    // Re-claim on the same host: PATCH the retained comment, no POST and no
    // GitHub lookup needed.
    calls.length = 0;
    await publishOrRefreshMarker(
      dir,
      "org/repo",
      11,
      { machineId: "host-A", ghFn, allowedAuthors: FLEET },
      () => 1700000030, // inside the refresh window — revival must still PATCH
    );
    assertEquals(counts(calls), { posts: 0, patches: 1 });
    const revived = JSON.parse(
      await Deno.readTextFile(markerStateFilePath(dir, "org/repo", 11)),
    );
    assertEquals(revived.commentId, 77);
    assertEquals(revived.released, undefined);
    assertEquals(revived.lastRefresh, 1700000030);
  });
});
