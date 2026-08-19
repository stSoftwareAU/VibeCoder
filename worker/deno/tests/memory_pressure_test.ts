/**
 * Tests for the guest memory-pressure probe (Issue #4301).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  classifyPressure,
  describeMemoryPressure,
  memoryPressureLogFields,
  parseMemInfo,
  probeMemoryPressure,
} from "../lib/memory_pressure.ts";

const MEMINFO = `MemTotal:       16384000 kB
MemFree:          120000 kB
MemAvailable:     819200 kB
Buffers:           10000 kB
`;

Deno.test("memory_pressure - parses MemTotal/MemAvailable and classifies against the threshold", () => {
  const parsed = parseMemInfo(MEMINFO);
  assertEquals(parsed, {
    totalBytes: 16384000 * 1024,
    availableBytes: 819200 * 1024,
  });
  // 5% available < 10% threshold → high
  assertEquals(
    classifyPressure(parsed!.totalBytes, parsed!.availableBytes),
    "high",
  );
  assertEquals(classifyPressure(100, 50), "ok");
  assertEquals(classifyPressure(0, 0), "ok");
  assertEquals(parseMemInfo("garbage"), null);
});

Deno.test("memory_pressure - probe reports high/ok/unknown via the injected reader", async () => {
  assertEquals(
    (await probeMemoryPressure({ readMemInfo: () => Promise.resolve(MEMINFO) }))
      .level,
    "high",
  );
  assertEquals(
    (await probeMemoryPressure({
      readMemInfo: () => Promise.resolve(MEMINFO),
      threshold: 0.01,
    })).level,
    "ok",
  );
  assertEquals(
    (await probeMemoryPressure({
      readMemInfo: () => Promise.reject(new Error("no /proc here")),
    })).level,
    "unknown",
  );
});

// ---------------------------------------------------------------------------
// Issue #4374 — the reading is rendered for humans and for the security log
// ---------------------------------------------------------------------------

Deno.test("describeMemoryPressure - names the level with the numbers when known (Issue #4374)", () => {
  assertEquals(
    describeMemoryPressure({
      level: "high",
      totalBytes: 16 * 1024 ** 3,
      availableBytes: 400 * 1024 ** 2,
    }),
    "high (400 MiB of 16.0 GiB available)",
  );
  assertEquals(
    describeMemoryPressure({
      level: "ok",
      totalBytes: 24 * 1024 ** 3,
      availableBytes: 8.5 * 1024 ** 3,
    }),
    "ok (8.5 GiB of 24.0 GiB available)",
  );
  // The macOS pressure level has no numbers; unknown has nothing at all.
  assertEquals(describeMemoryPressure({ level: "high" }), "high");
  assertEquals(describeMemoryPressure({ level: "unknown" }), "unknown");
});

Deno.test("memoryPressureLogFields - key=value fields for the AGENT_KILLED line (Issue #4374)", () => {
  assertEquals(
    memoryPressureLogFields({
      level: "high",
      totalBytes: 16 * 1024 ** 3,
      availableBytes: 400 * 1024 ** 2,
    }),
    "memory_pressure=high available_mib=400 total_mib=16384",
  );
  assertEquals(
    memoryPressureLogFields({ level: "unknown" }),
    "memory_pressure=unknown",
  );
});
