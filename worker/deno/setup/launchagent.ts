/**
 * macOS LaunchAgent plist generation and installation for VibeCoder.
 *
 * Generates and installs a LaunchAgent that runs the worker on a
 * 300-second interval. macOS-specific — gracefully skips on other platforms.
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 */

import { processEnvLookup } from "../lib/env_lookup.ts";
import { pathStyleFor } from "../lib/host_path_style.ts";
import { readConfiguredLogDirSync, resolveLogDir } from "../lib/log_dir.ts";
import { resolveHostConfigPath } from "../lib/host_config_path.ts";

/** Configuration for LaunchAgent setup. */
export interface LaunchAgentConfig {
  /** Root directory of the VibeCoder project. */
  scriptDir: string;
  /** LaunchAgents directory (default: ~/Library/LaunchAgents). */
  launchAgentDir?: string;
  /** Logs directory (default: this host's log directory, Issue #873). */
  logsDir?: string;
  /** Optional GH_TOKEN for the LaunchAgent environment. */
  ghToken?: string;
  /** Optional ANTHROPIC_API_KEY for the LaunchAgent environment. */
  anthropicApiKey?: string;
  /** Optional VIBE_FALLBACK_PATHS for the LaunchAgent environment. */
  fallbackPaths?: string;
  /** Skip launchctl commands (for testing). */
  skipLaunchctl?: boolean;
}

/** Result of a LaunchAgent operation. */
export interface LaunchAgentResult {
  ok: boolean;
  message: string;
}

const LAUNCHAGENT_LABEL = "com.vibe.auto-issue-worker";

/**
 * This host's log directory — the same resolution the launcher uses.
 *
 * The agent's stdout and stderr land beside the worker's own logs rather than
 * in a second directory nobody thinks to read (Issues #872, #873).
 *
 * @returns The resolved directory
 */
function hostLogsDir(): string {
  const home = Deno.env.get("HOME") ?? "~";
  return resolveLogDir(
    home,
    processEnvLookup,
    pathStyleFor(home),
    undefined,
    readConfiguredLogDirSync(
      resolveHostConfigPath({ baseDir: Deno.cwd(), env: processEnvLookup }),
    ),
  );
}

/**
 * Generate the LaunchAgent plist XML content.
 */
export function generatePlist(config: LaunchAgentConfig): string {
  const runScriptPath = `${config.scriptDir}/run.sh`;
  const logsDir = config.logsDir ?? hostLogsDir();

  let plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHAGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${runScriptPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${config.scriptDir}</string>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>StandardOutPath</key>
    <string>${logsDir}/launchagent-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${logsDir}/launchagent-stderr.log</string>
    <key>RunAtLoad</key>
    <true/>
`;

  // Add environment variables if provided
  const hasEnvVars = config.ghToken || config.anthropicApiKey ||
    config.fallbackPaths;
  if (hasEnvVars) {
    plist += "    <key>EnvironmentVariables</key>\n";
    plist += "    <dict>\n";

    if (config.ghToken) {
      plist += "        <key>GH_TOKEN</key>\n";
      plist += `        <string>${escapeXml(config.ghToken)}</string>\n`;
    }

    if (config.anthropicApiKey) {
      plist += "        <key>ANTHROPIC_API_KEY</key>\n";
      plist += `        <string>${
        escapeXml(config.anthropicApiKey)
      }</string>\n`;
    }

    if (config.fallbackPaths) {
      plist += "        <key>VIBE_FALLBACK_PATHS</key>\n";
      plist += `        <string>${escapeXml(config.fallbackPaths)}</string>\n`;
    }

    plist += "    </dict>\n";
  }

  plist += `</dict>
</plist>`;

  return plist;
}

/**
 * Write the plist to disk with owner-only permissions (mode 0o600).
 *
 * The plist embeds the worker's GH_TOKEN and ANTHROPIC_API_KEY in plaintext
 * (Issue #2514), so it must never be left world-readable. `Deno.writeTextFile`
 * applies the `mode` option only when *creating* a file; it does not change the
 * mode of a pre-existing file. We therefore chmod explicitly afterwards so an
 * already-existing plist (possibly written 0o644 by an older worker) is also
 * tightened to 0o600.
 */
export async function writeSecurePlist(
  plistPath: string,
  content: string,
): Promise<void> {
  await Deno.writeTextFile(plistPath, content, { mode: 0o600 });
  await Deno.chmod(plistPath, 0o600);
}

/** Escape special XML characters to prevent injection. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Setup macOS LaunchAgent (idempotent).
 *
 * On non-macOS platforms, returns a skip result.
 */
export async function setupLaunchAgent(
  config: LaunchAgentConfig,
): Promise<LaunchAgentResult> {
  if (Deno.build.os !== "darwin") {
    return {
      ok: true,
      message: "LaunchAgent setup is only available on macOS — skipped",
    };
  }

  const homeDir = Deno.env.get("HOME") ?? "~";
  const launchAgentDir = config.launchAgentDir ??
    `${homeDir}/Library/LaunchAgents`;
  const logsDir = config.logsDir ?? hostLogsDir();

  // Create directories
  try {
    await Deno.mkdir(logsDir, { recursive: true });
  } catch { /* may already exist */ }

  try {
    await Deno.mkdir(launchAgentDir, { recursive: true });
  } catch { /* may already exist */ }

  const plistPath = `${launchAgentDir}/${LAUNCHAGENT_LABEL}.plist`;
  const newContent = generatePlist(config);

  // Check if plist already exists with same content (idempotent)
  try {
    const existingContent = await Deno.readTextFile(plistPath);
    if (existingContent === newContent) {
      return { ok: true, message: "LaunchAgent plist already up to date" };
    }

    // Unload existing agent before updating
    if (!config.skipLaunchctl) {
      const uid = await getUid();
      await runLaunchctl(["bootout", `gui/${uid}/${LAUNCHAGENT_LABEL}`]);
    }
  } catch {
    // File doesn't exist yet — that's fine
  }

  // Write the plist with owner-only permissions — it embeds GH_TOKEN and
  // ANTHROPIC_API_KEY in plaintext (Issue #2514).
  await writeSecurePlist(plistPath, newContent);

  // Load the agent
  if (!config.skipLaunchctl) {
    const uid = await getUid();

    const bootstrapResult = await runLaunchctl([
      "bootstrap",
      `gui/${uid}`,
      plistPath,
    ]);
    if (!bootstrapResult.success) {
      // Try legacy load command for older macOS
      const loadResult = await runLaunchctl(["load", plistPath]);
      if (!loadResult.success) {
        return {
          ok: true,
          message:
            `Created plist at ${plistPath} but could not load automatically. Load manually with: launchctl bootstrap "gui/$(id -u)" "${plistPath}"`,
        };
      }
    }

    // Enable the agent
    await runLaunchctl(["enable", `gui/${uid}/${LAUNCHAGENT_LABEL}`]);
  }

  return { ok: true, message: `LaunchAgent setup complete: ${plistPath}` };
}

/**
 * Remove the LaunchAgent: unload it and delete its plist (Issue #26).
 *
 * The counterpart of {@link setupLaunchAgent} for the operator who answers
 * "no" to the install prompt on a host where an earlier setup left the agent
 * installed — otherwise it keeps launching the worker every five minutes
 * beside whatever they start by hand, and two workers on one host collide on
 * the work volumes. Idempotent: an agent that is not installed is not an
 * error.
 *
 * @param config - Where the plist lives and whether to drive launchctl
 * @returns Whether the agent is gone, and what happened
 */
export async function removeLaunchAgent(config: {
  launchAgentDir?: string;
  skipLaunchctl?: boolean;
}): Promise<LaunchAgentResult> {
  if (Deno.build.os !== "darwin") {
    return {
      ok: true,
      message: "LaunchAgent removal is only relevant on macOS — skipped",
    };
  }
  const homeDir = Deno.env.get("HOME") ?? "~";
  const launchAgentDir = config.launchAgentDir ??
    `${homeDir}/Library/LaunchAgents`;
  const plistPath = `${launchAgentDir}/${LAUNCHAGENT_LABEL}.plist`;

  // Unload first: a plist deleted from under a loaded agent leaves the job
  // running until logout. bootout of a job that is not loaded fails, and
  // that is fine — the plist may be a leftover from a session ago.
  if (!config.skipLaunchctl) {
    const uid = await getUid();
    await runLaunchctl(["bootout", `gui/${uid}/${LAUNCHAGENT_LABEL}`]);
  }

  try {
    await Deno.remove(plistPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { ok: true, message: "No LaunchAgent is installed" };
    }
    return {
      ok: false,
      message: `Could not remove ${plistPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { ok: true, message: `LaunchAgent removed: ${plistPath}` };
}

/**
 * Whether the LaunchAgent plist is present (Issue #26) — what setup asks
 * before offering to remove it. Presence of the file is the test: a loaded
 * job always has one, and an unloaded leftover still reloads at next login.
 */
export async function isLaunchAgentInstalled(
  launchAgentDir?: string,
): Promise<boolean> {
  const homeDir = Deno.env.get("HOME") ?? "~";
  const dir = launchAgentDir ?? `${homeDir}/Library/LaunchAgents`;
  try {
    await Deno.stat(`${dir}/${LAUNCHAGENT_LABEL}.plist`);
    return true;
  } catch {
    return false;
  }
}

async function getUid(): Promise<string> {
  const cmd = new Deno.Command("id", { args: ["-u"], stdout: "piped" });
  const output = await cmd.output();
  return new TextDecoder().decode(output.stdout).trim();
}

async function runLaunchctl(args: string[]): Promise<{ success: boolean }> {
  try {
    const cmd = new Deno.Command("launchctl", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    return { success: output.success };
  } catch {
    return { success: false };
  }
}

/** Get the LaunchAgent label (for use in status messages). */
export function getLaunchAgentLabel(): string {
  return LAUNCHAGENT_LABEL;
}
