/**
 * log-dir command (Issue #873).
 *
 * Prints the host log directory so `run.sh`, `loop.sh` and `run.ps1` never
 * spell the resolution themselves — mirroring how they already delegate to
 * `run-mode` and `container-launch-plan`. Issue #872 unified the overrides and
 * left three copies of the *default* behind, in bash, PowerShell and
 * TypeScript; Issue #873 moved that default onto the platform's own standard
 * location, which only stays one default if there is only one copy of it.
 *
 * Usage:
 *   deno run --allow-env --allow-read mod.ts log-dir [--config .config.json]
 *
 * The `.config.json` `log_dir` key is the only way to move the directory
 * (Issues #873, #1388): on the host, `.config.json` is the only configuration,
 * and the `LAUNCH_LOG_DIR` / `LOG_DIR` variables that used to sit between the
 * key and the default are ignored — loudly, by name, on stderr, so a host that
 * still exports one learns which key replaces it. The key is read from the
 * file here rather than through the loaded `WorkerConfig`: `mod.ts` falls back
 * to the default configuration for a config-optional command, which would turn
 * a broken config file into a silent platform default — the same reason
 * `run-mode` re-reads the file.
 *
 * Stdout carries exactly the directory and nothing else, so a launcher can
 * capture it with `dir=$(… mod.ts log-dir)`. The legacy-location notice and
 * the ignored-variable notice go to **stderr**, where they reach the operator
 * without being captured as part of the path — and the command returns **no**
 * `data`, because `mod.ts`
 * appends a result's `data` to stdout as JSON under `OUTPUT_JSON=true`
 * (mod.ts `outputResult`). A launcher capturing this path would then read `}`
 * on a host that exports that variable, which is precisely the silently-wrong
 * path this command exists to prevent.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { type EnvLookup, processEnvLookup } from "../lib/env_lookup.ts";
import { pathStyleFor } from "../lib/host_path_style.ts";
import { resolveHostConfigPath } from "../lib/host_config_path.ts";
import {
  hostLogDirPlatform,
  ignoredLogDirEnvNotice,
  legacyLogDirNotice,
  type LogDirPlatform,
  readConfiguredLogDir,
  resolveLogDir,
} from "../lib/log_dir.ts";

/** What the command reports alongside the printed directory. */
export interface LogDirResult {
  /** The resolved directory, the same string printed on stdout. */
  logDir: string;
  /** The legacy-default notice, when this host has one to hear. */
  notice?: string;
  /**
   * The line naming a `LAUNCH_LOG_DIR` / `LOG_DIR` still exported on this
   * host, which is ignored (Issue #1388); absent when neither is set.
   */
  ignoredEnvironment?: string;
  /** The configuration file consulted, whether or not it existed. */
  configFile: string;
}

/** Everything the command reads, injected so the tests need no real host. */
export interface ResolveLogDirForCommandOptions {
  /** Environment reader. Defaults to the process environment. */
  env?: EnvLookup;
  /** Whose convention the default follows. Defaults to this host's. */
  platform?: LogDirPlatform;
  /** Whether a directory is present. Defaults to a real filesystem probe. */
  exists?: (path: string) => boolean;
  /**
   * The configuration file to read `log_dir` from. Defaults to the host's
   * own, resolved from `CONFIG_FILE`/`CONFIG_PATH` exactly as `mod.ts` does.
   */
  configFile?: string;
}

/** True when the path is a directory on this host. */
function directoryExists(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    // Absent, or unreadable — either way there is nothing to report about it.
    return false;
  }
}

/**
 * Resolve the directory and the notice together.
 *
 * @param options - Injected environment, platform and presence probe
 * @returns The resolved directory, and the notice when one is due
 * @throws When neither HOME nor USERPROFILE is set — a launcher must not be
 *   handed a path relative to nothing (Issue #3234)
 */
export async function resolveLogDirForCommand(
  options: ResolveLogDirForCommandOptions = {},
): Promise<LogDirResult> {
  const env = options.env ?? processEnvLookup;
  const platform = options.platform ?? hostLogDirPlatform();
  const exists = options.exists ?? directoryExists;
  // Both launchers cd into the checkout before invoking this, so the
  // configuration file resolves exactly as it does for every other command.
  const configFile = options.configFile ??
    resolveHostConfigPath({ baseDir: Deno.cwd(), env });
  const configured = await readConfiguredLogDir(configFile);

  const home = (env("HOME") ?? env("USERPROFILE") ?? "").trim();
  if (home === "") {
    throw new Error(
      "Cannot resolve the log directory: neither HOME nor USERPROFILE is set.",
    );
  }
  const style = pathStyleFor(home);
  const logDir = resolveLogDir(home, env, style, platform, configured);
  const notice = legacyLogDirNotice({
    home,
    env,
    style,
    platform,
    exists,
    configured,
  });
  const ignoredEnvironment = ignoredLogDirEnvNotice(env);
  const result: LogDirResult = { logDir, configFile };
  if (notice !== undefined) result.notice = notice;
  if (ignoredEnvironment !== undefined) {
    result.ignoredEnvironment = ignoredEnvironment;
  }
  return result;
}

export const logDirCommand: Command = {
  name: "log-dir",
  description:
    'Print the host log directory — the .config.json "log_dir" key, else ' +
    "the platform default; LAUNCH_LOG_DIR and LOG_DIR are ignored " +
    "(Issues #872, #873, #1388)",
  /**
   * @param args - `--config` names the configuration file to read `log_dir`
   *   from; omitted, the host's own is used.
   * @param _config - Unused: the file is re-read here so a broken one cannot
   *   be masked by `mod.ts` falling back to the default configuration, and
   *   launchers call this before any configuration is guaranteed to exist.
   * @returns The resolved directory, printed verbatim on stdout.
   */
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const resolved = await resolveLogDirForCommand(
      typeof args["config"] === "string"
        ? { configFile: args["config"] as string }
        : {},
    );
    // Both notices belong on stderr: stdout is the captured path.
    if (resolved.ignoredEnvironment) console.error(resolved.ignoredEnvironment);
    if (resolved.notice) console.error(resolved.notice);
    // No `data`: see the module comment — it would be appended to stdout as
    // JSON under OUTPUT_JSON=true and captured as part of the path.
    return {
      success: true,
      message: resolved.logDir,
    };
  },
};
