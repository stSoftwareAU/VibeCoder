/**
 * Tests for the heartbeat milestone progress log (Issue #3753).
 *
 * A milestone is a short worker-authored line appended to the *existing*
 * heartbeat comment — never a new comment — and it forces an immediate
 * refresh so an observer sees progress at once rather than up to
 * `minRefreshSeconds` later.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  clearHeartbeat,
  formatHeartbeatMarker,
  markerStateFilePath,
  MAX_MILESTONES,
  MILESTONE_TEXT_MAX_LENGTH,
  parseHeartbeatMarker,
  publishOrRefreshMarker,
  recordMilestone,
  scanHeartbeatMarkers,
} from "../lib/heartbeat_storage.ts";

interface GhCall {
  args: string[];
  body: string | null;
}

/** Stub `ghFn` recording every call; PATCH/POST both succeed by default. */
function makeGhFn(
  options: { patchFails?: boolean; throws?: boolean } = {},
): { ghFn: (args: string[]) => Promise<string>; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const ghFn = (args: string[]): Promise<string> => {
    const bodyIdx = args.findIndex((a) => a.startsWith("body="));
    calls.push({
      args,
      body: bodyIdx >= 0 ? args[bodyIdx]!.substring("body=".length) : null,
    });
    if (options.throws) return Promise.reject(new Error("gh exploded"));
    if (args.includes("POST")) return Promise.resolve("90210");
    if (args.includes("PATCH")) {
      if (options.patchFails) return Promise.resolve("");
      const match = (args[1] ?? "").match(/issues\/comments\/(\d+)/);
      return Promise.resolve(match ? match[1]! : "");
    }
    return Promise.resolve("[]");
  };
  return { ghFn, calls };
}

function patches(calls: GhCall[]): GhCall[] {
  return calls.filter((c) => c.args.includes("PATCH"));
}

function posts(calls: GhCall[]): GhCall[] {
  return calls.filter((c) => c.args.includes("POST"));
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "hb-milestone-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Seed a live marker state file so tests start from a published comment. */
async function seedState(
  dir: string,
  state: Record<string, unknown>,
): Promise<void> {
  await Deno.writeTextFile(
    markerStateFilePath(dir, "org/repo", 42),
    JSON.stringify(state),
  );
}

async function readState(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await Deno.readTextFile(markerStateFilePath(dir, "org/repo", 42)),
  );
}

Deno.test("recordMilestone PATCHes once even inside the refresh window", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn();
    // lastRefresh is 10 seconds ago — well inside the 300s window.
    await seedState(dir, { commentId: 555, lastRefresh: 1700000000 });

    const result = await recordMilestone(
      dir,
      "org/repo",
      42,
      "Reproduced failure locally",
      { machineId: "host-A", ghFn },
      () => 1700000010,
    );

    assertEquals(result.ok, true);
    assertEquals(patches(calls).length, 1);
    assertEquals(posts(calls).length, 0);
    const body = patches(calls)[0]!.body ?? "";
    assertEquals(body.includes("**Progress**"), true);
    assertEquals(body.includes("Reproduced failure locally"), true);
  });
});

Deno.test("ordinary beats still respect minRefreshSeconds after a milestone", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn();
    await seedState(dir, { commentId: 555, lastRefresh: 1700000000 });

    await recordMilestone(
      dir,
      "org/repo",
      42,
      "Claimed PR #42",
      { machineId: "host-A", ghFn },
      () => 1700000010,
    );
    // A periodic beat 20 seconds later is inside the window — no API call.
    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn },
      () => 1700000030,
    );

    assertEquals(patches(calls).length, 1);
  });
});

Deno.test("milestone log is capped — 12 entries render the newest 10", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn();
    await seedState(dir, { commentId: 555, lastRefresh: 1700000000 });

    for (let i = 1; i <= 12; i++) {
      await recordMilestone(
        dir,
        "org/repo",
        42,
        `milestone-${i}`,
        { machineId: "host-A", ghFn },
        () => 1700000000 + i,
      );
    }

    const body = patches(calls).at(-1)!.body ?? "";
    assertEquals(body.includes("milestone-1\n"), false);
    assertEquals(body.includes("milestone-2\n"), false);
    assertEquals(body.includes("milestone-3"), true);
    assertEquals(body.includes("milestone-12"), true);
    const rendered = body.split("\n").filter((l) => l.startsWith("- ")).length;
    assertEquals(rendered, MAX_MILESTONES);

    const state = await readState(dir);
    assertEquals((state.milestones as unknown[]).length, MAX_MILESTONES);
  });
});

Deno.test("milestones survive a beat cycle and a state-file reload", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn();
    await seedState(dir, { commentId: 555, lastRefresh: 1700000000 });

    await recordMilestone(
      dir,
      "org/repo",
      42,
      "Claimed PR #42",
      { machineId: "host-A", ghFn },
      () => 1700000010,
    );
    // A later periodic beat, outside the refresh window, re-renders the body
    // purely from the reloaded state file.
    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn },
      () => 1700000900,
    );

    const body = patches(calls).at(-1)!.body ?? "";
    assertEquals(body.includes("Claimed PR #42"), true);
    assertEquals(
      body.includes(formatHeartbeatMarker("host-A", 1700000900)),
      true,
    );
  });
});

Deno.test("a claim prefix is preserved alongside the milestone log", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn();
    await seedState(dir, {
      commentId: 555,
      lastRefresh: 1700000000,
      claimPrefix: "<!-- CLAIM_LOCK:worker-1 --> Claimed by worker-1",
    });

    await recordMilestone(
      dir,
      "org/repo",
      42,
      "Fix pushed (a1b2c3d)",
      { machineId: "host-A", ghFn },
      () => 1700000010,
    );

    const body = patches(calls)[0]!.body ?? "";
    assertEquals(body.includes("<!-- CLAIM_LOCK:worker-1 -->"), true);
    assertEquals(body.includes("Fix pushed (a1b2c3d)"), true);
  });
});

Deno.test("a body carrying a milestone log still parses as a marker", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn();
    await seedState(dir, { commentId: 555, lastRefresh: 1700000000 });

    await recordMilestone(
      dir,
      "org/repo",
      42,
      "Waiting on CI re-run",
      { machineId: "host-A", ghFn },
      () => 1700000010,
    );

    const body = patches(calls)[0]!.body ?? "";
    const parsed = parseHeartbeatMarker(body);
    assertEquals(parsed?.machineId, "host-A");
    assertEquals(parsed?.epoch, 1700000010);
    assertEquals(parsed?.cleared, false);

    // The same body must survive the fleet-wide scan unchanged.
    const scanned = await scanHeartbeatMarkers(
      "org/repo",
      42,
      () =>
        Promise.resolve(
          JSON.stringify([{ body, author: "vibe-bot" }]),
        ),
      ["vibe-bot"],
    );
    assertEquals(scanned.length, 1);
    assertEquals(scanned[0]!.machineId, "host-A");
    assertEquals(scanned[0]!.epoch, 1700000010);
  });
});

Deno.test("a cleared marker with a milestone log still reports cleared", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn();
    await seedState(dir, { commentId: 555, lastRefresh: 1700000000 });

    await recordMilestone(
      dir,
      "org/repo",
      42,
      "Released — CI fix pushed",
      { machineId: "host-A", ghFn },
      () => 1700000010,
    );
    await clearHeartbeat(dir, "org/repo", 42, { machineId: "host-A", ghFn });

    const body = patches(calls).at(-1)!.body ?? "";
    const parsed = parseHeartbeatMarker(body);
    assertEquals(parsed?.epoch, 0);
    assertEquals(parsed?.cleared, true);
    // The timeline stays readable after release.
    assertEquals(body.includes("Released — CI fix pushed"), true);
  });
});

Deno.test("over-long milestone text is truncated to a single line", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn();
    await seedState(dir, { commentId: 555, lastRefresh: 1700000000 });

    const long = "x".repeat(400);
    await recordMilestone(
      dir,
      "org/repo",
      42,
      `${long}\nsecond line\nthird line`,
      { machineId: "host-A", ghFn },
      () => 1700000010,
    );

    const body = patches(calls)[0]!.body ?? "";
    const entryLines = body.split("\n").filter((l) => l.startsWith("- "));
    assertEquals(entryLines.length, 1);
    assertEquals(
      entryLines[0]!.length <= MILESTONE_TEXT_MAX_LENGTH + 10,
      true,
    );
    // The marker line is untouched by the long text.
    assertEquals(
      body.startsWith(formatHeartbeatMarker("host-A", 1700000010)),
      true,
    );
  });
});

Deno.test("a failing milestone PATCH leaves the caller's Result ok", async () => {
  await withTempDir(async (dir) => {
    const { ghFn } = makeGhFn({ throws: true });
    await seedState(dir, { commentId: 555, lastRefresh: 1700000000 });

    const result = await recordMilestone(
      dir,
      "org/repo",
      42,
      "Diagnosis complete",
      { machineId: "host-A", ghFn },
      () => 1700000010,
    );

    assertEquals(result.ok, true);
    // The milestone is still persisted for the next successful refresh.
    const state = await readState(dir);
    assertEquals((state.milestones as unknown[]).length, 1);
  });
});

Deno.test("recordMilestone without marker options persists but never calls gh", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn();
    await seedState(dir, { commentId: 555, lastRefresh: 1700000000 });

    const result = await recordMilestone(dir, "org/repo", 42, "local only");
    assertEquals(result.ok, true);
    assertEquals(calls.length, 0);
    void ghFn;

    const state = await readState(dir);
    assertEquals(
      (state.milestones as Array<{ text: string }>)[0]?.text,
      "local only",
    );
  });
});

Deno.test("a milestone recorded before the first publish is rendered on it", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn();

    // No marker state yet — the milestone is stashed locally.
    await recordMilestone(dir, "org/repo", 42, "Claimed PR #42");
    assertEquals(calls.length, 0);

    await publishOrRefreshMarker(
      dir,
      "org/repo",
      42,
      { machineId: "host-A", ghFn },
      () => 1700000100,
    );

    const written = posts(calls).at(-1) ?? patches(calls).at(-1);
    assertEquals((written?.body ?? "").includes("Claimed PR #42"), true);
  });
});

Deno.test("blank milestone text is ignored", async () => {
  await withTempDir(async (dir) => {
    const { ghFn, calls } = makeGhFn();
    await seedState(dir, { commentId: 555, lastRefresh: 1700000000 });

    const result = await recordMilestone(
      dir,
      "org/repo",
      42,
      "   \n  ",
      { machineId: "host-A", ghFn },
      () => 1700000010,
    );
    assertEquals(result.ok, true);
    assertEquals(calls.length, 0);
  });
});
