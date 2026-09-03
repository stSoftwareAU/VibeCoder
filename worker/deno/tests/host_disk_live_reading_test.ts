/**
 * Issue #852: a launch baseline must not outrank a live reading of the same
 * filesystem.
 *
 * `estimateHostFree` subtracts the work volume's growth from a figure the
 * launcher captured once, so the estimate can only ever fall. That is correct
 * in container mode, where the guest cannot see the host. It is wrong when the
 * work dir turns out to be on the very filesystem the baseline measured: there
 * `df` *is* the host, and the estimate is a strictly worse copy of it that
 * cannot notice space freed during the run.
 *
 * Observed on GRQ-23 on 2026-09-03: the run baselined at 28.4 GB, 40 GB was
 * freed on the host 15 minutes later, and the worker went on reporting
 * 28.4 GB against a 46 GB floor for hours — refusing to claim any issue in
 * any of 17 repositories while `df` showed 57 GB free. Only a restart cleared
 * it, which is the manual intervention this issue exists to remove.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { type DiskReading, HostDiskMonitor } from "../lib/host_disk.ts";

const GIB = 1024 * 1024 * 1024;

/** A 460 GB host, the shape of the GRQ-23 outage. */
const HOST_TOTAL = 460 * GIB;

function envWith(baselineFree: number, total: number) {
  const vars: Record<string, string> = {
    VIBE_HOST_DISK_AVAIL_BYTES: String(Math.floor(baselineFree)),
    VIBE_HOST_DISK_TOTAL_BYTES: String(Math.floor(total)),
    VIBE_HOST_DISK_LOW_FLOOR_GB: "46",
    VIBE_HOST_DISK_LOW_FLOOR_PERCENT: "0",
  };
  return (name: string) => vars[name];
}

function monitor(
  baselineFree: number,
  probe: () => DiskReading | null,
  total = HOST_TOTAL,
) {
  return new HostDiskMonitor({
    workDir: "/work",
    env: envWith(baselineFree, total),
    probe: () => Promise.resolve(probe()),
    sampleIntervalMs: 0,
  });
}

Deno.test("host disk - a live reading of the host filesystem beats the launch baseline (Issue #852)", async () => {
  // Baselined at 28.4 GB; 40 GB has since been freed on the host. The probe
  // reports the same total, so it is the same filesystem.
  const m = monitor(28.4 * GIB, () => ({
    availableBytes: 57 * GIB,
    totalBytes: HOST_TOTAL,
    usedBytes: HOST_TOTAL - 57 * GIB,
  }));
  const status = await m.check({ force: true });
  assertEquals(
    status.source,
    "native-df",
    "the same filesystem was measured directly — the estimate must not win",
  );
  assertEquals(
    status.level,
    "ok",
    "57 GB is above the 46 GB floor; the stale 28.4 GB baseline would gate",
  );
  assertEquals(status.availableBytes, 57 * GIB);
});

Deno.test("host disk - container mode still uses the baseline estimate (Issue #852)", async () => {
  // The work volume is a distinct, smaller filesystem: the guest cannot see
  // the host, so the estimate remains the only honest source.
  const m = monitor(28.4 * GIB, () => ({
    availableBytes: 40 * GIB,
    totalBytes: 64 * GIB,
    usedBytes: 24 * GIB,
  }));
  const status = await m.check({ force: true });
  assertEquals(
    status.source,
    "launch-baseline",
    "a different filesystem must not be mistaken for the host",
  );
  assertEquals(status.totalBytes, HOST_TOTAL);
});

Deno.test("host disk - an unreadable probe still falls back to the baseline (Issue #852)", async () => {
  const m = monitor(28.4 * GIB, () => null);
  const status = await m.check({ force: true });
  assertEquals(status.source, "launch-baseline");
  assertEquals(status.level, "low", "28.4 GB is below the 46 GB floor");
});

Deno.test("host disk - a live host reading below the floor still gates (Issue #852)", async () => {
  // The fix must not only ever unblock: a measured shortage gates just as the
  // estimate did.
  const m = monitor(200 * GIB, () => ({
    availableBytes: 20 * GIB,
    totalBytes: HOST_TOTAL,
    usedBytes: HOST_TOTAL - 20 * GIB,
  }));
  const status = await m.check({ force: true });
  assertEquals(status.source, "native-df");
  assertEquals(status.level, "low");
});

Deno.test("host disk - no baseline keeps native-df wording (Issue #852)", async () => {
  const m = new HostDiskMonitor({
    workDir: "/work",
    env: () => undefined,
    probe: () =>
      Promise.resolve({
        availableBytes: 57 * GIB,
        totalBytes: HOST_TOTAL,
        usedBytes: HOST_TOTAL - 57 * GIB,
      }),
    sampleIntervalMs: 0,
  });
  const status = await m.check({ force: true });
  assertEquals(status.source, "native-df");
  assertEquals(status.detail.includes("work dir filesystem"), true);
});
