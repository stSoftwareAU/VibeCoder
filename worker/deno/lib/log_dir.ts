/**
 * Where the fleet's logs live (Issues #872, #873).
 *
 * One resolution, shared by the launcher, `run.sh`, `loop.sh`, `run.ps1` and
 * the container mount. Issue #872 unified the *overrides* — `LAUNCH_LOG_DIR`,
 * then `LOG_DIR` — after setting one moved `launch-*.log` and left
 * `run_core.log` and every `worker-*.log` behind. This module is where the
 * **default** those overrides fall back to is decided, so there is one place
 * to change and nothing left to drift.
 *
 * ## The default is the platform's, not `$HOME/logs` (Issue #873)
 *
 * | Platform | Default                                                        |
 * | -------- | -------------------------------------------------------------- |
 * | Linux    | `$XDG_STATE_HOME/vibe-coder`, else `~/.local/state/vibe-coder`  |
 * | macOS    | `~/Library/Logs/vibe-coder`                                     |
 * | Windows  | `%LOCALAPPDATA%\vibe-coder\logs`                                |
 *
 * Logs are **state**, not cache and not configuration: the XDG Base Directory
 * Specification names state as the home for "logs [and] history", which is why
 * the Linux default is the state directory rather than `$XDG_DATA_HOME`. macOS
 * nominates `~/Library/Logs` for a user-scoped agent and Console.app reads it.
 * A host running the worker as a system service names `/var/log/vibe-coder`
 * through `LOG_DIR` — a daemon's directory is a deployment decision, not
 * something to infer from the process.
 *
 * The old default, `$HOME/logs`, followed no convention and put fleet state in
 * the operator's home directory beside their own files. Nothing migrates it:
 * {@link legacyLogDirNotice} names the old directory once and leaves it exactly
 * where it is.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { EnvLookup } from "./env_lookup.ts";
import {
  isAbsolutePath,
  joinPath,
  type LauncherPathStyle,
  normalisePath,
} from "./host_path_style.ts";

/** The host platforms whose log conventions differ. */
export type LogDirPlatform = "linux" | "darwin" | "windows";

/**
 * The overrides, in the precedence `loop.sh:56` has always used.
 *
 * Each is checked for a non-blank value independently, matching bash's
 * `${LAUNCH_LOG_DIR:-${LOG_DIR:-…}}`: `:-` treats an empty value as unset, so
 * a blank `LAUNCH_LOG_DIR` falls through to `LOG_DIR` rather than skipping
 * straight to the default. A `??` chain would not.
 */
export const LOG_DIR_ENV_NAMES = ["LAUNCH_LOG_DIR", "LOG_DIR"] as const;

/** The directory the fleet's logs live in, under each platform's own root. */
export const LOG_DIR_APP_NAME = "vibe-coder";

/** The default before Issue #873, still on every host that has ever run. */
export const LEGACY_LOG_DIR_NAME = "logs";

/**
 * Which platform's convention applies.
 *
 * @param os - A platform name, typically `Deno.build.os`
 * @returns The convention to follow; anything unrecognised is treated as a
 *   generic POSIX host, which is what XDG describes
 */
export function normaliseLogDirPlatform(os: string): LogDirPlatform {
  const name = os.trim().toLowerCase();
  if (name === "darwin") return "darwin";
  if (name === "windows") return "windows";
  return "linux";
}

/** The convention this host follows. */
export function hostLogDirPlatform(): LogDirPlatform {
  return normaliseLogDirPlatform(Deno.build.os);
}

/**
 * The location the default moved away from (Issue #873).
 *
 * @param home - The host's home directory
 * @param style - How this host spells its paths
 * @returns `$HOME/logs`, the pre-1.4.0 default
 */
export function legacyLogDir(
  home: string,
  style: LauncherPathStyle,
): string {
  return joinPath(normalisePath(home, style), LEGACY_LOG_DIR_NAME, style);
}

/**
 * The platform-standard log directory, before any override is applied.
 *
 * @param home - The host's home directory
 * @param env - Environment reader (injectable for tests)
 * @param style - How this host spells its paths
 * @param platform - Whose convention to follow; defaults to this host's
 * @returns The default directory for this platform
 */
export function defaultLogDir(
  home: string,
  env: EnvLookup,
  style: LauncherPathStyle,
  platform: LogDirPlatform = hostLogDirPlatform(),
): string {
  const base = normalisePath(home, style);
  if (platform === "darwin") {
    return joinPath(base, `Library/Logs/${LOG_DIR_APP_NAME}`, style);
  }
  if (platform === "windows") {
    // A user-scoped agent's logs belong under LOCALAPPDATA, which is where
    // Windows keeps machine-local, non-roaming per-user state.
    const localAppData = readEnvPath(env, "LOCALAPPDATA", style);
    const root = localAppData ?? joinPath(base, "AppData/Local", style);
    return joinPath(root, `${LOG_DIR_APP_NAME}/logs`, style);
  }
  // XDG: logs are state. A relative value "must be ignored" per the
  // specification, and a blank one means unset — in both cases the default
  // `$HOME/.local/state` applies rather than a path relative to nothing.
  const stateHome = readEnvPath(env, "XDG_STATE_HOME", style);
  const root = stateHome ?? joinPath(base, ".local/state", style);
  return joinPath(root, LOG_DIR_APP_NAME, style);
}

/**
 * The host directory logs are written to.
 *
 * `LAUNCH_LOG_DIR`, then `LOG_DIR`, then the platform default — the precedence
 * `loop.sh`, `run.sh` and the container mount all share (Issue #872). A blank
 * value is treated as unset: an exported-but-empty variable meant the empty
 * string here, which would have mounted the wrong host path.
 *
 * @param home - The host's home directory
 * @param env - Environment reader (injectable for tests)
 * @param style - How this host spells its paths
 * @param platform - Whose convention the default follows; defaults to this host's
 * @returns The resolved directory
 */
export function resolveLogDir(
  home: string,
  env: EnvLookup,
  style: LauncherPathStyle,
  platform: LogDirPlatform = hostLogDirPlatform(),
): string {
  const override = resolveLogDirOverride(env, style);
  return override ?? defaultLogDir(home, env, style, platform);
}

/**
 * The operator's explicit choice, if they made one.
 *
 * @param env - Environment reader
 * @param style - How this host spells its paths
 * @returns The override, or undefined when neither variable names one
 */
export function resolveLogDirOverride(
  env: EnvLookup,
  style: LauncherPathStyle,
): string | undefined {
  for (const name of LOG_DIR_ENV_NAMES) {
    const value = readEnvPath(env, name, style, { requireAbsolute: false });
    if (value !== undefined) return value;
  }
  return undefined;
}

/** What {@link legacyLogDirNotice} needs to decide whether to speak. */
export interface LegacyLogDirNoticeInput {
  /** The host's home directory. */
  home: string;
  /** Environment reader. */
  env: EnvLookup;
  /** How this host spells its paths. */
  style: LauncherPathStyle;
  /** Whose convention the default follows. */
  platform?: LogDirPlatform;
  /** Whether a directory is present on this host. */
  exists: (path: string) => boolean;
}

/**
 * Tell the operator once that the default moved — and move nothing.
 *
 * Silent on every host that has nothing to say: one that set `LOG_DIR` or
 * `LAUNCH_LOG_DIR` (the location is theirs, not a default), one that never had
 * `$HOME/logs`, and one whose new directory already exists — which is every
 * host from its second launch onwards, because the launcher creates it.
 *
 * @param input - Home, environment, path style and a presence probe
 * @returns The line to print, or undefined when there is nothing to report
 */
export function legacyLogDirNotice(
  input: LegacyLogDirNoticeInput,
): string | undefined {
  const { home, env, style, exists } = input;
  const platform = input.platform ?? hostLogDirPlatform();
  if (resolveLogDirOverride(env, style) !== undefined) return undefined;

  const legacy = legacyLogDir(home, style);
  const resolved = defaultLogDir(home, env, style, platform);
  if (resolved === legacy) return undefined;
  if (!exists(legacy)) return undefined;
  if (exists(resolved)) return undefined;

  // The destination does not exist — that is the condition this notice fires
  // on — so the move has to create it, or the command as printed fails.
  const move = style === "windows"
    ? `mkdir "${resolved}" && move "${legacy}\\*" "${resolved}"`
    : `mkdir -p ${resolved} && mv ${legacy}/* ${resolved}/`;
  return `[log-dir] Logs now default to ${resolved} (Issue #873). ` +
    `The previous default ${legacy} was left untouched — nothing has been ` +
    `moved or deleted. To bring its history across: ${move}. To keep the ` +
    `old location, set LOG_DIR=${legacy}.`;
}

/**
 * Read a path-valued variable, rejecting the values that are not paths.
 *
 * @param env - Environment reader
 * @param name - Variable to read
 * @param style - How this host spells its paths
 * @param options - `requireAbsolute` (default true) drops relative values, as
 *   the XDG specification requires for its base directories
 * @returns The normalised value, or undefined when it is unusable
 */
function readEnvPath(
  env: EnvLookup,
  name: string,
  style: LauncherPathStyle,
  options: { requireAbsolute?: boolean } = {},
): string | undefined {
  const value = (env(name) ?? "").trim();
  if (value === "") return undefined;
  if ((options.requireAbsolute ?? true) && !isAbsolutePath(value, style)) {
    return undefined;
  }
  return normalisePath(value, style);
}
