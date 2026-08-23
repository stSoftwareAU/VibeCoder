/**
 * Tests for the two-tier work volume (Issue #242).
 *
 * Real temp directories with injected clock, sizes and rescue: the
 * assertions are about which directories go and which are protected — a
 * monitored clone, a directory a live slot may be using, one with unpushed
 * commits the rescue could not push.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { resolveBaseDir } from "../lib/audit_journal.ts";
import {
  anySlotMidExecute,
  classifyWorkRootEntry,
  monitoredDirNames,
  reclaimWorkVolumeTiers,
  repoDirName,
  scanWorkRootTiers,
  selectAgedOutDirs,
  selectLargestFirst,
  summariseWorkVolumeTiers,
  type WorkRootDir,
} from "../lib/work_volume_tiers.ts";

const GIB = 1_073_741_824;
const NOW = 1_786_000_000;

const MONITORED = ["stSoftwareAU/VibeCoder", "stSoftwareAU/GRQ"];

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A clone in the work root, aged as asked. */
async function makeDir(
  workDir: string,
  name: string,
  options: { ageDays?: number; git?: boolean } = {},
): Promise<string> {
  const dir = `${workDir}/${name}`;
  await Deno.mkdir(dir, { recursive: true });
  if (options.git !== false) {
    await Deno.mkdir(`${dir}/.git`, { recursive: true });
    await Deno.writeTextFile(`${dir}/.git/FETCH_HEAD`, "abc\n");
  }
  await Deno.writeTextFile(`${dir}/README.md`, "data\n");
  const when = new Date((NOW - (options.ageDays ?? 0) * 86400) * 1000);
  for (
    const p of [
      `${dir}/README.md`,
      ...(options.git !== false
        ? [`${dir}/.git/FETCH_HEAD`, `${dir}/.git`]
        : []),
      dir,
    ]
  ) {
    await Deno.utime(p, when, when);
  }
  return dir;
}

function sizes(map: Record<string, number>) {
  return (path: string) =>
    Promise.resolve(map[path.slice(path.lastIndexOf("/") + 1)] ?? 0);
}

const NEVER_ACTIVE = () => Promise.resolve(false);
const RESCUE_OK = () =>
  Promise.resolve({ ok: true, pushedBranches: [], detail: "" });

Deno.test("repoDirName - takes the clone directory from owner/repo", () => {
  assertEquals(repoDirName("stSoftwareAU/GRQ-listing"), "GRQ-listing");
  assertEquals(repoDirName("GRQ-listing"), "GRQ-listing");
  assertEquals(repoDirName("stSoftwareAU/GRQ/"), "GRQ");
  assertEquals(repoDirName("  owner/repo  "), "repo");
});

Deno.test("classifyWorkRootEntry - tiers are a pure function of name and list", () => {
  const monitored = monitoredDirNames(MONITORED);
  assertEquals(classifyWorkRootEntry("VibeCoder", monitored), "monitored");
  assertEquals(classifyWorkRootEntry("GRQ", monitored), "monitored");
  // A sibling data repo a gate cloned — not monitored, therefore disposable.
  assertEquals(
    classifyWorkRootEntry("GRQ-shareprices2026Q2", monitored),
    "disposable",
  );
  assertEquals(classifyWorkRootEntry("VibeCoding", monitored), "disposable");
  // Worker-owned state and reserved names are neither tier.
  assertEquals(classifyWorkRootEntry(".claude-sessions", monitored), "state");
  assertEquals(classifyWorkRootEntry(".git", monitored), "state");
  assertEquals(classifyWorkRootEntry("logs", monitored), "state");
  assertEquals(classifyWorkRootEntry("lost+found", monitored), "state");
  assertEquals(classifyWorkRootEntry("", monitored), "state");
  // An empty monitored list makes every clone disposable, not every clone
  // monitored — the classification never guesses.
  assertEquals(classifyWorkRootEntry("VibeCoder", new Set()), "disposable");
});

Deno.test("classifyWorkRootEntry - the audit trail is state, never disposable (Issue #337)", () => {
  const monitored = monitoredDirNames(MONITORED);
  assertEquals(classifyWorkRootEntry("audit", monitored), "state");
  // The name is not a guess: whatever the audit journal resolves its base
  // directory to under WORK_DIR is the name that must tier as state, so a
  // rename on either side fails here rather than on a swept host.
  const previous = Deno.env.get("WORK_DIR");
  try {
    Deno.env.set("WORK_DIR", "/work");
    const baseDir = resolveBaseDir();
    const auditDirName = baseDir.slice(baseDir.lastIndexOf("/") + 1);
    assertEquals(classifyWorkRootEntry(auditDirName, monitored), "state");
  } finally {
    if (previous === undefined) Deno.env.delete("WORK_DIR");
    else Deno.env.set("WORK_DIR", previous);
  }
});

Deno.test("classifyWorkRootEntry - a monitored repo whose name matches a sibling stays monitored", () => {
  const monitored = monitoredDirNames(["owner/GRQ-listing"]);
  assertEquals(classifyWorkRootEntry("GRQ-listing", monitored), "monitored");
});

Deno.test("scanWorkRootTiers - measures and ages each tier", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await makeDir(workDir, "VibeCoder", { ageDays: 0 });
    await makeDir(workDir, "GRQ-listing", { ageDays: 5 });
    await makeDir(workDir, "broken", { ageDays: 0, git: false });
    await Deno.mkdir(`${workDir}/.claude-sessions`, { recursive: true });
    await Deno.writeTextFile(`${workDir}/.heartbeat_o_VibeCoder_1`, "1");

    const { dirs, errors } = await scanWorkRootTiers(workDir, MONITORED, {
      nowFn: () => NOW,
      sizeOf: sizes({ VibeCoder: 2 * GIB, "GRQ-listing": 4 * GIB, broken: 10 }),
    });

    assertEquals(errors, []);
    const byName = new Map(dirs.map((d) => [d.name, d]));
    assertEquals([...byName.keys()].sort(), [
      "GRQ-listing",
      "VibeCoder",
      "broken",
    ]);
    assertEquals(byName.get("VibeCoder")!.tier, "monitored");
    assertEquals(byName.get("VibeCoder")!.bytes, 2 * GIB);
    assertEquals(byName.get("GRQ-listing")!.tier, "disposable");
    assert(Math.abs(byName.get("GRQ-listing")!.ageDays - 5) < 0.01);
    assertEquals(byName.get("broken")!.hasGit, false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("scanWorkRootTiers - a fetch into .git keeps a data repo warm", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const dir = await makeDir(workDir, "GRQ-listing", { ageDays: 9 });
    // The gate fetched an hour ago: only `.git/FETCH_HEAD` moved.
    const fresh = new Date((NOW - 3600) * 1000);
    await Deno.utime(`${dir}/.git/FETCH_HEAD`, fresh, fresh);

    const { dirs } = await scanWorkRootTiers(workDir, MONITORED, {
      nowFn: () => NOW,
      sizeOf: () => Promise.resolve(GIB),
    });
    assert(
      dirs[0]!.ageDays < 1,
      `expected a warm repo, got ${dirs[0]!.ageDays}`,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

function record(
  name: string,
  bytes: number,
  ageDays: number,
  extra: Partial<WorkRootDir> = {},
): WorkRootDir {
  return {
    name,
    path: `/work/${name}`,
    tier: "disposable",
    bytes,
    ageDays,
    hasGit: true,
    readable: true,
    ...extra,
  };
}

Deno.test("selectAgedOutDirs - past the age limit, plus broken and unreadable dirs", () => {
  const dirs = [
    record("warm", GIB, 1),
    record("cold", GIB, 4),
    record("broken", 10, 0, { hasGit: false }),
    record("unreadable", 0, 0, { readable: false }),
    record("VibeCoder", 5 * GIB, 30, { tier: "monitored" }),
  ];
  assertEquals(
    selectAgedOutDirs(dirs, 3).map((d) => d.name),
    ["cold", "broken", "unreadable"],
  );
});

Deno.test("selectLargestFirst - takes the fewest dirs that free the space", () => {
  const dirs = [
    record("small", 1 * GIB, 0),
    record("huge", 7 * GIB, 0),
    record("medium", 4 * GIB, 0),
    record("VibeCoder", 20 * GIB, 0, { tier: "monitored" }),
  ];
  assertEquals(
    selectLargestFirst(dirs, 8 * GIB).map((d) => d.name),
    ["huge", "medium"],
  );
  // Nothing needed, nothing chosen.
  assertEquals(selectLargestFirst(dirs, 0), []);
  // More needed than exists — everything disposable goes, tier 1 never does.
  assertEquals(
    selectLargestFirst(dirs, 100 * GIB).map((d) => d.name),
    ["huge", "medium", "small"],
  );
});

Deno.test("reclaimWorkVolumeTiers - disk-low removes largest first and keeps monitored repos", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await makeDir(workDir, "VibeCoder");
    await makeDir(workDir, "GRQ");
    await makeDir(workDir, "GRQ-shareprices2026Q2");
    await makeDir(workDir, "GRQ-listing");
    await makeDir(workDir, "GRQ-portfolio");

    const logged: string[] = [];
    const result = await reclaimWorkVolumeTiers({
      workDir,
      monitoredRepos: MONITORED,
      mode: "disk-low",
      bytesNeeded: 10 * GIB,
      nowFn: () => NOW,
      sizeOf: sizes({
        VibeCoder: 1 * GIB,
        GRQ: 2 * GIB,
        "GRQ-shareprices2026Q2": 7 * GIB,
        "GRQ-listing": 4 * GIB,
        "GRQ-portfolio": 1 * GIB,
      }),
      anySlotActive: NEVER_ACTIVE,
      rescue: RESCUE_OK,
      log: (m) => logged.push(m),
    });

    assertEquals(result.removed.map((d) => d.name), [
      "GRQ-shareprices2026Q2",
      "GRQ-listing",
    ]);
    assertEquals(result.bytesReclaimed, 11 * GIB);
    assertEquals(result.monitored, { count: 2, bytes: 3 * GIB });
    assertEquals(result.disposable, { count: 3, bytes: 12 * GIB });
    assertEquals(await exists(`${workDir}/VibeCoder`), true);
    assertEquals(await exists(`${workDir}/GRQ`), true);
    assertEquals(await exists(`${workDir}/GRQ-portfolio`), true);
    assertEquals(await exists(`${workDir}/GRQ-shareprices2026Q2`), false);
    // Every removal names its size (Issue #242).
    assert(
      logged.some((l) => l.includes("GRQ-listing") && l.includes("4.0 GB")),
      logged.join("\n"),
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("reclaimWorkVolumeTiers - age mode drops idle side repos and keeps warm ones", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await makeDir(workDir, "VibeCoder", { ageDays: 30 });
    await makeDir(workDir, "GRQ-listing", { ageDays: 1 });
    await makeDir(workDir, "GRQ-companyreports", { ageDays: 4 });

    const result = await reclaimWorkVolumeTiers({
      workDir,
      monitoredRepos: MONITORED,
      mode: "age",
      maxAgeDays: 3,
      nowFn: () => NOW,
      sizeOf: sizes({ "GRQ-companyreports": 2 * GIB }),
      anySlotActive: NEVER_ACTIVE,
      rescue: RESCUE_OK,
    });

    assertEquals(result.removed.map((d) => d.name), ["GRQ-companyreports"]);
    // A monitored clone idle for 30 days is never removed by this path.
    assertEquals(await exists(`${workDir}/VibeCoder`), true);
    assertEquals(await exists(`${workDir}/GRQ-listing`), true);
    assertEquals(await exists(`${workDir}/GRQ-companyreports`), false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("reclaimWorkVolumeTiers - never prunes the audit trail (Issue #337)", async () => {
  // The audit directory has no `.git` and sits untouched between sweeps, so
  // before #337 it was disposable and both modes deleted it — which is what
  // made audit-chain-verify report AUDIT_CHAIN_BROKEN on every swept host.
  for (const mode of ["age", "disk-low"] as const) {
    const workDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${workDir}/audit/anchors`, { recursive: true });
      const journal = `${workDir}/audit/audit-worker-2026-08-22.jsonl`;
      await Deno.writeTextFile(journal, "{}\n");
      await Deno.writeTextFile(`${workDir}/audit.roster.jsonl`, "{}\n");
      const stale = new Date((NOW - 30 * 86400) * 1000);
      for (
        const p of [journal, `${workDir}/audit/anchors`, `${workDir}/audit`]
      ) {
        await Deno.utime(p, stale, stale);
      }
      await makeDir(workDir, "GRQ-listing", { ageDays: 30 });

      const result = await reclaimWorkVolumeTiers({
        workDir,
        monitoredRepos: MONITORED,
        mode,
        maxAgeDays: 3,
        bytesNeeded: 100 * GIB,
        nowFn: () => NOW,
        sizeOf: sizes({ audit: 4096, "GRQ-listing": 2 * GIB }),
        anySlotActive: NEVER_ACTIVE,
        rescue: RESCUE_OK,
      });

      // The sweep still does its job on the genuinely disposable clone.
      assertEquals(result.removed.map((d) => d.name), ["GRQ-listing"]);
      assertEquals(result.disposable.count, 1);
      assertEquals(await exists(journal), true);
      assertEquals(await exists(`${workDir}/audit.roster.jsonl`), true);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  }
});

Deno.test("reclaimWorkVolumeTiers - a slot mid-execute holds every removal back", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await makeDir(workDir, "GRQ-listing", { ageDays: 9 });
    const result = await reclaimWorkVolumeTiers({
      workDir,
      monitoredRepos: MONITORED,
      mode: "age",
      maxAgeDays: 3,
      nowFn: () => NOW,
      sizeOf: () => Promise.resolve(GIB),
      anySlotActive: () => Promise.resolve(true),
      rescue: RESCUE_OK,
    });
    assertEquals(result.skippedSlotActive, true);
    assertEquals(result.removed, []);
    assertEquals(await exists(`${workDir}/GRQ-listing`), true);
    assert(summariseWorkVolumeTiers(result).includes("mid-execute"));
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("reclaimWorkVolumeTiers - a failed push rescue keeps the directory", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await makeDir(workDir, "GRQ-listing", { ageDays: 9 });
    await makeDir(workDir, "scratch-copy", { ageDays: 9, git: false });

    const rescued: string[] = [];
    const result = await reclaimWorkVolumeTiers({
      workDir,
      monitoredRepos: MONITORED,
      mode: "age",
      maxAgeDays: 3,
      nowFn: () => NOW,
      sizeOf: () => Promise.resolve(GIB),
      anySlotActive: NEVER_ACTIVE,
      rescue: (path) => {
        rescued.push(path);
        return Promise.resolve({
          ok: false,
          pushedBranches: [],
          detail: "push of 'fix-1' failed",
        });
      },
    });

    assertEquals(result.keptRescueFailed, ["GRQ-listing"]);
    assertEquals(await exists(`${workDir}/GRQ-listing`), true);
    assertEquals(result.errors.length, 1);
    // A `.git`-less directory has nothing to rescue — it goes without one.
    assertEquals(result.removed.map((d) => d.name), ["scratch-copy"]);
    assertEquals(rescued.length, 1);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("reclaimWorkVolumeTiers - a removal failure is recorded, never thrown", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await makeDir(workDir, "GRQ-listing", { ageDays: 9 });
    const result = await reclaimWorkVolumeTiers({
      workDir,
      monitoredRepos: MONITORED,
      mode: "age",
      maxAgeDays: 3,
      nowFn: () => NOW,
      sizeOf: () => Promise.resolve(GIB),
      anySlotActive: NEVER_ACTIVE,
      rescue: RESCUE_OK,
      removeDir: () => Promise.reject(new Error("EBUSY")),
    });
    assertEquals(result.removed, []);
    assertEquals(result.bytesReclaimed, 0);
    assert(result.errors[0]!.includes("EBUSY"));
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("anySlotMidExecute - a fresh heartbeat is live, a stale one is not", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    assertEquals(await anySlotMidExecute(workDir, NOW), false);
    await Deno.writeTextFile(
      `${workDir}/.heartbeat_owner_GRQ_42`,
      `${NOW - 60}`,
    );
    assertEquals(await anySlotMidExecute(workDir, NOW), true);
    await Deno.writeTextFile(
      `${workDir}/.heartbeat_owner_GRQ_42`,
      `${NOW - 86400}`,
    );
    assertEquals(await anySlotMidExecute(workDir, NOW), false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("anySlotMidExecute - an unreadable work root fails safe", async () => {
  assertEquals(
    await anySlotMidExecute("/nonexistent-work-root-242", NOW),
    true,
  );
});

Deno.test("summariseWorkVolumeTiers - names both tiers and what went", () => {
  const line = summariseWorkVolumeTiers({
    mode: "disk-low",
    monitored: { count: 15, bytes: Math.round(2.1 * GIB) },
    disposable: { count: 8, bytes: Math.round(15.2 * GIB) },
    removed: [record("GRQ-listing", 4 * GIB, 0)],
    bytesReclaimed: 4 * GIB,
    keptRescueFailed: [],
    skippedSlotActive: false,
    errors: [],
  });
  assertEquals(
    line,
    "monitored 2.1 GB in 15 repos; side/data 15.2 GB in 8 dirs; " +
      "removed 1 (4.0 GB, disk-low)",
  );
});
