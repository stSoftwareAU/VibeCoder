/**
 * MemAvailable and PSI on the liveness tick (Issues #4225, #5324).
 *
 * The tick line is written only when the liveness guard returns ok. These
 * tests cover the fields that line appends: an integer MiB from
 * `Deno.systemMemoryInfo()` (its `available` figure, in bytes), the two
 * pressure files with whitespace collapsed, and `unavailable` when a read
 * fails. Production reads the PSI files through `cat` (`readProcFileWithCat`),
 * because Deno refuses `/proc` reads short of `--allow-all`; these tests inject
 * the reader. A missing file is not omitted and is not reported as zero.
 *
 * Australian English is used throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  collapseProcPressureText,
  formatLivenessPressureFields,
  memAvailableMibFromBytes,
  readLivenessTickPressure,
} from "../lib/liveness_guard.ts";

const PRESSURE_MEMORY = "/proc/pressure/memory";
const PRESSURE_CPU = "/proc/pressure/cpu";

const MEMORY_PSI = "some avg10=1.50 avg60=0.00 avg300=0.00 total=9\n" +
  "full avg10=0.25 avg60=0.00 avg300=0.00 total=3\n";
const CPU_PSI = "some avg10=0.00 avg60=0.10 avg300=0.00 total=1\n";

function reader(
  files: ReadonlyMap<string, string | Error>,
): (path: string) => Promise<string> {
  return (path) => {
    const value = files.get(path);
    if (value === undefined || value instanceof Error) {
      return Promise.reject(value ?? new Deno.errors.NotFound(path));
    }
    return Promise.resolve(value);
  };
}

Deno.test("collapseProcPressureText - blanks are empty, not a zero-stall line (Issue #4225)", () => {
  assertEquals(collapseProcPressureText(""), "empty");
  assertEquals(collapseProcPressureText("  \n\t"), "empty");
  assertEquals(
    collapseProcPressureText(MEMORY_PSI),
    "some,avg10=1.50,avg60=0.00,avg300=0.00,total=9,full,avg10=0.25,avg60=0.00,avg300=0.00,total=3",
  );
});

Deno.test("memAvailableMibFromBytes - bytes round to mebibytes, and a bad figure is unavailable (Issues #4225, #5324)", () => {
  assertEquals(memAvailableMibFromBytes(2097152), 2);
  assertEquals(memAvailableMibFromBytes(524288), 1);
  assertEquals(memAvailableMibFromBytes(0), 0);
  assertEquals(memAvailableMibFromBytes(NaN), "unavailable");
  assertEquals(memAvailableMibFromBytes(-1), "unavailable");
  assertEquals(memAvailableMibFromBytes(Infinity), "unavailable");
});

Deno.test("readLivenessTickPressure - a missing pressure file is unavailable and is not logged as zero (Issues #4225, #5324)", async () => {
  const files = new Map<string, string | Error>([
    [PRESSURE_MEMORY, new Deno.errors.NotFound("memory")],
    [PRESSURE_CPU, new Error("EIO")],
  ]);
  const reading = await readLivenessTickPressure({
    systemMemoryInfo: () => ({ available: 4 * 1024 * 1024 }),
    readPressureFile: reader(files),
  });
  assertEquals(reading.memAvailableMib, 4);
  assertEquals(reading.pressureMemory, "unavailable");
  assertEquals(reading.pressureCpu, "unavailable");

  const line = formatLivenessPressureFields(reading);
  assertEquals(
    line,
    "mem_available_mib=4 pressure_memory=unavailable pressure_cpu=unavailable",
  );
  assertEquals(line.includes("avg10=0"), false);
  assertEquals(line.includes("mem_available_mib=0"), false);
  assertEquals(line.includes("\n"), false);
});

Deno.test("readLivenessTickPressure - each PSI file is read, and a failed systemMemoryInfo does not drop PSI (Issues #4225, #5324)", async () => {
  const seen: string[] = [];
  const files = new Map<string, string>([
    [PRESSURE_MEMORY, MEMORY_PSI],
    [PRESSURE_CPU, CPU_PSI],
  ]);
  const reading = await readLivenessTickPressure({
    systemMemoryInfo: () => {
      throw new Deno.errors.NotCapable(
        'Requires sys access to "systemMemoryInfo", run again with the --allow-sys flag',
      );
    },
    readPressureFile: (path) => {
      seen.push(path);
      const text = files.get(path);
      if (text === undefined) {
        return Promise.reject(new Deno.errors.NotFound(path));
      }
      return Promise.resolve(text);
    },
  });
  assertEquals(seen, [PRESSURE_MEMORY, PRESSURE_CPU]);
  assertEquals(reading.memAvailableMib, "unavailable");
  assertEquals(
    reading.pressureCpu,
    "some,avg10=0.00,avg60=0.10,avg300=0.00,total=1",
  );
  assert(
    reading.pressureMemory.startsWith("some,avg10=1.50"),
    reading.pressureMemory,
  );
  assertEquals(
    formatLivenessPressureFields(reading).startsWith(
      "mem_available_mib=unavailable ",
    ),
    true,
  );
});
