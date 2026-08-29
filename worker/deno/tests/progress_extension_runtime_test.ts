/**
 * Tests for the progress-extension wiring (Issue #4296, part of #4290).
 *
 * The rolling probe is driven against a real temporary git repo — a verdict
 * is only worth acting on if real git state moves it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";
import {
  buildProgressExtension,
  createRollingDescendantProbe,
  createRollingTreeProbe,
} from "../lib/progress_extension_runtime.ts";
import { probeWorktreeFingerprint } from "../lib/worktree_progress.ts";
import { WIND_DOWN_NOTICE_FILENAME } from "../lib/wind_down_notice.ts";

/** Run a git command in `cwd`, failing loudly when it does not succeed. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runWithTimeout("git", args, { cwd, timeoutMs: 20_000 });
  if (!result.ok || !result.value.success) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  }
}

/** Create a temp git repo with one committed file. Returns its path. */
async function makeRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "progress-extension-" });
  await git(dir, "init", "--quiet");
  await git(dir, "config", "user.email", "worker@example.com");
  await git(dir, "config", "user.name", "Vibe Worker");
  await git(dir, "config", "commit.gpgsign", "false");
  await Deno.writeTextFile(`${dir}/README.md`, "line one\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

Deno.test("buildProgressExtension - disabled config yields no option at all", async () => {
  const dir = await makeRepo();
  try {
    assertEquals(
      await buildProgressExtension({ progressExtensionEnabled: false }, dir),
      undefined,
      "the runner must receive nothing, so the timeout is unchanged",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildProgressExtension - non-positive tunables refuse to extend", async () => {
  const dir = await makeRepo();
  try {
    assertEquals(
      await buildProgressExtension({
        progressExtensionEnabled: true,
        progressExtensionGrantSeconds: 0,
        progressExtensionStallSeconds: 300,
      }, dir),
      undefined,
    );
    assertEquals(
      await buildProgressExtension({
        progressExtensionEnabled: true,
        progressExtensionGrantSeconds: 900,
        progressExtensionStallSeconds: -1,
      }, dir),
      undefined,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildProgressExtension - enabled config carries the policy and a live probe", async () => {
  const dir = await makeRepo();
  try {
    const built = await buildProgressExtension({
      progressExtensionEnabled: true,
      progressExtensionGrantSeconds: 900,
      progressExtensionStallSeconds: 300,
    }, dir);

    assert(built, "an enabled config must produce the option");
    assertEquals(built.policy, {
      enabled: true,
      grantSeconds: 900,
      activityStallSeconds: 300,
    });
    // Nothing has changed since the baseline was taken before the run.
    assertEquals(await built.treeProbe(), "unchanged");
    await Deno.writeTextFile(`${dir}/new.ts`, "export const x = 1;\n");
    assertEquals(await built.treeProbe(), "advanced");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildProgressExtension - carries the run hard cap ceiling when one is given (Issue #421)", async () => {
  const dir = await makeRepo();
  const config = {
    progressExtensionEnabled: true,
    progressExtensionGrantSeconds: 900,
    progressExtensionStallSeconds: 300,
  };
  try {
    const capped = await buildProgressExtension(
      config,
      dir,
      undefined,
      1_700_000_000_000,
    );
    assert(capped, "an enabled config must produce the option");
    assertEquals(capped.ceilingMs, 1_700_000_000_000);

    // Omitted, the option carries no ceiling and extensions stay unbounded.
    const uncapped = await buildProgressExtension(config, dir);
    assert(uncapped);
    assertEquals(uncapped.ceilingMs, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("buildProgressExtension - wires the external probe and the wind-down notice (Issue #508)", async () => {
  const dir = await makeRepo();
  try {
    const built = await buildProgressExtension({
      progressExtensionEnabled: true,
      progressExtensionGrantSeconds: 900,
      progressExtensionStallSeconds: 300,
    }, dir);
    assert(built, "an enabled config must produce the option");
    assert(
      built.externalProbe,
      "a supervising agent's descendants must be visible to the gate",
    );
    // The live probe against this process: the first call takes the baseline.
    assertEquals(await built.externalProbe(Deno.pid), "unknown");

    assert(built.onWindDown, "the agent must have a budget channel");
    await built.onWindDown({
      remainingSeconds: 240,
      elapsedSeconds: 3_600,
      extensionsGranted: 2,
    });
    const notice = await Deno.readTextFile(
      `${dir}/${WIND_DOWN_NOTICE_FILENAME}`,
    );
    assert(notice.includes("240"), notice);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createRollingDescendantProbe - CPU burnt by a descendant reads as active work (Issue #508)", async () => {
  let cpuSeconds = 100;
  /** `HH:MM:SS`, as `ps -o time=` prints it. */
  const cpuTime = (seconds: number): string =>
    `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:` +
    `${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:` +
    `${String(seconds % 60).padStart(2, "0")}`;
  // A stable table: the agent (pid 200) with one child that accumulates CPU
  // between reads.
  const probe = createRollingDescendantProbe({
    runPs: () =>
      Promise.resolve(
        `  200     1 00:10:00\n  300   200 ${cpuTime(cpuSeconds)}`,
      ),
  });

  assertEquals(
    await probe(200),
    "unknown",
    "the first read has no window to compare against",
  );
  assertEquals(await probe(200), "idle", "no CPU burnt between the reads");
  cpuSeconds = 130;
  assertEquals(await probe(200), "active");
  assertEquals(await probe(200), "idle", "the delta is spent, not repeated");
});

Deno.test("createRollingDescendantProbe - a failed read is unknown and keeps the baseline (Issue #508)", async () => {
  let table = "  200     1 00:10:00\n  300   200 00:00:10";
  const probe = createRollingDescendantProbe({
    runPs: () =>
      table === ""
        ? Promise.reject(new Error("ps failed"))
        : Promise.resolve(table),
  });

  assertEquals(await probe(200), "unknown", "baseline");
  table = "";
  assertEquals(await probe(200), "unknown", "a broken read is never progress");
  // The baseline survived the failure, so the next good read still compares
  // against the CPU seen before it rather than fabricating a delta.
  table = "  200     1 00:10:00\n  300   200 00:00:10";
  assertEquals(await probe(200), "idle");
});

Deno.test("createRollingTreeProbe - compares against the previous check, not the baseline", async () => {
  const dir = await makeRepo();
  try {
    const probe = createRollingTreeProbe(
      dir,
      await probeWorktreeFingerprint(dir),
    );

    await Deno.writeTextFile(`${dir}/a.ts`, "export const a = 1;\n");
    assertEquals(await probe(), "advanced");
    // The edit is now the baseline — a run that stops editing reads as
    // unchanged on the very next check, which is what kills a stalled run.
    assertEquals(await probe(), "unchanged");
    await Deno.writeTextFile(`${dir}/b.ts`, "export const b = 2;\n");
    assertEquals(await probe(), "advanced");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createRollingTreeProbe - a directory that is not a repo reads as unknown", async () => {
  const dir = await Deno.makeTempDir({ prefix: "progress-extension-bare-" });
  try {
    const probe = createRollingTreeProbe(
      dir,
      await probeWorktreeFingerprint(dir),
    );
    assertEquals(
      await probe(),
      "unknown",
      "an unverifiable tree must never read as progress",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
