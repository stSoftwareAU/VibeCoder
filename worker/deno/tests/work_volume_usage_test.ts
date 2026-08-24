/**
 * Tests for the work volume's standing totals (Issue #244).
 *
 * The categoriser is exercised as the pure function it is; the walk runs
 * against real temp directories with injected sizes and clock, so the
 * assertions are about the totals, the budget guard, and the log line —
 * never about how the sizes were obtained.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  categoriseWorkVolumeEntry,
  formatWorkVolumeUsage,
  isWorkerCacheDir,
  reportWorkVolumeUsage,
  scanWorkVolumeUsage,
  type WorkVolumeUsage,
  workVolumeUnknownReason,
} from "../lib/work_volume_usage.ts";

const GIB = 1_073_741_824;

const MONITORED = new Set(["VibeCoder", "GRQ-23"]);

Deno.test("categoriseWorkVolumeEntry - monitored clones win over every other rule", () => {
  assertEquals(categoriseWorkVolumeEntry("VibeCoder", MONITORED), "monitored");
  assertEquals(categoriseWorkVolumeEntry("GRQ-23", MONITORED), "monitored");
});

Deno.test("categoriseWorkVolumeEntry - anything else that is a clone is side/data", () => {
  assertEquals(
    categoriseWorkVolumeEntry("GRQ-shareprices2026Q2", MONITORED),
    "side",
  );
  assertEquals(categoriseWorkVolumeEntry("GRQ-listing", MONITORED), "side");
});

Deno.test("categoriseWorkVolumeEntry - worker caches are their own bucket", () => {
  for (
    const name of [
      ".deno-cache",
      ".vibe-cache",
      ".gh-scan-cache",
      ".gh-timeline-cache",
      ".claude-sessions",
      ".claude-config",
    ]
  ) {
    assertEquals(categoriseWorkVolumeEntry(name, MONITORED), "cache", name);
    assertEquals(isWorkerCacheDir(name), true, name);
  }
});

Deno.test("categoriseWorkVolumeEntry - reserved names, other state and the empty name are 'other'", () => {
  assertEquals(categoriseWorkVolumeEntry("logs", MONITORED), "other");
  assertEquals(categoriseWorkVolumeEntry("lost+found", MONITORED), "other");
  assertEquals(categoriseWorkVolumeEntry(".runlogs", MONITORED), "other");
  assertEquals(categoriseWorkVolumeEntry(".before-src", MONITORED), "other");
  assertEquals(categoriseWorkVolumeEntry("", MONITORED), "other");
  assertEquals(isWorkerCacheDir(".runlogs"), false);
  // `.gh-cache` has no middle segment — not one of the gh caches.
  assertEquals(isWorkerCacheDir(".gh-cache"), false);
});

Deno.test("categoriseWorkVolumeEntry - a monitored repo given as owner/repo matches its clone directory", () => {
  // The scan derives the set with monitoredDirNames; this asserts the pair
  // behaves for the `owner/repo` form the config actually holds.
  const monitored = new Set(["VibeCoder"]);
  assertEquals(categoriseWorkVolumeEntry("VibeCoder", monitored), "monitored");
  assertEquals(
    categoriseWorkVolumeEntry("stSoftwareAU", monitored),
    "side",
  );
});

/** A work root with two monitored clones, two side clones, caches and state. */
async function makeWorkRoot(): Promise<string> {
  const tmp = await Deno.makeTempDir();
  for (
    const dir of [
      "VibeCoder",
      "GRQ-23",
      "GRQ-shareprices2026Q2",
      "GRQ-listing",
      ".deno-cache",
      ".claude-config",
      "logs",
    ]
  ) {
    await Deno.mkdir(`${tmp}/${dir}`, { recursive: true });
  }
  await Deno.writeTextFile(
    `${tmp}/.heartbeat-marker_org_repo_1`,
    "x".repeat(8),
  );
  return tmp;
}

/** Exact byte count for a GB figure, so the sums stay integer-exact. */
function gb(value: number): number {
  return Math.round(value * GIB);
}

const SIZES: Record<string, number> = {
  "VibeCoder": gb(1.5),
  "GRQ-23": gb(0.6),
  "GRQ-shareprices2026Q2": gb(7.3),
  "GRQ-listing": gb(3.9),
  ".deno-cache": gb(0.5),
  ".claude-config": gb(0.1),
  "logs": gb(0.2),
};

function sizeByBasename(path: string): Promise<number | null> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return Promise.resolve(SIZES[name] ?? null);
}

Deno.test("scanWorkVolumeUsage - totals every category and sums to the volume total", async () => {
  const tmp = await makeWorkRoot();
  try {
    const usage = await scanWorkVolumeUsage({
      workDir: tmp,
      monitoredRepos: ["stSoftwareAU/VibeCoder", "stSoftwareAU/GRQ-23"],
      sizeOf: sizeByBasename,
      findArtefacts: () => Promise.resolve([]),
    });
    assertEquals(usage.errors, []);
    assertEquals(usage.monitored.count, 2);
    assertEquals(usage.monitored.bytes, gb(1.5) + gb(0.6));
    assertEquals(usage.side.count, 2);
    assertEquals(usage.side.bytes, gb(7.3) + gb(3.9));
    assertEquals(usage.caches.count, 2);
    assertEquals(usage.caches.bytes, gb(0.5) + gb(0.1));
    // `logs` (0.2 GB) plus the 8-byte marker file.
    assertEquals(usage.other.count, 2);
    assertEquals(usage.other.bytes, gb(0.2) + 8);
    assertEquals(
      usage.totalBytes,
      usage.monitored.bytes + usage.side.bytes + usage.caches.bytes +
        usage.other.bytes,
    );
    assertEquals(usage.truncated, false);
    assertEquals(usage.skipped, 0);
    // Largest first, so the log names the offenders.
    assertEquals(usage.side.entries.map((e) => e.name), [
      "GRQ-shareprices2026Q2",
      "GRQ-listing",
    ]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("scanWorkVolumeUsage - build artefacts are named per clone and not double-counted in the total", async () => {
  const tmp = await makeWorkRoot();
  try {
    const usage = await scanWorkVolumeUsage({
      workDir: tmp,
      monitoredRepos: ["VibeCoder", "GRQ-23"],
      sizeOf: (path) =>
        path.endsWith("/target")
          ? Promise.resolve(gb(0.9))
          : sizeByBasename(path),
      findArtefacts: (repoDir) =>
        Promise.resolve(
          repoDir.endsWith("/VibeCoder") || repoDir.endsWith("/GRQ-listing")
            ? [`${repoDir}/target`]
            : [],
        ),
    });
    assertEquals(usage.artefacts.count, 2);
    assertEquals(usage.artefacts.bytes, 2 * gb(0.9));
    assertEquals(usage.artefacts.entries.map((e) => e.name).sort(), [
      "GRQ-listing/target",
      "VibeCoder/target",
    ]);
    // The artefacts sit inside the clones already measured — the four
    // disjoint categories still sum to the total.
    assertEquals(
      usage.totalBytes,
      usage.monitored.bytes + usage.side.bytes + usage.caches.bytes +
        usage.other.bytes,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("scanWorkVolumeUsage - a directory du cannot size is named, never silently zeroed as clean", async () => {
  const tmp = await makeWorkRoot();
  try {
    const usage = await scanWorkVolumeUsage({
      workDir: tmp,
      monitoredRepos: ["VibeCoder", "GRQ-23"],
      sizeOf: (path) =>
        path.endsWith("GRQ-listing")
          ? Promise.resolve(null)
          : sizeByBasename(path),
      findArtefacts: () => Promise.resolve([]),
    });
    // A permission-denied `du` is its own note, not an error: the
    // filesystem's root-only `lost+found` must not drown out a real fault.
    assertEquals(usage.unmeasured, ["GRQ-listing"]);
    assertEquals(usage.errors, []);
    assertStringIncludes(
      formatWorkVolumeUsage(usage),
      "unmeasured (counted as 0): GRQ-listing",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("scanWorkVolumeUsage - an unreadable work root fails loud instead of reporting an empty volume", async () => {
  const usage = await scanWorkVolumeUsage({
    workDir: "/definitely/not/a/work/volume",
    monitoredRepos: ["VibeCoder"],
    sizeOf: () => Promise.resolve(0),
  });
  assertEquals(usage.measured, 0);
  assertEquals(usage.errors.length, 1);
  assertStringIncludes(
    usage.errors[0] ?? "",
    "cannot read /definitely/not/a/work",
  );
  assertStringIncludes(formatWorkVolumeUsage(usage), "errors: cannot read");
});

Deno.test("scanWorkVolumeUsage - the walk stops at the budget and says how much it missed", async () => {
  const tmp = await makeWorkRoot();
  try {
    // Each `du` costs 40 s of the 120 s budget: three of the seven
    // directories are measured, the rest are skipped.
    let clock = 0;
    const usage = await scanWorkVolumeUsage({
      workDir: tmp,
      monitoredRepos: ["VibeCoder", "GRQ-23"],
      budgetMs: 120_000,
      nowMsFn: () => clock,
      sizeOf: (path) => {
        clock += 40_000;
        return sizeByBasename(path);
      },
      findArtefacts: () => Promise.resolve([]),
    });
    assertEquals(usage.measured, 3);
    assertEquals(usage.skipped, 4);
    assertEquals(usage.truncated, true);
    assertStringIncludes(
      formatWorkVolumeUsage(usage),
      "walk stopped at the 120s budget (3 dir(s) measured, 4 skipped; totals are a floor)",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

function usageFixture(): WorkVolumeUsage {
  const named = (pairs: [string, number][]) => ({
    bytes: pairs.reduce((sum, [, gb]) => sum + gb * GIB, 0),
    count: pairs.length,
    entries: pairs.map(([name, gb]) => ({ name, bytes: gb * GIB })),
  });
  const side = named([
    ["GRQ-shareprices2026Q2", 7.3],
    ["GRQ-listing", 3.9],
    ["GRQ-companyreports", 2.1],
    ["GRQ-dividends", 1.9],
  ]);
  side.count = 8;
  const artefacts = named([["GRQ-23/target", 3.1], ["VibeCoder/target", 2.0]]);
  artefacts.count = 4;
  const monitored = named([["VibeCoder", 2.1]]);
  monitored.count = 15;
  return {
    totalBytes: 18.4 * GIB,
    monitored,
    side,
    caches: { bytes: 0.6 * GIB, count: 3, entries: [] },
    other: { bytes: 0.2 * GIB, count: 4, entries: [] },
    artefacts,
    measured: 26,
    skipped: 0,
    truncated: false,
    budgetMs: 120_000,
    unmeasured: [],
    errors: [],
  };
}

Deno.test("formatWorkVolumeUsage - one line naming the top offenders in each category", () => {
  const line = formatWorkVolumeUsage(usageFixture());
  assertEquals(
    line,
    "Work volume: total 18.4 GB — monitored repos 2.1 GB (15) · " +
      "side/data clones 15.2 GB (8: GRQ-shareprices2026Q2 7.3, GRQ-listing 3.9, GRQ-companyreports 2.1, …) · " +
      "build artefacts 5.1 GB (4 target dirs: GRQ-23/target 3.1, VibeCoder/target 2.0, …) · " +
      "caches 0.6 GB · other 0.2 GB",
  );
});

Deno.test("formatWorkVolumeUsage - an empty volume reads cleanly and takes the caller's label", () => {
  const empty: WorkVolumeUsage = {
    totalBytes: 0,
    monitored: { bytes: 0, count: 0, entries: [] },
    side: { bytes: 0, count: 0, entries: [] },
    caches: { bytes: 0, count: 0, entries: [] },
    other: { bytes: 0, count: 0, entries: [] },
    artefacts: { bytes: 0, count: 0, entries: [] },
    measured: 0,
    skipped: 0,
    truncated: false,
    budgetMs: 120_000,
    unmeasured: [],
    errors: [],
  };
  assertEquals(
    formatWorkVolumeUsage(empty, "Work volume (after prune)"),
    "Work volume (after prune): total 0.0 GB — monitored repos 0.0 GB (0) · " +
      "side/data clones 0.0 GB (0) · build artefacts 0.0 GB (0 target dirs) · " +
      "caches 0.0 GB · other 0.0 GB",
  );
});

Deno.test("formatWorkVolumeUsage - a single artefact dir is named without a plural or an ellipsis", () => {
  const usage = usageFixture();
  usage.artefacts = {
    bytes: 3.1 * GIB,
    count: 1,
    entries: [{ name: "GRQ-23/target", bytes: 3.1 * GIB }],
  };
  assertStringIncludes(
    formatWorkVolumeUsage(usage),
    "build artefacts 3.1 GB (1 target dir: GRQ-23/target 3.1)",
  );
  assert(!formatWorkVolumeUsage(usage).includes("target dirs"));
});

// ---------------------------------------------------------------------------
// Zero is not a measurement (Issue #345)
// ---------------------------------------------------------------------------

/** An all-zero reading over `measured` directories — the #345 symptom. */
function allZeroUsage(measured: number): WorkVolumeUsage {
  const usage = usageFixture();
  usage.totalBytes = 0;
  for (
    const bucket of [
      usage.monitored,
      usage.side,
      usage.caches,
      usage.other,
      usage.artefacts,
    ]
  ) {
    bucket.bytes = 0;
    bucket.entries = bucket.entries.map((e) => ({ ...e, bytes: 0 }));
  }
  usage.measured = measured;
  return usage;
}

Deno.test("workVolumeUnknownReason - a real reading is a measurement", () => {
  assertEquals(workVolumeUnknownReason(usageFixture()), null);
});

Deno.test("workVolumeUnknownReason - every bucket zero over measured directories is unknown, not 0.0 GB (Issue #345)", () => {
  const reason = workVolumeUnknownReason(allZeroUsage(26));
  assert(reason !== null, "expected an all-zero reading to be unknown");
  assertStringIncludes(reason, "26");
});

Deno.test("workVolumeUnknownReason - a genuinely empty work root still reads as a clean zero", () => {
  const empty = allZeroUsage(0);
  empty.monitored.count = 0;
  empty.side.count = 0;
  empty.caches.count = 0;
  empty.other.count = 0;
  empty.artefacts.count = 0;
  empty.monitored.entries = [];
  empty.side.entries = [];
  empty.artefacts.entries = [];
  assertEquals(workVolumeUnknownReason(empty), null);
});

Deno.test("workVolumeUnknownReason - an unreadable work root and a budget that measured nothing are unknown", () => {
  const broken = usageFixture();
  broken.errors = ["cannot read /work: Structure needs cleaning"];
  assert(workVolumeUnknownReason(broken) !== null);

  const starved = allZeroUsage(0);
  starved.truncated = true;
  starved.skipped = 12;
  const reason = workVolumeUnknownReason(starved);
  assert(reason !== null, "expected a budget-starved walk to be unknown");
  assertStringIncludes(reason, "budget");
});

Deno.test("formatWorkVolumeUsage - an all-zero reading reports unknown and never a confident total (Issue #345)", () => {
  const usage = allZeroUsage(26);
  usage.unmeasured = ["lost+found"];
  const line = formatWorkVolumeUsage(usage);
  assertStringIncludes(line, "Work volume: unknown");
  assert(
    !line.includes("total 0.0 GB"),
    `a blind probe must not publish a total: ${line}`,
  );
  // The diagnostics that say *why* survive on the same line.
  assertStringIncludes(line, "unmeasured (counted as 0): lost+found");
});

Deno.test("formatWorkVolumeUsage - an unreadable work root reports unknown with the error", () => {
  const usage = allZeroUsage(0);
  usage.errors = ["cannot read /work: Structure needs cleaning"];
  const line = formatWorkVolumeUsage(usage, "Work volume (after prune)");
  assertStringIncludes(line, "Work volume (after prune): unknown");
  assertStringIncludes(line, "errors: cannot read /work");
});

Deno.test("reportWorkVolumeUsage - refuses to publish a split with no monitored list", async () => {
  const line = await reportWorkVolumeUsage({
    workDir: "/tmp",
    monitoredRepos: [],
    sizeOf: () => Promise.resolve(0),
  });
  assertStringIncludes(line, "standing totals skipped");
  assertStringIncludes(line, "no monitored repositories configured");
});

Deno.test("reportWorkVolumeUsage - scans and formats with the monitored list", async () => {
  const tmp = await makeWorkRoot();
  try {
    const line = await reportWorkVolumeUsage({
      workDir: tmp,
      monitoredRepos: ["stSoftwareAU/VibeCoder", "stSoftwareAU/GRQ-23"],
      sizeOf: sizeByBasename,
      findArtefacts: () => Promise.resolve([]),
    });
    assertStringIncludes(line, "Work volume: total 14.1 GB");
    assertStringIncludes(line, "monitored repos 2.1 GB (2)");
    assertStringIncludes(
      line,
      "side/data clones 11.2 GB (2: GRQ-shareprices2026Q2 7.3, GRQ-listing 3.9)",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
