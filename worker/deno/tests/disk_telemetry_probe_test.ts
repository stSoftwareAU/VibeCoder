/**
 * Regression tests for the two blind disk probes (Issue #345).
 *
 * `duBytes` and `probeDiskReading` both parse a subprocess's **stdout**, and
 * both asked `runWithTimeout` for `quiet: true` — which sets `stdout: "null"`
 * and returns `""`. So `du` answered a confident 0 for every directory on
 * every host, and `df` answered "unreadable": two disk signals blind, one of
 * them silently.
 *
 * These run the real subprocesses against real temp directories — the whole
 * point is that the bytes survive the round trip, which no injected size can
 * prove.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { duBytes, parseDuBytes } from "../lib/work_volume_prune.ts";
import { HostDiskMonitor, probeDiskReading } from "../lib/host_disk.ts";

const MIB = 1024 * 1024;

Deno.test("parseDuBytes - a du -sk line becomes bytes", () => {
  assertEquals(parseDuBytes("4\t/work/VibeCoder"), 4096);
  assertEquals(parseDuBytes("  2048   /work/GRQ-23  "), 2048 * 1024);
  assertEquals(parseDuBytes("0\t/work/empty"), 0);
});

Deno.test("parseDuBytes - output that says nothing is unmeasured, never zero", () => {
  // The Issue #345 fault: discarded stdout parsed as a confident 0 bytes.
  assertEquals(parseDuBytes(""), null);
  assertEquals(parseDuBytes("   \n  "), null);
  assertEquals(parseDuBytes("du: cannot read directory"), null);
  assertEquals(parseDuBytes("-1\t/work/odd"), null);
});

Deno.test("duBytes - measures a real directory's bytes instead of reporting 0 (Issue #345)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.writeFile(`${tmp}/payload.bin`, new Uint8Array(2 * MIB));
    const bytes = await duBytes(tmp);
    assert(bytes !== null, "expected a reading, got null");
    assert(
      bytes >= 2 * MIB,
      `expected at least 2 MiB from a 2 MiB directory, got ${bytes}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("probeDiskReading - reads the filesystem df actually reports (Issue #345)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const reading = await probeDiskReading(tmp);
    assert(reading !== null, "expected a df reading, got null");
    assert(reading.totalBytes > 0, `total was ${reading.totalBytes}`);
    assert(reading.availableBytes >= 0, `avail was ${reading.availableBytes}`);
    assert(
      reading.usedBytes + reading.availableBytes <= reading.totalBytes * 1.05,
      "used + available should be within the filesystem size",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("probeDiskReading - a path with no filesystem is unreadable, not a zero reading", async () => {
  assertEquals(await probeDiskReading("/definitely/not/a/mount/point"), null);
});

Deno.test("HostDiskMonitor - 'not probed yet' is not a blind signal (Issue #345)", async () => {
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: () => undefined,
    probe: () => Promise.resolve(null),
    log: () => {},
  });
  // Both the unprobed state and a genuinely failed probe report
  // `level: "unknown"`, so the level alone cannot tell them apart — and a
  // host that has not looked yet must never be counted as one that looked
  // and saw nothing.
  assertEquals(m.probed, false);
  assertEquals(m.status.level, "unknown");

  await m.check();
  assertEquals(m.probed, true);
  assertEquals(m.status.level, "unknown");
});

Deno.test("HostDiskMonitor - probed stays true once a reading has been taken (Issue #345)", async () => {
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: () => undefined,
    probe: () =>
      Promise.resolve({
        availableBytes: 40 * 1024 * MIB,
        usedBytes: 10 * 1024 * MIB,
        totalBytes: 50 * 1024 * MIB,
      }),
    log: () => {},
  });
  assertEquals(m.probed, false);
  const status = await m.check();
  assertEquals(status.level, "ok");
  assertEquals(m.probed, true);
});
