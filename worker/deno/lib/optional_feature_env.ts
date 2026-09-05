/**
 * Optional-feature settings from `.config.json`, applied to the process
 * environment (Issue #535 keys, worker-side).
 *
 * The bash-era conductor turned these keys into environment variables by
 * `eval`-ing the `load-config` export script; the Deno driver never did, so
 * `imgbb_api_key` and `update_gh_user_status` in the config file reached
 * nothing. This module is that missing step: the same variables, resolved
 * purely so it can be tested, applied once at worker start.
 *
 * What it no longer reproduces is the script's `${VAR:-config}` expansion
 * (Issue #1032). That made the *environment* win, which is the reverse of the
 * rule Issue #289 settled and every other knob follows, so an operator who
 * stated `imgbb_api_key` in the file and also exported `VIBE_IMGBB_API_KEY`
 * got the variable while the same operator's disk floor came from the file.
 * Precedence is now stated once, in `config_precedence.ts`: **the file wins**,
 * the variable applies when the file states nothing, and the documented
 * default applies when neither does. A value still taken from a deprecated
 * `VIBE_*` variable is warned about once per run, naming the key that
 * replaces it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { ConfigFile } from "../types.ts";
import {
  resolveSetting,
  warnDeprecatedEnvSetting,
} from "./config_precedence.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/** How the resolver sees the process. */
export interface OptionalFeatureEnvOptions {
  /** Read an environment variable; undefined when unset. */
  env: (name: string) => string | undefined;
}

/** One optional-feature setting, and the two names it can be stated under. */
interface OptionalFeatureSetting {
  /** The variable this setting's consumers read. */
  readonly envVar: string;
  /** The `.config.json` key that states it. */
  readonly configKey: string;
  /** What the file states, stringified; undefined when it states nothing. */
  readonly configured: string | undefined;
  /** Applied when neither source states a value; `""` for "no default". */
  readonly fallback: string;
  /**
   * Whether {@link envVar} is a deprecated operator override that 2.0.0 will
   * stop reading (Issue #874). `UPDATE_GH_USER_STATUS` is not: it is the
   * variable this very module *sets* for the feature checks downstream, so
   * telling an operator it will stop being read would be false.
   */
  readonly deprecatedEnvVar: boolean;
}

/**
 * The environment entries the config file asks for and the process does not
 * already carry. Pure — no I/O.
 *
 * A setting the file states is emitted even when the process already carries
 * the variable, because the file wins and the applied value has to be the one
 * in force (Issue #1032). A setting the *environment* supplied is not emitted:
 * the process already holds it, and there is nothing to apply.
 *
 * @param raw - The parsed `.config.json`
 * @param options - Environment reader and container flag
 * @returns Name → value for every variable to set
 */
export function resolveOptionalFeatureEnv(
  raw: ConfigFile,
  options: OptionalFeatureEnvOptions,
): Record<string, string> {
  const settings: OptionalFeatureSetting[] = [
    {
      envVar: "VIBE_IMGBB_API_KEY",
      configKey: "imgbb_api_key",
      configured: raw.imgbb_api_key,
      fallback: "",
      deprecatedEnvVar: true,
    },
    {
      envVar: "UPDATE_GH_USER_STATUS",
      configKey: "update_gh_user_status",
      configured: raw.update_gh_user_status === undefined
        ? undefined
        : String(raw.update_gh_user_status),
      // Documented default true (docs/CONFIGURATION.md) — exactly what
      // load-config exported.
      fallback: "true",
      deprecatedEnvVar: false,
    },
  ];

  const out: Record<string, string> = {};
  for (const setting of settings) {
    const resolved = resolveSetting<string>({
      configKey: setting.configKey,
      envVar: setting.envVar,
      env: (name) => options.env(name),
      configured: setting.configured ?? null,
      fallback: setting.fallback,
      parse: (value) => value,
      // A blank value in either source states nothing, as the `${VAR:-config}`
      // expansion this replaces also treated it.
      accept: (value) => value.trim() !== "",
    });

    if (resolved.source === "env") {
      if (setting.deprecatedEnvVar) {
        warnDeprecatedEnvSetting(resolved, setting.configKey);
      }
      continue; // the process already carries it
    }
    if (resolved.value !== "") out[setting.envVar] = resolved.value;
  }
  return out;
}

/**
 * Read `.config.json` and apply {@link resolveOptionalFeatureEnv} to the
 * process. Best-effort by design: a config that cannot be read or parsed is
 * the config loader's failure to report, not this step's — nothing here may
 * stop the worker.
 *
 * @param configPath - Path of `.config.json`
 * @param setEnv - How to establish a variable (injectable for tests)
 * @param env - Where the ambient values the config file now wins over are read
 *   from (Issue #969). Defaults to the process environment, so the worker's
 *   startup call is unchanged; a test states the ambient environment instead
 *   of writing one into the process every parallel worker shares.
 * @returns The variables applied
 */
export async function applyOptionalFeatureEnv(
  configPath: string,
  setEnv: (name: string, value: string) => void = (name, value) =>
    Deno.env.set(name, value),
  env: EnvLookup = processEnvLookup,
): Promise<Record<string, string>> {
  let raw: ConfigFile;
  try {
    raw = JSON.parse(await Deno.readTextFile(configPath)) as ConfigFile;
  } catch {
    return {};
  }
  const resolved = resolveOptionalFeatureEnv(raw, {
    env: (name) => {
      try {
        return env(name);
      } catch {
        // A denied `--allow-env` reads as "nothing ambient", so the config
        // value applies rather than the step failing.
        return undefined;
      }
    },
  });
  for (const [name, value] of Object.entries(resolved)) {
    setEnv(name, value);
  }
  return resolved;
}
