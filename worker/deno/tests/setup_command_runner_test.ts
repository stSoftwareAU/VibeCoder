/**
 * Tests for the shared `setup/` subprocess runner (Issue #1259).
 *
 * `setup/` spawned `gh` itself — seven copies of the same runner, plus the
 * config writer and the milestone-ruleset executor — so a setup `gh` call
 * ran outside the write-repo allowlist, `redactGhBodyArgs` and the audit
 * journal. These tests assert the routing behaviourally: the `gh` leg is
 * observed through the chokepoint's own injectable runner, so no real `gh`
 * process starts.
 *
 * Uses Australian English throughout.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { _resetGhSpawnRunner, _setGhSpawnRunner } from "../lib/gh_spawn.ts";
import {
  createSetupRunCommand,
  runSetupCommand,
} from "../setup/setup_command_runner.ts";

/** Capture what the chokepoint's low-level runner was handed. */
function recordingRunner(
  result: { code?: number; stdout?: string; stderr?: string } = {},
): { calls: { args: string[]; env?: Record<string, string> }[] } {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  _setGhSpawnRunner((args, options) => {
    calls.push({
      args: [...args],
      ...(options.env ? { env: options.env } : {}),
    });
    const code = result.code ?? 0;
    return Promise.resolve({
      code,
      success: code === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
  });
  return { calls };
}

Deno.test("runSetupCommand - routes a gh command through the spawnGh chokepoint", async () => {
  const recorded = recordingRunner({ stdout: "  vibe-coder-bot\n" });
  try {
    const output = await runSetupCommand([
      "gh",
      "api",
      "user",
      "--jq",
      ".login",
    ]);
    assertEquals(recorded.calls.length, 1);
    assertEquals(recorded.calls[0]?.args, ["api", "user", "--jq", ".login"]);
    assertEquals(output.success, true);
    assertEquals(output.stdout, "vibe-coder-bot");
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("createSetupRunCommand - passes the configured GH_CONFIG_DIR to the chokepoint", async () => {
  const recorded = recordingRunner();
  try {
    const runner = createSetupRunCommand("/tmp/vibe-gh-config");
    await runner(["gh", "label", "list", "--repo", "owner/repo"]);
    assertEquals(
      recorded.calls[0]?.env?.["GH_CONFIG_DIR"],
      "/tmp/vibe-gh-config",
    );
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("runSetupCommand - reports a failed gh command instead of throwing", async () => {
  recordingRunner({ code: 1, stderr: "  gh: not authenticated\n" });
  try {
    const output = await runSetupCommand(["gh", "auth", "status"]);
    assertEquals(output.success, false);
    assertEquals(output.stderr, "gh: not authenticated");
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("runSetupCommand - routes git through the timeout chokepoint", async () => {
  const output = await runSetupCommand(["git", "--version"]);
  assertEquals(output.success, true);
  assertStringIncludes(output.stdout, "git version");
});

Deno.test("runSetupCommand - spawns a non-guarded binary directly", async () => {
  const output = await runSetupCommand([Deno.execPath(), "--version"]);
  assertEquals(output.success, true);
  assertStringIncludes(output.stdout, "deno");
});

Deno.test("runSetupCommand - an empty command vector fails loud", async () => {
  await assertRejects(
    () => runSetupCommand([]),
    Error,
    "empty command vector",
  );
});
