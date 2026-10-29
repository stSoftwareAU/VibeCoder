/**
 * The launcher's recreate decline reaches the worker (Issue #4498).
 *
 * When the launcher reports `[WORK_VOLUME_UNRECOVERED]` it has already decided
 * that recreating the work volume will not return the missing space. The
 * launch-end text must then say so, and must not promise a recreate. These
 * tests pin the parser's new optional fields, the stop-reason wording on both
 * sides of the decline, and the path from a `host-disk.json` on disk through
 * the monitor's getters to the stop reason.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  HOST_DISK_AVAIL_ENV,
  HOST_DISK_TOTAL_ENV,
  HostDiskMonitor,
  MAX_LARGEST_HOST_DIRECTORIES_CHARS,
  parseHostDiskRefresh,
} from "../lib/host_disk.ts";
import {
  type HeavyBuildDiskReading,
  HOST_DISK_PARK_NOTE,
  hostDiskLaunchStopReason,
} from "../lib/heavy_build_gate.ts";

const GB = 1_073_741_824;
const LARGEST = "/var/lib/docker 212.0G; /home/vibe/.cache/sccache 41.3G";
const OLD_PROMISE =
  "the next launch recreates the volume if the host is still below the floor (Issue #4360).";

function reading(
  extra: Partial<HeavyBuildDiskReading> = {},
): HeavyBuildDiskReading {
  return {
    status: {
      level: "low",
      availableBytes: 6.9 * GB,
      totalBytes: 460 * GB,
      source: "launch-baseline",
      detail:
        `host (estimated from the launcher's reading 5 min ago) 6.9 GB free (1.5%) of 460.4 GB, floor 46.0 GB — below the floor`,
    },
    floorBytes: 46 * GB,
    trimRefused: true,
    ...extra,
  };
}

Deno.test("Issue #4498 - a declined recreate says so, names the largest directories, and makes no recreate promise", () => {
  const stop = hostDiskLaunchStopReason(
    reading({ recreateDeclined: true, largestHostDirectories: LARGEST }),
  );
  assert(stop !== null);
  assertStringIncludes(stop!, "46.0 GB");
  assertStringIncludes(stop!, "declined to recreate the work volume");
  assertStringIncludes(
    stop!,
    "the missing space is elsewhere on the host (stale build caches or clones outside the worker volumes)",
  );
  assertStringIncludes(stop!, `Largest host directories: ${LARGEST}.`);
  assertStringIncludes(
    stop!,
    "Nothing in the worker will free it until the host has room",
  );
  assertStringIncludes(stop!, HOST_DISK_PARK_NOTE);
  assertEquals(stop!.includes("recreates the volume"), false);
  assertEquals(stop!.includes("next launch"), false);
  assert(stop!.endsWith(HOST_DISK_PARK_NOTE), stop!);
});

Deno.test("Issue #4498 - a declined recreate with no directory text omits the largest-directories clause", () => {
  for (const largest of [undefined, "", "   "]) {
    const stop = hostDiskLaunchStopReason(
      reading({ recreateDeclined: true, largestHostDirectories: largest }),
    );
    assert(stop !== null);
    assertStringIncludes(stop!, "declined to recreate the work volume");
    assertEquals(stop!.includes("Largest host directories"), false);
    assertEquals(stop!.includes("recreates the volume"), false);
    assertStringIncludes(stop!, HOST_DISK_PARK_NOTE);
  }
});

Deno.test("Issue #4498 - declined absent or false keeps the recreate promise, and ignores the directory text", () => {
  for (
    const extra of [
      {},
      { recreateDeclined: false },
      { recreateDeclined: false, largestHostDirectories: LARGEST },
    ]
  ) {
    const stop = hostDiskLaunchStopReason(reading(extra));
    assert(stop !== null);
    assertStringIncludes(stop!, "The work volume trim was refused");
    assertStringIncludes(stop!, OLD_PROMISE);
    assertEquals(stop!.includes("declined"), false);
    assertEquals(stop!.includes("Largest host directories"), false);
    assertStringIncludes(stop!, HOST_DISK_PARK_NOTE);
    assert(stop!.endsWith(HOST_DISK_PARK_NOTE), stop!);
  }
});

Deno.test("Issue #4498 - a declined recreate still ends the launch only when low and trim-refused", () => {
  const declined = { recreateDeclined: true, largestHostDirectories: LARGEST };
  assertEquals(
    hostDiskLaunchStopReason(reading({ ...declined, trimRefused: false })),
    null,
  );
  assertEquals(
    hostDiskLaunchStopReason({
      ...reading(declined),
      status: { ...reading().status, level: "ok" },
    }),
    null,
  );
});

Deno.test("Issue #4498 - the parser reads the new fields, sanitises the directory text, and rejects the wrong types", () => {
  assertEquals(
    parseHostDiskRefresh(
      '{"availableBytes":1024,"totalBytes":4096,"measuredAt":1700000000,"workVolumeRecreateDeclined":true,"largestHostDirectories":"/var/lib/docker 212.0G"}',
    ),
    {
      availableBytes: 1024,
      totalBytes: 4096,
      measuredAt: 1700000000,
      workVolumeRecreateDeclined: true,
      largestHostDirectories: "/var/lib/docker 212.0G",
    },
  );
  assertEquals(
    parseHostDiskRefresh(
      '{"availableBytes":1024,"totalBytes":4096,"measuredAt":1700000000,"workVolumeRecreateDeclined":"yes"}',
    ),
    null,
  );
  assertEquals(
    parseHostDiskRefresh(
      '{"availableBytes":1024,"totalBytes":4096,"measuredAt":1700000000,"largestHostDirectories":42}',
    ),
    null,
  );
  // Newlines and control characters become spaces: the text is one log line.
  assertEquals(
    parseHostDiskRefresh(
      '{"availableBytes":1024,"totalBytes":4096,"measuredAt":1700000000,"largestHostDirectories":"a\\nb\\u0007c\\u2028d"}',
    )?.largestHostDirectories,
    "a b c d",
  );
  // Blank text reads as absent, not as an empty string.
  const blank = parseHostDiskRefresh(
    '{"availableBytes":1024,"totalBytes":4096,"measuredAt":1700000000,"largestHostDirectories":" \\n\\t "}',
  );
  assert(blank !== null);
  assertEquals("largestHostDirectories" in blank!, false);
  // Long text is capped.
  const long = parseHostDiskRefresh(
    JSON.stringify({
      availableBytes: 1024,
      totalBytes: 4096,
      measuredAt: 1700000000,
      largestHostDirectories: "x".repeat(
        MAX_LARGEST_HOST_DIRECTORIES_CHARS + 500,
      ),
    }),
  );
  assertEquals(
    long?.largestHostDirectories?.length,
    MAX_LARGEST_HOST_DIRECTORIES_CHARS,
  );
});

Deno.test("Issue #4498 - an old-shape host-disk.json with no new fields still parses and reads as not declined", () => {
  const parsed = parseHostDiskRefresh(
    '{"availableBytes":1024,"totalBytes":4096,"measuredAt":1700000000,"workVolumeTrimRefused":true}',
  );
  assertEquals(parsed, {
    availableBytes: 1024,
    totalBytes: 4096,
    measuredAt: 1700000000,
    workVolumeTrimRefused: true,
  });
  assertEquals(parsed?.workVolumeRecreateDeclined ?? false, false);
});

/** The environment baseline the launch plan writes: 6.9 GB of 460 GB free. */
function baselineEnv(name: string): string | undefined {
  if (name === HOST_DISK_AVAIL_ENV) return String(6.9 * GB);
  if (name === HOST_DISK_TOTAL_ENV) return String(460 * GB);
  return undefined;
}

/**
 * Build the monitor the way production does, with the launcher's file at
 * `refreshFile`, and turn its status into the stop reason the production
 * caller computes (run_core_production_deps.ts).
 */
async function stopFromMonitor(
  refreshFile: string,
): Promise<{ stop: string | null; monitor: HostDiskMonitor }> {
  const monitor = new HostDiskMonitor({
    workDir: "/work",
    env: baselineEnv,
    // A container-side probe reports the virtual volume, not the host, so the
    // launcher's reading is adopted.
    probe: () =>
      Promise.resolve({
        availableBytes: 0,
        usedBytes: 30 * GB,
        totalBytes: 504 * GB,
      }),
    now: () => 1_000_000,
    refreshFile,
  });
  const status = await monitor.check({ force: true });
  const stop = hostDiskLaunchStopReason({
    status,
    floorBytes: status.totalBytes === undefined
      ? undefined
      : monitor.floorBytesFor(status.totalBytes),
    trimRefused: monitor.workVolumeTrimRefused,
    recreateDeclined: monitor.workVolumeRecreateDeclined,
    largestHostDirectories: monitor.largestHostDirectories,
  });
  return { stop, monitor };
}

Deno.test("Issue #4498 - a declined host-disk.json on disk reaches the launch-end text through the monitor", async () => {
  const root = await Deno.makeTempDir();
  try {
    const refreshFile = `${root}/host-disk.json`;
    // measuredAt is Unix seconds; 900 s is 100 s before the monitor's clock.
    await Deno.writeTextFile(
      refreshFile,
      JSON.stringify({
        availableBytes: 6.9 * GB,
        totalBytes: 460 * GB,
        measuredAt: 900,
        workVolumeTrimRefused: true,
        workVolumeRecreateDeclined: true,
        largestHostDirectories: LARGEST,
      }),
    );
    const { stop, monitor } = await stopFromMonitor(refreshFile);
    assertEquals(monitor.workVolumeTrimRefused, true);
    assertEquals(monitor.workVolumeRecreateDeclined, true);
    assertEquals(monitor.largestHostDirectories, LARGEST);
    assert(stop !== null, "a low, trim-refused host must end the launch");
    assertStringIncludes(stop!, "declined to recreate the work volume");
    assertStringIncludes(stop!, `Largest host directories: ${LARGEST}.`);
    assertStringIncludes(stop!, HOST_DISK_PARK_NOTE);
    assertEquals(stop!.includes("recreates the volume"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Issue #4498 - an old-shape host-disk.json through the monitor keeps the recreate promise", async () => {
  const root = await Deno.makeTempDir();
  try {
    const refreshFile = `${root}/host-disk.json`;
    await Deno.writeTextFile(
      refreshFile,
      JSON.stringify({
        availableBytes: 6.9 * GB,
        totalBytes: 460 * GB,
        measuredAt: 900,
        workVolumeTrimRefused: true,
      }),
    );
    const { stop, monitor } = await stopFromMonitor(refreshFile);
    assertEquals(monitor.workVolumeTrimRefused, true);
    assertEquals(monitor.workVolumeRecreateDeclined, false);
    assertEquals(monitor.largestHostDirectories, undefined);
    assert(stop !== null);
    assertStringIncludes(stop!, OLD_PROMISE);
    assertEquals(stop!.includes("declined"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
