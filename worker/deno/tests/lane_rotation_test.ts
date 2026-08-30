/**
 * Tests for lane_rotation.ts — stopping the maintenance lane starving its
 * last pass (Issue #608).
 *
 * The four agent-backed passes share one slot and ran in a fixed order, so
 * whoever was last got whatever the others left. Measured on the fleet, that
 * was routinely nothing:
 *
 *     04:16:44Z Priority 1.55: CI Fix
 *     04:26:44Z [watchdog] CI Fix exceeded hard timeout 600s
 *     04:26:44Z stop reason=deadline — Resolve PR Merge Conflicts … defer
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  advanceLaneRotation,
  LANE_ROTATION_FILE,
  type LaneRotationIo,
  readLaneRotation,
  rotate,
} from "../lib/lane_rotation.ts";

const PASSES = ["PR Feedback", "Spelling Fix", "CI Fix", "Conflicts"];

/** An in-memory work directory. */
function fakeIo(
  seed?: string,
): LaneRotationIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  if (seed !== undefined) files.set(`/work/${LANE_ROTATION_FILE}`, seed);
  return {
    files,
    readTextFile: (path) => {
      const value = files.get(path);
      return value === undefined
        ? Promise.reject(new Deno.errors.NotFound(path))
        : Promise.resolve(value);
    },
    writeTextFile: (path, data) => {
      files.set(path, data);
      return Promise.resolve();
    },
  };
}

Deno.test("rotate - every pass leads exactly once across a full turn", () => {
  const led = new Set<string>();
  for (let cycle = 0; cycle < PASSES.length; cycle++) {
    const order = rotate(PASSES, cycle);
    assertEquals(order.length, PASSES.length, "no pass may be dropped");
    assertEquals(new Set(order).size, PASSES.length, "nor duplicated");
    led.add(order[0]!);
  }
  assertEquals(led.size, PASSES.length, "each pass leads once per turn");
  // The one that mattered: conflicts lead on the cycle that reaches them.
  assertEquals(rotate(PASSES, 3)[0], "Conflicts");
});

Deno.test("rotate - a corrupt offset is normalised, never thrown on", () => {
  // A state file the volume mangled must not fail a pass.
  for (const offset of [-1, 7, 1.9, Number.NaN, Number.POSITIVE_INFINITY]) {
    const order = rotate(PASSES, offset);
    assertEquals(order.length, PASSES.length, `offset ${offset} lost a pass`);
    assertEquals(new Set(order).size, PASSES.length);
  }
  assertEquals(rotate([], 3), []);
});

Deno.test("readLaneRotation - a missing or unreadable counter starts from the top", async () => {
  assertEquals(await readLaneRotation("/work", fakeIo()), 0);
  // No work directory: nothing to persist to, so the declared order stands.
  assertEquals(await readLaneRotation(undefined, fakeIo("2")), 0);
  assertEquals(await readLaneRotation("/work", fakeIo("not a number")), 0);
  assertEquals(await readLaneRotation("/work", fakeIo("-5")), 0);
  assertEquals(await readLaneRotation("/work", fakeIo("3\n")), 3);
});

Deno.test("advanceLaneRotation - the next cycle starts one further along", async () => {
  const io = fakeIo("1");
  await advanceLaneRotation("/work", 1, io);
  assertEquals(await readLaneRotation("/work", io), 2);
});

Deno.test("advanceLaneRotation - an unwritable counter warns and does not throw", async () => {
  // The Issue #580 lesson: a state file that cannot be written must not take
  // the work down with it. The lane still runs; it just does not rotate.
  const warnings: string[] = [];
  const io: LaneRotationIo = {
    readTextFile: () => Promise.reject(new Deno.errors.NotFound("x")),
    writeTextFile: () => Promise.reject(new Error("read-only file system")),
  };

  await advanceLaneRotation("/work", 0, io, (m) => warnings.push(m));

  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "read-only file system");
  assertStringIncludes(warnings[0]!, "the same pass leads every cycle");
});

Deno.test("rotation across runs - a host that gets one lane cycle per run still rotates", async () => {
  // Measured on the fleet: runs got 1, 6, 1 and 2 lane cycles. Run-local
  // rotation would leave a single-cycle run always leading with the same
  // pass, which is why the offset is persisted rather than held in memory.
  const io = fakeIo();
  const leaders: string[] = [];
  for (let run = 0; run < PASSES.length; run++) {
    const offset = await readLaneRotation("/work", io);
    leaders.push(rotate(PASSES, offset)[0]!);
    await advanceLaneRotation("/work", offset, io);
  }
  assertEquals(leaders, PASSES, "each run leads with the next pass along");
  assert(leaders.includes("Conflicts"));
});
