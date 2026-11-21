/**
 * Tests for the guest memory-pressure probe (Issue #4301).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  classifyPressure,
  describeMemoryPressure,
  memoryPressureLogFields,
  probeHostMemoryPressureFromSystem,
  probeMemoryPressure,
} from "../lib/memory_pressure.ts";

const TOTAL = 16384000 * 1024;
const AVAILABLE = 819200 * 1024;

Deno.test("memory_pressure - classifies against the threshold", () => {
  // 5% available < 10% threshold → high
  assertEquals(classifyPressure(TOTAL, AVAILABLE), "high");
  assertEquals(classifyPressure(100, 50), "ok");
  assertEquals(classifyPressure(0, 0), "ok");
});

Deno.test("memory_pressure - probe reports high/ok/unknown via the injected reader", async () => {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  const systemMemoryInfo = () => ({ total: TOTAL, available: AVAILABLE });
  assertEquals(
    (await probeMemoryPressure({ os: "linux", systemMemoryInfo, warn })).level,
    "high",
  );
  assertEquals(
    (await probeMemoryPressure({
      os: "linux",
      systemMemoryInfo,
      threshold: 0.01,
      warn,
    })).level,
    "ok",
  );
  assertEquals(
    (await probeMemoryPressure({
      os: "linux",
      systemMemoryInfo: () => {
        throw new Error("no sys here");
      },
      warn,
    })).level,
    "unknown",
  );
});

Deno.test("probeMemoryPressure - a refused read warns once with its cause and reads unknown (Issue #5319)", async () => {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  const refused = () => {
    throw new Deno.errors.NotCapable(
      'Requires sys access to "systemMemoryInfo", run again with the --allow-sys flag (5319 once-test)',
    );
  };
  assertEquals(
    await probeMemoryPressure({ os: "linux", systemMemoryInfo: refused, warn }),
    { level: "unknown" },
  );
  assertEquals(
    await probeMemoryPressure({ os: "linux", systemMemoryInfo: refused, warn }),
    { level: "unknown" },
  );
  assertEquals(warnings.length, 1);
  assertStringIncludes(
    warnings[0] ?? "",
    'NotCapable: Requires sys access to "systemMemoryInfo"',
  );
  assertStringIncludes(warnings[0] ?? "", 'reporting "unknown"');
  // A different cause is a new warning.
  assertEquals(
    await probeMemoryPressure({
      os: "linux",
      systemMemoryInfo: () => ({ total: 0, available: 0 }),
      warn,
    }),
    { level: "unknown" },
  );
  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings[1] ?? "", "systemMemoryInfo returned total=0");
});

Deno.test("probeMemoryPressure - a non-Linux host reads unknown silently without calling the reader (Issue #5319)", async () => {
  const warnings: string[] = [];
  let called = false;
  assertEquals(
    await probeMemoryPressure({
      os: "darwin",
      systemMemoryInfo: () => {
        called = true;
        return { total: TOTAL, available: AVAILABLE };
      },
      warn: (message) => warnings.push(message),
    }),
    { level: "unknown" },
  );
  assertEquals(called, false);
  assertEquals(warnings, []);
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

Deno.test("probeHostMemoryPressureFromSystem - Linux classifies Deno.systemMemoryInfo with the bytes (Issue #5250)", async () => {
  const GIB = 1024 ** 3;
  assertEquals(
    await probeHostMemoryPressureFromSystem({
      os: "linux",
      systemMemoryInfo: () => ({ total: 16 * GIB, available: 8 * GIB }),
    }),
    { level: "ok", totalBytes: 16 * GIB, availableBytes: 8 * GIB },
  );
  assertEquals(
    await probeHostMemoryPressureFromSystem({
      os: "linux",
      systemMemoryInfo: () => ({ total: 16 * GIB, available: GIB / 2 }),
    }),
    { level: "high", totalBytes: 16 * GIB, availableBytes: GIB / 2 },
  );
});

Deno.test("probeHostMemoryPressureFromSystem - a refused read throws its cause rather than reporting unknown (Issue #5250)", async () => {
  const error = await assertRejects(
    () =>
      probeHostMemoryPressureFromSystem({
        os: "linux",
        systemMemoryInfo: () => {
          throw new Deno.errors.PermissionDenied(
            'Requires sys access to "systemMemoryInfo"',
          );
        },
      }),
    Deno.errors.PermissionDenied,
  );
  assertEquals(
    error.message,
    'Requires sys access to "systemMemoryInfo"',
  );
});

Deno.test("probeHostMemoryPressureFromSystem - an implausible reading is refused, and other platforms keep their own probe (Issue #5250)", async () => {
  await assertRejects(
    () =>
      probeHostMemoryPressureFromSystem({
        os: "linux",
        systemMemoryInfo: () => ({ total: 0, available: 0 }),
      }),
    Error,
    "systemMemoryInfo returned total=0",
  );
  // A non-Linux, non-macOS host has no signal: "unknown", no byte counts.
  assertEquals(
    await probeHostMemoryPressureFromSystem({ os: "windows" }),
    { level: "unknown" },
  );
});
