/**
 * Tests for the run-bootstrap command (Issue #3501).
 *
 * CLI-specific tests only — orchestration unit tests live in
 * run_bootstrap_test.ts. Covers metadata, required-arg validation, and the
 * `--shell-exports` rendering path against a real (isolated) git repository.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runBootstrapCommand } from "../commands/run_bootstrap.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import type { WorkerConfig } from "../types.ts";

function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

Deno.test("run-bootstrap command - has correct name", () => {
  assertEquals(runBootstrapCommand.name, "run-bootstrap");
});

Deno.test("run-bootstrap command - has a description", () => {
  assertEquals(typeof runBootstrapCommand.description, "string");
  assertEquals(runBootstrapCommand.description.length > 0, true);
});

Deno.test("run-bootstrap command - fails when --repo-dir is missing", async () => {
  const result = await runBootstrapCommand.execute({}, createMockConfig());
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--repo-dir is required");
});

Deno.test("run-bootstrap command - shell-exports emits export lines on success", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_bootstrap_cmd_test_" });
  const repoDir = `${tmpDir}/repo`;
  const remoteDir = `${tmpDir}/remote.git`;
  const logDir = `${tmpDir}/logs`;
  try {
    // Create a bare "remote" with a Develop branch, then clone it so the
    // git reset (fetch/checkout/reset/clean) has a real origin to act on.
    await Deno.mkdir(remoteDir, { recursive: true });
    await runGitCommand([
      "init",
      "--bare",
      "--initial-branch=Develop",
      remoteDir,
    ]);

    const seedDir = `${tmpDir}/seed`;
    await runGitCommand(["init", "--initial-branch=Develop", seedDir]);
    await runGitCommand(["config", "user.email", "t@example.com"], {
      cwd: seedDir,
    });
    await runGitCommand(["config", "user.name", "Test"], { cwd: seedDir });
    await Deno.writeTextFile(`${seedDir}/README.md`, "seed\n");
    await runGitCommand(["add", "."], { cwd: seedDir });
    await runGitCommand(["commit", "-m", "seed"], { cwd: seedDir });
    await runGitCommand(["remote", "add", "origin", remoteDir], {
      cwd: seedDir,
    });
    await runGitCommand(["push", "origin", "Develop"], { cwd: seedDir });

    await runGitCommand(["clone", remoteDir, repoDir]);
    await runGitCommand(["config", "user.email", "t@example.com"], {
      cwd: repoDir,
    });
    await runGitCommand(["config", "user.name", "Test"], { cwd: repoDir });

    const result = await runBootstrapCommand.execute(
      {
        "repo-dir": repoDir,
        "log-dir": logDir,
        "current-path": "/usr/bin",
        "home": tmpDir,
        "pid": 555,
        "default-branch": "Develop",
        "skip-software-update": true,
        "shell-exports": true,
      },
      createMockConfig(),
    );

    assertEquals(result.success, true);
    assertStringIncludes(result.message, "export PATH=");
    assertStringIncludes(result.message, "export VIBE_RUN_ID=");
    // Timestamp-named since Issue #4227 — extract the exported path rather
    // than predicting the second it names.
    const exportMatch = result.message.match(
      /export WORKER_LOG_FILE='([^']+\/worker-\d{8}-\d{6}(?:-\d+)?\.log)'/,
    );
    assert(
      exportMatch,
      `WORKER_LOG_FILE export missing or not timestamp-named: ${result.message}`,
    );

    // The worker log file was actually created in-process.
    const logContent = await Deno.readTextFile(exportMatch[1]!);
    assertStringIncludes(logContent, "run_core pid=555 start=");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
