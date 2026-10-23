/**
 * Tests for the guest memory-pressure probe (Issue #4301).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  classifyPressure,
  describeMemoryPressure,
  livenessResourceLogFields,
  memoryPressureLogFields,
  parseMemInfo,
  parsePsi,
  probeLivenessResources,
  probeMemoryPressure,
  probePsi,
  PSI_CPU_PATH,
  PSI_MAX_CHARS,
  PSI_MEMORY_PATH,
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

// ---------------------------------------------------------------------------
// Issue #4225 — PSI parsing, the injectable probes, and the liveness tick
// ---------------------------------------------------------------------------

const PSI_MEMORY_TEXT = `some avg10=1.23 avg60=2.34 avg300=3.45 total=123456
full avg10=0.50 avg60=0.60 avg300=0.70 total=7890
`;

const PSI_CPU_SOME_ONLY =
  `some avg10=45.00 avg60=30.00 avg300=12.00 total=987654
`;

Deno.test("parsePsi - parses the some and full lines of a memory file (Issue #4225)", () => {
  assertEquals(parsePsi(PSI_MEMORY_TEXT), {
    some: { avg10: 1.23, avg60: 2.34, avg300: 3.45, totalUs: 123456 },
    full: { avg10: 0.5, avg60: 0.6, avg300: 0.7, totalUs: 7890 },
  });
});

Deno.test("parsePsi - a cpu file with only a some line has no full field (Issue #4225)", () => {
  assertEquals(parsePsi(PSI_CPU_SOME_ONLY), {
    some: { avg10: 45, avg60: 30, avg300: 12, totalUs: 987654 },
  });
});

Deno.test("parsePsi - malformed or empty text is null, never a zero (Issue #4225)", () => {
  const malformed = [
    "",
    "   \n  \n",
    "garbage",
    "some avg10=1.00 avg60=1.00 avg300=1.00", // no total
    "some avg10=1.00 avg60=1.00 avg300=1.00 total=-5", // negative
    "some avg10=abc avg60=1.00 avg300=1.00 total=5", // not a number
    "some avg10=1.2.3 avg60=1.00 avg300=1.00 total=5", // two dots
    "some avg10=1.00 avg10=2.00 avg60=1.00 avg300=1.00 total=5", // repeated key
    "some avg10=1.00 avg60=1.00 avg300=1.00 total=5 extra=9", // unknown key
    "some avg10=1.00 avg60=1.00 avg300=1.00 total=1.5", // total not integer
    "some avg10=1.00 avg60=1.00 avg300=1.00 total=5\nsome avg10=1.00 avg60=1.00 avg300=1.00 total=5", // repeated line
    "full avg10=1.00 avg60=1.00 avg300=1.00 total=5", // full without some
    "some", // no fields
    "partial avg10=1.00 avg60=1.00 avg300=1.00 total=5", // unknown line kind
  ];
  for (const text of malformed) {
    assertEquals(
      parsePsi(text),
      null,
      `expected null for ${JSON.stringify(text)}`,
    );
  }
});

Deno.test("probePsi - a missing or unreadable file is unknown, not a zero (Issue #4225)", async () => {
  assertEquals(
    await probePsi(
      "/nowhere/pressure/memory",
      () => Promise.reject(new Deno.errors.NotFound("no PSI")),
    ),
    undefined,
  );
  assertEquals(
    await probePsi("/nowhere/pressure/cpu", () => {
      throw new Error("synchronous read failure");
    }),
    undefined,
  );
  assertEquals(
    await probePsi(PSI_MEMORY_PATH, () => Promise.resolve("not psi at all")),
    undefined,
  );
});

Deno.test("probePsi - reads the given path through the injected reader (Issue #4225)", async () => {
  const seen: string[] = [];
  const parsed = await probePsi(PSI_CPU_PATH, (path) => {
    seen.push(path);
    return Promise.resolve(PSI_CPU_SOME_ONLY);
  });
  assertEquals(seen, [PSI_CPU_PATH]);
  assertEquals(parsed?.some.avg10, 45);
  assertEquals(parsed?.full, undefined);
});

Deno.test("probeLivenessResources - reads meminfo and both PSI files, each independently (Issue #4225)", async () => {
  const reading = await probeLivenessResources({
    readMemInfo: () => Promise.resolve(MEMINFO),
    readPsi: (path) =>
      Promise.resolve(
        path === PSI_MEMORY_PATH ? PSI_MEMORY_TEXT : PSI_CPU_SOME_ONLY,
      ),
  });
  assertEquals(reading.mem.level, "high");
  assertEquals(reading.psiMem?.full?.avg10, 0.5);
  assertEquals(reading.psiCpu?.some.avg10, 45);
  assertEquals(reading.psiCpu?.full, undefined);
});

Deno.test("probeLivenessResources - a failing source is unknown and never throws (Issue #4225)", async () => {
  const reading = await probeLivenessResources({
    readMemInfo: () => Promise.reject(new Error("no meminfo")),
    readPsi: () => Promise.reject(new Error("no PSI")),
  });
  assertEquals(reading, {
    mem: { level: "unknown" },
    psiMem: undefined,
    psiCpu: undefined,
  });
});

Deno.test("livenessResourceLogFields - fixed key set, values in MiB and PSI avg10 to two places (Issue #4225)", async () => {
  const reading = await probeLivenessResources({
    readMemInfo: () =>
      Promise.resolve(
        "MemTotal:       8388608 kB\nMemAvailable:    409600 kB\n",
      ),
    readPsi: (path) =>
      Promise.resolve(
        path === PSI_MEMORY_PATH
          ? "some avg10=1.23 avg60=0 avg300=0 total=1\nfull avg10=0.5 avg60=0 avg300=0 total=1\n"
          : "some avg10=45 avg60=0 avg300=0 total=1\n",
      ),
  });
  assertEquals(
    livenessResourceLogFields(reading),
    "mem_available_mib=400 mem_total_mib=8192 psi_mem_some_avg10=1.23 psi_mem_full_avg10=0.50 psi_cpu_some_avg10=45.00",
  );
});

Deno.test("livenessResourceLogFields - an unreadable source is written as unknown, never zero (Issue #4225)", () => {
  assertEquals(
    livenessResourceLogFields({ mem: { level: "unknown" } }),
    "mem_available_mib=unknown mem_total_mib=unknown psi_mem_some_avg10=unknown psi_mem_full_avg10=unknown psi_cpu_some_avg10=unknown",
  );
  // A cpu-only-some kernel: the memory full line is simply not there.
  assertEquals(
    livenessResourceLogFields({
      mem: {
        level: "ok",
        totalBytes: 1024 ** 3,
        availableBytes: 512 * 1024 ** 2,
      },
      psiCpu: parsePsi(PSI_CPU_SOME_ONLY)!,
    }),
    "mem_available_mib=512 mem_total_mib=1024 psi_mem_some_avg10=unknown psi_mem_full_avg10=unknown psi_cpu_some_avg10=45.00",
  );
});

Deno.test("parsePsi - hostile oversized and pathological input is rejected quickly (Issue #4225)", () => {
  // Over the size cap: refused before any splitting.
  const oversized = "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n".repeat(
    PSI_MAX_CHARS,
  );
  assertEquals(oversized.length > PSI_MAX_CHARS, true);
  assertEquals(parsePsi(oversized), null);
  // A megabyte of one token: over the cap, so null.
  assertEquals(parsePsi("some " + "a=".repeat(500_000)), null);
  // Within the cap but a 3000-digit average overflows to Infinity: null.
  assertEquals(
    parsePsi(`some avg10=${"9".repeat(3000)} avg60=0 avg300=0 total=0`),
    null,
  );
  // Within the cap, many lines of unknown kind: stops at the first bad line.
  assertEquals(parsePsi("x\n".repeat(1000)), null);
  // Within the cap, a long run of separators and no fields: null.
  assertEquals(parsePsi("some" + " ".repeat(4000) + "x"), null);
});
