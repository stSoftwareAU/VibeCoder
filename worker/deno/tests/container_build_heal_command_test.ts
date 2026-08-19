/**
 * Tests for the container-build-heal command's contract (Issue #4441).
 *
 * The launchers read this command's *exit status* as an instruction — 0 retry
 * the build, 3 this is not a builder failure, anything else the heal did not
 * work — so the statuses matter as much as the message. Nothing here starts a
 * builder: the healing behaviour itself is covered on injected seams by
 * `container_build_heal_test.ts` and end-to-end by the launcher tests.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  BUILD_NOT_HEALABLE_EXIT,
  healBuild,
} from "../commands/container_build_heal.ts";

/** Write a build log the command can classify. */
async function buildLog(contents: string): Promise<string> {
  const path = await Deno.makeTempFile({ prefix: "vibe_build_heal_" });
  await Deno.writeTextFile(path, contents);
  return path;
}

Deno.test("container-build-heal - refuses a request with no runtime", async () => {
  const result = await healBuild({ log: "/tmp/whatever" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--runtime");
});

Deno.test("container-build-heal - refuses a request with no build log", async () => {
  const result = await healBuild({ runtime: "docker" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--log");
});

Deno.test("container-build-heal - refuses a runtime the launchers do not support", async () => {
  const result = await healBuild({ runtime: "kubectl", log: "/tmp/whatever" });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "not a container runtime");
});

Deno.test("container-build-heal - an unreadable build log fails loud", async () => {
  // Guessing either way would be worse than saying so: a log that cannot be
  // read must not classify as "nothing to heal" (Issue #3234).
  const result = await healBuild({
    runtime: "docker",
    log: "/no/such/build/log",
  });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "/no/such/build/log");
  assertEquals(result.exitCode, undefined);
});

Deno.test("container-build-heal - exits 3 for a build failure it does not cover", async () => {
  const path = await buildLog("E: Unable to locate package nosuchpackage");
  try {
    const result = await healBuild({ runtime: "docker", log: path });
    // A correct answer, not a command failure — but a status the launcher can
    // tell apart from "healed, retry".
    assertEquals(result.success, true);
    assertEquals(result.exitCode, BUILD_NOT_HEALABLE_EXIT);
    assertEquals(result.data?.healable, false);
    assertEquals(result.data?.healed, false);
  } finally {
    await Deno.remove(path);
  }
});
