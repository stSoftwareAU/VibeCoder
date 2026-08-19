/**
 * Tests for the `resolve-cross-repo-dep` command (Issue #2941).
 *
 * Drives the command with an injected `__testRunner` so the dry-run resolve +
 * probe is exercised end-to-end with no real network.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  resolveCrossRepoDepCommand,
  type ResolveCrossRepoDepData,
} from "../commands/resolve_cross_repo_dep.ts";
import type { CommandOutput, RunCommand } from "../lib/cross_repo_fix.ts";
import type { WorkerConfig } from "../types.ts";

const config = {} as WorkerConfig;

function ok(stdout: string): CommandOutput {
  return { success: true, stdout, stderr: "" };
}

Deno.test("resolve-cross-repo-dep - missing --package fails", async () => {
  const result = await resolveCrossRepoDepCommand.execute({}, config);
  assertEquals(result.success, false);
  assertStringIncludes(result.message ?? "", "package");
});

Deno.test("resolve-cross-repo-dep - internal reachable dep reports the canonical repo", async () => {
  const runner: RunCommand = (_cmd) =>
    Promise.resolve(
      ok(JSON.stringify({
        full_name: "stSoftwareAU/private-repo-14",
        permissions: { push: true },
      })),
    );
  const result = await resolveCrossRepoDepCommand.execute(
    { "package": "jsr:@stsoftware/private-repo-14", "__testRunner": runner },
    config,
  );
  assertEquals(result.success, true);
  const data = result.data as ResolveCrossRepoDepData;
  assertEquals(data.target.kind, "internal-reachable");
  if (data.target.kind === "internal-reachable") {
    assertEquals(data.target.repo, "stSoftwareAU/private-repo-14");
  }
  assertStringIncludes(result.message ?? "", "internal-reachable");
});

Deno.test("resolve-cross-repo-dep - external dep reports external", async () => {
  const runner: RunCommand = (_cmd) => Promise.resolve(ok("{}"));
  const result = await resolveCrossRepoDepCommand.execute(
    { "package": "npm:lodash", "__testRunner": runner },
    config,
  );
  assertEquals(result.success, true);
  const data = result.data as ResolveCrossRepoDepData;
  assertEquals(data.target.kind, "external");
  assertStringIncludes(result.message ?? "", "external");
});
