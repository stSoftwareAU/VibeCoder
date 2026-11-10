/**
 * Where the fleet's logs live (Issues #872, #873).
 *
 * One resolution, shared by the launcher, `run.sh`, `loop.sh`, `run.ps1` and
 * the container mount. Issue #872 unified what used to be two environment
 * overrides after setting one moved `launch-*.log` and left `run_core.log`
 * and every `worker-*.log` behind. This module is where the **default** is
 * decided, so there is one place to change and nothing left to drift.
 *
 * ## The operator pins it in `.config.json`, and nowhere else
 *
 * On the host, `.config.json` is the only configuration (Issue #1388). The
 * directory is pinned there with {@link LOG_DIR_CONFIG_KEY} — `log_dir` — and
 * the precedence the whole fleet shares is **`log_dir`, then the platform
 * default**. The environment variables that used to sit between the two,
 * `LAUNCH_LOG_DIR` and `LOG_DIR`, are **ignored**: a value exported in a
 * shell profile, a crontab line or a unit file is invisible to the next
 * reader and differs per launcher, which is exactly how one host on a fleet
 * comes to behave unlike the rest. A host that still exports one is told so,
 * once per launch and by name, through {@link ignoredLogDirEnvNotice}; a
 * system service that wants `/var/log/vibe-coder` states it in the file.
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
 * A host running the worker as a system service states `/var/log/vibe-coder`
 * as `log_dir` — a daemon's directory is a deployment decision, not something
 * to infer from the process.
 *
 * The old default, `$HOME/logs`, followed no convention and put fleet state in
 * the operator's home directory beside their own files. Nothing migrates it:
 * {@link legacyLogDirNotice} names the old directory once and leaves it exactly
 * where it is.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */ import { isAbsolutePath, joinPath, normalisePath } from "./host_path_style.ts";
/**
 * The environment variables that used to move the directory (Issues #872,
 * #873) and no longer do (Issue #1388). Kept as names only, so the launcher
 * can tell an operator who still exports one that it is being ignored and
 * which key replaces it — silence is how a fleet drifts.
 */ export const IGNORED_LOG_DIR_ENV_NAMES = [
  "LAUNCH_LOG_DIR",
  "LOG_DIR"
];
/**
 * The `.config.json` key that pins the directory — the only way to move it.
 *
 * Read from the file rather than from a loaded `WorkerConfig`: `mod.ts` falls
 * back to the default configuration for a config-optional command, which would
 * turn a broken config file into a silent platform default — and the launchers
 * call `log-dir` before any configuration is guaranteed to exist. This is the
 * same reason `run_mode` is re-read in `commands/run_mode.ts` (Issue #3234).
 */ export const LOG_DIR_CONFIG_KEY = "log_dir";
/** The directory the fleet's logs live in, under each platform's own root. */ export const LOG_DIR_APP_NAME = "vibe-coder";
/** The default before Issue #873, still on every host that has ever run. */ export const LEGACY_LOG_DIR_NAME = "logs";
/**
 * Which platform's convention applies.
 *
 * @param os - A platform name, typically `Deno.build.os`
 * @returns The convention to follow; anything unrecognised is treated as a
 *   generic POSIX host, which is what XDG describes
 */ export function normaliseLogDirPlatform(os) {
  const name = os.trim().toLowerCase();
  if (name === "darwin") return "darwin";
  if (name === "windows") return "windows";
  return "linux";
}
/** The convention this host follows. */ export function hostLogDirPlatform() {
  return normaliseLogDirPlatform(Deno.build.os);
}
/**
 * The location the default moved away from (Issue #873).
 *
 * @param home - The host's home directory
 * @param style - How this host spells its paths
 * @returns `$HOME/logs`, the pre-1.4.0 default
 */ export function legacyLogDir(home, style) {
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
 */ export function defaultLogDir(home, env, style, platform = hostLogDirPlatform()) {
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
 * `log_dir`, then the platform default — the precedence `loop.sh`, `run.sh`
 * and the container mount all share (Issues #872, #873, #1388). A blank config
 * value is treated as unset, exactly as an absent key is. The environment is
 * consulted only for the platform's own base directories (`XDG_STATE_HOME`,
 * `LOCALAPPDATA`); `LAUNCH_LOG_DIR` and `LOG_DIR` are ignored.
 *
 * @param home - The host's home directory
 * @param env - Environment reader (injectable for tests); platform base
 *   directories only, never an operator override
 * @param style - How this host spells its paths
 * @param platform - Whose convention the default follows; defaults to this host's
 * @param configured - The `.config.json` `log_dir` value, when the deployment
 *   states one. Read with {@link readConfiguredLogDir}.
 * @returns The resolved directory
 * @throws When `configured` is a relative path — see
 *   {@link normaliseConfiguredLogDir}
 */ export function resolveLogDir(home, env, style, platform = hostLogDirPlatform(), configured) {
  const pinned = normaliseConfiguredLogDir(configured, home, style);
  if (pinned !== undefined) return pinned;
  return defaultLogDir(home, env, style, platform);
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
 */ export function normaliseConfiguredLogDir(value, home, style) {
  const stated = (value ?? "").trim();
  if (stated === "") return undefined;
  const base = normalisePath(home, style);
  if (stated === "~") return base;
  if (stated.startsWith("~/") || stated.startsWith("~\\")) {
    return joinPath(base, normalisePath(stated.slice(2), style), style);
  }
  if (!isAbsolutePath(stated, style)) {
    throw new Error(`.config.json "${LOG_DIR_CONFIG_KEY}" must be an absolute path or ` + `start with "~/", but names ${JSON.stringify(stated)}. A relative ` + `directory resolves differently for each launcher, which splits the ` + `logs across directories (Issue #873).`);
  }
  return normalisePath(stated, style);
}
/**
 * Tell an operator who still exports `LAUNCH_LOG_DIR` or `LOG_DIR` that the
 * variable no longer does anything, and what to write instead (Issue #1388).
 *
 * One line naming every set variable, or nothing when none is set. The value
 * is quoted back so the operator can move it into `.config.json` verbatim; a
 * blank export is not worth a line, because it never moved anything either.
 *
 * @param env - Environment reader
 * @returns The line to print on stderr, or undefined when there is nothing to say
 */ export function ignoredLogDirEnvNotice(env) {
  const set = [];
  let example;
  for (const name of IGNORED_LOG_DIR_ENV_NAMES){
    const value = (env(name) ?? "").trim();
    if (value === "") continue;
    set.push(`${name}=${JSON.stringify(value)}`);
    example ??= value;
  }
  if (set.length === 0 || example === undefined) return undefined;
  return `[log-dir] ${set.join(" and ")} ${set.length === 1 ? "is" : "are"} set but ignored (Issue #1388): on the host only .config.json configures ` + `the worker. To keep that directory, state "${LOG_DIR_CONFIG_KEY}": ${JSON.stringify(example)} in .config.json and unset the variable.`;
}
/**
 * Tell the operator once that the default moved — and move nothing.
 *
 * Silent on every host that has nothing to say: one that states `log_dir`
 * (the location is theirs, not a default), one that never had `$HOME/logs`,
 * and one whose new directory already exists — which is every host from its
 * second launch onwards, because the launcher creates it. An exported
 * `LOG_DIR` no longer silences it (Issue #1388): the variable is ignored, so
 * the default really does apply, and the notice is how the operator learns
 * that `log_dir` is now the way to keep the old location.
 *
 * @param input - Home, environment, path style, the pinned directory and a
 *   presence probe
 * @returns The line to print, or undefined when there is nothing to report
 */ export function legacyLogDirNotice(input) {
  const { home, env, style, exists } = input;
  const platform = input.platform ?? hostLogDirPlatform();
  if (normaliseConfiguredLogDir(input.configured, home, style) !== undefined) {
    return undefined;
  }
  const legacy = legacyLogDir(home, style);
  const resolved = defaultLogDir(home, env, style, platform);
  if (resolved === legacy) return undefined;
  if (!exists(legacy)) return undefined;
  if (exists(resolved)) return undefined;
  // The destination does not exist — that is the condition this notice fires
  // on — so the move has to create it, or the command as printed fails.
  const move = style === "windows" ? `mkdir "${resolved}" && move "${legacy}\\*" "${resolved}"` : `mkdir -p ${resolved} && mv ${legacy}/* ${resolved}/`;
  return `[log-dir] Logs now default to ${resolved} (Issue #873). ` + `The previous default ${legacy} was left untouched — nothing has been ` + `moved or deleted. To bring its history across: ${move}. To keep the ` + `old location, state "${LOG_DIR_CONFIG_KEY}": ${JSON.stringify(legacy)} ` + `in .config.json.`;
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
 */ function readEnvPath(env, name, style, options = {}) {
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
 */ function parseConfiguredLogDir(text, configFile) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot resolve the log directory: ${configFile} is not readable JSON ` + `(${error.message}). Fix it, or re-run ./setup.sh.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Cannot resolve the log directory: ${configFile} does not hold a JSON ` + `object.`);
  }
  const value = parsed[LOG_DIR_CONFIG_KEY];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Cannot resolve the log directory: ${configFile} key ` + `"${LOG_DIR_CONFIG_KEY}" must be a string.`);
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
 */ export async function readConfiguredLogDir(configFile) {
  let text;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new Error(`Cannot resolve the log directory: ${configFile} is unreadable ` + `(${error.message}).`);
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
 */ export function readConfiguredLogDirSync(configFile) {
  let text;
  try {
    text = Deno.readTextFileSync(configFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new Error(`Cannot resolve the log directory: ${configFile} is unreadable ` + `(${error.message}).`);
  }
  return parseConfiguredLogDir(text, configFile);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9sb2dfZGlyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogV2hlcmUgdGhlIGZsZWV0J3MgbG9ncyBsaXZlIChJc3N1ZXMgIzg3MiwgIzg3MykuXG4gKlxuICogT25lIHJlc29sdXRpb24sIHNoYXJlZCBieSB0aGUgbGF1bmNoZXIsIGBydW4uc2hgLCBgbG9vcC5zaGAsIGBydW4ucHMxYCBhbmRcbiAqIHRoZSBjb250YWluZXIgbW91bnQuIElzc3VlICM4NzIgdW5pZmllZCB3aGF0IHVzZWQgdG8gYmUgdHdvIGVudmlyb25tZW50XG4gKiBvdmVycmlkZXMgYWZ0ZXIgc2V0dGluZyBvbmUgbW92ZWQgYGxhdW5jaC0qLmxvZ2AgYW5kIGxlZnQgYHJ1bl9jb3JlLmxvZ2BcbiAqIGFuZCBldmVyeSBgd29ya2VyLSoubG9nYCBiZWhpbmQuIFRoaXMgbW9kdWxlIGlzIHdoZXJlIHRoZSAqKmRlZmF1bHQqKiBpc1xuICogZGVjaWRlZCwgc28gdGhlcmUgaXMgb25lIHBsYWNlIHRvIGNoYW5nZSBhbmQgbm90aGluZyBsZWZ0IHRvIGRyaWZ0LlxuICpcbiAqICMjIFRoZSBvcGVyYXRvciBwaW5zIGl0IGluIGAuY29uZmlnLmpzb25gLCBhbmQgbm93aGVyZSBlbHNlXG4gKlxuICogT24gdGhlIGhvc3QsIGAuY29uZmlnLmpzb25gIGlzIHRoZSBvbmx5IGNvbmZpZ3VyYXRpb24gKElzc3VlICMxMzg4KS4gVGhlXG4gKiBkaXJlY3RvcnkgaXMgcGlubmVkIHRoZXJlIHdpdGgge0BsaW5rIExPR19ESVJfQ09ORklHX0tFWX0g4oCUIGBsb2dfZGlyYCDigJQgYW5kXG4gKiB0aGUgcHJlY2VkZW5jZSB0aGUgd2hvbGUgZmxlZXQgc2hhcmVzIGlzICoqYGxvZ19kaXJgLCB0aGVuIHRoZSBwbGF0Zm9ybVxuICogZGVmYXVsdCoqLiBUaGUgZW52aXJvbm1lbnQgdmFyaWFibGVzIHRoYXQgdXNlZCB0byBzaXQgYmV0d2VlbiB0aGUgdHdvLFxuICogYExBVU5DSF9MT0dfRElSYCBhbmQgYExPR19ESVJgLCBhcmUgKippZ25vcmVkKio6IGEgdmFsdWUgZXhwb3J0ZWQgaW4gYVxuICogc2hlbGwgcHJvZmlsZSwgYSBjcm9udGFiIGxpbmUgb3IgYSB1bml0IGZpbGUgaXMgaW52aXNpYmxlIHRvIHRoZSBuZXh0XG4gKiByZWFkZXIgYW5kIGRpZmZlcnMgcGVyIGxhdW5jaGVyLCB3aGljaCBpcyBleGFjdGx5IGhvdyBvbmUgaG9zdCBvbiBhIGZsZWV0XG4gKiBjb21lcyB0byBiZWhhdmUgdW5saWtlIHRoZSByZXN0LiBBIGhvc3QgdGhhdCBzdGlsbCBleHBvcnRzIG9uZSBpcyB0b2xkIHNvLFxuICogb25jZSBwZXIgbGF1bmNoIGFuZCBieSBuYW1lLCB0aHJvdWdoIHtAbGluayBpZ25vcmVkTG9nRGlyRW52Tm90aWNlfTsgYVxuICogc3lzdGVtIHNlcnZpY2UgdGhhdCB3YW50cyBgL3Zhci9sb2cvdmliZS1jb2RlcmAgc3RhdGVzIGl0IGluIHRoZSBmaWxlLlxuICpcbiAqIFRoZSB2YWx1ZSB0YWtlcyB0aGUgc2FtZSBzaGFwZSBhcyBldmVyeSBvdGhlciBwYXRoLXZhbHVlZCBrZXlcbiAqIChgc3NoX2tleV9wYXRoYCwgYGdoX2NvbmZpZ19kaXJgKTogYW4gYWJzb2x1dGUgcGF0aCwgb3Igb25lIGFuY2hvcmVkIGF0XG4gKiBgfmAuIEEgcmVsYXRpdmUgdmFsdWUgaXMgcmVmdXNlZCByYXRoZXIgdGhhbiByZXNvbHZlZCBhZ2FpbnN0IHdoaWNoZXZlclxuICogZGlyZWN0b3J5IHRoZSBjYWxsZXIgaGFwcGVuZWQgdG8gYmUgaW4g4oCUIHRoYXQgaXMgcHJlY2lzZWx5IGhvdyBsb2dzIGVuZCB1cFxuICogaW4gdHdvIHBsYWNlcy5cbiAqXG4gKiAjIyBUaGUgZGVmYXVsdCBpcyB0aGUgcGxhdGZvcm0ncywgbm90IGAkSE9NRS9sb2dzYCAoSXNzdWUgIzg3MylcbiAqXG4gKiB8IFBsYXRmb3JtIHwgRGVmYXVsdCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfFxuICogfCAtLS0tLS0tLSB8IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tIHxcbiAqIHwgTGludXggICAgfCBgJFhER19TVEFURV9IT01FL3ZpYmUtY29kZXJgLCBlbHNlIGB+Ly5sb2NhbC9zdGF0ZS92aWJlLWNvZGVyYCAgfFxuICogfCBtYWNPUyAgICB8IGB+L0xpYnJhcnkvTG9ncy92aWJlLWNvZGVyYCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB8XG4gKiB8IFdpbmRvd3MgIHwgYCVMT0NBTEFQUERBVEElXFx2aWJlLWNvZGVyXFxsb2dzYCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfFxuICpcbiAqIExvZ3MgYXJlICoqc3RhdGUqKiwgbm90IGNhY2hlIGFuZCBub3QgY29uZmlndXJhdGlvbjogdGhlIFhERyBCYXNlIERpcmVjdG9yeVxuICogU3BlY2lmaWNhdGlvbiBuYW1lcyBzdGF0ZSBhcyB0aGUgaG9tZSBmb3IgXCJsb2dzIFthbmRdIGhpc3RvcnlcIiwgd2hpY2ggaXMgd2h5XG4gKiB0aGUgTGludXggZGVmYXVsdCBpcyB0aGUgc3RhdGUgZGlyZWN0b3J5IHJhdGhlciB0aGFuIGAkWERHX0RBVEFfSE9NRWAuIG1hY09TXG4gKiBub21pbmF0ZXMgYH4vTGlicmFyeS9Mb2dzYCBmb3IgYSB1c2VyLXNjb3BlZCBhZ2VudCBhbmQgQ29uc29sZS5hcHAgcmVhZHMgaXQuXG4gKiBBIGhvc3QgcnVubmluZyB0aGUgd29ya2VyIGFzIGEgc3lzdGVtIHNlcnZpY2Ugc3RhdGVzIGAvdmFyL2xvZy92aWJlLWNvZGVyYFxuICogYXMgYGxvZ19kaXJgIOKAlCBhIGRhZW1vbidzIGRpcmVjdG9yeSBpcyBhIGRlcGxveW1lbnQgZGVjaXNpb24sIG5vdCBzb21ldGhpbmdcbiAqIHRvIGluZmVyIGZyb20gdGhlIHByb2Nlc3MuXG4gKlxuICogVGhlIG9sZCBkZWZhdWx0LCBgJEhPTUUvbG9nc2AsIGZvbGxvd2VkIG5vIGNvbnZlbnRpb24gYW5kIHB1dCBmbGVldCBzdGF0ZSBpblxuICogdGhlIG9wZXJhdG9yJ3MgaG9tZSBkaXJlY3RvcnkgYmVzaWRlIHRoZWlyIG93biBmaWxlcy4gTm90aGluZyBtaWdyYXRlcyBpdDpcbiAqIHtAbGluayBsZWdhY3lMb2dEaXJOb3RpY2V9IG5hbWVzIHRoZSBvbGQgZGlyZWN0b3J5IG9uY2UgYW5kIGxlYXZlcyBpdCBleGFjdGx5XG4gKiB3aGVyZSBpdCBpcy5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLilcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEVudkxvb2t1cCB9IGZyb20gXCIuL2Vudl9sb29rdXAudHNcIjtcbmltcG9ydCB7XG4gIGlzQWJzb2x1dGVQYXRoLFxuICBqb2luUGF0aCxcbiAgdHlwZSBMYXVuY2hlclBhdGhTdHlsZSxcbiAgbm9ybWFsaXNlUGF0aCxcbn0gZnJvbSBcIi4vaG9zdF9wYXRoX3N0eWxlLnRzXCI7XG5cbi8qKiBUaGUgaG9zdCBwbGF0Zm9ybXMgd2hvc2UgbG9nIGNvbnZlbnRpb25zIGRpZmZlci4gKi9cbmV4cG9ydCB0eXBlIExvZ0RpclBsYXRmb3JtID0gXCJsaW51eFwiIHwgXCJkYXJ3aW5cIiB8IFwid2luZG93c1wiO1xuXG4vKipcbiAqIFRoZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgdGhhdCB1c2VkIHRvIG1vdmUgdGhlIGRpcmVjdG9yeSAoSXNzdWVzICM4NzIsXG4gKiAjODczKSBhbmQgbm8gbG9uZ2VyIGRvIChJc3N1ZSAjMTM4OCkuIEtlcHQgYXMgbmFtZXMgb25seSwgc28gdGhlIGxhdW5jaGVyXG4gKiBjYW4gdGVsbCBhbiBvcGVyYXRvciB3aG8gc3RpbGwgZXhwb3J0cyBvbmUgdGhhdCBpdCBpcyBiZWluZyBpZ25vcmVkIGFuZFxuICogd2hpY2gga2V5IHJlcGxhY2VzIGl0IOKAlCBzaWxlbmNlIGlzIGhvdyBhIGZsZWV0IGRyaWZ0cy5cbiAqL1xuZXhwb3J0IGNvbnN0IElHTk9SRURfTE9HX0RJUl9FTlZfTkFNRVMgPSBbXCJMQVVOQ0hfTE9HX0RJUlwiLCBcIkxPR19ESVJcIl0gYXMgY29uc3Q7XG5cbi8qKlxuICogVGhlIGAuY29uZmlnLmpzb25gIGtleSB0aGF0IHBpbnMgdGhlIGRpcmVjdG9yeSDigJQgdGhlIG9ubHkgd2F5IHRvIG1vdmUgaXQuXG4gKlxuICogUmVhZCBmcm9tIHRoZSBmaWxlIHJhdGhlciB0aGFuIGZyb20gYSBsb2FkZWQgYFdvcmtlckNvbmZpZ2A6IGBtb2QudHNgIGZhbGxzXG4gKiBiYWNrIHRvIHRoZSBkZWZhdWx0IGNvbmZpZ3VyYXRpb24gZm9yIGEgY29uZmlnLW9wdGlvbmFsIGNvbW1hbmQsIHdoaWNoIHdvdWxkXG4gKiB0dXJuIGEgYnJva2VuIGNvbmZpZyBmaWxlIGludG8gYSBzaWxlbnQgcGxhdGZvcm0gZGVmYXVsdCDigJQgYW5kIHRoZSBsYXVuY2hlcnNcbiAqIGNhbGwgYGxvZy1kaXJgIGJlZm9yZSBhbnkgY29uZmlndXJhdGlvbiBpcyBndWFyYW50ZWVkIHRvIGV4aXN0LiBUaGlzIGlzIHRoZVxuICogc2FtZSByZWFzb24gYHJ1bl9tb2RlYCBpcyByZS1yZWFkIGluIGBjb21tYW5kcy9ydW5fbW9kZS50c2AgKElzc3VlICMzMjM0KS5cbiAqL1xuZXhwb3J0IGNvbnN0IExPR19ESVJfQ09ORklHX0tFWSA9IFwibG9nX2RpclwiO1xuXG4vKiogVGhlIGRpcmVjdG9yeSB0aGUgZmxlZXQncyBsb2dzIGxpdmUgaW4sIHVuZGVyIGVhY2ggcGxhdGZvcm0ncyBvd24gcm9vdC4gKi9cbmV4cG9ydCBjb25zdCBMT0dfRElSX0FQUF9OQU1FID0gXCJ2aWJlLWNvZGVyXCI7XG5cbi8qKiBUaGUgZGVmYXVsdCBiZWZvcmUgSXNzdWUgIzg3Mywgc3RpbGwgb24gZXZlcnkgaG9zdCB0aGF0IGhhcyBldmVyIHJ1bi4gKi9cbmV4cG9ydCBjb25zdCBMRUdBQ1lfTE9HX0RJUl9OQU1FID0gXCJsb2dzXCI7XG5cbi8qKlxuICogV2hpY2ggcGxhdGZvcm0ncyBjb252ZW50aW9uIGFwcGxpZXMuXG4gKlxuICogQHBhcmFtIG9zIC0gQSBwbGF0Zm9ybSBuYW1lLCB0eXBpY2FsbHkgYERlbm8uYnVpbGQub3NgXG4gKiBAcmV0dXJucyBUaGUgY29udmVudGlvbiB0byBmb2xsb3c7IGFueXRoaW5nIHVucmVjb2duaXNlZCBpcyB0cmVhdGVkIGFzIGFcbiAqICAgZ2VuZXJpYyBQT1NJWCBob3N0LCB3aGljaCBpcyB3aGF0IFhERyBkZXNjcmliZXNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGlzZUxvZ0RpclBsYXRmb3JtKG9zOiBzdHJpbmcpOiBMb2dEaXJQbGF0Zm9ybSB7XG4gIGNvbnN0IG5hbWUgPSBvcy50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKG5hbWUgPT09IFwiZGFyd2luXCIpIHJldHVybiBcImRhcndpblwiO1xuICBpZiAobmFtZSA9PT0gXCJ3aW5kb3dzXCIpIHJldHVybiBcIndpbmRvd3NcIjtcbiAgcmV0dXJuIFwibGludXhcIjtcbn1cblxuLyoqIFRoZSBjb252ZW50aW9uIHRoaXMgaG9zdCBmb2xsb3dzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhvc3RMb2dEaXJQbGF0Zm9ybSgpOiBMb2dEaXJQbGF0Zm9ybSB7XG4gIHJldHVybiBub3JtYWxpc2VMb2dEaXJQbGF0Zm9ybShEZW5vLmJ1aWxkLm9zKTtcbn1cblxuLyoqXG4gKiBUaGUgbG9jYXRpb24gdGhlIGRlZmF1bHQgbW92ZWQgYXdheSBmcm9tIChJc3N1ZSAjODczKS5cbiAqXG4gKiBAcGFyYW0gaG9tZSAtIFRoZSBob3N0J3MgaG9tZSBkaXJlY3RvcnlcbiAqIEBwYXJhbSBzdHlsZSAtIEhvdyB0aGlzIGhvc3Qgc3BlbGxzIGl0cyBwYXRoc1xuICogQHJldHVybnMgYCRIT01FL2xvZ3NgLCB0aGUgcHJlLTEuNC4wIGRlZmF1bHRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxlZ2FjeUxvZ0RpcihcbiAgaG9tZTogc3RyaW5nLFxuICBzdHlsZTogTGF1bmNoZXJQYXRoU3R5bGUsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gam9pblBhdGgobm9ybWFsaXNlUGF0aChob21lLCBzdHlsZSksIExFR0FDWV9MT0dfRElSX05BTUUsIHN0eWxlKTtcbn1cblxuLyoqXG4gKiBUaGUgcGxhdGZvcm0tc3RhbmRhcmQgbG9nIGRpcmVjdG9yeSwgYmVmb3JlIGFueSBvdmVycmlkZSBpcyBhcHBsaWVkLlxuICpcbiAqIEBwYXJhbSBob21lIC0gVGhlIGhvc3QncyBob21lIGRpcmVjdG9yeVxuICogQHBhcmFtIGVudiAtIEVudmlyb25tZW50IHJlYWRlciAoaW5qZWN0YWJsZSBmb3IgdGVzdHMpXG4gKiBAcGFyYW0gc3R5bGUgLSBIb3cgdGhpcyBob3N0IHNwZWxscyBpdHMgcGF0aHNcbiAqIEBwYXJhbSBwbGF0Zm9ybSAtIFdob3NlIGNvbnZlbnRpb24gdG8gZm9sbG93OyBkZWZhdWx0cyB0byB0aGlzIGhvc3Qnc1xuICogQHJldHVybnMgVGhlIGRlZmF1bHQgZGlyZWN0b3J5IGZvciB0aGlzIHBsYXRmb3JtXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0TG9nRGlyKFxuICBob21lOiBzdHJpbmcsXG4gIGVudjogRW52TG9va3VwLFxuICBzdHlsZTogTGF1bmNoZXJQYXRoU3R5bGUsXG4gIHBsYXRmb3JtOiBMb2dEaXJQbGF0Zm9ybSA9IGhvc3RMb2dEaXJQbGF0Zm9ybSgpLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG5vcm1hbGlzZVBhdGgoaG9tZSwgc3R5bGUpO1xuICBpZiAocGxhdGZvcm0gPT09IFwiZGFyd2luXCIpIHtcbiAgICByZXR1cm4gam9pblBhdGgoYmFzZSwgYExpYnJhcnkvTG9ncy8ke0xPR19ESVJfQVBQX05BTUV9YCwgc3R5bGUpO1xuICB9XG4gIGlmIChwbGF0Zm9ybSA9PT0gXCJ3aW5kb3dzXCIpIHtcbiAgICAvLyBBIHVzZXItc2NvcGVkIGFnZW50J3MgbG9ncyBiZWxvbmcgdW5kZXIgTE9DQUxBUFBEQVRBLCB3aGljaCBpcyB3aGVyZVxuICAgIC8vIFdpbmRvd3Mga2VlcHMgbWFjaGluZS1sb2NhbCwgbm9uLXJvYW1pbmcgcGVyLXVzZXIgc3RhdGUuXG4gICAgY29uc3QgbG9jYWxBcHBEYXRhID0gcmVhZEVudlBhdGgoZW52LCBcIkxPQ0FMQVBQREFUQVwiLCBzdHlsZSk7XG4gICAgY29uc3Qgcm9vdCA9IGxvY2FsQXBwRGF0YSA/PyBqb2luUGF0aChiYXNlLCBcIkFwcERhdGEvTG9jYWxcIiwgc3R5bGUpO1xuICAgIHJldHVybiBqb2luUGF0aChyb290LCBgJHtMT0dfRElSX0FQUF9OQU1FfS9sb2dzYCwgc3R5bGUpO1xuICB9XG4gIC8vIFhERzogbG9ncyBhcmUgc3RhdGUuIEEgcmVsYXRpdmUgdmFsdWUgXCJtdXN0IGJlIGlnbm9yZWRcIiBwZXIgdGhlXG4gIC8vIHNwZWNpZmljYXRpb24sIGFuZCBhIGJsYW5rIG9uZSBtZWFucyB1bnNldCDigJQgaW4gYm90aCBjYXNlcyB0aGUgZGVmYXVsdFxuICAvLyBgJEhPTUUvLmxvY2FsL3N0YXRlYCBhcHBsaWVzIHJhdGhlciB0aGFuIGEgcGF0aCByZWxhdGl2ZSB0byBub3RoaW5nLlxuICBjb25zdCBzdGF0ZUhvbWUgPSByZWFkRW52UGF0aChlbnYsIFwiWERHX1NUQVRFX0hPTUVcIiwgc3R5bGUpO1xuICBjb25zdCByb290ID0gc3RhdGVIb21lID8/IGpvaW5QYXRoKGJhc2UsIFwiLmxvY2FsL3N0YXRlXCIsIHN0eWxlKTtcbiAgcmV0dXJuIGpvaW5QYXRoKHJvb3QsIExPR19ESVJfQVBQX05BTUUsIHN0eWxlKTtcbn1cblxuLyoqXG4gKiBUaGUgaG9zdCBkaXJlY3RvcnkgbG9ncyBhcmUgd3JpdHRlbiB0by5cbiAqXG4gKiBgbG9nX2RpcmAsIHRoZW4gdGhlIHBsYXRmb3JtIGRlZmF1bHQg4oCUIHRoZSBwcmVjZWRlbmNlIGBsb29wLnNoYCwgYHJ1bi5zaGBcbiAqIGFuZCB0aGUgY29udGFpbmVyIG1vdW50IGFsbCBzaGFyZSAoSXNzdWVzICM4NzIsICM4NzMsICMxMzg4KS4gQSBibGFuayBjb25maWdcbiAqIHZhbHVlIGlzIHRyZWF0ZWQgYXMgdW5zZXQsIGV4YWN0bHkgYXMgYW4gYWJzZW50IGtleSBpcy4gVGhlIGVudmlyb25tZW50IGlzXG4gKiBjb25zdWx0ZWQgb25seSBmb3IgdGhlIHBsYXRmb3JtJ3Mgb3duIGJhc2UgZGlyZWN0b3JpZXMgKGBYREdfU1RBVEVfSE9NRWAsXG4gKiBgTE9DQUxBUFBEQVRBYCk7IGBMQVVOQ0hfTE9HX0RJUmAgYW5kIGBMT0dfRElSYCBhcmUgaWdub3JlZC5cbiAqXG4gKiBAcGFyYW0gaG9tZSAtIFRoZSBob3N0J3MgaG9tZSBkaXJlY3RvcnlcbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCByZWFkZXIgKGluamVjdGFibGUgZm9yIHRlc3RzKTsgcGxhdGZvcm0gYmFzZVxuICogICBkaXJlY3RvcmllcyBvbmx5LCBuZXZlciBhbiBvcGVyYXRvciBvdmVycmlkZVxuICogQHBhcmFtIHN0eWxlIC0gSG93IHRoaXMgaG9zdCBzcGVsbHMgaXRzIHBhdGhzXG4gKiBAcGFyYW0gcGxhdGZvcm0gLSBXaG9zZSBjb252ZW50aW9uIHRoZSBkZWZhdWx0IGZvbGxvd3M7IGRlZmF1bHRzIHRvIHRoaXMgaG9zdCdzXG4gKiBAcGFyYW0gY29uZmlndXJlZCAtIFRoZSBgLmNvbmZpZy5qc29uYCBgbG9nX2RpcmAgdmFsdWUsIHdoZW4gdGhlIGRlcGxveW1lbnRcbiAqICAgc3RhdGVzIG9uZS4gUmVhZCB3aXRoIHtAbGluayByZWFkQ29uZmlndXJlZExvZ0Rpcn0uXG4gKiBAcmV0dXJucyBUaGUgcmVzb2x2ZWQgZGlyZWN0b3J5XG4gKiBAdGhyb3dzIFdoZW4gYGNvbmZpZ3VyZWRgIGlzIGEgcmVsYXRpdmUgcGF0aCDigJQgc2VlXG4gKiAgIHtAbGluayBub3JtYWxpc2VDb25maWd1cmVkTG9nRGlyfVxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUxvZ0RpcihcbiAgaG9tZTogc3RyaW5nLFxuICBlbnY6IEVudkxvb2t1cCxcbiAgc3R5bGU6IExhdW5jaGVyUGF0aFN0eWxlLFxuICBwbGF0Zm9ybTogTG9nRGlyUGxhdGZvcm0gPSBob3N0TG9nRGlyUGxhdGZvcm0oKSxcbiAgY29uZmlndXJlZD86IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHBpbm5lZCA9IG5vcm1hbGlzZUNvbmZpZ3VyZWRMb2dEaXIoY29uZmlndXJlZCwgaG9tZSwgc3R5bGUpO1xuICBpZiAocGlubmVkICE9PSB1bmRlZmluZWQpIHJldHVybiBwaW5uZWQ7XG4gIHJldHVybiBkZWZhdWx0TG9nRGlyKGhvbWUsIGVudiwgc3R5bGUsIHBsYXRmb3JtKTtcbn1cblxuLyoqXG4gKiBUaGUgZGVwbG95bWVudCdzIHBpbm5lZCBkaXJlY3RvcnksIGV4cGFuZGVkIGFuZCBjaGVja2VkLlxuICpcbiAqIEZvbGxvd3MgdGhlIHNoYXBlIG9mIGV2ZXJ5IG90aGVyIHBhdGgtdmFsdWVkIGtleTogYSBsZWFkaW5nIGB+YCBpcyBleHBhbmRlZFxuICogYWdhaW5zdCB0aGUgaG9zdCdzIGhvbWUsIGV4YWN0bHkgYXMgYGFwcGx5U2VydmljZUFjY291bnRFbnZgIGV4cGFuZHNcbiAqIGBzc2hfa2V5X3BhdGhgIGFuZCBgZ2hfY29uZmlnX2RpcmAuIEEgYmxhbmsgdmFsdWUgbWVhbnMgdGhlIGtleSB3YXMgbm90XG4gKiBzdGF0ZWQuIEFueXRoaW5nIGVsc2UgbXVzdCBiZSBhYnNvbHV0ZSDigJQgYSByZWxhdGl2ZSBsb2cgZGlyZWN0b3J5IHJlc29sdmVzXG4gKiBhZ2FpbnN0IHdoaWNoZXZlciBkaXJlY3RvcnkgdGhlIGNhbGxlciBoYXBwZW5lZCB0byBiZSBzdGFydGVkIGluLCBzb1xuICogYGxvb3Auc2hgLCBgcnVuLnNoYCBhbmQgdGhlIGNvbnRhaW5lciBtb3VudCB3b3VsZCBlYWNoIGdldCBhIGRpZmZlcmVudFxuICogYW5zd2VyLCB3aGljaCBpcyB0aGUgc3BsaXQgdGhpcyBrZXkgZXhpc3RzIHRvIHByZXZlbnQuXG4gKlxuICogQHBhcmFtIHZhbHVlIC0gVGhlIHJhdyBgLmNvbmZpZy5qc29uYCB2YWx1ZSwgaWYgYW55XG4gKiBAcGFyYW0gaG9tZSAtIFRoZSBob3N0J3MgaG9tZSBkaXJlY3RvcnksIGZvciBhIGB+YC1hbmNob3JlZCB2YWx1ZVxuICogQHBhcmFtIHN0eWxlIC0gSG93IHRoaXMgaG9zdCBzcGVsbHMgaXRzIHBhdGhzXG4gKiBAcmV0dXJucyBUaGUgcmVzb2x2ZWQgZGlyZWN0b3J5LCBvciB1bmRlZmluZWQgd2hlbiBub3RoaW5nIHdhcyBzdGF0ZWRcbiAqIEB0aHJvd3MgV2hlbiBhIHN0YXRlZCB2YWx1ZSBpcyBuZWl0aGVyIGFic29sdXRlIG5vciBgfmAtYW5jaG9yZWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGlzZUNvbmZpZ3VyZWRMb2dEaXIoXG4gIHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGhvbWU6IHN0cmluZyxcbiAgc3R5bGU6IExhdW5jaGVyUGF0aFN0eWxlLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3Qgc3RhdGVkID0gKHZhbHVlID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKHN0YXRlZCA9PT0gXCJcIikgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBjb25zdCBiYXNlID0gbm9ybWFsaXNlUGF0aChob21lLCBzdHlsZSk7XG4gIGlmIChzdGF0ZWQgPT09IFwiflwiKSByZXR1cm4gYmFzZTtcbiAgaWYgKHN0YXRlZC5zdGFydHNXaXRoKFwifi9cIikgfHwgc3RhdGVkLnN0YXJ0c1dpdGgoXCJ+XFxcXFwiKSkge1xuICAgIHJldHVybiBqb2luUGF0aChiYXNlLCBub3JtYWxpc2VQYXRoKHN0YXRlZC5zbGljZSgyKSwgc3R5bGUpLCBzdHlsZSk7XG4gIH1cbiAgaWYgKCFpc0Fic29sdXRlUGF0aChzdGF0ZWQsIHN0eWxlKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGAuY29uZmlnLmpzb24gXCIke0xPR19ESVJfQ09ORklHX0tFWX1cIiBtdXN0IGJlIGFuIGFic29sdXRlIHBhdGggb3IgYCArXG4gICAgICAgIGBzdGFydCB3aXRoIFwifi9cIiwgYnV0IG5hbWVzICR7SlNPTi5zdHJpbmdpZnkoc3RhdGVkKX0uIEEgcmVsYXRpdmUgYCArXG4gICAgICAgIGBkaXJlY3RvcnkgcmVzb2x2ZXMgZGlmZmVyZW50bHkgZm9yIGVhY2ggbGF1bmNoZXIsIHdoaWNoIHNwbGl0cyB0aGUgYCArXG4gICAgICAgIGBsb2dzIGFjcm9zcyBkaXJlY3RvcmllcyAoSXNzdWUgIzg3MykuYCxcbiAgICApO1xuICB9XG4gIHJldHVybiBub3JtYWxpc2VQYXRoKHN0YXRlZCwgc3R5bGUpO1xufVxuXG4vKipcbiAqIFRlbGwgYW4gb3BlcmF0b3Igd2hvIHN0aWxsIGV4cG9ydHMgYExBVU5DSF9MT0dfRElSYCBvciBgTE9HX0RJUmAgdGhhdCB0aGVcbiAqIHZhcmlhYmxlIG5vIGxvbmdlciBkb2VzIGFueXRoaW5nLCBhbmQgd2hhdCB0byB3cml0ZSBpbnN0ZWFkIChJc3N1ZSAjMTM4OCkuXG4gKlxuICogT25lIGxpbmUgbmFtaW5nIGV2ZXJ5IHNldCB2YXJpYWJsZSwgb3Igbm90aGluZyB3aGVuIG5vbmUgaXMgc2V0LiBUaGUgdmFsdWVcbiAqIGlzIHF1b3RlZCBiYWNrIHNvIHRoZSBvcGVyYXRvciBjYW4gbW92ZSBpdCBpbnRvIGAuY29uZmlnLmpzb25gIHZlcmJhdGltOyBhXG4gKiBibGFuayBleHBvcnQgaXMgbm90IHdvcnRoIGEgbGluZSwgYmVjYXVzZSBpdCBuZXZlciBtb3ZlZCBhbnl0aGluZyBlaXRoZXIuXG4gKlxuICogQHBhcmFtIGVudiAtIEVudmlyb25tZW50IHJlYWRlclxuICogQHJldHVybnMgVGhlIGxpbmUgdG8gcHJpbnQgb24gc3RkZXJyLCBvciB1bmRlZmluZWQgd2hlbiB0aGVyZSBpcyBub3RoaW5nIHRvIHNheVxuICovXG5leHBvcnQgZnVuY3Rpb24gaWdub3JlZExvZ0RpckVudk5vdGljZShlbnY6IEVudkxvb2t1cCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHNldDogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV4YW1wbGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgZm9yIChjb25zdCBuYW1lIG9mIElHTk9SRURfTE9HX0RJUl9FTlZfTkFNRVMpIHtcbiAgICBjb25zdCB2YWx1ZSA9IChlbnYobmFtZSkgPz8gXCJcIikudHJpbSgpO1xuICAgIGlmICh2YWx1ZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgc2V0LnB1c2goYCR7bmFtZX09JHtKU09OLnN0cmluZ2lmeSh2YWx1ZSl9YCk7XG4gICAgZXhhbXBsZSA/Pz0gdmFsdWU7XG4gIH1cbiAgaWYgKHNldC5sZW5ndGggPT09IDAgfHwgZXhhbXBsZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gYFtsb2ctZGlyXSAke3NldC5qb2luKFwiIGFuZCBcIil9ICR7XG4gICAgc2V0Lmxlbmd0aCA9PT0gMSA/IFwiaXNcIiA6IFwiYXJlXCJcbiAgfSBzZXQgYnV0IGlnbm9yZWQgKElzc3VlICMxMzg4KTogb24gdGhlIGhvc3Qgb25seSAuY29uZmlnLmpzb24gY29uZmlndXJlcyBgICtcbiAgICBgdGhlIHdvcmtlci4gVG8ga2VlcCB0aGF0IGRpcmVjdG9yeSwgc3RhdGUgXCIke0xPR19ESVJfQ09ORklHX0tFWX1cIjogJHtcbiAgICAgIEpTT04uc3RyaW5naWZ5KGV4YW1wbGUpXG4gICAgfSBpbiAuY29uZmlnLmpzb24gYW5kIHVuc2V0IHRoZSB2YXJpYWJsZS5gO1xufVxuXG4vKiogV2hhdCB7QGxpbmsgbGVnYWN5TG9nRGlyTm90aWNlfSBuZWVkcyB0byBkZWNpZGUgd2hldGhlciB0byBzcGVhay4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTGVnYWN5TG9nRGlyTm90aWNlSW5wdXQge1xuICAvKiogVGhlIGhvc3QncyBob21lIGRpcmVjdG9yeS4gKi9cbiAgaG9tZTogc3RyaW5nO1xuICAvKiogRW52aXJvbm1lbnQgcmVhZGVyLiAqL1xuICBlbnY6IEVudkxvb2t1cDtcbiAgLyoqIEhvdyB0aGlzIGhvc3Qgc3BlbGxzIGl0cyBwYXRocy4gKi9cbiAgc3R5bGU6IExhdW5jaGVyUGF0aFN0eWxlO1xuICAvKiogV2hvc2UgY29udmVudGlvbiB0aGUgZGVmYXVsdCBmb2xsb3dzLiAqL1xuICBwbGF0Zm9ybT86IExvZ0RpclBsYXRmb3JtO1xuICAvKiogV2hldGhlciBhIGRpcmVjdG9yeSBpcyBwcmVzZW50IG9uIHRoaXMgaG9zdC4gKi9cbiAgZXhpc3RzOiAocGF0aDogc3RyaW5nKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGAuY29uZmlnLmpzb25gIGBsb2dfZGlyYCB2YWx1ZSwgd2hlbiB0aGUgZGVwbG95bWVudCBzdGF0ZXMgb25lLiAqL1xuICBjb25maWd1cmVkPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIFRlbGwgdGhlIG9wZXJhdG9yIG9uY2UgdGhhdCB0aGUgZGVmYXVsdCBtb3ZlZCDigJQgYW5kIG1vdmUgbm90aGluZy5cbiAqXG4gKiBTaWxlbnQgb24gZXZlcnkgaG9zdCB0aGF0IGhhcyBub3RoaW5nIHRvIHNheTogb25lIHRoYXQgc3RhdGVzIGBsb2dfZGlyYFxuICogKHRoZSBsb2NhdGlvbiBpcyB0aGVpcnMsIG5vdCBhIGRlZmF1bHQpLCBvbmUgdGhhdCBuZXZlciBoYWQgYCRIT01FL2xvZ3NgLFxuICogYW5kIG9uZSB3aG9zZSBuZXcgZGlyZWN0b3J5IGFscmVhZHkgZXhpc3RzIOKAlCB3aGljaCBpcyBldmVyeSBob3N0IGZyb20gaXRzXG4gKiBzZWNvbmQgbGF1bmNoIG9ud2FyZHMsIGJlY2F1c2UgdGhlIGxhdW5jaGVyIGNyZWF0ZXMgaXQuIEFuIGV4cG9ydGVkXG4gKiBgTE9HX0RJUmAgbm8gbG9uZ2VyIHNpbGVuY2VzIGl0IChJc3N1ZSAjMTM4OCk6IHRoZSB2YXJpYWJsZSBpcyBpZ25vcmVkLCBzb1xuICogdGhlIGRlZmF1bHQgcmVhbGx5IGRvZXMgYXBwbHksIGFuZCB0aGUgbm90aWNlIGlzIGhvdyB0aGUgb3BlcmF0b3IgbGVhcm5zXG4gKiB0aGF0IGBsb2dfZGlyYCBpcyBub3cgdGhlIHdheSB0byBrZWVwIHRoZSBvbGQgbG9jYXRpb24uXG4gKlxuICogQHBhcmFtIGlucHV0IC0gSG9tZSwgZW52aXJvbm1lbnQsIHBhdGggc3R5bGUsIHRoZSBwaW5uZWQgZGlyZWN0b3J5IGFuZCBhXG4gKiAgIHByZXNlbmNlIHByb2JlXG4gKiBAcmV0dXJucyBUaGUgbGluZSB0byBwcmludCwgb3IgdW5kZWZpbmVkIHdoZW4gdGhlcmUgaXMgbm90aGluZyB0byByZXBvcnRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxlZ2FjeUxvZ0Rpck5vdGljZShcbiAgaW5wdXQ6IExlZ2FjeUxvZ0Rpck5vdGljZUlucHV0LFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgeyBob21lLCBlbnYsIHN0eWxlLCBleGlzdHMgfSA9IGlucHV0O1xuICBjb25zdCBwbGF0Zm9ybSA9IGlucHV0LnBsYXRmb3JtID8/IGhvc3RMb2dEaXJQbGF0Zm9ybSgpO1xuICBpZiAobm9ybWFsaXNlQ29uZmlndXJlZExvZ0RpcihpbnB1dC5jb25maWd1cmVkLCBob21lLCBzdHlsZSkgIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgY29uc3QgbGVnYWN5ID0gbGVnYWN5TG9nRGlyKGhvbWUsIHN0eWxlKTtcbiAgY29uc3QgcmVzb2x2ZWQgPSBkZWZhdWx0TG9nRGlyKGhvbWUsIGVudiwgc3R5bGUsIHBsYXRmb3JtKTtcbiAgaWYgKHJlc29sdmVkID09PSBsZWdhY3kpIHJldHVybiB1bmRlZmluZWQ7XG4gIGlmICghZXhpc3RzKGxlZ2FjeSkpIHJldHVybiB1bmRlZmluZWQ7XG4gIGlmIChleGlzdHMocmVzb2x2ZWQpKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIC8vIFRoZSBkZXN0aW5hdGlvbiBkb2VzIG5vdCBleGlzdCDigJQgdGhhdCBpcyB0aGUgY29uZGl0aW9uIHRoaXMgbm90aWNlIGZpcmVzXG4gIC8vIG9uIOKAlCBzbyB0aGUgbW92ZSBoYXMgdG8gY3JlYXRlIGl0LCBvciB0aGUgY29tbWFuZCBhcyBwcmludGVkIGZhaWxzLlxuICBjb25zdCBtb3ZlID0gc3R5bGUgPT09IFwid2luZG93c1wiXG4gICAgPyBgbWtkaXIgXCIke3Jlc29sdmVkfVwiICYmIG1vdmUgXCIke2xlZ2FjeX1cXFxcKlwiIFwiJHtyZXNvbHZlZH1cImBcbiAgICA6IGBta2RpciAtcCAke3Jlc29sdmVkfSAmJiBtdiAke2xlZ2FjeX0vKiAke3Jlc29sdmVkfS9gO1xuICByZXR1cm4gYFtsb2ctZGlyXSBMb2dzIG5vdyBkZWZhdWx0IHRvICR7cmVzb2x2ZWR9IChJc3N1ZSAjODczKS4gYCArXG4gICAgYFRoZSBwcmV2aW91cyBkZWZhdWx0ICR7bGVnYWN5fSB3YXMgbGVmdCB1bnRvdWNoZWQg4oCUIG5vdGhpbmcgaGFzIGJlZW4gYCArXG4gICAgYG1vdmVkIG9yIGRlbGV0ZWQuIFRvIGJyaW5nIGl0cyBoaXN0b3J5IGFjcm9zczogJHttb3ZlfS4gVG8ga2VlcCB0aGUgYCArXG4gICAgYG9sZCBsb2NhdGlvbiwgc3RhdGUgXCIke0xPR19ESVJfQ09ORklHX0tFWX1cIjogJHtKU09OLnN0cmluZ2lmeShsZWdhY3kpfSBgICtcbiAgICBgaW4gLmNvbmZpZy5qc29uLmA7XG59XG5cbi8qKlxuICogUmVhZCBhIHBhdGgtdmFsdWVkIHZhcmlhYmxlLCByZWplY3RpbmcgdGhlIHZhbHVlcyB0aGF0IGFyZSBub3QgcGF0aHMuXG4gKlxuICogQHBhcmFtIGVudiAtIEVudmlyb25tZW50IHJlYWRlclxuICogQHBhcmFtIG5hbWUgLSBWYXJpYWJsZSB0byByZWFkXG4gKiBAcGFyYW0gc3R5bGUgLSBIb3cgdGhpcyBob3N0IHNwZWxscyBpdHMgcGF0aHNcbiAqIEBwYXJhbSBvcHRpb25zIC0gYHJlcXVpcmVBYnNvbHV0ZWAgKGRlZmF1bHQgdHJ1ZSkgZHJvcHMgcmVsYXRpdmUgdmFsdWVzLCBhc1xuICogICB0aGUgWERHIHNwZWNpZmljYXRpb24gcmVxdWlyZXMgZm9yIGl0cyBiYXNlIGRpcmVjdG9yaWVzXG4gKiBAcmV0dXJucyBUaGUgbm9ybWFsaXNlZCB2YWx1ZSwgb3IgdW5kZWZpbmVkIHdoZW4gaXQgaXMgdW51c2FibGVcbiAqL1xuZnVuY3Rpb24gcmVhZEVudlBhdGgoXG4gIGVudjogRW52TG9va3VwLFxuICBuYW1lOiBzdHJpbmcsXG4gIHN0eWxlOiBMYXVuY2hlclBhdGhTdHlsZSxcbiAgb3B0aW9uczogeyByZXF1aXJlQWJzb2x1dGU/OiBib29sZWFuIH0gPSB7fSxcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHZhbHVlID0gKGVudihuYW1lKSA/PyBcIlwiKS50cmltKCk7XG4gIGlmICh2YWx1ZSA9PT0gXCJcIikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKChvcHRpb25zLnJlcXVpcmVBYnNvbHV0ZSA/PyB0cnVlKSAmJiAhaXNBYnNvbHV0ZVBhdGgodmFsdWUsIHN0eWxlKSkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGlzZVBhdGgodmFsdWUsIHN0eWxlKTtcbn1cblxuLyoqXG4gKiBQdWxsIGBsb2dfZGlyYCBvdXQgb2YgYSBjb25maWd1cmF0aW9uIGZpbGUncyB0ZXh0LlxuICpcbiAqIFNoYXJlZCBieSB0aGUgYXN5bmMgYW5kIHN5bmMgcmVhZGVycyBzbyB0aGUgdHdvIGNhbm5vdCBkaXNhZ3JlZSBhYm91dCB3aGF0XG4gKiBjb3VudHMgYXMgc3RhdGVkLCBvciBhYm91dCB3aGljaCBmYXVsdHMgYXJlIGxvdWQuXG4gKlxuICogQHBhcmFtIHRleHQgLSBUaGUgZmlsZSdzIGNvbnRlbnRzXG4gKiBAcGFyYW0gY29uZmlnRmlsZSAtIFBhdGgsIGZvciB0aGUgZXJyb3IgbWVzc2FnZXNcbiAqIEByZXR1cm5zIFRoZSByYXcgdmFsdWUsIG9yIHVuZGVmaW5lZCB3aGVuIHRoZSBrZXkgaXMgbm90IHN0YXRlZFxuICogQHRocm93cyBXaGVuIHRoZSBmaWxlIGlzIG5vdCBhIEpTT04gb2JqZWN0LCBvciB0aGUga2V5IGlzIG5vdCBhIHN0cmluZ1xuICovXG5mdW5jdGlvbiBwYXJzZUNvbmZpZ3VyZWRMb2dEaXIoXG4gIHRleHQ6IHN0cmluZyxcbiAgY29uZmlnRmlsZTogc3RyaW5nLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHRleHQpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDYW5ub3QgcmVzb2x2ZSB0aGUgbG9nIGRpcmVjdG9yeTogJHtjb25maWdGaWxlfSBpcyBub3QgcmVhZGFibGUgSlNPTiBgICtcbiAgICAgICAgYCgkeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX0pLiBGaXggaXQsIG9yIHJlLXJ1biAuL3NldHVwLnNoLmAsXG4gICAgKTtcbiAgfVxuICBpZiAodHlwZW9mIHBhcnNlZCAhPT0gXCJvYmplY3RcIiB8fCBwYXJzZWQgPT09IG51bGwgfHwgQXJyYXkuaXNBcnJheShwYXJzZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYENhbm5vdCByZXNvbHZlIHRoZSBsb2cgZGlyZWN0b3J5OiAke2NvbmZpZ0ZpbGV9IGRvZXMgbm90IGhvbGQgYSBKU09OIGAgK1xuICAgICAgICBgb2JqZWN0LmAsXG4gICAgKTtcbiAgfVxuICBjb25zdCB2YWx1ZSA9IChwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW0xPR19ESVJfQ09ORklHX0tFWV07XG4gIGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDYW5ub3QgcmVzb2x2ZSB0aGUgbG9nIGRpcmVjdG9yeTogJHtjb25maWdGaWxlfSBrZXkgYCArXG4gICAgICAgIGBcIiR7TE9HX0RJUl9DT05GSUdfS0VZfVwiIG11c3QgYmUgYSBzdHJpbmcuYCxcbiAgICApO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBkZXBsb3ltZW50J3MgcGlubmVkIGxvZyBkaXJlY3Rvcnkgb3V0IG9mIGl0cyBjb25maWd1cmF0aW9uIGZpbGUuXG4gKlxuICogQSBtaXNzaW5nIGZpbGUgaXMgYSBsZWdpdGltYXRlIFwibm90aGluZyBzdGF0ZWRcIiDigJQgYSBsYXVuY2hlciBtYXkgcnVuIGJlZm9yZVxuICogYC4vc2V0dXAuc2hgIGhhcyB3cml0dGVuIG9uZS4gRXZlcnkgb3RoZXIgZmF1bHQgaXMgbG91ZDogYSBsYXVuY2hlciBtdXN0IG5vdFxuICogZmFsbCBiYWNrIHRvIHRoZSBwbGF0Zm9ybSBkZWZhdWx0IGJlY2F1c2UgdGhlIGZpbGUgaXQgd2FzIHBvaW50ZWQgYXQgaXNcbiAqIGJyb2tlbiwgb3IgdGhlIGxvZ3MgbW92ZSB3aXRob3V0IGFueW9uZSBiZWluZyB0b2xkIChJc3N1ZSAjMzIzNCdzIHJ1bGUsXG4gKiBhcHBsaWVkIHRvIHRoaXMga2V5KS5cbiAqXG4gKiBAcGFyYW0gY29uZmlnRmlsZSAtIEhvc3QgcGF0aCBvZiB0aGUgd29ya2VyIGNvbmZpZ3VyYXRpb24gZmlsZVxuICogQHJldHVybnMgVGhlIHJhdyB2YWx1ZSwgb3IgdW5kZWZpbmVkIHdoZW4gbm90aGluZyBpcyBzdGF0ZWRcbiAqIEB0aHJvd3MgV2hlbiB0aGUgZmlsZSBleGlzdHMgYnV0IGlzIHVucmVhZGFibGUsIGlzIG5vdCBKU09OLCBkb2VzIG5vdCBob2xkXG4gKiAgIGFuIG9iamVjdCwgb3Igc2V0cyB0aGUga2V5IHRvIGEgbm9uLXN0cmluZ1xuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZENvbmZpZ3VyZWRMb2dEaXIoXG4gIGNvbmZpZ0ZpbGU6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG4gIGxldCB0ZXh0OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgdGV4dCA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKGNvbmZpZ0ZpbGUpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDYW5ub3QgcmVzb2x2ZSB0aGUgbG9nIGRpcmVjdG9yeTogJHtjb25maWdGaWxlfSBpcyB1bnJlYWRhYmxlIGAgK1xuICAgICAgICBgKCR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfSkuYCxcbiAgICApO1xuICB9XG4gIHJldHVybiBwYXJzZUNvbmZpZ3VyZWRMb2dEaXIodGV4dCwgY29uZmlnRmlsZSk7XG59XG5cbi8qKlxuICoge0BsaW5rIHJlYWRDb25maWd1cmVkTG9nRGlyfSBmb3IgdGhlIGNhbGxlcnMgdGhhdCBjYW5ub3QgYXdhaXQg4oCUIHNldHVwLCBhbmRcbiAqIHRoZSBsYXVuY2hlciBoZWxwZXJzIHRoYXQgcmVzb2x2ZSB0aGVpciBkaXJlY3RvcnkgaW4gYSBwbGFpbiBmdW5jdGlvbi5cbiAqXG4gKiBAcGFyYW0gY29uZmlnRmlsZSAtIEhvc3QgcGF0aCBvZiB0aGUgd29ya2VyIGNvbmZpZ3VyYXRpb24gZmlsZVxuICogQHJldHVybnMgVGhlIHJhdyB2YWx1ZSwgb3IgdW5kZWZpbmVkIHdoZW4gbm90aGluZyBpcyBzdGF0ZWRcbiAqIEB0aHJvd3MgQXMge0BsaW5rIHJlYWRDb25maWd1cmVkTG9nRGlyfSBkb2VzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkQ29uZmlndXJlZExvZ0RpclN5bmMoXG4gIGNvbmZpZ0ZpbGU6IHN0cmluZyxcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGxldCB0ZXh0OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgdGV4dCA9IERlbm8ucmVhZFRleHRGaWxlU3luYyhjb25maWdGaWxlKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQ2Fubm90IHJlc29sdmUgdGhlIGxvZyBkaXJlY3Rvcnk6ICR7Y29uZmlnRmlsZX0gaXMgdW5yZWFkYWJsZSBgICtcbiAgICAgICAgYCgkeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX0pLmAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcGFyc2VDb25maWd1cmVkTG9nRGlyKHRleHQsIGNvbmZpZ0ZpbGUpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWtEQyxHQUdELFNBQ0UsY0FBYyxFQUNkLFFBQVEsRUFFUixhQUFhLFFBQ1IsdUJBQXVCO0FBSzlCOzs7OztDQUtDLEdBQ0QsT0FBTyxNQUFNLDRCQUE0QjtFQUFDO0VBQWtCO0NBQVUsQ0FBVTtBQUVoRjs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sTUFBTSxxQkFBcUIsVUFBVTtBQUU1Qyw0RUFBNEUsR0FDNUUsT0FBTyxNQUFNLG1CQUFtQixhQUFhO0FBRTdDLDBFQUEwRSxHQUMxRSxPQUFPLE1BQU0sc0JBQXNCLE9BQU87QUFFMUM7Ozs7OztDQU1DLEdBQ0QsT0FBTyxTQUFTLHdCQUF3QixFQUFVO0VBQ2hELE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxXQUFXO0VBQ2xDLElBQUksU0FBUyxVQUFVLE9BQU87RUFDOUIsSUFBSSxTQUFTLFdBQVcsT0FBTztFQUMvQixPQUFPO0FBQ1Q7QUFFQSxzQ0FBc0MsR0FDdEMsT0FBTyxTQUFTO0VBQ2QsT0FBTyx3QkFBd0IsS0FBSyxLQUFLLENBQUMsRUFBRTtBQUM5QztBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUyxhQUNkLElBQVksRUFDWixLQUF3QjtFQUV4QixPQUFPLFNBQVMsY0FBYyxNQUFNLFFB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
// denoCacheMetadata=15691464565256271232,13982193291554679357