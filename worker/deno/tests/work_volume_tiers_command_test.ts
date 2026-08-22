/**
 * Tests for the work-volume-tiers command (Issue #242).
 *
 * The production monitored list comes from the loaded configuration; the
 * command validates its knobs and refuses to tier a work root it has no
 * monitored list for rather than treating every clone as disposable.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import type { WorkerConfig } from "../types.ts";
import {
  resolveMonitoredRepos,
  workVolumeTiersCommand,
} from "../commands/work_volume_tiers.ts";

const GIB = 1_073_741_824;

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    repos: ["stSoftwareAU/VibeCoder", "stSoftwareAU/GRQ"],
    ...overrides,
  } as WorkerConfig;
}

async function makeClone(workDir: string, name: string, ageDays: number) {
  const dir = `${workDir}/${name}`;
  await Deno.mkdir(`${dir}/.git`, { recursive: true });
  await Deno.writeTextFile(`${dir}/README.md`, "x\n");
  await Deno.writeTextFile(`${dir}/.git/FETCH_HEAD`, "abc\n");
  const when = new Date(Date.now() - ageDays * 86400 * 1000);
  for (
    const p of [
      `${dir}/README.md`,
      `${dir}/.git/FETCH_HEAD`,
      `${dir}/.git`,
      dir,
    ]
  ) {
    await Deno.utime(p, when, when);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("resolveMonitoredRepos - falls back to the loaded config", () => {
  assertEquals(resolveMonitoredRepos({}, config()), [
    "stSoftwareAU/VibeCoder",
    "stSoftwareAU/GRQ",
  ]);
  assertEquals(resolveMonitoredRepos({ repos: "o/a, o/b" }, config()), [
    "o/a",
    "o/b",
  ]);
  assertEquals(resolveMonitoredRepos({ repos: ["o/a"] }, config()), ["o/a"]);
  assertEquals(resolveMonitoredRepos({}, undefined), []);
});

Deno.test("work-volume-tiers - ages out a side clone and keeps the monitored ones", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await makeClone(workDir, "VibeCoder", 30);
    await makeClone(workDir, "GRQ-shareprices2026Q2", 9);
    await makeClone(workDir, "GRQ-listing", 1);

    const result = await workVolumeTiersCommand.execute(
      { "work-dir": workDir, "mode": "age", "max-age-days": 3 },
      config(),
    );

    assertEquals(result.success, true);
    assert(result.message.includes("monitored"), result.message);
    assertEquals(await exists(`${workDir}/VibeCoder`), true);
    assertEquals(await exists(`${workDir}/GRQ-listing`), true);
    assertEquals(await exists(`${workDir}/GRQ-shareprices2026Q2`), false);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("work-volume-tiers - disk-low mode needs the bytes it must free", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const missing = await workVolumeTiersCommand.execute(
      { "work-dir": workDir, "mode": "disk-low" },
      config(),
    );
    assertEquals(missing.success, false);
    assert(missing.message.includes("--bytes-needed"), missing.message);

    // Nothing needed frees nothing, whatever sits in the work root.
    await makeClone(workDir, "GRQ-listing", 0);
    const none = await workVolumeTiersCommand.execute(
      { "work-dir": workDir, "mode": "disk-low", "bytes-needed": 0 },
      config(),
    );
    assertEquals(none.success, true);
    assert(none.message.includes("removed 0"), none.message);
    assertEquals(await exists(`${workDir}/GRQ-listing`), true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("work-volume-tiers - rejects an unknown mode and negative knobs", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const mode = await workVolumeTiersCommand.execute(
      { "work-dir": workDir, "mode": "everything" },
      config(),
    );
    assertEquals(mode.success, false);
    assert(mode.message.includes("--mode"), mode.message);

    const knob = await workVolumeTiersCommand.execute(
      { "work-dir": workDir, "max-age-days": -1 },
      config(),
    );
    assertEquals(knob.success, false);
    assert(knob.message.includes("max-age-days"), knob.message);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("work-volume-tiers - an empty monitored list fails loud, removing nothing", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await makeClone(workDir, "VibeCoder", 30);
    const result = await workVolumeTiersCommand.execute(
      { "work-dir": workDir, "mode": "disk-low", "bytes-needed": 50 * GIB },
      config({ repos: [] }),
    );
    assertEquals(result.success, false);
    assert(
      result.message.includes("no monitored repositories"),
      result.message,
    );
    assertEquals(await exists(`${workDir}/VibeCoder`), true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("work-volume-tiers - a missing work dir is refused", async () => {
  const previous = Deno.env.get("WORK_DIR");
  Deno.env.delete("WORK_DIR");
  try {
    const result = await workVolumeTiersCommand.execute(
      {},
      config({ workDir: "" }),
    );
    assertEquals(result.success, false);
    assert(result.message.includes("--work-dir"), result.message);
  } finally {
    if (previous !== undefined) Deno.env.set("WORK_DIR", previous);
  }
});
