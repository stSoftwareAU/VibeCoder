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
 * ## The operator pins it in `.config.json`, not in the environment
 *
 * Host-side operator configuration lives in `.config.json`, so the directory
 * is pinned there with {@link LOG_DIR_CONFIG_KEY} — `log_dir` — and the
 * precedence the whole fleet shares is **`log_dir`, then `LAUNCH_LOG_DIR`,
 * then `LOG_DIR`, then the platform default**. The two variables stay: a
 * launchd or systemd unit naming `/var/log/vibe-coder` sets an environment,
 * not a config file. They are simply no longer the only way to say it.
 *
 * The value takes the same shape as every other path-valued key
 * (`ssh_key_path`, `gh_config_dir`): an absolute path, or one anchored at
 * `~`. A relative value is refused rather than resolved against whichever
 * directory the caller happened to be in — that is precisely how logs end up
 * in two places.
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

/**
 * The `.config.json` key that pins the directory, outranking both variables.
 *
 * Read from the file rather than from a loaded `WorkerConfig`: `mod.ts` falls
 * back to the default configuration for a config-optional command, which would
 * turn a broken config file into a silent platform default — and the launchers
 * call `log-dir` before any configuration is guaranteed to exist. This is the
 * same reason `run_mode` is re-read in `commands/run_mode.ts` (Issue #3234).
 */
export const LOG_DIR_CONFIG_KEY = "log_dir";

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
 * `log_dir`, then `LAUNCH_LOG_DIR`, then `LOG_DIR`, then the platform default
 * — the precedence `loop.sh`, `run.sh` and the container mount all share
 * (Issues #872, #873). A blank value is treated as unset at every level: an
 * exported-but-empty variable meant the empty string here, which would have
 * mounted the wrong host path, and a blank config key means the same nothing.
 *
 * @param home - The host's home directory
 * @param env - Environment reader (injectable for tests)
 * @param style - How this host spells its paths
 * @param platform - Whose convention the default follows; defaults to this host's
 * @param configured - The `.config.json` `log_dir` value, when the deployment
 *   states one. Read with {@link readConfiguredLogDir}.
 * @returns The resolved directory
 * @throws When `configured` is a relative path — see
 *   {@link normaliseConfiguredLogDir}
 */
export function resolveLogDir(
  home: string,
  env: EnvLookup,
  style: LauncherPathStyle,
  platform: LogDirPlatform = hostLogDirPlatform(),
  configured?: string,
): string {
  const pinned = normaliseConfiguredLogDir(configured, home, style);
  if (pinned !== undefined) return pinned;
  const override = resolveLogDirOverride(env, style);
  return override ?? defaultLogDir(home, env, style, platform);
}

/**
 * The deployment's pinned directory, expanded and checked.
 *
 * Follows the shape of every other path-valued key: a leading `~` is expanded
 * against the host's home, exactly as `applyServiceAccountEnv` expands
 * `ssh_key_path` and `gh_config_dir`. A blank value means the key was not
 * stated. Anything else must be absolute — a relative log directory resolves
 * against whichever directory the caller happened to be started in, so
 * `loop.sh`, `run.sh` and the container mount would each get a different
 * answer, which is the split this key exists to prevent.
 *
 * @param value - The raw `.config.json` value, if any
 * @param home - The host's home directory, for a `~`-anchored value
 * @param style - How this host spells its paths
 * @returns The resolved directory, or undefined when nothing was stated
 * @throws When a stated value is neither absolute nor `~`-anchored
 */
export function normaliseConfiguredLogDir(
  value: string | undefined,
  home: string,
  style: LauncherPathStyle,
): string | undefined {
  const stated = (value ?? "").trim();
  if (stated === "") return undefined;

  const base = normalisePath(home, style);
  if (stated === "~") return base;
  if (stated.startsWith("~/") || stated.startsWith("~\\")) {
    return joinPath(base, normalisePath(stated.slice(2), style), style);
  }
  if (!isAbsolutePath(stated, style)) {
    throw new Error(
      `.config.json "${LOG_DIR_CONFIG_KEY}" must be an absolute path or ` +
        `start with "~/", but names ${JSON.stringify(stated)}. A relative ` +
        `directory resolves differently for each launcher, which splits the ` +
        `logs across directories (Issue #873).`,
    );
  }
  return normalisePath(stated, style);
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
  /** The `.config.json` `log_dir` value, when the deployment states one. */
  configured?: string;
}

/**
 * Tell the operator once that the default moved — and move nothing.
 *
 * Silent on every host that has nothing to say: one that states `log_dir`, set
 * `LOG_DIR` or set `LAUNCH_LOG_DIR` (the location is theirs, not a default),
 * one that never had `$HOME/logs`, and one whose new directory already exists
 * — which is every host from its second launch onwards, because the launcher
 * creates it.
 *
 * @param input - Home, environment, path style, the pinned directory and a
 *   presence probe
 * @returns The line to print, or undefined when there is nothing to report
 */
export function legacyLogDirNotice(
  input: LegacyLogDirNoticeInput,
): string | undefined {
  const { home, env, style, exists } = input;
  const platform = input.platform ?? hostLogDirPlatform();
  if (normaliseConfiguredLogDir(input.configured, home, style) !== undefined) {
    return undefined;
  }
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
    `old location, state "${LOG_DIR_CONFIG_KEY}": ${JSON.stringify(legacy)} ` +
    `in .config.json.`;
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

/**
 * Pull `log_dir` out of a configuration file's text.
 *
 * Shared by the async and sync readers so the two cannot disagree about what
 * counts as stated, or about which faults are loud.
 *
 * @param text - The file's contents
 * @param configFile - Path, for the error messages
 * @returns The raw value, or undefined when the key is not stated
 * @throws When the file is not a JSON object, or the key is not a string
 */
function parseConfiguredLogDir(
  text: string,
  configFile: string,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot resolve the log directory: ${configFile} is not readable JSON ` +
        `(${(error as Error).message}). Fix it, or re-run ./setup.sh.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Cannot resolve the log directory: ${configFile} does not hold a JSON ` +
        `object.`,
    );
  }
  const value = (parsed as Record<string, unknown>)[LOG_DIR_CONFIG_KEY];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(
      `Cannot resolve the log directory: ${configFile} key ` +
        `"${LOG_DIR_CONFIG_KEY}" must be a string.`,
    );
  }
  return value;
}

/**
 * Read the deployment's pinned log directory out of its configuration file.
 *
 * A missing file is a legitimate "nothing stated" — a launcher may run before
 * `./setup.sh` has written one. Every other fault is loud: a launcher must not
 * fall back to the platform default because the file it was pointed at is
 * broken, or the logs move without anyone being told (Issue #3234's rule,
 * applied to this key).
 *
 * @param configFile - Host path of the worker configuration file
 * @returns The raw value, or undefined when nothing is stated
 * @throws When the file exists but is unreadable, is not JSON, does not hold
 *   an object, or sets the key to a non-string
 */
export async function readConfiguredLogDir(
  configFile: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new Error(
      `Cannot resolve the log directory: ${configFile} is unreadable ` +
        `(${(error as Error).message}).`,
    );
  }
  return parseConfiguredLogDir(text, configFile);
}

/**
 * {@link readConfiguredLogDir} for the callers that cannot await — setup, and
 * the launcher helpers that resolve their directory in a plain function.
 *
 * @param configFile - Host path of the worker configuration file
 * @returns The raw value, or undefined when nothing is stated
 * @throws As {@link readConfiguredLogDir} does
 */
export function readConfiguredLogDirSync(
  configFile: string,
): string | undefined {
  let text: string;
  try {
    text = Deno.readTextFileSync(configFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new Error(
      `Cannot resolve the log directory: ${configFile} is unreadable ` +
        `(${(error as Error).message}).`,
    );
  }
  return parseConfiguredLogDir(text, configFile);
}
