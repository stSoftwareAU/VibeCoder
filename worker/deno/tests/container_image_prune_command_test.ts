/**
 * Tests for the container-image-prune command's contract (Issue #4162).
 *
 * The launchers call this after the image they need is present, so what it
 * refuses matters as much as what it deletes: an unusable request must be a
 * loud, named failure rather than a quiet success that leaves a multi-gigabyte
 * superseded image behind (Issue #3234). Nothing here starts a subprocess — the
 * pruning behaviour itself is covered by `container_image_prune_test.ts` on
 * injected seams and end-to-end by the launcher tests.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { pruneImages } from "../commands/container_image_prune.ts";

Deno.test("container-image-prune - refuses a request with no runtime", async () => {
  const result = await pruneImages({ keep: "vibe-coder:0a1b2c3d4e5f" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--runtime");
});

Deno.test("container-image-prune - refuses a request with nothing to keep", async () => {
  const result = await pruneImages({ runtime: "docker" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--keep");
});

Deno.test("container-image-prune - refuses a runtime the launchers do not support", async () => {
  const result = await pruneImages({
    runtime: "kubectl",
    keep: "vibe-coder:0a1b2c3d4e5f",
  });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "not a container runtime");
  // The message names what is supported, so a host log is actionable.
  assertStringIncludes(result.message, "docker");
});

Deno.test("container-image-prune - refuses a keep reference it cannot trust", async () => {
  const result = await pruneImages({
    runtime: "docker",
    keep: "vibe-coder:abc;rm -rf /",
  });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "reference");
});
