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
import { escapeXml } from "../lib/xml_escape.ts";
import { atomicWrite } from "../lib/file_utils.ts";

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

/**
 * How the LaunchAgent code reaches `launchctl` (Issue #1369).
 *
 * Injected rather than called directly so the load/reload behaviour can be
 * tested on any platform without touching the host's real agents.
 */
export interface LaunchctlDriver {
  /** The current user's numeric uid. */
  uid(): Promise<string>;
  /** Run `launchctl` with these arguments. */
  run(args: string[]): Promise<{ success: boolean }>;
}

/**
 * What the host's LaunchAgent actually is (Issue #1369).
 *
 * `plist-not-loaded` is the state that used to be reported as `installed`: the
 * plist sits on disk but launchd has no such service, so nothing runs the
 * worker until the next login.
 */
export type LaunchAgentStatus =
  | "installed"
  | "plist-not-loaded"
  | "not-installed";

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
 *
 * **Every** interpolated value is escaped, paths included (Issue #1220). The
 * path fields are as much configuration as the environment values are:
 * `logsDir` resolves from `log_dir` in `.config.json`, else the platform
 * default, and `scriptDir` is the checkout path. Left raw,
 * a value carrying `</string>` closed the enclosing element and could add a
 * `ProgramArguments` entry — or a `<key>Program</key>` replacing the executable
 * outright — that launchd then runs on the host at every login. Escaping also
 * keeps an honest path containing `&` from producing a plist launchd rejects.
 */
export function generatePlist(config: LaunchAgentConfig): string {
  const scriptDir = escapeXml(config.scriptDir);
  const runScriptPath = `${scriptDir}/run.sh`;
  const logsDir = escapeXml(config.logsDir ?? hostLogsDir());

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
    <string>${scriptDir}</string>
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
 * Tighten an existing plist to owner-only permissions (Issue #1220).
 *
 * The plist embeds the worker's GH_TOKEN and ANTHROPIC_API_KEY in plaintext
 * (Issue #2514), so it must never be left world-readable — and the one case
 * the tightening was written for, a plist an older worker wrote 0o644, is
 * exactly the case that re-renders to *identical* content and so took
 * {@link setupLaunchAgent}'s "already up to date" short circuit without ever
 * being chmodded. Re-running `./setup.sh` to pick up the fix silently did
 * nothing. This runs on that path too.
 *
 * @param plistPath - The plist to tighten
 */
export async function tightenPlistPermissions(
  plistPath: string,
): Promise<void> {
  await Deno.chmod(plistPath, 0o600);
}

/**
 * Write the plist to disk with owner-only permissions (mode 0o600).
 *
 * Written through {@link atomicWrite} rather than
 * `Deno.writeTextFile` + a late `chmod` (Issue #1220): that sequence
 * truncates a pre-existing 0o644 plist and fills it with the two tokens
 * *before* narrowing the mode, and both calls follow a symlink pre-positioned
 * at the path. `atomicWrite` creates its temp file `O_EXCL` at 0o600 and
 * renames it into place, so neither window exists. A failed write is loud —
 * a plist that was not written must never look like one that was.
 *
 * @param plistPath - Where the LaunchAgent plist belongs
 * @param content - The rendered plist
 * @throws When the write fails
 */
export async function writeSecurePlist(
  plistPath: string,
  content: string,
): Promise<void> {
  const result = await atomicWrite({
    targetFile: plistPath,
    content,
    mode: 0o600,
  });
  if (!result.ok) {
    throw new Error(
      `Could not write the LaunchAgent plist ${plistPath}: ` +
        result.error.message,
    );
  }
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

  // Is a plist already there, and does it already say what we would write?
  // The read is the only thing this catch is allowed to absorb: a chmod that
  // fails is a token left readable, and must not pass as "up to date".
  let existingContent: string | undefined;
  try {
    existingContent = await Deno.readTextFile(plistPath);
  } catch {
    // File doesn't exist yet — that's fine
  }

  if (existingContent === newContent) {
    // Still tighten it: an older worker's 0o644 plist re-renders to
    // identical content, so this is the very path its tokens are on.
    try {
      await tightenPlistPermissions(plistPath);
    } catch (error) {
      return {
        ok: false,
        message: `LaunchAgent plist ${plistPath} is up to date but could ` +
          `not be restricted to owner-only (${
            error instanceof Error ? error.message : String(error)
          }). It holds GH_TOKEN and ANTHROPIC_API_KEY in plaintext — fix its ` +
          `ownership, then re-run setup.`,
      };
    }
    // Identical content is not evidence that launchd still holds the job
    // (Issue #1369): an agent booted out leaves its plist behind, and this
    // branch used to report "up to date" without ever bootstrapping it, so
    // re-running setup could not recover the host.
    if (!config.skipLaunchctl) {
      const reload = await reloadIfUnloaded(plistPath);
      if (!reload.ok || reload.reloaded) {
        return { ok: reload.ok, message: reload.message };
      }
    }
    return { ok: true, message: "LaunchAgent plist already up to date" };
  }

  // Unload the existing agent before replacing its definition.
  if (existingContent !== undefined && !config.skipLaunchctl) {
    const uid = await getUid();
    await runLaunchctl(["bootout", `gui/${uid}/${LAUNCHAGENT_LABEL}`]);
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
 *
 * Presence is *not* the test for whether the worker is actually running —
 * see {@link getLaunchAgentStatus}.
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

/**
 * Does launchd hold the job — `launchctl print gui/<uid>/<label>`?
 *
 * @param launchctl - How to reach launchctl (injected in tests)
 * @returns True when launchd knows the service
 */
export async function isLaunchAgentLoaded(
  launchctl: LaunchctlDriver = systemLaunchctl,
): Promise<boolean> {
  const uid = await launchctl.uid();
  const result = await launchctl.run([
    "print",
    `gui/${uid}/${LAUNCHAGENT_LABEL}`,
  ]);
  return result.success;
}

/**
 * What the LaunchAgent really is on this host (Issue #1369).
 *
 * The old answer came from a `stat` of the plist alone, so a host whose agent
 * had been booted out — plist still on disk, launchd holding nothing — was
 * reported as `installed` and looked healthy while no worker ran. launchd is
 * the authority on whether the service exists, so it is asked.
 *
 * @param launchAgentDir - Where the plist lives (default ~/Library/LaunchAgents)
 * @param launchctl - How to reach launchctl (injected in tests)
 * @returns `installed`, `plist-not-loaded`, or `not-installed`
 */
export async function getLaunchAgentStatus(
  launchAgentDir?: string,
  launchctl: LaunchctlDriver = systemLaunchctl,
): Promise<LaunchAgentStatus> {
  if (!(await isLaunchAgentInstalled(launchAgentDir))) return "not-installed";
  return (await isLaunchAgentLoaded(launchctl))
    ? "installed"
    : "plist-not-loaded";
}

/** Outcome of {@link reloadIfUnloaded}. */
export interface ReloadResult extends LaunchAgentResult {
  /** True when launchd had forgotten the job and it was loaded again. */
  reloaded: boolean;
}

/**
 * Load a plist that launchd has forgotten (Issue #1369).
 *
 * {@link setupLaunchAgent} used to compare plist *content* and stop at
 * "already up to date", so a host whose agent had been booted out could not be
 * recovered by re-running setup — only a hand-typed `launchctl bootstrap`
 * brought it back. Identical content is no evidence that launchd still holds
 * the job, so the job itself is checked, and an unloaded one is bootstrapped.
 *
 * A plist that is present, unloaded, and cannot be loaded is a host with no
 * worker: that fails loud rather than passing as up to date.
 *
 * @param plistPath - The plist launchd should be holding
 * @param launchctl - How to reach launchctl (injected in tests)
 * @returns Whether the agent is loaded, and whether this call loaded it
 */
export async function reloadIfUnloaded(
  plistPath: string,
  launchctl: LaunchctlDriver = systemLaunchctl,
): Promise<ReloadResult> {
  if (await isLaunchAgentLoaded(launchctl)) {
    return { ok: true, reloaded: false, message: "LaunchAgent is loaded" };
  }

  const uid = await launchctl.uid();
  const bootstrapped = await launchctl.run([
    "bootstrap",
    `gui/${uid}`,
    plistPath,
  ]);
  if (!bootstrapped.success) {
    // Legacy load for older macOS.
    const loaded = await launchctl.run(["load", plistPath]);
    if (!loaded.success) {
      return {
        ok: false,
        reloaded: false,
        message:
          `The LaunchAgent plist ${plistPath} is present but launchd has no ` +
          `such service, and it could not be loaded. Nothing is running the ` +
          `worker on this host. Load it by hand with: ` +
          `launchctl bootstrap "gui/$(id -u)" "${plistPath}"`,
      };
    }
  }

  await launchctl.run(["enable", `gui/${uid}/${LAUNCHAGENT_LABEL}`]);
  return {
    ok: true,
    reloaded: true,
    message:
      `LaunchAgent plist was up to date but launchd had no such service — ` +
      `reloaded it: ${plistPath}`,
  };
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

/** The real launchctl on this host. */
const systemLaunchctl: LaunchctlDriver = {
  uid: getUid,
  run: runLaunchctl,
};

/** Get the LaunchAgent label (for use in status messages). */
export function getLaunchAgentLabel(): string {
  return LAUNCHAGENT_LABEL;
}
