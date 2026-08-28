/**
 * The fleet-health checkout is not disposable (Issue #477).
 *
 * # The incident
 *
 * Host GRQ-23 sat below its host-disk floor for three days, claimed none of
 * the 43 claimable issues across its monitored repos, and reported nothing at
 * all to the fleet board. The operator only found it by reading logs on the
 * machine in front of them; an unattended host would have shown the same
 * silence and been read as healthy.
 *
 * The cause is a livelock between two subsystems that are each individually
 * correct:
 *
 *   1. `classifyWorkRootEntry` tiers every work-root directory that is not
 *      dot-prefixed, not reserved and not a monitored clone as `disposable`.
 *      The fleet-health checkout (`GRQ-health` on this host) matches none of
 *      those, so the disk-low reclaim deletes it to win back space:
 *      `side/data 0.0 GB in 1 dirs; removed 1 (0.0 GB, disk-low)`.
 *   2. `ensureFleetHealthRepo` then refuses to clone it back while the host
 *      is below the floor (Issue #410) — correctly, since a host short of
 *      disk should not spend disk on an optional clone:
 *      `FLEET health checkout deferred: the host is below its disk floor`.
 *
 * So the checkout is destroyed by the low-disk condition and cannot be
 * rebuilt until the low-disk condition clears — and the report that would
 * have named the low-disk condition (Issue #226's `hostNotes`) is exactly
 * what the missing checkout prevents. The one fault the disk warning exists
 * to raise is the one fault that silences it.
 *
 * # What these tests pin
 *
 * The checkout is a diagnostic instrument, not a side clone: reclaiming it to
 * free space destroys the fleet's only view of the host that most needs
 * watching, and it is measured in megabytes against a floor measured in
 * gigabytes, so it never buys the space it costs. It must survive the sweep
 * that fires precisely when it is needed.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { fleetHealthCheckoutDirName } from "../lib/fleet_health.ts";
import {
  classifyWorkRootEntry,
  monitoredDirNames,
  reclaimWorkVolumeTiers,
  scanWorkRootTiers,
} from "../lib/work_volume_tiers.ts";

const GIB = 1_073_741_824;
const NOW = 1_786_000_000;
const MONITORED = ["stSoftwareAU/VibeCoder", "stSoftwareAU/GRQ"];
const HEALTH = "GRQ-health";

const NEVER_ACTIVE = () => Promise.resolve(false);
const RESCUE_OK = () =>
  Promise.resolve({ ok: true, pushedBranches: [] as string[], detail: "" });

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function sizes(
  table: Record<string, number>,
): (path: string) => Promise<number | null> {
  return (path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return Promise.resolve(table[name] ?? 0);
  };
}

Deno.test("classifyWorkRootEntry - the fleet-health checkout is state, not disposable (Issue #477)", () => {
  const monitored = monitoredDirNames(MONITORED);

  assertEquals(
    classifyWorkRootEntry(HEALTH, monitored, [HEALTH]),
    "state",
    "the health checkout must never be tiered as disposable — the disk-low " +
      "reclaim deletes disposable dirs, and #410 then refuses to clone it back",
  );
});

Deno.test("classifyWorkRootEntry - an ordinary side clone stays disposable (Issue #477)", () => {
  const monitored = monitoredDirNames(MONITORED);

  assertEquals(
    classifyWorkRootEntry("GRQ-shareprices2026Q2", monitored, [HEALTH]),
    "disposable",
    "protecting the health checkout must not protect every side clone",
  );
  assertEquals(
    classifyWorkRootEntry("VibeCoder", monitored, [HEALTH]),
    "monitored",
  );
});

Deno.test("classifyWorkRootEntry - no protected list keeps the historical tiering (Issue #477)", () => {
  const monitored = monitoredDirNames(MONITORED);

  assertEquals(classifyWorkRootEntry(HEALTH, monitored), "disposable");
  assertEquals(classifyWorkRootEntry("logs", monitored), "state");
});

Deno.test("scanWorkRootTiers - the protected checkout is not a reclaim candidate (Issue #477)", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    for (const name of ["VibeCoder", HEALTH, "GRQ-shareprices2026Q2"]) {
      await Deno.mkdir(`${workDir}/${name}`, { recursive: true });
    }

    const { dirs } = await scanWorkRootTiers(workDir, MONITORED, {
      nowFn: () => NOW,
      sizeOf: sizes({ VibeCoder: 1 * GIB, "GRQ-shareprices2026Q2": 7 * GIB }),
      protectedNames: [HEALTH],
    });

    assert(
      !dirs.some((d) => d.name === HEALTH),
      `state entries are skipped by the scan, so the health checkout must ` +
        `not appear as a candidate; got ${dirs.map((d) => d.name).join(", ")}`,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("reclaimWorkVolumeTiers - disk-low leaves the fleet-health checkout on disk (Issue #477)", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    for (const name of ["VibeCoder", HEALTH, "GRQ-shareprices2026Q2"]) {
      await Deno.mkdir(`${workDir}/${name}`, { recursive: true });
    }

    const result = await reclaimWorkVolumeTiers({
      workDir,
      monitoredRepos: MONITORED,
      mode: "disk-low",
      // Far more than the volume holds: the sweep takes everything it may.
      bytesNeeded: 100 * GIB,
      nowFn: () => NOW,
      sizeOf: sizes({ VibeCoder: 1 * GIB, "GRQ-shareprices2026Q2": 7 * GIB }),
      anySlotActive: NEVER_ACTIVE,
      rescue: RESCUE_OK,
      protectedNames: [HEALTH],
    });

    assert(
      await exists(`${workDir}/${HEALTH}`),
      "the disk-low reclaim must not delete the fleet-health checkout — " +
        "deleting it is what silenced GRQ-23 for three days (Issue #477)",
    );
    assert(
      !result.removed.some((d) => d.name === HEALTH),
      `the health checkout must not be reported as removed; got ${
        result.removed.map((d) => d.name).join(", ")
      }`,
    );
    // The sweep still does its job on genuinely disposable clones.
    assert(
      !await exists(`${workDir}/GRQ-shareprices2026Q2`),
      "an ordinary side clone must still be reclaimed under disk pressure",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("fleetHealthCheckoutDirName - the work-root entry name for a health checkout (Issue #477)", () => {
  // The reclaim compares bare work-root entry names; the config carries an
  // absolute path, so the protection is only real if the two agree.
  assertEquals(
    fleetHealthCheckoutDirName("/home/vibe/auto-issue-work/GRQ-health"),
    "GRQ-health",
  );
  assertEquals(
    fleetHealthCheckoutDirName("/home/vibe/auto-issue-work/GRQ-health/"),
    "GRQ-health",
    "a trailing slash must not produce an empty name that protects nothing",
  );
  assertEquals(fleetHealthCheckoutDirName("GRQ-health"), "GRQ-health");
  assertEquals(
    fleetHealthCheckoutDirName(""),
    "",
    "an unconfigured health dir protects nothing rather than everything",
  );
});

Deno.test("classifyWorkRootEntry - an empty protected name protects nothing (Issue #477)", () => {
  const monitored = monitoredDirNames(MONITORED);
  // A host with FLEET health tracking off must not accidentally reserve the
  // whole work root through an empty string.
  assertEquals(
    classifyWorkRootEntry("GRQ-shareprices2026Q2", monitored, [""]),
    "disposable",
  );
});
