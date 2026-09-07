/**
 * Tests for the work-volume prune (Issue #228).
 *
 * Real temp directories, injected clock and sizes: the assertions are about
 * which directories go and which are protected — an active repo's target,
 * the worker's own state directories, plain files in the work root.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ArtefactRecord,
  findCargoTargets,
  pruneWorkVolume,
  repoHasHeartbeat,
  selectArtefactsToRemove,
  summariseWorkVolumePrune,
} from "../lib/work_volume_prune.ts";

const GIB = 1_073_741_824;
const NOW = 1_786_000_000;

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function touch(path: string, epoch: number): Promise<void> {
  const when = new Date(epoch * 1000);
  await Deno.utime(path, when, when);
}

/** A repo clone with a cargo target dir, aged as asked. */
async function makeRepo(
  workDir: string,
  name: string,
  options: { targetAgeDays?: number; nested?: boolean } = {},
): Promise<string> {
  const repo = `${workDir}/${name}`;
  await Deno.mkdir(`${repo}/.git`, { recursive: true });
  const base = options.nested ? `${repo}/rust` : repo;
  await Deno.mkdir(`${base}/target/debug`, { recursive: true });
  await Deno.writeTextFile(`${base}/Cargo.toml`, "[package]\n");
  await Deno.writeTextFile(`${base}/target/debug/a.o`, "x");
  const age = (options.targetAgeDays ?? 0) * 86400;
  for (
    const p of [
      `${base}/target/debug/a.o`,
      `${base}/target/debug`,
      `${base}/target`,
    ]
  ) {
    await touch(p, NOW - age);
  }
  return `${base}/target`;
}

Deno.test("findCargoTargets - the root target and one level down, only beside a Cargo.toml", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const root = await makeRepo(tmp, "a");
    const nested = await makeRepo(tmp, "b", { nested: true });
    // A `target` with no Cargo.toml beside it is not cargo's.
    await Deno.mkdir(`${tmp}/c/.git`, { recursive: true });
    await Deno.mkdir(`${tmp}/c/target`, { recursive: true });
    assertEquals(await findCargoTargets(`${tmp}/a`), [root]);
    assertEquals(await findCargoTargets(`${tmp}/b`), [nested]);
    assertEquals(await findCargoTargets(`${tmp}/c`), []);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("selectArtefactsToRemove - past the age limit, then oldest first until under the cap", () => {
  const r = (repo: string, gb: number, ageDays: number): ArtefactRecord => ({
    repo,
    path: `/w/${repo}/target`,
    bytes: gb * GIB,
    ageDays,
  });
  const records = [
    r("old", 1, 5),
    r("big-old", 7, 1.5),
    r("big-new", 7, 0.1),
    r("small", 1, 0.5),
  ];
  const removed = selectArtefactsToRemove(records, 2, 10 * GIB).map((x) =>
    x.repo
  );
  // "old" by age; then 15 GB remain > 10 GB → oldest (big-old) goes → 8 GB.
  // Returned in listing order.
  assertEquals(removed, ["old", "big-old"]);
  assertEquals(selectArtefactsToRemove(records, 10, 100 * GIB), []);
});

Deno.test("repoHasHeartbeat - matches the repo segment of a heartbeat file name", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // A live beat, not the placeholder "1": the file's epoch is now read and
    // age-checked, so only a fresh beat marks the repo active (Issue #1232).
    await Deno.writeTextFile(
      `${tmp}/.heartbeat_stSoftwareAU_NEAT-AI-core_42`,
      `${NOW - 60}`,
    );
    assertEquals(await repoHasHeartbeat(tmp, "NEAT-AI-core", NOW), true);
    assertEquals(await repoHasHeartbeat(tmp, "NEAT-AI", NOW), false);
    assertEquals(await repoHasHeartbeat(tmp, "core", NOW), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("repoHasHeartbeat - a forged future-dated heartbeat never marks a repo active", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const path = `${tmp}/.heartbeat_a_NEAT-AI-core_1`;
    // Exactly what any process in the agent-writable work root can drop.
    await Deno.writeTextFile(path, "9999999999");
    assertEquals(await repoHasHeartbeat(tmp, "NEAT-AI-core", NOW), false);

    // A stale beat is no longer active either, and a fresh one still is.
    await Deno.writeTextFile(path, `${NOW - 5 * 86400}`);
    assertEquals(await repoHasHeartbeat(tmp, "NEAT-AI-core", NOW), false);
    await Deno.writeTextFile(path, `${NOW - 30}`);
    assertEquals(await repoHasHeartbeat(tmp, "NEAT-AI-core", NOW), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("pruneWorkVolume - a forged heartbeat does not exempt a repo's artefacts", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const stale = await makeRepo(tmp, "stale", { targetAgeDays: 5 });
    // The forged file names the repo and carries a far-future epoch.
    await Deno.writeTextFile(`${tmp}/.heartbeat_a_stale_1`, "9999999999");

    const result = await pruneWorkVolume({
      workDir: tmp,
      nowFn: () => NOW,
      sizeOf: () => Promise.resolve(GIB),
    });

    assertEquals(result.artefacts.skippedActive, []);
    assertEquals(result.artefacts.removed.map((r) => r.repo), ["stale"]);
    assertEquals(await exists(stale), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("pruneWorkVolume - removes stale targets, the oldest over the cap, never an active repo's", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const stale = await makeRepo(tmp, "stale", { targetAgeDays: 5 });
    const fresh = await makeRepo(tmp, "fresh", { targetAgeDays: 0 });
    const active = await makeRepo(tmp, "active", { targetAgeDays: 9 });
    const sizes: Record<string, number> = {
      [stale]: 1 * GIB,
      [fresh]: 2 * GIB,
      [active]: 8 * GIB,
    };
    const result = await pruneWorkVolume({
      workDir: tmp,
      nowFn: () => NOW,
      sizeOf: (p) => Promise.resolve(sizes[p] ?? 0),
      isRepoActive: (_w, name) => Promise.resolve(name === "active"),
      artefactMaxAgeDays: 2,
      artefactMaxTotalBytes: 10 * GIB,
    });
    assertEquals(result.errors, []);
    assertEquals(result.artefacts.removed.map((r) => r.repo), ["stale"]);
    assertEquals(result.artefacts.skippedActive, ["active"]);
    assertEquals(await exists(stale), false);
    assertEquals(await exists(fresh), true);
    assertEquals(await exists(active), true);
    assert(summariseWorkVolumePrune(result).includes("removed 1"));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("pruneWorkVolume - old scratch dot-dirs in the work root go; the worker's own state dirs and files stay", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    for (
      const d of [
        ".bench-history-b4e5",
        ".before-src",
        ".deno-cache",
        ".claude-sessions",
        ".fresh-scratch",
      ]
    ) {
      await Deno.mkdir(`${tmp}/${d}`, { recursive: true });
      await touch(`${tmp}/${d}`, NOW - 3 * 86400);
    }
    await touch(`${tmp}/.fresh-scratch`, NOW - 3600);
    await Deno.writeTextFile(`${tmp}/.cooldown_state.json`, "{}");
    await touch(`${tmp}/.cooldown_state.json`, NOW - 30 * 86400);
    const result = await pruneWorkVolume({
      workDir: tmp,
      nowFn: () => NOW,
      sizeOf: () => Promise.resolve(0),
      isRepoActive: () => Promise.resolve(false),
      scratchMaxAgeHours: 24,
    });
    assertEquals(result.errors, []);
    assertEquals(result.scratch.removed.sort(), [
      ".before-src",
      ".bench-history-b4e5",
    ]);
    assertEquals(await exists(`${tmp}/.deno-cache`), true);
    assertEquals(await exists(`${tmp}/.claude-sessions`), true);
    assertEquals(await exists(`${tmp}/.fresh-scratch`), true);
    assertEquals(await exists(`${tmp}/.cooldown_state.json`), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("pruneWorkVolume - marker state files older than the limit are removed; fresh ones stay", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmp}/.heartbeat-marker_org_repo_1`, "{}");
    await touch(`${tmp}/.heartbeat-marker_org_repo_1`, NOW - 5 * 86400);
    await Deno.writeTextFile(`${tmp}/.heartbeat-marker_org_repo_2`, "{}");
    await touch(`${tmp}/.heartbeat-marker_org_repo_2`, NOW - 600);
    const result = await pruneWorkVolume({
      workDir: tmp,
      nowFn: () => NOW,
      sizeOf: () => Promise.resolve(0),
      isRepoActive: () => Promise.resolve(false),
      markerMaxAgeDays: 2,
    });
    assertEquals(result.markers.removed, [".heartbeat-marker_org_repo_1"]);
    assertEquals(await exists(`${tmp}/.heartbeat-marker_org_repo_2`), true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
