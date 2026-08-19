/**
 * Tests for the memory-pressure slot governor (Issue #4179, part of #4168).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { SlotGovernor } from "../lib/slot_governor.ts";
import type { MemoryPressureReading } from "../lib/memory_pressure.ts";
import { probeHostMemoryPressure } from "../lib/memory_pressure.ts";

function sequence(levels: MemoryPressureReading["level"][]) {
  const pending = [...levels];
  return () => {
    const level = pending.length > 1 ? pending.shift()! : pending[0]!;
    return Promise.resolve({ level } as MemoryPressureReading);
  };
}

Deno.test("slot governor - injected high→low sequence drives the effective count down then back up, one log line per transition (Issue #4179)", async () => {
  const logs: string[] = [];
  let now = 0;
  const gov = new SlotGovernor({
    probe: sequence(["high", "high", "ok", "ok", "ok"]),
    now: () => now,
    sampleIntervalMs: 1000,
    log: (m) => {
      logs.push(m);
    },
  });
  const seen: number[] = [];
  for (let i = 0; i < 5; i++) {
    seen.push(await gov.effectiveSlots(4));
    now += 1000;
  }
  assertEquals(seen, [2, 1, 2, 3, 4]);
  const transitions = logs.filter((l) => l.startsWith("Slot ceiling"));
  assertEquals(transitions.length, 5, logs.join("\n"));
  assert(transitions[0]!.includes("4 → 2"), transitions[0]);
  assert(transitions[4]!.includes("3 → 4"), transitions[4]);
});

Deno.test("slot governor - effective count never exceeds the configured value, whatever the reading (Issue #4179)", async () => {
  const gov = new SlotGovernor({
    probe: sequence(["ok"]),
    now: () => 0,
  });
  assertEquals(await gov.effectiveSlots(2), 2);
  // A later, lower configured value wins over a higher remembered ceiling.
  assertEquals(await gov.effectiveSlots(1), 1);
});

Deno.test("slot governor - between samples the ceiling holds; a fresh sample steps it (Issue #4179)", async () => {
  let now = 0;
  const gov = new SlotGovernor({
    probe: sequence(["high", "ok"]),
    now: () => now,
    sampleIntervalMs: 30_000,
  });
  assertEquals(await gov.effectiveSlots(4), 2);
  now += 1000;
  assertEquals(
    await gov.effectiveSlots(4),
    2,
    "no re-probe inside the cadence",
  );
  now += 30_000;
  assertEquals(
    await gov.effectiveSlots(4),
    3,
    "recovery step on the next probe",
  );
});

Deno.test("slot governor - probe throws → effective count equals configured and one warning is logged (Issue #4179)", async () => {
  const logs: string[] = [];
  let now = 0;
  const gov = new SlotGovernor({
    probe: () => Promise.reject(new Error("no such sysctl")),
    now: () => now,
    sampleIntervalMs: 1,
    log: (m) => {
      logs.push(m);
    },
  });
  assertEquals(await gov.effectiveSlots(4), 4);
  now += 10;
  assertEquals(await gov.effectiveSlots(4), 4);
  assertEquals(
    logs.filter((l) => l.includes("Memory-pressure probe failed")).length,
    1,
    logs.join("\n"),
  );
});

Deno.test("slot governor - unknown reading (no signal on this platform) → configured (Issue #4179)", async () => {
  const gov = new SlotGovernor({ probe: sequence(["unknown"]), now: () => 0 });
  assertEquals(await gov.effectiveSlots(3), 3);
});

Deno.test("slot governor - configured 1 never probes (Issue #4179)", async () => {
  let probes = 0;
  const gov = new SlotGovernor({
    probe: () => {
      probes++;
      return Promise.resolve({ level: "high" });
    },
    now: () => 0,
  });
  assertEquals(await gov.effectiveSlots(1), 1);
  assertEquals(probes, 0);
});

Deno.test("memory pressure - host probe: darwin sysctl levels map 1→ok, 2/4→high, garbage→unknown; other OS → unknown (Issue #4179)", async () => {
  const darwin = (raw: string) =>
    probeHostMemoryPressure({
      os: "darwin",
      readDarwinPressureLevel: () => Promise.resolve(raw),
    });
  assertEquals((await darwin("1\n")).level, "ok");
  assertEquals((await darwin("2")).level, "high");
  assertEquals((await darwin("4")).level, "high");
  assertEquals((await darwin("nope")).level, "unknown");
  assertEquals(
    (await probeHostMemoryPressure({
      os: "darwin",
      readDarwinPressureLevel: () => Promise.reject(new Error("denied")),
    })).level,
    "unknown",
  );
  assertEquals(
    (await probeHostMemoryPressure({ os: "windows" })).level,
    "unknown",
  );
  assertEquals(
    (await probeHostMemoryPressure({
      os: "linux",
      readMemInfo: () =>
        Promise.resolve("MemTotal: 1000 kB\nMemAvailable: 50 kB\n"),
    })).level,
    "high",
  );
});
