/**
 * Playwright MCP and screenshot support setup for VibeCoder.
 *
 * Sets up Playwright MCP server for capturing screenshots of UI changes.
 * Requires Deno 2+ for npm: specifier support.
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 * Issue #2308: Pin @playwright/mcp version and scope Deno permissions
 *   so a hijacked publish cannot read worker secrets or load native code.
 * Issue #2799: Gate the pinned `npm:` specifiers with an explicit registry
 *   `time`-based age check at setup time. These versions live in `.ts`
 *   string literals, so neither Deno's native `minimumDependencyAge`
 *   quarantine (declared imports only) nor Renovate (its `deno` manager is
 *   disabled and its `npm` manager parses `package.json`, not `.ts` literals)
 *   covers them — the age gate below is the only automated quarantine.
 * Issue #4069: The container image bakes Playwright's Chromium, so the
 *   browser resolves from the image and nothing downloads one at container
 *   start or mid-run. Browser profile/state goes to a disposable location,
 *   never to the mounted host checkout.
 */

import {
  DEFAULT_NPM_QUARANTINE_HOURS,
  defaultNpmAgeDeps,
  type NpmAgeFetchDeps,
  type NpmQuarantineReport,
  type QuarantinedPackage,
  verifyNpmPackagesQuarantine,
} from "../lib/npm_package_age.ts";

/**
 * Pinned version of @playwright/mcp.
 *
 * Issue #2308: do NOT use `@latest`. Bumping this string is the deliberate,
 * reviewable knob — matching the SHA-pinning discipline already applied to
 * GitHub Actions.
 *
 * Issue #2799: this specifier is gated by the explicit npm-registry age check
 * in {@link verifyScreenshotNpmQuarantine}, NOT by Renovate — Renovate never
 * sees a version embedded in a `.ts` string literal.
 */
export const PLAYWRIGHT_MCP_VERSION = "0.0.75";

/**
 * Environment variables the Playwright MCP process must NOT be able to read.
 *
 * Issue #2308: the worker exposes high-value secrets through the environment
 * (ImgBB API key, GitHub App credentials, SSH command, Anthropic API key).
 * Deno's `--deny-env=<list>` takes precedence over `--allow-env`, so even a
 * compromised release cannot read these via `Deno.env.get()`.
 */
export const PLAYWRIGHT_MCP_DENIED_ENV: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GIT_SSH_COMMAND",
  "VIBE_IMGBB_API_KEY",
];

/**
 * Where the container image bakes Playwright's browsers (Issue #4069).
 *
 * `container/Containerfile` installs Chromium here at build time and sets
 * `PLAYWRIGHT_BROWSERS_PATH` to the same path, so the MCP server resolves the
 * in-image browser and never downloads one. The value is restated in
 * `container/tools.json`; `container_manifest_test.ts` fails the gate when the
 * two drift apart.
 */
export const CONTAINER_BROWSERS_PATH = "/opt/playwright-browsers";

/**
 * Disposable directory the browser writes its profile/state to.
 *
 * Deliberately outside the mounted checkout: inside the container `/tmp` is a
 * `tmpfs` the launcher mounts (see `container_launch.ts`), so the profile dies
 * with the container instead of leaking browser state into the repository or
 * onto the host.
 */
export const BROWSER_PROFILE_DIR_NAME = "vibe-playwright-profile";
/** Directory name for the MCP server's scratch output (snapshots, unnamed screenshots). */
export const BROWSER_OUTPUT_DIR_NAME = "vibe-playwright-output";

/** Where the Playwright MCP browser runs from, and what it writes. */
export interface BrowserEnvironment {
  /** Baked browsers directory, or undefined when the image has none. */
  browsersPath?: string;
  /** Disposable directory the browser writes its profile/state to. */
  profileDir: string;
  /** True when the browser came from the image — nothing to download. */
  baked: boolean;
}

/** Injectable seams so the resolver is testable off a real container. */
export interface BrowserEnvironmentDeps {
  /** Environment reader (default: `Deno.env.get`). */
  getEnv?: (name: string) => string | undefined;
  /** Directory-existence probe (default: `Deno.statSync`). */
  dirExists?: (path: string) => boolean;
  /** Host platform (default: `Deno.build.os`). */
  os?: typeof Deno.build.os;
}

function defaultGetEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    // No --allow-env: treat as unset rather than aborting setup.
    return undefined;
  }
}

function defaultDirExists(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

/** Disposable profile location for the host platform. */
function defaultProfileDir(
  os: typeof Deno.build.os,
  getEnv: (name: string) => string | undefined,
): string {
  if (os === "windows") {
    const temp = getEnv("TEMP") ?? getEnv("TMP") ?? "C:\\Windows\\Temp";
    return `${temp.replace(/[\\/]+$/, "")}\\${BROWSER_PROFILE_DIR_NAME}`;
  }
  return `/tmp/${BROWSER_PROFILE_DIR_NAME}`;
}

/**
 * Resolve where the Playwright browser comes from and where it may write.
 *
 * A browsers directory that exists is a baked one: inside the container image
 * `PLAYWRIGHT_BROWSERS_PATH` points at {@link CONTAINER_BROWSERS_PATH} and
 * Chromium is already there, so setup installs nothing. On a host with no
 * baked browser the caller still gets a disposable profile directory.
 *
 * @param deps - Injectable environment/filesystem seams (testing).
 * @returns The resolved browser environment.
 */
export function resolveBrowserEnvironment(
  deps: BrowserEnvironmentDeps = {},
): BrowserEnvironment {
  const getEnv = deps.getEnv ?? defaultGetEnv;
  const dirExists = deps.dirExists ?? defaultDirExists;
  const os = deps.os ?? Deno.build.os;

  const declared = getEnv("PLAYWRIGHT_BROWSERS_PATH")?.trim();
  const candidate = declared && declared !== ""
    ? declared
    : CONTAINER_BROWSERS_PATH;
  const baked = dirExists(candidate);

  const override = getEnv("VIBE_BROWSER_PROFILE_DIR")?.trim();
  const profileDir = override && override !== ""
    ? override
    : defaultProfileDir(os, getEnv);

  return { browsersPath: baked ? candidate : undefined, profileDir, baked };
}

/** Configuration for screenshot setup. */
export interface ScreenshotConfig {
  /** Root directory of the VibeCoder project. */
  scriptDir: string;
  /** Directory for .mcp.json (default: scriptDir). */
  mcpConfigDir?: string;
  /** Directory name for screenshots (default: docs/evidence). */
  screenshotDir?: string;
  /** Skip browser installation (for testing). */
  skipInstall?: boolean;
  /** Command runner override (testing). */
  runCommand?: (cmd: string[]) => Promise<CommandOutput>;
  /**
   * Quarantine window (hours) for the pinned `npm:` specifiers
   * (Issue #2799). Defaults to {@link DEFAULT_NPM_QUARANTINE_HOURS} (24h).
   */
  quarantineHours?: number;
  /**
   * Injectable npm age-check deps (testing). When omitted, the real npm
   * registry fetcher and the system clock are used.
   */
  npmAgeDeps?: NpmAgeFetchDeps;
  /**
   * Resolved browser environment (Issue #4069). When omitted it is resolved
   * from the process environment and filesystem by
   * {@link resolveBrowserEnvironment}.
   */
  browserEnvironment?: BrowserEnvironment;
}

/** Result of a screenshot setup operation. */
export interface ScreenshotResult {
  ok: boolean;
  message: string;
}

interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

async function defaultRunCommand(cmd: string[]): Promise<CommandOutput> {
  const command = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const decoder = new TextDecoder();
  return {
    success: output.success,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim(),
  };
}

/**
 * Check if Deno 2+ is available (required for npm: specifiers).
 */
export async function checkDenoVersion(
  runCommand?: (cmd: string[]) => Promise<CommandOutput>,
): Promise<{ ok: boolean; version?: string }> {
  const runner = runCommand ?? defaultRunCommand;
  try {
    const result = await runner(["deno", "--version"]);
    if (!result.success) return { ok: false };

    const firstLine = result.stdout.split("\n")[0] ?? "";
    const versionMatch = firstLine.match(/deno (\d+)/);
    if (!versionMatch) return { ok: false };

    const major = parseInt(versionMatch[1]!, 10);
    if (major < 2) return { ok: false };

    return { ok: true, version: firstLine };
  } catch {
    return { ok: false };
  }
}

/**
 * Check Linux browser dependencies for headless Chrome.
 *
 * The `os` seam defaults to the host platform (`Deno.build.os`); tests inject
 * `"linux"` to exercise the `dpkg` probe loop on a non-Linux runner without
 * touching the real environment.
 */
export async function checkLinuxBrowserDeps(
  runCommand?: (cmd: string[]) => Promise<CommandOutput>,
  os: typeof Deno.build.os = Deno.build.os,
): Promise<{ ok: boolean; missing: string[] }> {
  if (os !== "linux") {
    return { ok: true, missing: [] };
  }

  const runner = runCommand ?? defaultRunCommand;
  const requiredPackages = [
    "libnss3",
    "libnspr4",
    "libatk1.0-0",
    "libatk-bridge2.0-0",
    "libcups2",
    "libdrm2",
    "libxkbcommon0",
    "libxcomposite1",
    "libxdamage1",
    "libxfixes3",
    "libxrandr2",
    "libgbm1",
    "libasound2",
  ];

  const missing: string[] = [];

  // Check if dpkg is available
  const dpkgCheck = await runner(["which", "dpkg"]);
  if (!dpkgCheck.success) {
    // Cannot check — assume OK
    return { ok: true, missing: [] };
  }

  for (const pkg of requiredPackages) {
    const result = await runner(["dpkg", "-s", pkg]);
    if (!result.success) {
      missing.push(pkg);
    }
  }

  return { ok: missing.length === 0, missing };
}

/**
 * Generate the MCP configuration JSON for Playwright.
 *
 * Issue #2308: the spawn args drop `--allow-all` for explicit allow-flags
 * (deliberately excluding `--allow-ffi`) and use `--deny-env` to block
 * Playwright MCP from reading worker secrets, even if the package itself is
 * compromised. The npm specifier is pinned to {@link PLAYWRIGHT_MCP_VERSION}
 * so the registry's `@latest` tag cannot auto-roll us onto a hijacked
 * publish.
 *
 * Issue #4069: when the browser is baked into the container image the server
 * is pointed at it explicitly through `PLAYWRIGHT_BROWSERS_PATH`, and the
 * browser profile is written to a disposable directory rather than into the
 * mounted checkout.
 *
 * @param config - Screenshot setup configuration.
 * @returns The `.mcp.json` document, pretty-printed.
 * @throws Error when the resolved profile directory sits inside the mounted
 *   checkout — browser state must never be written there.
 */
export function generateMcpConfig(config: ScreenshotConfig): string {
  const mcpDir = config.mcpConfigDir ?? config.scriptDir;
  const denyEnv = PLAYWRIGHT_MCP_DENIED_ENV.join(",");
  const browser = config.browserEnvironment ?? resolveBrowserEnvironment();

  assertDisposableProfileDir(browser.profileDir, mcpDir);
  // The server's output directory is scratch beside the profile, NOT the
  // checkout's docs/evidence (Issue #4355): on every `browser_navigate` the
  // server writes an accessibility snapshot (`page-<ts>.yml`) into
  // --output-dir, which would land those files in the repository and in
  // the next commit. Screenshots the agent names explicitly
  // (`filename: docs/evidence/<name>.png`) resolve against the server's
  // working directory — the clone — so evidence still lands where the
  // gate and the PR expect it.
  const outputDir = defaultOutputDir(browser.profileDir);

  const args = [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-env",
    `--deny-env=${denyEnv}`,
    "--allow-run",
    "--allow-sys",
    `npm:@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
    "--headless",
    // The server defaults to the `chrome` channel (Google Chrome), which
    // neither the image nor `playwright install chromium` provides — every
    // screenshot in the container failed with "Chromium distribution
    // 'chrome' is not found at /opt/google/chrome/chrome" (Issue #4355).
    // Name the Chromium that is actually installed.
    "--browser",
    "chromium",
  ];

  // Inside the container the OS-level sandbox needs user namespaces the
  // runtime may not grant; the container boundary is the isolation that
  // matters there. On a host (no baked browser) Chromium keeps its sandbox.
  if (browser.baked) args.push("--no-sandbox");

  args.push("--user-data-dir", browser.profileDir);
  args.push("--output-dir", outputDir);

  const playwright: Record<string, unknown> = { command: "deno", args };
  if (browser.browsersPath) {
    playwright.env = { PLAYWRIGHT_BROWSERS_PATH: browser.browsersPath };
  }

  return JSON.stringify({ mcpServers: { playwright } }, null, 2);
}

/**
 * Fail loud when the browser profile would be written to the mounted
 * checkout (Issue #4069) — that is host state, not disposable scratch.
 */
/** Scratch output directory beside the browser profile (Issue #4355). */
export function defaultOutputDir(profileDir: string): string {
  const sep = profileDir.includes("\\") && !profileDir.includes("/")
    ? "\\"
    : "/";
  const parent = profileDir.replace(/[\\/]+[^\\/]*$/, "");
  return `${parent}${sep}${BROWSER_OUTPUT_DIR_NAME}`;
}

function assertDisposableProfileDir(profileDir: string, mcpDir: string): void {
  const normalise = (p: string) => p.replace(/[\\/]+$/, "");
  const root = normalise(mcpDir);
  const profile = normalise(profileDir);
  if (root !== "" && (profile === root || profile.startsWith(`${root}/`))) {
    throw new Error(
      `Browser profile directory "${profileDir}" is inside the mounted ` +
        `checkout "${mcpDir}". Point VIBE_BROWSER_PROFILE_DIR at a ` +
        `disposable location such as /tmp/${BROWSER_PROFILE_DIR_NAME}.`,
    );
  }
}

/**
 * Pinned version of the `playwright` browser-installer package.
 *
 * Issue #2308: the install helper runs once at setup time under operator
 * control (not on every screenshot), so its supply-chain blast radius is
 * smaller than the MCP server's — but the version is still pinned so a
 * hijacked `@latest` cannot land silently on the next `setup.sh` run.
 *
 * Issue #2799: the installer runs with `--allow-all`, so a freshly-published
 * (potentially hijacked) version is the highest-value thing to gate. Renovate
 * does NOT cover this specifier — it is gated by the explicit registry age
 * check in {@link verifyScreenshotNpmQuarantine}, run before the install.
 *
 * Issue #4069: this must be the exact version `@playwright/mcp@`{@link
 * PLAYWRIGHT_MCP_VERSION} depends on. Playwright stores browsers as
 * `chromium-<revision>` and each release pins its own revision, so a
 * near-miss version installs a browser the MCP server will not use and then
 * downloads the right one mid-run. `container/tools.json` pins
 * `playwright-core` at this same version and the image bakes that browser;
 * `container_manifest_test.ts` fails the gate when the two drift.
 */
export const PLAYWRIGHT_INSTALLER_VERSION = "1.61.0-alpha-1778188671000";

/** The pinned third-party npm specifiers screenshot setup shells out to. */
export function playwrightQuarantinedPackages(): QuarantinedPackage[] {
  return [
    { name: "@playwright/mcp", version: PLAYWRIGHT_MCP_VERSION },
    { name: "playwright", version: PLAYWRIGHT_INSTALLER_VERSION },
  ];
}

/**
 * Run the npm-registry `time`-based quarantine gate over the pinned Playwright
 * specifiers (Issue #2799). Fail-closed (Issue #3711): a version that is
 * definitively newer than the window is refused, and so is one whose age could
 * not be verified — the installer runs under `--allow-all`, so a lookup that
 * could not be performed must not stand in for one that passed.
 */
export function verifyScreenshotNpmQuarantine(
  config: ScreenshotConfig,
): Promise<NpmQuarantineReport> {
  const deps = config.npmAgeDeps ?? defaultNpmAgeDeps();
  const hours = config.quarantineHours ?? DEFAULT_NPM_QUARANTINE_HOURS;
  return verifyNpmPackagesQuarantine(
    playwrightQuarantinedPackages(),
    hours,
    deps,
  );
}

/**
 * Install Playwright browsers for screenshot support.
 *
 * The installer legitimately needs broad permissions (downloads browser
 * binaries, writes to the playwright cache, runs subprocesses to verify
 * the install). Pinning the npm specifier is the supply-chain mitigation.
 */
export async function installPlaywrightBrowsers(
  runCommand?: (cmd: string[]) => Promise<CommandOutput>,
): Promise<ScreenshotResult> {
  const runner = runCommand ?? defaultRunCommand;
  const result = await runner([
    "deno",
    "run",
    "--allow-all",
    `npm:playwright@${PLAYWRIGHT_INSTALLER_VERSION}`,
    "install",
    "chromium",
  ]);

  if (result.success) {
    return {
      ok: true,
      message: "Playwright Chromium browser installed successfully",
    };
  }

  return {
    ok: false,
    message:
      `Failed to install Playwright browsers. Install manually with: deno run --allow-all npm:playwright@${PLAYWRIGHT_INSTALLER_VERSION} install chromium`,
  };
}

/**
 * Setup Playwright MCP server for screenshot support (idempotent).
 */
export async function setupPlaywrightMcp(
  config: ScreenshotConfig,
): Promise<ScreenshotResult> {
  // Check Deno version first
  const denoCheck = await checkDenoVersion(config.runCommand);
  if (!denoCheck.ok) {
    return {
      ok: false,
      message: "Deno 2+ is required for screenshot support",
    };
  }

  // Issue #2799: quarantine the pinned `npm:` specifiers before using them.
  // Issue #3711: an unreachable or failing registry is fatal too — an
  // unverifiable age refuses setup instead of silently passing the gate.
  const quarantine = await verifyScreenshotNpmQuarantine(config);
  if (!quarantine.ok) {
    const refused = quarantine.refused
      .map((v) => `${v.package}@${v.version}`)
      .join(", ");
    const detail = quarantine.refused.map((v) => v.reason).join(" ");
    return {
      ok: false,
      message:
        `Refusing screenshot setup: pinned npm package(s) did not clear the ` +
        `dependency-update quarantine window: ${refused}. ${detail} ` +
        `Wait for the version(s) to age past the window, pin an older, ` +
        `verified release, or re-run once the npm registry is reachable.`,
    };
  }

  // Issue #4069: a baked browser brings its own system libraries, so the
  // dpkg probe is a host-only concern.
  const browser = config.browserEnvironment ?? resolveBrowserEnvironment();
  if (Deno.build.os === "linux" && !browser.baked) {
    const browserDeps = await checkLinuxBrowserDeps(config.runCommand);
    if (!browserDeps.ok) {
      // Non-fatal warning — continue setup
      console.warn(
        `Some browser dependencies may be missing: ${
          browserDeps.missing.join(", ")
        }`,
      );
    }
  }

  const mcpDir = config.mcpConfigDir ?? config.scriptDir;
  const mcpConfigFile = `${mcpDir}/.mcp.json`;
  const newConfig = generateMcpConfig({
    ...config,
    browserEnvironment: browser,
  });

  // Check if config already exists with same content (idempotent)
  try {
    const existingContent = await Deno.readTextFile(mcpConfigFile);
    if (existingContent.trim() === newConfig.trim()) {
      return {
        ok: true,
        message: `MCP configuration already up to date: ${mcpConfigFile}`,
      };
    }

    // Try to merge with existing config
    try {
      const existing = JSON.parse(existingContent);
      const newObj = JSON.parse(newConfig);
      if (existing.mcpServers) {
        const merged = {
          ...existing,
          mcpServers: { ...existing.mcpServers, ...newObj.mcpServers },
        };
        await Deno.writeTextFile(
          mcpConfigFile,
          JSON.stringify(merged, null, 2),
        );
        return {
          ok: true,
          message: `Updated MCP configuration: ${mcpConfigFile}`,
        };
      }
    } catch {
      // Existing file is not valid JSON — overwrite
    }
  } catch {
    // File doesn't exist — create new
  }

  // Write new config
  await Deno.writeTextFile(mcpConfigFile, newConfig);

  // Issue #4069: the container image already carries Chromium, so there is
  // nothing to download — installing again would fetch a second copy.
  if (browser.baked) {
    return {
      ok: true,
      message: `Screenshot support setup complete: ${mcpConfigFile} ` +
        `(Chromium from the image at ${browser.browsersPath}, no download)`,
    };
  }

  // Install browsers unless skipped
  if (!config.skipInstall) {
    await installPlaywrightBrowsers(config.runCommand);
  }

  return {
    ok: true,
    message: `Screenshot support setup complete: ${mcpConfigFile}`,
  };
}
