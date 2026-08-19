/**
 * Tests for setup/config_writer.ts
 *
 * Tests the hooks, git exclude, and config setup orchestration.
 * Core config logic (buildOverridesOnly, mergeNonInteractive) is already
 * tested in setup_config_setup_test.ts alongside this file.
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 */

import { assertEquals } from "@std/assert";
import {
  installPreCommitHook,
  removePrePushHook,
  runConfigSetup,
  updateGitInfoExclude,
} from "../setup/config_writer.ts";

// ── runConfigSetup ──────────────────────────────────────────────────────

Deno.test("runConfigSetup - writes config to a temp file", async () => {
  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/.config.json`;

  const env = (name: string): string | undefined => {
    if (name === "VIBE_ALLOWED_AUTHORS") return "testuser";
    if (name === "VIBE_REPOS") return "org/repo1,org/repo2";
    return undefined;
  };

  // Issue #4030: stub the login lookup so the test never shells out to `gh`.
  const result = await runConfigSetup(configPath, env, {
    resolveWorkerLogin: () => Promise.resolve("VibeCoderBot"),
  });
  assertEquals(result.ok, true);

  // Verify the file was written
  const content = await Deno.readTextFile(configPath);
  const config = JSON.parse(content);
  assertEquals(config.allowed_authors, ["testuser"]);
  assertEquals(config.repos, ["org/repo1", "org/repo2"]);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("runConfigSetup - preserves existing config values", async () => {
  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/.config.json`;

  // Write existing config
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      allowed_authors: ["existinguser"],
      ssh_key_path: "~/.ssh/id_rsa",
    }),
  );

  // Run with no env overrides
  const env = (_name: string): string | undefined => undefined;

  const result = await runConfigSetup(configPath, env, {
    resolveWorkerLogin: () => Promise.resolve("VibeCoderBot"),
  });
  assertEquals(result.ok, true);

  const content = await Deno.readTextFile(configPath);
  const config = JSON.parse(content);
  assertEquals(config.allowed_authors, ["existinguser"]);
  assertEquals(config.ssh_key_path, "~/.ssh/id_rsa");

  await Deno.remove(tmpDir, { recursive: true });
});

// ── installPreCommitHook ────────────────────────────────────────────────

Deno.test("installPreCommitHook - skips when not in a git repo", async () => {
  const tmpDir = await Deno.makeTempDir();
  const result = await installPreCommitHook(tmpDir);
  assertEquals(result.ok, true);
  assertEquals(result.message.includes("Not in a git repository"), true);
  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("installPreCommitHook - skips when hook source not found", async () => {
  const tmpDir = await Deno.makeTempDir();
  await Deno.mkdir(`${tmpDir}/.git`, { recursive: true });
  const result = await installPreCommitHook(tmpDir);
  assertEquals(result.ok, true);
  assertEquals(result.message.includes("hook source not found"), true);
  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("installPreCommitHook - creates hook when none exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  await Deno.mkdir(`${tmpDir}/.git/hooks`, { recursive: true });
  await Deno.mkdir(`${tmpDir}/hooks`, { recursive: true });
  await Deno.writeTextFile(
    `${tmpDir}/hooks/pre-commit`,
    "#!/bin/bash\nexit 0\n",
  );

  const result = await installPreCommitHook(tmpDir);
  assertEquals(result.ok, true);
  assertEquals(result.message.includes("Installed pre-commit hook"), true);

  // Verify hook file was created
  const hookContent = await Deno.readTextFile(
    `${tmpDir}/.git/hooks/pre-commit`,
  );
  assertEquals(hookContent.includes("VibeCoder config file protection"), true);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("installPreCommitHook - idempotent when already installed", async () => {
  const tmpDir = await Deno.makeTempDir();
  await Deno.mkdir(`${tmpDir}/.git/hooks`, { recursive: true });
  await Deno.mkdir(`${tmpDir}/hooks`, { recursive: true });
  await Deno.writeTextFile(
    `${tmpDir}/hooks/pre-commit`,
    "#!/bin/bash\nexit 0\n",
  );

  // Install once
  await installPreCommitHook(tmpDir);
  // Install again — should detect existing
  const result = await installPreCommitHook(tmpDir);
  assertEquals(result.ok, true);
  assertEquals(result.message, "Pre-commit hook already installed");

  await Deno.remove(tmpDir, { recursive: true });
});

// ── installed shim runtime behaviour (Issue #3956) ──────────────────────

/** Run the installed `.git/hooks/pre-commit` shim and capture its result. */
async function runInstalledShim(
  repoDir: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> {
  const out = await new Deno.Command("bash", {
    args: [`${repoDir}/.git/hooks/pre-commit`],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
}

/** Temp repo with a stub tracked hook, ready for shim installation. */
async function makeRepoWithStubHook(): Promise<string> {
  const tmpDir = await Deno.makeTempDir();
  await Deno.mkdir(`${tmpDir}/.git/hooks`, { recursive: true });
  await Deno.mkdir(`${tmpDir}/hooks`, { recursive: true });
  await Deno.writeTextFile(
    `${tmpDir}/hooks/pre-commit`,
    "#!/bin/bash\nexit 0\n",
  );
  await new Deno.Command("chmod", {
    args: ["+x", `${tmpDir}/hooks/pre-commit`],
  }).output();
  return tmpDir;
}

Deno.test({
  name:
    "config_writer installed shim rejects commit when hooks/pre-commit is absent",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tmpDir = await makeRepoWithStubHook();
    await installPreCommitHook(tmpDir);
    await Deno.remove(`${tmpDir}/hooks/pre-commit`);

    const { code, stderr } = await runInstalledShim(tmpDir);
    assertEquals(code, 1);
    assertEquals(stderr.includes(`${tmpDir}/hooks/pre-commit`), true);
    assertEquals(stderr.includes("Commit rejected"), true);

    await Deno.remove(tmpDir, { recursive: true });
  },
});

Deno.test({
  name:
    "config_writer appended shim rejects commit when hooks/pre-commit is absent",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tmpDir = await makeRepoWithStubHook();
    // Pre-existing hook with no VibeCoder protection — takes the append path.
    await Deno.writeTextFile(
      `${tmpDir}/.git/hooks/pre-commit`,
      "#!/bin/bash\nset -euo pipefail\necho existing hook\n",
    );

    const result = await installPreCommitHook(tmpDir);
    assertEquals(result.message.includes("Integrated VibeCoder"), true);
    await Deno.remove(`${tmpDir}/hooks/pre-commit`);

    const { code, stderr } = await runInstalledShim(tmpDir);
    assertEquals(code, 1);
    assertEquals(stderr.includes(`${tmpDir}/hooks/pre-commit`), true);
    assertEquals(stderr.includes("Commit rejected"), true);

    await Deno.remove(tmpDir, { recursive: true });
  },
});

Deno.test({
  name: "config_writer installed shim propagates 126 for a non-executable hook",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tmpDir = await makeRepoWithStubHook();
    await installPreCommitHook(tmpDir);
    // Strip the execute bit — bash reports 126 and the shim must propagate it.
    await new Deno.Command("chmod", {
      args: ["-x", `${tmpDir}/hooks/pre-commit`],
    }).output();

    const { code } = await runInstalledShim(tmpDir);
    assertEquals(code, 126);

    await Deno.remove(tmpDir, { recursive: true });
  },
});

Deno.test({
  name:
    "config_writer installed shim honours the documented missing-hook bypass",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tmpDir = await makeRepoWithStubHook();
    await installPreCommitHook(tmpDir);
    await Deno.remove(`${tmpDir}/hooks/pre-commit`);

    const { code, stderr } = await runInstalledShim(tmpDir, {
      VIBE_ALLOW_MISSING_PRECOMMIT_HOOK: "1",
    });
    assertEquals(code, 0);
    assertEquals(stderr.includes("WARNING"), true);

    await Deno.remove(tmpDir, { recursive: true });
  },
});

Deno.test({
  name: "config_writer installed shim runs the tracked hook when present",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tmpDir = await makeRepoWithStubHook();
    // Tracked hook rejects — the shim must propagate its exit code.
    await Deno.writeTextFile(
      `${tmpDir}/hooks/pre-commit`,
      '#!/bin/bash\necho "blocked by tracked hook" >&2\nexit 3\n',
    );
    await new Deno.Command("chmod", {
      args: ["+x", `${tmpDir}/hooks/pre-commit`],
    }).output();
    await installPreCommitHook(tmpDir);

    const { code, stderr } = await runInstalledShim(tmpDir);
    assertEquals(code, 3);
    assertEquals(stderr.includes("blocked by tracked hook"), true);

    await Deno.remove(tmpDir, { recursive: true });
  },
});

// ── removePrePushHook ───────────────────────────────────────────────────

Deno.test("removePrePushHook - no-op when hook does not exist", async () => {
  const tmpDir = await Deno.makeTempDir();
  const result = await removePrePushHook(tmpDir);
  assertEquals(result.ok, true);
  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("removePrePushHook - removes VibeCoder pre-push hook", async () => {
  const tmpDir = await Deno.makeTempDir();
  const hookPath = `${tmpDir}/.git/hooks/pre-push`;
  await Deno.mkdir(`${tmpDir}/.git/hooks`, { recursive: true });
  await Deno.writeTextFile(
    hookPath,
    "#!/bin/bash\n# VibeCoder pre-push quality gate\nexit 0\n",
  );

  const result = await removePrePushHook(tmpDir);
  assertEquals(result.ok, true);
  assertEquals(result.message, "Removed retired pre-push quality gate hook");

  // Verify file is gone
  try {
    await Deno.stat(hookPath);
    assertEquals(true, false, "Hook file should have been deleted");
  } catch {
    // Expected — file should not exist
  }

  await Deno.remove(tmpDir, { recursive: true });
});

// ── updateGitInfoExclude ────────────────────────────────────────────────

Deno.test("updateGitInfoExclude - creates exclude file with patterns", async () => {
  const tmpDir = await Deno.makeTempDir();
  await Deno.mkdir(`${tmpDir}/.git/info`, { recursive: true });

  const result = await updateGitInfoExclude(tmpDir);
  assertEquals(result.ok, true);

  const content = await Deno.readTextFile(`${tmpDir}/.git/info/exclude`);
  assertEquals(content.includes(".config.json"), true);
  assertEquals(content.includes("*.secret.json"), true);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("updateGitInfoExclude - idempotent when patterns already present", async () => {
  const tmpDir = await Deno.makeTempDir();
  await Deno.mkdir(`${tmpDir}/.git/info`, { recursive: true });

  // Write initial patterns
  await updateGitInfoExclude(tmpDir);
  const firstContent = await Deno.readTextFile(`${tmpDir}/.git/info/exclude`);

  // Run again — should not duplicate
  await updateGitInfoExclude(tmpDir);
  const secondContent = await Deno.readTextFile(`${tmpDir}/.git/info/exclude`);

  assertEquals(firstContent, secondContent);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("updateGitInfoExclude - skips when not in a git repo", async () => {
  const tmpDir = await Deno.makeTempDir();
  const result = await updateGitInfoExclude(tmpDir);
  assertEquals(result.ok, true);
  assertEquals(result.message, "Not in a git repository");
  await Deno.remove(tmpDir, { recursive: true });
});
