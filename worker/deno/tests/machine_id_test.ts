/**
 * Tests for lib/machine_id.ts — stable machine identifier helper (Issue #1454).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  getMachineId,
  getOrCreateMachineUuid,
  MACHINE_ID_FILENAME,
} from "../lib/machine_id.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "machine-id-test-" });
}

Deno.test("machine_id - getOrCreateMachineUuid creates a new UUID on first call", async () => {
  const dir = await makeTempDir();
  try {
    const uuid = await getOrCreateMachineUuid(dir);
    assert(uuid.length > 0);
    // UUIDs are 36 chars in the canonical form
    assertEquals(uuid.length, 36);

    // File was persisted
    const onDisk = (await Deno.readTextFile(`${dir}/${MACHINE_ID_FILENAME}`))
      .trim();
    assertEquals(onDisk, uuid);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("machine_id - getOrCreateMachineUuid returns the same UUID on second call", async () => {
  const dir = await makeTempDir();
  try {
    const first = await getOrCreateMachineUuid(dir);
    const second = await getOrCreateMachineUuid(dir);
    assertEquals(first, second);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("machine_id - getOrCreateMachineUuid returns different UUIDs for different workDirs", async () => {
  const a = await makeTempDir();
  const b = await makeTempDir();
  try {
    const uuidA = await getOrCreateMachineUuid(a);
    const uuidB = await getOrCreateMachineUuid(b);
    assertNotEquals(uuidA, uuidB);
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("machine_id - getMachineId combines hostname and UUID", async () => {
  const dir = await makeTempDir();
  try {
    const id = await getMachineId(dir);
    assert(id.length > 0);
    assert(id.includes("-"));
    const uuid = await getOrCreateMachineUuid(dir);
    assert(id.endsWith(uuid), `expected ${id} to end with ${uuid}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("machine_id - getMachineId is stable across calls", async () => {
  const dir = await makeTempDir();
  try {
    const a = await getMachineId(dir);
    const b = await getMachineId(dir);
    assertEquals(a, b);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("machine_id - getMachineId id contains no whitespace or colon characters", async () => {
  const dir = await makeTempDir();
  try {
    const id = await getMachineId(dir);
    // These characters would break the marker `VIBE_CODER_HEARTBEAT:{id}:{epoch}` encoding
    assertEquals(id.includes(":"), false);
    assertEquals(/\s/.test(id), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
