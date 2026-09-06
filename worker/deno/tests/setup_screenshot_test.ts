/**
 * Tests for setup/screenshot.ts
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  BROWSER_OUTPUT_DIR_NAME,
  BROWSER_PROFILE_DIR_NAME,
  checkDenoVersion,
  checkLinuxBrowserDeps,
  CONTAINER_BROWSERS_PATH,
  generateMcpConfig,
  installPlaywrightBrowsers,
  PLAYWRIGHT_INSTALLER_VERSION,
  PLAYWRIGHT_MCP_DENIED_ENV,
  PLAYWRIGHT_MCP_VERSION,
  playwrightQuarantinedPackages,
  resolveBrowserEnvironment,
  resolveDeniedPaths,
  setupPlaywrightMcp,
  verifyScreenshotNpmQuarantine,
} from "../setup/screenshot.ts";
import type {
  BrowserEnvironment,
  ScreenshotConfig,
} from "../setup/screenshot.ts";
import type { NpmAgeFetchDeps } from "../lib/npm_package_age.ts";

const FIXED_NOW = new Date("2026-06-15T12:00:00Z");

/** Deterministic npm age deps: every pinned version is well past the window. */
function eligibleNpmAgeDeps(): NpmAgeFetchDeps {
  const old = new Date(FIXED_NOW.getTime() - 1000 * 3_600_000).toISOString();
  return {
    fetchTimeData: (pkg) => {
      const pinned = playwrightQuarantinedPackages().find((p) =>
        p.name === pkg
      );
      return Promise.resolve(pinned ? { [pinned.version]: old } : undefined);
    },
    now: () => FIXED_NOW,
  };
}

// ── Mock command runner ─────────────────────────────────────────────────

function mockRunner(denoVersion: string | null = "deno 2.1.0") {
  return async (
    cmd: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }> => {
    if (cmd[0] === "deno" && cmd[1] === "--version") {
      if (denoVersion) {
        return { success: true, stdout: denoVersion, stderr: "" };
      }
      return { success: false, stdout: "", stderr: "not found" };
    }
    if (cmd[0] === "deno" && cmd[1] === "run") {
      // Mock playwright install
      return { success: true, stdout: "Installed", stderr: "" };
    }
    if (cmd[0] === "which") {
      return { success: false, stdout: "", stderr: "" };
    }
    return { success: false, stdout: "", stderr: "unknown command" };
  };
}

// ── checkDenoVersion ────────────────────────────────────────────────────

Deno.test("checkDenoVersion - succeeds for Deno 2+", async () => {
  const result = await checkDenoVersion(mockRunner("deno 2.1.0"));
  assertEquals(result.ok, true);
  assertEquals(result.version, "deno 2.1.0");
});

Deno.test("checkDenoVersion - fails for Deno 1.x", async () => {
  const result = await checkDenoVersion(mockRunner("deno 1.40.0"));
  assertEquals(result.ok, false);
});

Deno.test("checkDenoVersion - fails when deno is not available", async () => {
  const result = await checkDenoVersion(mockRunner(null));
  assertEquals(result.ok, false);
});

// ── installPlaywrightBrowsers ───────────────────────────────────────────

Deno.test("installPlaywrightBrowsers - reports success when the installer succeeds", async () => {
  const runner = (_cmd: string[]) =>
    Promise.resolve({
      success: true,
      stdout: "Downloading Chromium",
      stderr: "",
    });
  const result = await installPlaywrightBrowsers(runner);
  assertEquals(result.ok, true);
  assertStringIncludes(result.message, "installed successfully");
});

Deno.test("installPlaywrightBrowsers - reports failure with manual-install instructions", async () => {
  const runner = (_cmd: string[]) =>
    Promise.resolve({ success: false, stdout: "", stderr: "network error" });
  const result = await installPlaywrightBrowsers(runner);
  assertEquals(result.ok, false);
  assertStringIncludes(result.message, "Failed to install Playwright browsers");
  // The failure message must carry the exact pinned manual-install command.
  assertStringIncludes(
    result.message,
    `deno run --allow-all npm:playwright@${PLAYWRIGHT_INSTALLER_VERSION} install chromium`,
  );
});

Deno.test("installPlaywrightBrowsers - invokes the pinned installer specifier", async () => {
  let invoked: string[] = [];
  const runner = (cmd: string[]) => {
    invoked = cmd;
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await installPlaywrightBrowsers(runner);
  assertEquals(invoked, [
    "deno",
    "run",
    "--allow-all",
    `npm:playwright@${PLAYWRIGHT_INSTALLER_VERSION}`,
    "install",
    "chromium",
  ]);
});

// ── checkLinuxBrowserDeps ───────────────────────────────────────────────

/** Fake runner: dpkg present, and every package in `absent` probes as missing. */
function dpkgRunner(dpkgPresent: boolean, absent: string[] = []) {
  return (cmd: string[]) => {
    if (cmd[0] === "which" && cmd[1] === "dpkg") {
      return Promise.resolve({ success: dpkgPresent, stdout: "", stderr: "" });
    }
    if (cmd[0] === "dpkg" && cmd[1] === "-s") {
      const pkg = cmd[2] ?? "";
      return Promise.resolve({
        success: !absent.includes(pkg),
        stdout: "",
        stderr: "",
      });
    }
    return Promise.resolve({ success: false, stdout: "", stderr: "unknown" });
  };
}

Deno.test("checkLinuxBrowserDeps - non-Linux host returns ok with no missing", async () => {
  // Pass an explicit non-Linux os so the branch is exercised deterministically
  // regardless of the host running the suite (macOS locally, Linux in CI): on
  // the non-Linux branch the dpkg runner never fires.
  const result = await checkLinuxBrowserDeps(
    dpkgRunner(true, ["libnss3"]),
    "darwin",
  );
  assertEquals(result, { ok: true, missing: [] });
});

Deno.test("checkLinuxBrowserDeps - lists exactly the packages whose dpkg probe failed", async () => {
  const absent = ["libnss3", "libgbm1", "libasound2"];
  const result = await checkLinuxBrowserDeps(
    dpkgRunner(true, absent),
    "linux",
  );
  assertEquals(result.ok, false);
  assertEquals(result.missing, absent);
});

Deno.test("checkLinuxBrowserDeps - ok with no missing when every package is installed", async () => {
  const result = await checkLinuxBrowserDeps(dpkgRunner(true, []), "linux");
  assertEquals(result, { ok: true, missing: [] });
});

Deno.test("checkLinuxBrowserDeps - absent dpkg returns ok with no missing (cannot check)", async () => {
  // dpkg missing: the loop is skipped and the check assumes OK.
  const result = await checkLinuxBrowserDeps(
    dpkgRunner(false, ["libnss3"]),
    "linux",
  );
  assertEquals(result, { ok: true, missing: [] });
});

// ── generateMcpConfig ───────────────────────────────────────────────────

Deno.test("generateMcpConfig - generates valid JSON with default dirs", () => {
  const config: ScreenshotConfig = { scriptDir: "/opt/vibe" };
  const json = generateMcpConfig(config);
  const parsed = JSON.parse(json);

  assertEquals(parsed.mcpServers.playwright.command, "deno");
  assertStringIncludes(
    JSON.stringify(parsed.mcpServers.playwright.args),
    "--headless",
  );
  // Output is scratch beside the profile (Issue #4355), never the checkout.
  assertStringIncludes(
    JSON.stringify(parsed.mcpServers.playwright.args),
    `/${BROWSER_OUTPUT_DIR_NAME}`,
  );
});

Deno.test("generateMcpConfig - output dir is scratch beside the browser profile, never the checkout's docs/evidence (Issue #4355)", () => {
  // On every browser_navigate the server writes an accessibility snapshot
  // (page-<ts>.yml) into --output-dir; pointing that at the checkout put
  // junk into the repository and the next commit.
  for (
    const config of [
      { scriptDir: "/opt/vibe", screenshotDir: "screenshots" },
      { scriptDir: "/opt/vibe", mcpConfigDir: "/custom/dir" },
    ] as ScreenshotConfig[]
  ) {
    const args: string[] =
      JSON.parse(generateMcpConfig(config)).mcpServers.playwright.args;
    const out = args[args.indexOf("--output-dir") + 1]!;
    assertEquals(out.startsWith("/opt/vibe"), false, out);
    assertEquals(out.startsWith("/custom/dir"), false, out);
    assertEquals(out.endsWith(`/${BROWSER_OUTPUT_DIR_NAME}`), true, out);
    const profile = args[args.indexOf("--user-data-dir") + 1]!;
    assertEquals(
      out.slice(0, out.lastIndexOf("/")),
      profile.slice(0, profile.lastIndexOf("/")),
      "output dir sits beside the profile dir",
    );
  }
});

// ── Issue #2308: supply-chain hardening ────────────────────────────────

Deno.test("generateMcpConfig - pins @playwright/mcp to an exact version (no @latest)", () => {
  const config: ScreenshotConfig = { scriptDir: "/opt/vibe" };
  const args: string[] =
    JSON.parse(generateMcpConfig(config)).mcpServers.playwright.args;

  // No `@latest` — that is what enables a hijacked publish to land silently.
  for (const arg of args) {
    if (arg.startsWith("npm:@playwright/mcp")) {
      assertEquals(
        arg.includes("@latest"),
        false,
        `Pinned npm specifier must not contain @latest, got: ${arg}`,
      );
      assertEquals(arg, `npm:@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`);
      // Sanity: the pin looks like a semver (x.y.z), not a range.
      const version = arg.split("@").pop() ?? "";
      assertEquals(
        /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version),
        true,
        `Version pin must be exact semver, got: ${version}`,
      );
    }
  }
});

Deno.test("generateMcpConfig - drops --allow-all in favour of scoped permissions", () => {
  const config: ScreenshotConfig = { scriptDir: "/opt/vibe" };
  const args: string[] =
    JSON.parse(generateMcpConfig(config)).mcpServers.playwright.args;

  assertEquals(
    args.includes("--allow-all"),
    false,
    "Playwright MCP must NOT run with --allow-all (Issue #2308)",
  );
  // FFI is the worst-case escape — loading arbitrary native code. Never grant it.
  assertEquals(
    args.some((a) => a === "--allow-ffi" || a.startsWith("--allow-ffi=")),
    false,
    "Playwright MCP must NOT have --allow-ffi (Issue #2308)",
  );
});

Deno.test("generateMcpConfig - denies env vars that hold worker secrets", () => {
  const config: ScreenshotConfig = { scriptDir: "/opt/vibe" };
  const args: string[] =
    JSON.parse(generateMcpConfig(config)).mcpServers.playwright.args;

  const denyEnvArg = args.find((a) => a.startsWith("--deny-env="));
  assertEquals(
    typeof denyEnvArg,
    "string",
    "Expected a --deny-env=... flag (Issue #2308)",
  );
  const denied = (denyEnvArg as string).slice("--deny-env=".length).split(",");

  // Every named secret from the issue's exploit sketch must be in the deny list.
  for (
    const name of [
      "VIBE_IMGBB_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_APP_PRIVATE_KEY_PATH",
      "GIT_SSH_COMMAND",
      "ANTHROPIC_API_KEY",
    ]
  ) {
    assertEquals(
      denied.includes(name),
      true,
      `${name} must be in --deny-env (Issue #2308 exfiltration vector)`,
    );
  }
  // PLAYWRIGHT_MCP_DENIED_ENV is the single source of truth.
  assertEquals(
    denied.sort().join(","),
    [...PLAYWRIGHT_MCP_DENIED_ENV].sort().join(","),
  );
});

// ── setupPlaywrightMcp ──────────────────────────────────────────────────

Deno.test("setupPlaywrightMcp - fails when Deno 2+ is not available", async () => {
  const config: ScreenshotConfig = {
    scriptDir: "/opt/vibe",
    runCommand: mockRunner("deno 1.40.0"),
    skipInstall: true,
  };
  const result = await setupPlaywrightMcp(config);
  assertEquals(result.ok, false);
  assertStringIncludes(result.message, "Deno 2+");
});

Deno.test("setupPlaywrightMcp - creates MCP config file", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: ScreenshotConfig = {
    scriptDir: tmpDir,
    mcpConfigDir: tmpDir,
    runCommand: mockRunner(),
    skipInstall: true,
    npmAgeDeps: eligibleNpmAgeDeps(),
  };

  const result = await setupPlaywrightMcp(config);
  assertEquals(result.ok, true);

  // Verify file was created
  const content = await Deno.readTextFile(`${tmpDir}/.mcp.json`);
  const parsed = JSON.parse(content);
  assertEquals(parsed.mcpServers.playwright.command, "deno");

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("setupPlaywrightMcp - idempotent when config already matches", async () => {
  const tmpDir = await Deno.makeTempDir();
  const config: ScreenshotConfig = {
    scriptDir: tmpDir,
    mcpConfigDir: tmpDir,
    runCommand: mockRunner(),
    skipInstall: true,
    npmAgeDeps: eligibleNpmAgeDeps(),
  };

  // First setup
  await setupPlaywrightMcp(config);

  // Second setup — should detect already up to date
  const result = await setupPlaywrightMcp(config);
  assertEquals(result.ok, true);
  assertStringIncludes(result.message, "already up to date");

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("setupPlaywrightMcp - merges with existing MCP config", async () => {
  const tmpDir = await Deno.makeTempDir();

  // Write existing config with another server
  const existingConfig = {
    mcpServers: {
      "other-server": { command: "node", args: ["server.js"] },
    },
  };
  await Deno.writeTextFile(
    `${tmpDir}/.mcp.json`,
    JSON.stringify(existingConfig, null, 2),
  );

  const config: ScreenshotConfig = {
    scriptDir: tmpDir,
    mcpConfigDir: tmpDir,
    runCommand: mockRunner(),
    skipInstall: true,
    npmAgeDeps: eligibleNpmAgeDeps(),
  };

  const result = await setupPlaywrightMcp(config);
  assertEquals(result.ok, true);

  // Verify both servers exist
  const content = await Deno.readTextFile(`${tmpDir}/.mcp.json`);
  const parsed = JSON.parse(content);
  assertEquals("other-server" in parsed.mcpServers, true);
  assertEquals("playwright" in parsed.mcpServers, true);

  await Deno.remove(tmpDir, { recursive: true });
});

// ── Issue #2799: npm dependency-age quarantine gate ─────────────────────

Deno.test("playwrightQuarantinedPackages - lists both pinned npm specifiers", () => {
  const pkgs = playwrightQuarantinedPackages();
  assertEquals(pkgs, [
    { name: "@playwright/mcp", version: PLAYWRIGHT_MCP_VERSION },
    { name: "playwright", version: PLAYWRIGHT_INSTALLER_VERSION },
  ]);
});

Deno.test("verifyScreenshotNpmQuarantine - ok when both versions are aged", async () => {
  const report = await verifyScreenshotNpmQuarantine({
    scriptDir: "/opt/vibe",
    npmAgeDeps: eligibleNpmAgeDeps(),
  });
  assertEquals(report.ok, true);
  assertEquals(report.blocked.length, 0);
  assertEquals(report.verdicts.length, 2);
});

Deno.test("verifyScreenshotNpmQuarantine - blocks a too-new pinned version", async () => {
  const fresh = new Date(FIXED_NOW.getTime() - 2 * 3_600_000).toISOString();
  const deps: NpmAgeFetchDeps = {
    fetchTimeData: (pkg) => {
      const data: Record<string, string> = pkg === "@playwright/mcp"
        ? { [PLAYWRIGHT_MCP_VERSION]: fresh } // 2h old — under the window
        : { [PLAYWRIGHT_INSTALLER_VERSION]: new Date(0).toISOString() };
      return Promise.resolve(data);
    },
    now: () => FIXED_NOW,
  };
  const report = await verifyScreenshotNpmQuarantine({
    scriptDir: "/opt/vibe",
    npmAgeDeps: deps,
  });
  assertEquals(report.ok, false);
  assertEquals(report.blocked[0]?.package, "@playwright/mcp");
});

Deno.test("setupPlaywrightMcp - refuses setup when a pinned version is under quarantine", async () => {
  const tmpDir = await Deno.makeTempDir();
  const fresh = new Date(FIXED_NOW.getTime() - 1 * 3_600_000).toISOString();
  const deps: NpmAgeFetchDeps = {
    fetchTimeData: (pkg) => {
      const data: Record<string, string> = pkg === "playwright"
        ? { [PLAYWRIGHT_INSTALLER_VERSION]: fresh } // 1h old — under the window
        : { [PLAYWRIGHT_MCP_VERSION]: new Date(0).toISOString() };
      return Promise.resolve(data);
    },
    now: () => FIXED_NOW,
  };
  const config: ScreenshotConfig = {
    scriptDir: tmpDir,
    mcpConfigDir: tmpDir,
    runCommand: mockRunner(),
    skipInstall: true,
    npmAgeDeps: deps,
  };

  const result = await setupPlaywrightMcp(config);
  assertEquals(result.ok, false);
  assertStringIncludes(result.message, "quarantine");
  assertStringIncludes(
    result.message,
    `playwright@${PLAYWRIGHT_INSTALLER_VERSION}`,
  );

  // No .mcp.json must have been written when the gate refused setup.
  let wrote = true;
  try {
    await Deno.readTextFile(`${tmpDir}/.mcp.json`);
  } catch {
    wrote = false;
  }
  assertEquals(wrote, false);

  await Deno.remove(tmpDir, { recursive: true });
});

// Issue #3711 — behaviour change: an unreachable registry used to let setup
// proceed ("indeterminate does not block"), installing a version whose age
// nobody had verified under `--allow-all`. It now refuses. Same scenario,
// re-asserted against the fail-closed contract.
Deno.test("setupPlaywrightMcp - refuses when the registry is unreachable (fail closed)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const deps: NpmAgeFetchDeps = {
    fetchTimeData: () => Promise.reject(new Error("connection reset")),
    now: () => FIXED_NOW,
  };
  const config: ScreenshotConfig = {
    scriptDir: tmpDir,
    mcpConfigDir: tmpDir,
    runCommand: mockRunner(),
    skipInstall: true,
    npmAgeDeps: deps,
  };

  const result = await setupPlaywrightMcp(config);
  assertEquals(result.ok, false);
  assertStringIncludes(result.message, "quarantine");
  assertStringIncludes(result.message, "connection reset");
  assertStringIncludes(
    result.message,
    `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
  );

  // No .mcp.json must have been written when the gate refused setup.
  let wrote = true;
  try {
    await Deno.readTextFile(`${tmpDir}/.mcp.json`);
  } catch {
    wrote = false;
  }
  assertEquals(wrote, false);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("verifyScreenshotNpmQuarantine - refuses an unverifiable age", async () => {
  const deps: NpmAgeFetchDeps = {
    fetchTimeData: () => Promise.resolve(undefined), // registry unreachable
    now: () => FIXED_NOW,
  };
  const report = await verifyScreenshotNpmQuarantine({
    scriptDir: "/opt/vibe",
    npmAgeDeps: deps,
  });
  assertEquals(report.ok, false);
  assertEquals(report.blocked.length, 0);
  assertEquals(report.indeterminate.length, 2);
  assertEquals(report.refused.length, 2);
});

// ── Issue #4069: the browser comes from the container image ─────────────

/** Browser environment as resolved inside the container image. */
function bakedBrowser(): BrowserEnvironment {
  return {
    browsersPath: CONTAINER_BROWSERS_PATH,
    profileDir: `/tmp/${BROWSER_PROFILE_DIR_NAME}`,
    baked: true,
  };
}

/** Browser environment on a host with no baked browser. */
function hostBrowser(): BrowserEnvironment {
  return { profileDir: `/tmp/${BROWSER_PROFILE_DIR_NAME}`, baked: false };
}

Deno.test("resolveBrowserEnvironment - reports a baked browser when the image path exists", () => {
  const env = resolveBrowserEnvironment({
    getEnv: (name) =>
      name === "PLAYWRIGHT_BROWSERS_PATH" ? CONTAINER_BROWSERS_PATH : undefined,
    dirExists: (path) => path === CONTAINER_BROWSERS_PATH,
    os: "linux",
  });

  assertEquals(env.baked, true);
  assertEquals(env.browsersPath, CONTAINER_BROWSERS_PATH);
  assertEquals(env.profileDir, `/tmp/${BROWSER_PROFILE_DIR_NAME}`);
});

Deno.test("resolveBrowserEnvironment - falls back to the image path when the variable is unset", () => {
  const env = resolveBrowserEnvironment({
    getEnv: () => undefined,
    dirExists: (path) => path === CONTAINER_BROWSERS_PATH,
    os: "linux",
  });

  assertEquals(env.baked, true);
  assertEquals(env.browsersPath, CONTAINER_BROWSERS_PATH);
});

Deno.test("resolveBrowserEnvironment - no baked browser on a host without one", () => {
  const env = resolveBrowserEnvironment({
    getEnv: () => undefined,
    dirExists: () => false,
    os: "darwin",
  });

  assertEquals(env.baked, false);
  assertEquals(env.browsersPath, undefined);
  assertEquals(env.profileDir, `/tmp/${BROWSER_PROFILE_DIR_NAME}`);
});

Deno.test("resolveBrowserEnvironment - honours an explicit browsers path", () => {
  const env = resolveBrowserEnvironment({
    getEnv: (name) =>
      name === "PLAYWRIGHT_BROWSERS_PATH" ? "/srv/browsers" : undefined,
    dirExists: (path) => path === "/srv/browsers",
    os: "linux",
  });

  assertEquals(env.baked, true);
  assertEquals(env.browsersPath, "/srv/browsers");
});

Deno.test("resolveBrowserEnvironment - profile lands in the Windows temp area", () => {
  const env = resolveBrowserEnvironment({
    getEnv: (
      name,
    ) => (name === "TEMP" ? "C:\\Users\\vibe\\AppData\\Temp\\" : undefined),
    dirExists: () => false,
    os: "windows",
  });

  assertEquals(
    env.profileDir,
    `C:\\Users\\vibe\\AppData\\Temp\\${BROWSER_PROFILE_DIR_NAME}`,
  );
});

Deno.test("resolveBrowserEnvironment - VIBE_BROWSER_PROFILE_DIR overrides the default", () => {
  const env = resolveBrowserEnvironment({
    getEnv: (name) =>
      name === "VIBE_BROWSER_PROFILE_DIR" ? "/run/scratch/profile" : undefined,
    dirExists: () => false,
    os: "linux",
  });

  assertEquals(env.profileDir, "/run/scratch/profile");
});

Deno.test("generateMcpConfig - points the server at the in-image browser", () => {
  const server = JSON.parse(generateMcpConfig({
    scriptDir: "/workspace",
    browserEnvironment: bakedBrowser(),
  })).mcpServers.playwright;

  assertEquals(server.env.PLAYWRIGHT_BROWSERS_PATH, CONTAINER_BROWSERS_PATH);
  // The container boundary is the isolation that matters in-image, and the
  // OS sandbox needs user namespaces the runtime may not grant.
  assertEquals((server.args as string[]).includes("--no-sandbox"), true);
});

Deno.test("generateMcpConfig - keeps the OS sandbox when no browser is baked in", () => {
  const server = JSON.parse(generateMcpConfig({
    scriptDir: "/opt/vibe",
    browserEnvironment: hostBrowser(),
  })).mcpServers.playwright;

  // Issue #1288: the env block is now always present (it blanks the
  // secrets), but with no baked browser it must not point at one.
  assertEquals("PLAYWRIGHT_BROWSERS_PATH" in server.env, false);
  assertEquals((server.args as string[]).includes("--no-sandbox"), false);
});

Deno.test("generateMcpConfig - writes the browser profile to a disposable directory", () => {
  const args: string[] = JSON.parse(generateMcpConfig({
    scriptDir: "/workspace",
    browserEnvironment: bakedBrowser(),
  })).mcpServers.playwright.args;

  const index = args.indexOf("--user-data-dir");
  assertEquals(index >= 0, true, "expected a --user-data-dir flag");
  assertEquals(args[index + 1], `/tmp/${BROWSER_PROFILE_DIR_NAME}`);
  // Never the mounted checkout: that is host state, not scratch.
  assertEquals(args[index + 1]!.startsWith("/workspace"), false);
});

Deno.test("generateMcpConfig - refuses a profile directory inside the mounted checkout", () => {
  assertThrows(
    () =>
      generateMcpConfig({
        scriptDir: "/workspace",
        browserEnvironment: {
          profileDir: "/workspace/.playwright-profile",
          baked: true,
          browsersPath: CONTAINER_BROWSERS_PATH,
        },
      }),
    Error,
    "inside the mounted checkout",
  );
});

Deno.test("generateMcpConfig - still denies every secret when the browser is baked in", () => {
  const args: string[] = JSON.parse(generateMcpConfig({
    scriptDir: "/workspace",
    browserEnvironment: bakedBrowser(),
  })).mcpServers.playwright.args;

  const denyEnvArg = args.find((a) => a.startsWith("--deny-env="))!;
  assertEquals(
    denyEnvArg.slice("--deny-env=".length).split(",").sort().join(","),
    [...PLAYWRIGHT_MCP_DENIED_ENV].sort().join(","),
  );
});

Deno.test("setupPlaywrightMcp - downloads no browser when the image bakes one", async () => {
  const tmpDir = await Deno.makeTempDir();
  const invoked: string[][] = [];
  const config: ScreenshotConfig = {
    scriptDir: tmpDir,
    mcpConfigDir: tmpDir,
    runCommand: (cmd) => {
      invoked.push(cmd);
      return mockRunner()(cmd);
    },
    npmAgeDeps: eligibleNpmAgeDeps(),
    browserEnvironment: bakedBrowser(),
  };

  const result = await setupPlaywrightMcp(config);
  assertEquals(result.ok, true);
  assertStringIncludes(result.message, "no download");

  // `skipInstall` is deliberately NOT set: the baked browser is what stops
  // the installer running, so a regression here is a real mid-run download.
  assertEquals(
    invoked.some((cmd) => cmd.join(" ").includes("npm:playwright@")),
    false,
    "no Playwright browser install may be spawned when the image bakes one",
  );

  const parsed = JSON.parse(await Deno.readTextFile(`${tmpDir}/.mcp.json`));
  assertEquals(
    parsed.mcpServers.playwright.env.PLAYWRIGHT_BROWSERS_PATH,
    CONTAINER_BROWSERS_PATH,
  );

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("setupPlaywrightMcp - installs the browser when the host has none baked in", async () => {
  const tmpDir = await Deno.makeTempDir();
  const invoked: string[][] = [];
  const config: ScreenshotConfig = {
    scriptDir: tmpDir,
    mcpConfigDir: tmpDir,
    runCommand: (cmd) => {
      invoked.push(cmd);
      return mockRunner()(cmd);
    },
    npmAgeDeps: eligibleNpmAgeDeps(),
    browserEnvironment: hostBrowser(),
  };

  assertEquals((await setupPlaywrightMcp(config)).ok, true);
  assertEquals(
    invoked.some((cmd) =>
      cmd.join(" ").includes(`npm:playwright@${PLAYWRIGHT_INSTALLER_VERSION}`)
    ),
    true,
    "a host without a baked browser must still install one",
  );

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("PLAYWRIGHT_INSTALLER_VERSION - is an exact pin, never a floating alias", () => {
  for (const pinned of [PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_INSTALLER_VERSION]) {
    assertEquals(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinned),
      true,
      `Expected an exact version pin, got: ${pinned}`,
    );
  }
});

// ── #4355: the server must use the Chromium the installer/image provides ──

Deno.test("generateMcpConfig - selects the chromium browser channel, baked or host (Issue #4355)", () => {
  // @playwright/mcp defaults to the `chrome` channel (Google Chrome), which
  // neither the image nor `playwright install chromium` provides — observed
  // in the container as "Chromium distribution 'chrome' is not found at
  // /opt/google/chrome/chrome" on every browser_take_screenshot.
  for (const browserEnvironment of [bakedBrowser(), hostBrowser()]) {
    const args: string[] = JSON.parse(generateMcpConfig({
      scriptDir: "/workspace",
      browserEnvironment,
    })).mcpServers.playwright.args;
    const index = args.indexOf("--browser");
    assertEquals(index >= 0, true, "expected a --browser flag");
    assertEquals(args[index + 1], "chromium");
    // The channel flag belongs to the MCP server, after the npm specifier.
    assertEquals(
      index > args.findIndex((a) => a.startsWith("npm:@playwright/mcp@")),
      true,
    );
  }
});

// ── #1288: --deny-env does not bound a child process ──────────────────────

Deno.test("generateMcpConfig - blanks every denied secret in the server's own environment (Issue #1288)", () => {
  // `--deny-env` is a permission check inside the Deno runtime: the value is
  // still in the process environment, so any child spawned under
  // `--allow-run` (`printenv GH_TOKEN`) reads it. Blanking the values is what
  // actually removes them from the child's view.
  for (const browserEnvironment of [bakedBrowser(), hostBrowser()]) {
    const server = JSON.parse(generateMcpConfig({
      scriptDir: "/workspace",
      browserEnvironment,
    })).mcpServers.playwright;

    const env = server.env as Record<string, string> | undefined;
    assertEquals(
      typeof env,
      "object",
      "the server config must carry an env block that blanks the secrets",
    );
    for (const name of PLAYWRIGHT_MCP_DENIED_ENV) {
      assertEquals(
        env?.[name],
        "",
        `${name} must be blanked for the MCP server and its children`,
      );
    }
  }
});

Deno.test("generateMcpConfig - blanking the secrets keeps the baked browser pointer (Issue #1288)", () => {
  const baked = JSON.parse(generateMcpConfig({
    scriptDir: "/workspace",
    browserEnvironment: bakedBrowser(),
  })).mcpServers.playwright.env as Record<string, string>;
  assertEquals(baked.PLAYWRIGHT_BROWSERS_PATH, CONTAINER_BROWSERS_PATH);

  const host = JSON.parse(generateMcpConfig({
    scriptDir: "/opt/vibe",
    browserEnvironment: hostBrowser(),
  })).mcpServers.playwright.env as Record<string, string>;
  assertEquals("PLAYWRIGHT_BROWSERS_PATH" in host, false);
});

Deno.test("generateMcpConfig - denies read and write of the credential stores (Issue #1288)", () => {
  const args: string[] = JSON.parse(generateMcpConfig({
    scriptDir: "/workspace",
    browserEnvironment: bakedBrowser(),
    deniedPaths: ["/home/vibe/.config/gh", "/home/vibe/.ssh"],
  })).mcpServers.playwright.args;

  for (const flag of ["--deny-read=", "--deny-write="]) {
    const arg = args.find((a) => a.startsWith(flag));
    assertEquals(typeof arg, "string", `expected a ${flag}... flag`);
    assertEquals(
      (arg as string).slice(flag.length).split(","),
      ["/home/vibe/.config/gh", "/home/vibe/.ssh"],
    );
  }
});

Deno.test("generateMcpConfig - omits the deny-path flags when there is nothing to deny (Issue #1288)", () => {
  // `--deny-read=` with an empty list denies every read and would break the
  // server outright, so the flag must be dropped rather than emitted empty.
  const args: string[] = JSON.parse(generateMcpConfig({
    scriptDir: "/workspace",
    browserEnvironment: bakedBrowser(),
    deniedPaths: [],
  })).mcpServers.playwright.args;

  assertEquals(args.some((a) => a.startsWith("--deny-read")), false);
  assertEquals(args.some((a) => a.startsWith("--deny-write")), false);
});

Deno.test("resolveDeniedPaths - covers the credential stores under HOME", () => {
  const paths = resolveDeniedPaths({
    getEnv: (name) => (name === "HOME" ? "/home/vibe" : undefined),
  });

  for (
    const expected of [
      "/home/vibe/.ssh",
      "/home/vibe/.config/gh",
      "/home/vibe/.aws",
      "/home/vibe/.gnupg",
      "/home/vibe/.netrc",
      "/home/vibe/.git-credentials",
    ]
  ) {
    assertEquals(paths.includes(expected), true, `missing ${expected}`);
  }
});

Deno.test("resolveDeniedPaths - covers the relocated gh config and the app private key", () => {
  const paths = resolveDeniedPaths({
    getEnv: (name) =>
      ({
        HOME: "/home/vibe",
        GH_CONFIG_DIR: "/srv/state/gh",
        CLAUDE_CONFIG_DIR: "/srv/state/claude",
        GITHUB_APP_PRIVATE_KEY_PATH: "/srv/secrets/app.pem",
      })[name],
  });

  assertEquals(paths.includes("/srv/state/gh"), true);
  assertEquals(paths.includes("/srv/state/claude"), true);
  assertEquals(paths.includes("/srv/secrets/app.pem"), true);
  // No duplicates, and nothing empty — an empty entry in a deny list is a
  // path that never matches, silently weakening the guard.
  assertEquals(new Set(paths).size, paths.length);
  assertEquals(paths.some((p) => p.trim() === ""), false);
});

Deno.test("resolveDeniedPaths - returns nothing when the environment names no home", () => {
  assertEquals(resolveDeniedPaths({ getEnv: () => undefined }), []);
});
