/**
 * The shared launcher harness never reaches the real `reclaim-host-caches`
 * (Issue #4498, PR #4500 review).
 *
 * The real command deletes idle CACHEDIR.TAG directories from the host's own
 * `/tmp`, so any suite that builds a launch through the plain shared
 * `setupHarness` on a host under its disk floor would run it. These tests use
 * that plain harness, with no per-suite wrapper, and prove the stub answers.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BASH_LAUNCHER,
  invocationOrder,
  recorded,
  runLauncher,
  setupHarness,
} from "./fixtures/launcher_harness.ts";

const SENTINEL = "[HOST_CACHE_RECLAIM] stub answered (not the real command)";

Deno.test("the plain shared harness answers reclaim-host-caches itself on a host below its floor (#4500 review)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "1",
    STUB_DF_AVAIL_KB: String(10 * 1024 * 1024),
    STUB_DF_TOTAL_KB: String(460 * 1024 * 1024),
    VIBE_HOST_DISK_LOW_FLOOR_GB: "15",
    VIBE_HOST_DISK_LOW_FLOOR_PERCENT: "0",
    STUB_RECLAIM_STDOUT: SENTINEL,
  });
  try {
    const outcome = await runLauncher(harness, BASH_LAUNCHER);
    assertEquals(outcome.code, 0, outcome.stderr);
    // Only the stub prints the sentinel: the real command never ran.
    assertStringIncludes(outcome.stderr, SENTINEL);
    const args = await recorded(harness, "reclaim-host-caches");
    assert(args, "the stub must record the reclaim's arguments");
    assertEquals(args.includes("--floor-kb"), true, `got ${args}`);
    assert(
      (await invocationOrder(harness)).includes("reclaim-host-caches"),
      "the stub must record the reclaim in the invocation order",
    );
  } finally {
    await harness.cleanup();
  }
});

Deno.test("the plain shared harness does not reclaim on a host above its floor (#4500 review)", async () => {
  const harness = await setupHarness({
    STUB_IMAGE_INSPECT_EXIT: "1",
    STUB_DF_AVAIL_KB: String(100 * 1024 * 1024),
    STUB_DF_TOTAL_KB: String(460 * 1024 * 1024),
    VIBE_HOST_DISK_LOW_FLOOR_GB: "15",
    VIBE_HOST_DISK_LOW_FLOOR_PERCENT: "0",
    STUB_RECLAIM_STDOUT: SENTINEL,
  });
  try {
    const outcome = await runLauncher(harness, BASH_LAUNCHER);
    assertEquals(outcome.code, 0, outcome.stderr);
    assertEquals(outcome.stderr.includes(SENTINEL), false);
    assertEquals(await recorded(harness, "reclaim-host-caches"), null);
  } finally {
    await harness.cleanup();
  }
});
