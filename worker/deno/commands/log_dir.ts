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
 *   deno run --allow-env --allow-read mod.ts log-dir
 *
 * Stdout carries exactly the directory and nothing else, so a launcher can
 * capture it with `LOG_DIR=$(… mod.ts log-dir)`. The legacy-location notice
 * goes to **stderr**, where it reaches the operator without being captured as
 * part of the path — and the command returns **no** `data`, because `mod.ts`
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
import {
  hostLogDirPlatform,
  legacyLogDirNotice,
  type LogDirPlatform,
  resolveLogDir,
} from "../lib/log_dir.ts";

/** What the command reports alongside the printed directory. */
export interface LogDirResult {
  /** The resolved directory, the same string printed on stdout. */
  logDir: string;
  /** The legacy-default notice, when this host has one to hear. */
  notice?: string;
}

/** Everything the command reads, injected so the tests need no real host. */
export interface ResolveLogDirForCommandOptions {
  /** Environment reader. Defaults to the process environment. */
  env?: EnvLookup;
  /** Whose convention the default follows. Defaults to this host's. */
  platform?: LogDirPlatform;
  /** Whether a directory is present. Defaults to a real filesystem probe. */
  exists?: (path: string) => boolean;
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
export function resolveLogDirForCommand(
  options: ResolveLogDirForCommandOptions = {},
): LogDirResult {
  const env = options.env ?? processEnvLookup;
  const platform = options.platform ?? hostLogDirPlatform();
  const exists = options.exists ?? directoryExists;

  const home = (env("HOME") ?? env("USERPROFILE") ?? "").trim();
  if (home === "") {
    throw new Error(
      "Cannot resolve the log directory: neither HOME nor USERPROFILE is set.",
    );
  }
  const style = pathStyleFor(home);
  const logDir = resolveLogDir(home, env, style, platform);
  const notice = legacyLogDirNotice({ home, env, style, platform, exists });
  return notice === undefined ? { logDir } : { logDir, notice };
}

export const logDirCommand: Command = {
  name: "log-dir",
  description:
    "Print the host log directory — the platform default unless LOG_DIR " +
    "or LAUNCH_LOG_DIR names one (Issues #872, #873)",
  /**
   * @param _args - Unused; the resolution takes no arguments.
   * @param _config - Unused: launchers call this before any configuration is
   *   guaranteed to exist.
   * @returns The resolved directory, printed verbatim on stdout.
   */
  async execute(
    _args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const resolved = resolveLogDirForCommand();
    // The notice belongs on stderr: stdout is the captured path.
    if (resolved.notice) console.error(resolved.notice);
    // No `data`: see the module comment — it would be appended to stdout as
    // JSON under OUTPUT_JSON=true and captured as part of the path.
    return {
      success: true,
      message: resolved.logDir,
    };
  },
};
