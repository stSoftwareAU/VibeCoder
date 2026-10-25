/**
 * Tests for the quality-helpers command's subprocess timeouts (Issue #4249).
 *
 * Uses Australian English throughout.
 */

import { assert, assertNotEquals, assertRejects } from "@std/assert";
import {
  cleanupDevServerPorts,
  runQualityCommand,
} from "../commands/quality_helpers.ts";

Deno.test("runQualityCommand - a timeout is a non-zero exit, not success (Issue #4249)", async () => {
  const code = await runQualityCommand("sleep 30", 0);
  assertNotEquals(code, 0);
  assert(code === 124);
});

Deno.test("cleanupDevServerPorts - a probe timeout is not a completed cleanup (Issue #4249)", async () => {
  await assertRejects(() => cleanupDevServerPorts(0), Error, "timed out");
});
