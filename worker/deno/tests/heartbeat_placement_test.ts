/**
 * Tests for tests/support/heartbeat_placement.ts (Issue #1662).
 *
 * The PR-kind suites assert that a clone was left holding no heartbeat state,
 * so the scan behind that assertion must actually see stray files — a helper
 * that always returned an empty list would keep every one of them green.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  heartbeatStrays,
  trackHeartbeatDirs,
} from "./support/heartbeat_placement.ts";
import {
  heartbeatFilePath,
  markerStateFilePath,
} from "../lib/heartbeat_storage.ts";

Deno.test("heartbeatStrays - names the heartbeat and marker files a directory holds", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-strays-" });
  try {
    await Deno.writeTextFile(heartbeatFilePath(dir, "org/repo", 42), "now");
    await Deno.writeTextFile(markerStateFilePath(dir, "org/repo", 42), "{}");
    // Unrelated content is not a stray.
    await Deno.writeTextFile(`${dir}/README.md`, "# repo");

    assertEquals(await heartbeatStrays(dir), [
      ".heartbeat-marker_org_repo_42",
      ".heartbeat_org_repo_42",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("heartbeatStrays - a directory holding no state reports none", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-strays-" });
  try {
    await Deno.writeTextFile(`${dir}/README.md`, "# repo");
    assertEquals(await heartbeatStrays(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("trackHeartbeatDirs - records each directory and writes both state files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-strays-" });
  try {
    const dirs = { record: [] as string[], clear: [] as string[] };
    const overrides = trackHeartbeatDirs(dirs);

    const recorded = await overrides.recordHeartbeat!(dir, "org/repo", 7);
    assertEquals(recorded.ok, true);
    const cleared = await overrides.clearHeartbeat!(dir, "org/repo", 7);
    assertEquals(cleared.ok, true);

    assertEquals(dirs.record, [dir]);
    assertEquals(dirs.clear, [dir]);
    assertEquals(await heartbeatStrays(dir), [
      ".heartbeat-marker_org_repo_7",
      ".heartbeat_org_repo_7",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
