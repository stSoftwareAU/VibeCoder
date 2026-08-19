/**
 * Tests for the container-reap command's contract (Issue #4173).
 *
 * The launchers call this command when their watchdog fires and before every
 * launch, so what it refuses matters as much as what it reaps: a request it
 * cannot carry out must be a loud, named failure rather than a quiet success
 * that leaves a wedged container running (Issue #3234).
 *
 * The reaping behaviour itself is covered by `container_watchdog_test.ts`
 * (injected seams) and end-to-end by the launcher tests; nothing here starts a
 * subprocess or signals a process.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { reap } from "../commands/container_reap.ts";

Deno.test("container-reap - refuses a request with no runtime", async () => {
  const result = await reap({ name: "vibe-coder-1" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--runtime");
});

Deno.test("container-reap - refuses a request that names nothing to reap", async () => {
  const result = await reap({ runtime: "docker" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--stale");
});

Deno.test("container-reap - refuses a runtime the launchers do not support", async () => {
  const result = await reap({ runtime: "kubectl", name: "vibe-coder-1" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "not a container runtime");
  // The message names the runtimes that are supported, so an operator reading
  // a host log can act on it.
  assertStringIncludes(result.message, "docker");
});

Deno.test("container-reap - a stale scan without a deadline is refused", async () => {
  const result = await reap({ runtime: "docker", stale: true });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--max-age-seconds");
});
