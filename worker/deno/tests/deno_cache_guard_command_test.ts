/**
 * Tests for the deno-cache-guard command (Issue #4302).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { denoCacheGuardCommand } from "../commands/deno_cache_guard.ts";
import { denoCacheDir } from "../lib/deno_cache_guard.ts";
import type { WorkerConfig } from "../types.ts";

const CONFIG = { workDir: "" } as unknown as WorkerConfig;

Deno.test("deno-cache-guard command - requires a work dir", async () => {
  // The empty string is "WORK_DIR is not set", handed in rather than
  // deleted from the process (Issue #966): deleting it raced every other
  // worker sharing this process, and left the assertion at the mercy of
  // whether the ambient variable happened to be set.
  const result = await denoCacheGuardCommand.execute({}, CONFIG, "");
  assertEquals(result.success, false);
  assertStringIncludes(result.message ?? "", "work-dir");
});

Deno.test("deno-cache-guard command - guards the injected work dir, never the ambient WORK_DIR (Issue #966)", async () => {
  // A code path that fell back to `Deno.env.get("WORK_DIR")` would wipe
  // whatever the real variable names. The injected directory is one no
  // environment carries, so a fallback misses this cache and fails here.
  const injected = await Deno.makeTempDir({ prefix: "deno_guard_injected_" });
  try {
    const dir = denoCacheDir(injected);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/blob.bin`, "x".repeat(2048));

    const result = await denoCacheGuardCommand.execute(
      { "max-bytes": "1024" },
      CONFIG,
      injected,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message ?? "", "wiped");
    await assertRejects(() => Deno.stat(dir), Deno.errors.NotFound);
  } finally {
    await Deno.remove(injected, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("deno-cache-guard command - rejects an invalid max-bytes", async () => {
  const result = await denoCacheGuardCommand.execute(
    { "work-dir": "/tmp", "max-bytes": "not-a-number" },
    CONFIG,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message ?? "", "max-bytes");
});

Deno.test("deno-cache-guard command - wipes an oversized cache", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "deno_guard_cmd_" });
  try {
    const dir = denoCacheDir(workDir);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/blob.bin`, "x".repeat(2048));

    const result = await denoCacheGuardCommand.execute(
      { "work-dir": workDir, "max-bytes": "1024" },
      CONFIG,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message ?? "", "wiped");
    let exists = true;
    try {
      await Deno.stat(dir);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
