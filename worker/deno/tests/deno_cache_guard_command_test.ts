/**
 * Tests for the deno-cache-guard command (Issue #4302).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { denoCacheGuardCommand } from "../commands/deno_cache_guard.ts";
import { denoCacheDir } from "../lib/deno_cache_guard.ts";
import type { WorkerConfig } from "../types.ts";

const CONFIG = { workDir: "" } as unknown as WorkerConfig;

Deno.test("deno-cache-guard command - requires a work dir", async () => {
  const previous = Deno.env.get("WORK_DIR");
  Deno.env.delete("WORK_DIR");
  try {
    const result = await denoCacheGuardCommand.execute({}, CONFIG);
    assertEquals(result.success, false);
    assertStringIncludes(result.message ?? "", "work-dir");
  } finally {
    if (previous !== undefined) Deno.env.set("WORK_DIR", previous);
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
