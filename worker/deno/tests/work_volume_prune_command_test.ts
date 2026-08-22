/**
 * Tests for the work-volume-prune command's standing-totals breakdown
 * (Issue #244).
 *
 * The prune already logged what it *removed*; the summary now carries what
 * the volume still holds, and the "after" line only when a reclamation
 * actually happened — so the before/after of a reclamation is visible in
 * the housekeeping log without paying for a second walk on an idle run.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { WorkerConfig } from "../types.ts";
import { workVolumePruneCommand } from "../commands/work_volume_prune.ts";

function config(repos: string[]): WorkerConfig {
  return { repos } as WorkerConfig;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A monitored clone with a cargo target dir of the given age. */
async function makeRepo(
  workDir: string,
  name: string,
  targetAgeDays: number,
): Promise<void> {
  const repo = `${workDir}/${name}`;
  await Deno.mkdir(`${repo}/.git`, { recursive: true });
  await Deno.mkdir(`${repo}/target/debug`, { recursive: true });
  await Deno.writeTextFile(`${repo}/Cargo.toml`, "[package]\n");
  await Deno.writeTextFile(`${repo}/target/debug/a.o`, "x".repeat(1024));
  const when = new Date(Date.now() - targetAgeDays * 86400 * 1000);
  for (
    const p of [
      `${repo}/target/debug/a.o`,
      `${repo}/target/debug`,
      `${repo}/target`,
    ]
  ) {
    await Deno.utime(p, when, when);
  }
}

Deno.test("work-volume-prune - an idle run reports the standing totals once, with no 'after' line", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeRepo(tmp, "VibeCoder", 0);
    await Deno.mkdir(`${tmp}/GRQ-shareprices2026Q2`, { recursive: true });
    await Deno.mkdir(`${tmp}/.deno-cache`, { recursive: true });

    const result = await workVolumePruneCommand.execute(
      { "work-dir": tmp, "artefact-max-age-days": 2 },
      config(["stSoftwareAU/VibeCoder"]),
    );

    assertEquals(result.success, true);
    assertStringIncludes(result.message, "Work volume before: total ");
    assertStringIncludes(result.message, "monitored repos ");
    assertStringIncludes(result.message, "side/data clones ");
    assertStringIncludes(result.message, "(1: GRQ-shareprices2026Q2 ");
    assertStringIncludes(result.message, "1 target dir: VibeCoder/target");
    assert(
      !result.message.includes("Work volume after"),
      "an idle prune must not pay for a second walk",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("work-volume-prune - a reclamation reports both the before and the after breakdown", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeRepo(tmp, "VibeCoder", 30);

    const result = await workVolumePruneCommand.execute(
      { "work-dir": tmp, "artefact-max-age-days": 2 },
      config(["stSoftwareAU/VibeCoder"]),
    );

    assertEquals(result.success, true);
    assertStringIncludes(result.message, "removed 1 ");
    assertEquals(await exists(`${tmp}/VibeCoder/target`), false);
    assertStringIncludes(result.message, "Work volume before: total ");
    assertStringIncludes(result.message, "Work volume after: total ");
    // The stale target is gone, so the "after" line no longer names one.
    const after = result.message.slice(result.message.indexOf("after: total"));
    assertStringIncludes(after, "build artefacts 0.0 GB (0 target dirs)");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("work-volume-prune - with no monitored repositories the split is refused, not guessed", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/GRQ-listing`, { recursive: true });
    const result = await workVolumePruneCommand.execute(
      { "work-dir": tmp },
      config([]),
    );
    assertEquals(result.success, true);
    assertStringIncludes(
      result.message,
      "Work volume before: standing totals skipped — no monitored repositories configured",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("work-volume-prune - still rejects an invalid knob before measuring anything", async () => {
  const result = await workVolumePruneCommand.execute(
    { "work-dir": "/tmp", "artefact-max-age-days": "not-a-number" },
    config(["stSoftwareAU/VibeCoder"]),
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "must be a non-negative number");
});
