/**
 * Tests for the stale-workdir command (Issue #1493).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { staleWorkDirCommand } from "../commands/stale_workdir.ts";
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
  const previousEnv = Deno.env.get("WORK_DIR");
  Deno.env.delete("WORK_DIR");
  try {
    const result = await staleWorkDirCommand.execute({}, emptyConfig);
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "--work-dir is required");
  } finally {
    if (previousEnv !== undefined) Deno.env.set("WORK_DIR", previousEnv);
  }
});

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
