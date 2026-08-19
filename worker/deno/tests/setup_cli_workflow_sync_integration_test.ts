/**
 * Integration test: setup_cli.ts workflow-sync subcommand.
 *
 * Issue #1445: Verify that setup_cli.ts handles the workflow-sync
 * subcommand and that setup.sh invokes it in the orchestration flow.
 *
 * These tests run setup_cli.ts as a subprocess to verify real CLI
 * behaviour — no source-file grepping.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

/** Resolve paths relative to the worker/deno/ directory. */
const DENO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Temporary directory cleaned up after each test. */
let tmpDir: string;

function setup(): void {
  tmpDir = Deno.makeTempDirSync({ prefix: "setup_cli_wf_" });
}

function teardown(): void {
  try {
    Deno.removeSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }
}

/**
 * Run setup_cli.ts with the given subcommand and a temporary config.
 * Returns combined stdout+stderr and the exit code.
 */
async function runSetupCli(
  subcommand: string,
  configContent: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const configPath = `${tmpDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(configContent));

  const cliPath = `${DENO_ROOT}/setup/setup_cli.ts`;

  // Spawn the current Deno binary by absolute path — a bare "deno" fails with
  // NotFound when the executable is not on the child process's PATH (CI runner).
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      cliPath,
      subcommand,
      "--config-path",
      configPath,
      "--script-dir",
      tmpDir,
    ],
    cwd: DENO_ROOT,
    stdout: "piped",
    stderr: "piped",
    env: {
      // Prevent gh CLI calls leaking into real GitHub
      VIBE_SKIP_PREREQ_CHECK: "true",
      VIBE_SKIP_AUTH_CHECK: "true",
      // Ensure no interactive prompts
      CI: "true",
    },
  });

  const child = await cmd.output();
  const stdout = new TextDecoder().decode(child.stdout);
  const stderr = new TextDecoder().decode(child.stderr);
  return { stdout, stderr, code: child.code };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("setup_cli workflow-sync - handles empty repos list gracefully", async () => {
  setup();
  try {
    const result = await runSetupCli("workflow-sync", { repos: [] });
    const output = result.stdout + result.stderr;

    // Should warn about no repos and exit successfully
    assertStringIncludes(
      output,
      "No repos configured",
      "Should report no repos configured when list is empty",
    );
    assertEquals(result.code, 0, "Should exit with code 0 (non-fatal)");
  } finally {
    teardown();
  }
});

Deno.test("setup_cli workflow-sync - handles missing repos key gracefully", async () => {
  setup();
  try {
    const result = await runSetupCli("workflow-sync", {});
    const output = result.stdout + result.stderr;

    // Should warn about no repos and exit successfully
    assertStringIncludes(
      output,
      "No repos configured",
      "Should report no repos when key is missing from config",
    );
    assertEquals(result.code, 0, "Should exit with code 0 (non-fatal)");
  } finally {
    teardown();
  }
});

Deno.test("setup_cli workflow-sync - prints synchronisation header", async () => {
  setup();
  try {
    const result = await runSetupCli("workflow-sync", { repos: [] });
    const output = result.stdout + result.stderr;

    assertStringIncludes(
      output,
      "Synchronising workflows",
      "Should print the workflow sync header message",
    );
  } finally {
    teardown();
  }
});
