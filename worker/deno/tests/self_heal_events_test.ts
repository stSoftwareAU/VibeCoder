/**
 * Tests for self_heal_events.ts — structured events log + summary (Issue #1497).
 */

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_SUMMARY_RECENT_LIMIT,
  emitSelfHealEvent,
  emitSelfHealEventAuto,
  eventsLogPath,
  formatSummary,
  SELF_HEAL_EVENTS_FILENAME,
  setSelfHealEventsWorkDir,
  summariseSelfHealEvents,
} from "../lib/self_heal_events.ts";
import {
  DEFAULT_LOG_MAX_ROTATIONS,
  rotateAllLogs,
} from "../lib/log_rotation.ts";
import { stripComments } from "../lib/parallel_unsafe_test_manifest.ts";

async function makeTmp(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "self_heal_events_" });
}

Deno.test("self_heal_events - emit appends a JSON line and creates logs dir", async () => {
  const workDir = await makeTmp();
  try {
    const ok = await emitSelfHealEvent({
      module: "disk_space",
      action: "threshold_cleanup",
      reason: "usage 92% >= 90%",
      result: "ok",
      bytesReclaimed: 1024,
    }, { workDir });
    assertEquals(ok, true);

    const path = eventsLogPath(workDir);
    const content = await Deno.readTextFile(path);
    const parsed = JSON.parse(content.trim());
    assertEquals(parsed.module, "disk_space");
    assertEquals(parsed.action, "threshold_cleanup");
    assertEquals(parsed.reason, "usage 92% >= 90%");
    assertEquals(parsed.result, "ok");
    assertEquals(parsed.bytesReclaimed, 1024);
    assert(typeof parsed.timestamp === "string" && parsed.timestamp.length > 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("self_heal_events - multiple emits append one line each", async () => {
  const workDir = await makeTmp();
  try {
    for (let i = 0; i < 3; i++) {
      await emitSelfHealEvent({
        module: "branch_cleanup",
        action: "merged_branch_delete",
        reason: `run ${i}`,
        result: "ok",
      }, { workDir });
    }

    const content = await Deno.readTextFile(eventsLogPath(workDir));
    const lines = content.trim().split("\n");
    assertEquals(lines.length, 3);
    for (const line of lines) JSON.parse(line); // All parse
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("self_heal_events - empty workDir returns false without throwing", async () => {
  const ok = await emitSelfHealEvent({
    module: "x",
    action: "y",
    reason: "z",
    result: "ok",
  }, { workDir: "" });
  assertEquals(ok, false);
});

Deno.test("self_heal_events - summary of missing file returns empty", async () => {
  const workDir = await makeTmp();
  try {
    const summary = await summariseSelfHealEvents({ workDir });
    assertEquals(summary.totalEvents, 0);
    assertEquals(summary.perModule.length, 0);
    assertEquals(summary.totalBytesReclaimed, 0);
    assertEquals(summary.recent.length, 0);
    assertEquals(summary.malformedLines, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("self_heal_events - summary of empty file returns empty", async () => {
  const workDir = await makeTmp();
  try {
    await Deno.mkdir(`${workDir}/logs`, { recursive: true });
    await Deno.writeTextFile(eventsLogPath(workDir), "");
    const summary = await summariseSelfHealEvents({ workDir });
    assertEquals(summary.totalEvents, 0);
    assertEquals(summary.perModule.length, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("self_heal_events - summary counts per module and sums bytes", async () => {
  const workDir = await makeTmp();
  try {
    const now = new Date("2026-04-22T00:00:00Z");
    // disk_space x 2, branch_cleanup x 1
    await emitSelfHealEvent({
      module: "disk_space",
      action: "deno_cache",
      reason: "tier 1",
      result: "ok",
      bytesReclaimed: 1024,
      timestamp: now.toISOString(),
    }, { workDir });
    await emitSelfHealEvent({
      module: "disk_space",
      action: "npm_cache",
      reason: "tier 2",
      result: "ok",
      bytesReclaimed: 2048,
      timestamp: new Date(now.getTime() + 1000).toISOString(),
    }, { workDir });
    await emitSelfHealEvent({
      module: "branch_cleanup",
      action: "merged_branch_delete",
      reason: "PR merged",
      result: "ok",
      timestamp: new Date(now.getTime() + 2000).toISOString(),
    }, { workDir });

    const summary = await summariseSelfHealEvents({
      workDir,
      now: () => new Date(now.getTime() + 5000),
    });
    assertEquals(summary.totalEvents, 3);
    assertEquals(summary.totalBytesReclaimed, 3072);

    const disk = summary.perModule.find((m) => m.module === "disk_space");
    assert(disk);
    assertEquals(disk.eventCount, 2);
    assertEquals(disk.bytesReclaimed, 3072);

    const branch = summary.perModule.find((m) => m.module === "branch_cleanup");
    assert(branch);
    assertEquals(branch.eventCount, 1);
    assertEquals(branch.bytesReclaimed, 0);

    // per-module sorted by descending count
    assertEquals(summary.perModule[0]!.module, "disk_space");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("self_heal_events - summary filters events outside window", async () => {
  const workDir = await makeTmp();
  try {
    const now = new Date("2026-04-22T00:00:00Z");
    // One event 10 days ago (outside 7-day window), one today (inside).
    const tenDaysAgo = new Date(now.getTime() - 10 * 86400_000).toISOString();
    const today = now.toISOString();
    await emitSelfHealEvent({
      module: "crash_cleanup",
      action: "old",
      reason: "long ago",
      result: "ok",
      timestamp: tenDaysAgo,
    }, { workDir });
    await emitSelfHealEvent({
      module: "crash_cleanup",
      action: "recent",
      reason: "today",
      result: "ok",
      timestamp: today,
    }, { workDir });

    const summary = await summariseSelfHealEvents({
      workDir,
      windowDays: 7,
      now: () => now,
    });
    assertEquals(summary.totalEvents, 1);
    assertEquals(summary.perModule[0]!.eventCount, 1);
    assertEquals(summary.recent[0]!.action, "recent");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("self_heal_events - summary tolerates malformed lines", async () => {
  const workDir = await makeTmp();
  try {
    await Deno.mkdir(`${workDir}/logs`, { recursive: true });
    const path = eventsLogPath(workDir);
    const good = JSON.stringify({
      timestamp: new Date().toISOString(),
      module: "session_compaction",
      action: "soft",
      reason: "size over budget",
      result: "ok",
    });
    const bad1 = "{not json";
    const bad2 = JSON.stringify({ foo: "missing required fields" });
    const bad3 = JSON.stringify({
      timestamp: new Date().toISOString(),
      module: "x",
      action: "y",
      reason: "z",
      result: "not-a-valid-result",
    });
    await Deno.writeTextFile(
      path,
      `${good}\n${bad1}\n${bad2}\n${bad3}\n\n`,
    );

    const summary = await summariseSelfHealEvents({ workDir, windowDays: 0 });
    assertEquals(summary.totalEvents, 1);
    assertEquals(summary.malformedLines, 3);
    assertEquals(summary.perModule[0]!.module, "session_compaction");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("self_heal_events - summary recent is newest-first and bounded", async () => {
  const workDir = await makeTmp();
  try {
    const base = new Date("2026-04-22T00:00:00Z").getTime();
    const count = DEFAULT_SUMMARY_RECENT_LIMIT + 5;
    for (let i = 0; i < count; i++) {
      await emitSelfHealEvent({
        module: "git_state_recovery",
        action: "abort_merge",
        reason: `event ${i}`,
        result: "ok",
        timestamp: new Date(base + i * 1000).toISOString(),
      }, { workDir });
    }

    const summary = await summariseSelfHealEvents({
      workDir,
      windowDays: 0,
      recentLimit: DEFAULT_SUMMARY_RECENT_LIMIT,
    });
    assertEquals(summary.totalEvents, count);
    assertEquals(summary.recent.length, DEFAULT_SUMMARY_RECENT_LIMIT);
    // Newest first
    assertEquals(summary.recent[0]!.reason, `event ${count - 1}`);
    assertEquals(
      summary.recent[DEFAULT_SUMMARY_RECENT_LIMIT - 1]!.reason,
      `event ${count - DEFAULT_SUMMARY_RECENT_LIMIT}`,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("self_heal_events - formatSummary produces readable text", async () => {
  const workDir = await makeTmp();
  try {
    await emitSelfHealEvent({
      module: "disk_space",
      action: "deno_cache",
      reason: "tier 1",
      result: "ok",
      bytesReclaimed: 512,
    }, { workDir });

    const summary = await summariseSelfHealEvents({ workDir, windowDays: 0 });
    const text = formatSummary(summary);
    assert(text.includes("Self-healing summary"));
    assert(text.includes("Total events: 1"));
    assert(text.includes("disk_space"));
    assert(text.includes("512 bytes"));
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("self_heal_events - events log is rotated by rotateAllLogs", async () => {
  const workDir = await makeTmp();
  try {
    const logDir = `${workDir}/logs`;
    await Deno.mkdir(logDir, { recursive: true });
    const path = `${logDir}/${SELF_HEAL_EVENTS_FILENAME}`;
    // 2 MB of content; threshold is 1 MB so it should rotate.
    const chunk = "x".repeat(1024);
    const content = chunk.repeat(2 * 1024);
    await Deno.writeTextFile(path, content);

    const result = await rotateAllLogs(logDir, { maxSizeMb: 1 });
    assert(
      result.rotatedCount >= 1,
      `expected at least 1 rotation, got ${result.rotatedCount}`,
    );

    // self-heal.jsonl should have moved to self-heal.jsonl.1
    const rotated = await Deno.stat(`${path}.1`);
    assert(rotated.isFile);
    // Original file should be gone (or empty) after rotation
    try {
      const after = await Deno.stat(path);
      // If it exists it must be empty — rotateLogFile only renames, so it
      // should be absent in practice.
      assertEquals(after.size, 0);
    } catch {
      // expected: renamed away
    }
    // DEFAULT_LOG_MAX_ROTATIONS sanity
    assert(DEFAULT_LOG_MAX_ROTATIONS >= 1);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The sink requires explicit wiring (Issue #4250)
// ---------------------------------------------------------------------------

Deno.test("emitSelfHealEventAuto - emits nothing without production wiring (Issue #4250)", async () => {
  // ~350 fabricated entries reached the operator's real self-heal.jsonl
  // because the sink fell back to WORK_DIR, then HOME — leaking was
  // opt-out. A test that forgets to sandbox must now emit nothing.
  const dir = await Deno.makeTempDir({ prefix: "self_heal_unwired_" });
  setSelfHealEventsWorkDir(undefined);
  try {
    const ok = await emitSelfHealEventAuto({
      module: "test",
      action: "should_not_write",
      reason: "unwired sink",
      result: "ok",
    });
    assertEquals(ok, false, "an unwired sink must refuse to emit");
    assertEquals([...Deno.readDirSync(dir)], [], "no file may appear");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("self_heal_events - the sink reads no environment variable at all (Issue #4250, Issue #966)", async () => {
  // The half of #4250 the test above used to carry by setting WORK_DIR and
  // HOME on the process and watching nothing appear under them. Naming two
  // variables only ever caught those two, and the mutation raced every
  // other worker in the process — which is why this module was in the
  // serial pass. The invariant is stronger and cheaper stated directly:
  // this module resolves its sink from its parameters and its explicit
  // wiring, and consults the environment for nothing whatsoever. Re-adding
  // any fallback — WORK_DIR, HOME, XDG_STATE_HOME, anything — fails here.
  const source = stripComments(
    await Deno.readTextFile(
      new URL("../lib/self_heal_events.ts", import.meta.url),
    ),
  );
  assertEquals(
    source.includes("Deno.env"),
    false,
    "self_heal_events.ts must not read the process environment",
  );
});

Deno.test("emitSelfHealEventAuto - the production wiring supplies the sink (Issue #4250)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "self_heal_wired_" });
  try {
    setSelfHealEventsWorkDir(dir);
    const ok = await emitSelfHealEventAuto({
      module: "test",
      action: "wired_write",
      reason: "explicit wiring",
      result: "ok",
    });
    assertEquals(ok, true);
    const contents = await Deno.readTextFile(`${dir}/logs/self-heal.jsonl`);
    assertEquals(contents.includes("wired_write"), true);
  } finally {
    setSelfHealEventsWorkDir(undefined);
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("emitSelfHealEventAuto - an explicit override still wins unwired (Issue #4250)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "self_heal_override_" });
  try {
    setSelfHealEventsWorkDir(undefined);
    const ok = await emitSelfHealEventAuto({
      module: "test",
      action: "override_write",
      reason: "explicit dir",
      result: "ok",
    }, dir);
    assertEquals(ok, true);
    const contents = await Deno.readTextFile(`${dir}/logs/self-heal.jsonl`);
    assertEquals(contents.includes("override_write"), true);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});
