/**
 * Tests for deno_cache.ts — Deno cache cleanup utilities.
 *
 * Issue #1489: Clean Deno cache when low on disk space.
 *
 * These tests substitute a stand-in executable (/bin/true, /bin/false, a
 * non-existent binary) for the real `deno` binary so they never mutate
 * the developer's actual Deno cache and remain fast.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  cleanDenoCache,
  type DenoCacheCleanResult,
} from "../lib/deno_cache.ts";

/** Resolve a system binary across macOS (/usr/bin) and Linux (/bin). */
function resolveBinary(name: string): string {
  for (const dir of ["/usr/bin", "/bin"]) {
    try {
      Deno.statSync(`${dir}/${name}`);
      return `${dir}/${name}`;
    } catch {
      continue;
    }
  }
  throw new Error(`Could not locate ${name} on this system`);
}

const TRUE_BIN = resolveBinary("true");
const FALSE_BIN = resolveBinary("false");

Deno.test("deno_cache - cleanDenoCache returns a result with expected fields", async () => {
  const result: DenoCacheCleanResult = await cleanDenoCache({
    executable: TRUE_BIN,
  });
  assertEquals(typeof result.success, "boolean");
  assertEquals(typeof result.message, "string");
  assertEquals(typeof result.timedOut, "boolean");
});

Deno.test("deno_cache - cleanDenoCache reports success when executable exits 0", async () => {
  const result = await cleanDenoCache({ executable: TRUE_BIN });
  assertEquals(result.success, true);
  assertEquals(result.timedOut, false);
  assertStringIncludes(result.message, "succeeded");
});

Deno.test("deno_cache - cleanDenoCache reports failure when executable exits non-zero", async () => {
  const result = await cleanDenoCache({ executable: FALSE_BIN });
  assertEquals(result.success, false);
  assertEquals(result.timedOut, false);
  assertStringIncludes(result.message, "exited with code");
});

Deno.test("deno_cache - cleanDenoCache includes stderr in failure message (Issue #1979)", async () => {
  // Use bash to emit stderr and exit non-zero. bash with args ["clean",
  // "--quiet"] will fail because "clean" is not an existing script, and bash
  // will write "bash: clean: No such file or directory" (or similar) to
  // stderr. The failure message must include that stderr text now that
  // subprocess_timeout always pipes stderr regardless of quiet.
  const result = await cleanDenoCache({
    executable: "/bin/bash",
  });
  assertEquals(result.success, false);
  assertEquals(result.timedOut, false);
  assertStringIncludes(result.message, "exited with code");
  // The lowercased message should include "clean" (bash's error references
  // the missing script name).
  assertStringIncludes(result.message.toLowerCase(), "clean");
});

Deno.test("deno_cache - cleanDenoCache reports failure when executable is missing", async () => {
  const result = await cleanDenoCache({
    executable: "/no/such/binary/definitely-not-deno-1489",
  });
  assertEquals(result.success, false);
  assertStringIncludes(
    result.message.toLowerCase(),
    "deno clean failed to start",
  );
});

Deno.test("deno_cache - cleanDenoCache honours timeout", async () => {
  // Use a temporary script that sleeps regardless of its arguments so the
  // timeout fires reliably. `sleep clean --quiet` exits immediately on
  // Linux (invalid interval), so we cannot use the sleep binary directly.
  const scriptPath = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(scriptPath, "#!/bin/sh\nsleep 5\n");
  await Deno.chmod(scriptPath, 0o755);

  try {
    const result = await cleanDenoCache({
      executable: scriptPath,
      timeoutMs: 50,
    });
    assertEquals(result.timedOut, true);
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "timed out");
  } finally {
    await Deno.remove(scriptPath).catch(() => {});
  }
});

Deno.test("deno_cache - cleanDenoCache dryRun option is accepted", async () => {
  // Verify the option is accepted by the API (behaviour with real deno
  // varies between versions; we only check the shape here).
  const result = await cleanDenoCache({ executable: TRUE_BIN, dryRun: true });
  assertEquals(result.success, true);
});
