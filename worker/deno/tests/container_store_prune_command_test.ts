/**
 * Contract tests for the container-store-prune command (Issue #227).
 *
 * Nothing here starts a subprocess — the reclamation itself is covered by
 * `container_store_prune_test.ts` on injected seams. What matters here is
 * that an unusable request is a loud, named failure.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { pruneStore } from "../commands/container_store_prune.ts";

Deno.test("container-store-prune - refuses a request with no runtime", async () => {
  const result = await pruneStore({});
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--runtime");
});

Deno.test("container-store-prune - refuses a runtime the launchers do not support", async () => {
  const result = await pruneStore({ runtime: "kubectl" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "not a container runtime");
});

Deno.test("container-store-prune - refuses a floor outside 0–100", async () => {
  const result = await pruneStore({
    runtime: "docker",
    "builder-floor-percent": "150",
  });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--builder-floor-percent");
});
