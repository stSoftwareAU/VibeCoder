/**
 * Tests for the stale-workdir command (Issue #1493).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { staleWorkDirCommand } from "../commands/stale_workdir.ts";
import { setupRepo } from "../commands/git_operations.ts";
import { laneWorktreePath } from "../lib/lane_worktree.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

Deno.test("staleWorkDirCommand - has correct name", () => {
  assertEquals(staleWorkDirCommand.name, "stale-workdir");
});

Deno.test("staleWorkDirCommand - has description", () => {
  assertEquals(typeof staleWorkDirCommand.description, "string");
  assertEquals(staleWorkDirCommand.description.length > 0, true);
});

Deno.test("staleWorkDirCommand - fails when work-dir missing and no config/env fallback", async () => {
  const emptyConfig = buildDefaultWorkerConfig({ workDir: "" });
  // "WORK_DIR is not set" is handed in as the empty string rather than
  // deleted from the process (Issue #966). Deleting it raced every other
  // worker in this process, and left the assertion resting on whether the
  // ambient variable happened to be set at all.
  const result = await staleWorkDirCommand.execute({}, emptyConfig, "");
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--work-dir is required");
});

Deno.test("staleWorkDirCommand - sweeps the injected work dir, never the ambient WORK_DIR (Issue #966)", async () => {
  // The directory arrives through the parameter and through nothing else:
  // a code path that fell back to `Deno.env.get("WORK_DIR")` would scan
  // some other root, find no stale clone, and fail this assertion rather
  // than passing on the ambient value.
  const injected = await Deno.makeTempDir({ prefix: "stale_workdir_param_" });
  try {
    const repoPath = `${injected}/old-repo`;
    await Deno.mkdir(`${repoPath}/.git`, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    await Deno.utime(
      repoPath,
      new Date(now * 1000),
      new Date((now - 30 * 86400) * 1000),
    );

    const result = await staleWorkDirCommand.execute(
      {},
      buildDefaultWorkerConfig({ workDir: "" }),
      injected,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, injected);
    assertStringIncludes(result.message, "removed 1 stale");
    assertEquals(await exists(repoPath), false);
  } finally {
    await Deno.remove(injected, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("an injected work dir is no bypass: an escaping path segment is still refused (Issue #966)", async () => {
  // WORK_DIR is the root every clone, lane worktree and sweep is derived
  // from, and both derivations refuse a segment that would climb out of it
  // (`..`, empty, `/`, `\`). Handing the root in as a parameter must not
  // become a way past those checks, so the refusals are asserted against
  // an injected root rather than an environment-derived one.
  const injected = await Deno.makeTempDir({ prefix: "workdir_escape_" });
  try {
    for (const slug of ["owner/..", "owner/.", "owner/", "owner/a\\b"]) {
      const result = await setupRepo(slug, injected);
      assertEquals(result.success, false, `setupRepo accepted "${slug}"`);
      assertStringIncludes(result.message ?? "", "unsafe path segment");
    }
    // The refusal lands before any git command, so the injected root is
    // untouched — `setupRepo` opens with `reset --hard` and `clean -fd`,
    // which is why the check is re-asserted at this choke-point.
    assertEquals([...Deno.readDirSync(injected)], []);

    // The per-lane worktree derivation (Issue #923) refuses the same
    // segments, in both the repo slug and the lane id.
    assertThrows(
      () => laneWorktreePath(injected, "owner/..", "lane"),
      Error,
      "unsafe repo segment",
    );
    assertThrows(
      () => laneWorktreePath(injected, "owner/repo", "../escape"),
      Error,
      "unsafe lane id",
    );
    // A safe pair still resolves, and stays under the injected root.
    assertEquals(
      laneWorktreePath(injected, "owner/repo", "m1"),
      `${injected}/worktrees/m1/repo`,
    );
  } finally {
    await Deno.remove(injected, { recursive: true }).catch(() => undefined);
  }
});

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("staleWorkDirCommand - fails on non-numeric max-age-days", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await staleWorkDirCommand.execute(
      { "work-dir": tmpDir, "max-age-days": "not-a-number" },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "invalid --max-age-days");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("staleWorkDirCommand - reports success on clean work dir", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await staleWorkDirCommand.execute(
      { "work-dir": tmpDir },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "no stale or partial directories");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("staleWorkDirCommand - honours numeric max-age-days argument", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await staleWorkDirCommand.execute(
      { "work-dir": tmpDir, "max-age-days": 3 },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("staleWorkDirCommand - uses config.staleWorkDirDays when flag absent", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = buildDefaultWorkerConfig({
      workDir: tmpDir,
      staleWorkDirDays: 3,
    });

    // Build a repo clone modified 5 days ago — stale at 3-day threshold,
    // active at the default 7-day threshold.
    const repoPath = `${tmpDir}/old-repo`;
    await Deno.mkdir(`${repoPath}/.git`, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    const past = new Date((now - 5 * 86400) * 1000);
    await Deno.utime(repoPath, new Date(now * 1000), past);

    const result = await staleWorkDirCommand.execute({}, config);
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "removed 1 stale");
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch { /* already removed */ }
  }
});
