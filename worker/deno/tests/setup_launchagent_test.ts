/**
 * Tests for setup/launchagent.ts
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  generatePlist,
  getLaunchAgentLabel,
  isLaunchAgentInstalled,
  removeLaunchAgent,
  setupLaunchAgent,
  writeSecurePlist,
} from "../setup/launchagent.ts";
import type { LaunchAgentConfig } from "../setup/launchagent.ts";

// ── generatePlist ───────────────────────────────────────────────────────

Deno.test("generatePlist - generates valid plist with required fields", () => {
  const config: LaunchAgentConfig = {
    scriptDir: "/opt/vibe",
  };
  const plist = generatePlist(config);

  assertStringIncludes(plist, '<?xml version="1.0"');
  assertStringIncludes(plist, "com.vibe.auto-issue-worker");
  assertStringIncludes(plist, "/opt/vibe/run.sh");
  assertStringIncludes(plist, "/opt/vibe");
  assertStringIncludes(plist, "<integer>300</integer>");
  assertStringIncludes(plist, "<true/>");
});

Deno.test("generatePlist - includes custom logs directory", () => {
  const config: LaunchAgentConfig = {
    scriptDir: "/opt/vibe",
    logsDir: "/var/log/vibe",
  };
  const plist = generatePlist(config);

  assertStringIncludes(plist, "/var/log/vibe/launchagent-stdout.log");
  assertStringIncludes(plist, "/var/log/vibe/launchagent-stderr.log");
});

Deno.test("generatePlist - includes environment variables when provided", () => {
  const config: LaunchAgentConfig = {
    scriptDir: "/opt/vibe",
    ghToken: "ghp_test123",
    anthropicApiKey: "sk-ant-test",
    fallbackPaths: "/opt/homebrew/bin",
  };
  const plist = generatePlist(config);

  assertStringIncludes(plist, "<key>GH_TOKEN</key>");
  assertStringIncludes(plist, "ghp_test123");
  assertStringIncludes(plist, "<key>ANTHROPIC_API_KEY</key>");
  assertStringIncludes(plist, "sk-ant-test");
  assertStringIncludes(plist, "<key>VIBE_FALLBACK_PATHS</key>");
  assertStringIncludes(plist, "/opt/homebrew/bin");
});

Deno.test("generatePlist - omits EnvironmentVariables when none provided", () => {
  const config: LaunchAgentConfig = {
    scriptDir: "/opt/vibe",
  };
  const plist = generatePlist(config);

  assertEquals(plist.includes("EnvironmentVariables"), false);
});

Deno.test("generatePlist - escapes XML special characters in env values", () => {
  const config: LaunchAgentConfig = {
    scriptDir: "/opt/vibe",
    ghToken: "test<>&\"'value",
  };
  const plist = generatePlist(config);

  assertStringIncludes(plist, "&lt;");
  assertStringIncludes(plist, "&gt;");
  assertStringIncludes(plist, "&amp;");
  assertStringIncludes(plist, "&quot;");
  assertStringIncludes(plist, "&apos;");
  assertEquals(plist.includes("test<>&\"'value"), false);
});

// ── writeSecurePlist ─────────────────────────────────────────────────────

// chmod/mode bits are POSIX-only; skip the permission assertions on Windows.
const isWindows = Deno.build.os === "windows";

Deno.test({
  name: "writeSecurePlist - new file is created with mode 0o600",
  ignore: isWindows,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const plistPath = `${dir}/com.vibe.auto-issue-worker.plist`;
      await writeSecurePlist(plistPath, "<plist>secret</plist>");

      const info = await Deno.stat(plistPath);
      assertEquals((info.mode ?? 0) & 0o777, 0o600);
      assertEquals(await Deno.readTextFile(plistPath), "<plist>secret</plist>");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "writeSecurePlist - tightens an existing world-readable file to 0o600",
  ignore: isWindows,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const plistPath = `${dir}/com.vibe.auto-issue-worker.plist`;
      // Simulate a plist left world-readable by an older worker.
      await Deno.writeTextFile(plistPath, "old", { mode: 0o644 });
      await Deno.chmod(plistPath, 0o644);
      assertEquals((await Deno.stat(plistPath)).mode! & 0o777, 0o644);

      await writeSecurePlist(plistPath, "new");

      const info = await Deno.stat(plistPath);
      assertEquals((info.mode ?? 0) & 0o777, 0o600);
      assertEquals(await Deno.readTextFile(plistPath), "new");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ── getLaunchAgentLabel ──────────────────────────────────────────────────

Deno.test("getLaunchAgentLabel - returns the expected label", () => {
  assertEquals(getLaunchAgentLabel(), "com.vibe.auto-issue-worker");
});

// ── setupLaunchAgent ─────────────────────────────────────────────────────

const isDarwin = Deno.build.os === "darwin";
const PLIST_NAME = `${getLaunchAgentLabel()}.plist`;

// The platform gate is an observable behaviour worth pinning so it is never
// accidentally inverted — on any non-macOS host the orchestrator must skip
// cleanly without touching the filesystem.
Deno.test({
  name: "setupLaunchAgent - skips on non-macOS with an informative message",
  ignore: isDarwin,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const result = await setupLaunchAgent({
        scriptDir: "/opt/vibe",
        launchAgentDir: dir,
        logsDir: dir,
        skipLaunchctl: true,
      });

      assertEquals(result.ok, true);
      assertStringIncludes(result.message, "only available on macOS");
      // No plist should have been written on a non-darwin platform.
      assertEquals(
        (await Array.fromAsync(Deno.readDir(dir))).length,
        0,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// On macOS the orchestrator must create the target directories and write a
// plist whose contents match generatePlist(). launchctl wiring is stubbed out
// with skipLaunchctl so the test never mutates the host's real agents.
Deno.test({
  name: "setupLaunchAgent - writes a plist and creates directories (darwin)",
  ignore: !isDarwin,
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const launchAgentDir = `${root}/LaunchAgents`;
      const logsDir = `${root}/logs`;
      const config: LaunchAgentConfig = {
        scriptDir: "/opt/vibe",
        launchAgentDir,
        logsDir,
        skipLaunchctl: true,
      };

      const result = await setupLaunchAgent(config);

      assertEquals(result.ok, true);
      const plistPath = `${launchAgentDir}/${PLIST_NAME}`;
      assertStringIncludes(result.message, plistPath);

      // Directories were created.
      assertEquals((await Deno.stat(launchAgentDir)).isDirectory, true);
      assertEquals((await Deno.stat(logsDir)).isDirectory, true);

      // The written plist matches the generator's output exactly.
      const written = await Deno.readTextFile(plistPath);
      assertEquals(written, generatePlist(config));
      assertStringIncludes(written, "/opt/vibe/run.sh");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

// A second run with identical config must be idempotent — it detects the
// up-to-date plist and reports so rather than rewriting or reloading.
Deno.test({
  name: "setupLaunchAgent - is idempotent when plist is up to date (darwin)",
  ignore: !isDarwin,
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const config: LaunchAgentConfig = {
        scriptDir: "/opt/vibe",
        launchAgentDir: `${root}/LaunchAgents`,
        logsDir: `${root}/logs`,
        skipLaunchctl: true,
      };

      const first = await setupLaunchAgent(config);
      assertEquals(first.ok, true);

      const second = await setupLaunchAgent(config);
      assertEquals(second.ok, true);
      assertStringIncludes(second.message, "already up to date");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "removeLaunchAgent / isLaunchAgentInstalled - a declined install can remove the agent an earlier setup left, idempotently (Issue #26)",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      assertEquals(await isLaunchAgentInstalled(dir), false);
      const absent = await removeLaunchAgent({
        launchAgentDir: dir,
        skipLaunchctl: true,
      });
      assertEquals(absent.ok, true);
      assertStringIncludes(absent.message, "No LaunchAgent is installed");

      const plistPath = `${dir}/com.vibe.auto-issue-worker.plist`;
      await Deno.writeTextFile(plistPath, "<plist/>");
      assertEquals(await isLaunchAgentInstalled(dir), true);

      const removed = await removeLaunchAgent({
        launchAgentDir: dir,
        skipLaunchctl: true,
      });
      assertEquals(removed.ok, true, removed.message);
      assertStringIncludes(removed.message, plistPath);
      assertEquals(await isLaunchAgentInstalled(dir), false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
