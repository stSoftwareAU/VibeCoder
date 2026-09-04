/**
 * Optional-feature settings from `.config.json`, applied to the process
 * environment (Issue #535 keys, worker-side).
 *
 * The bash-era conductor turned these keys into environment variables by
 * `eval`-ing the `load-config` export script; the Deno driver never did, so
 * `imgbb_api_key` and `update_gh_user_status` in the config file reached
 * nothing. This module is that missing step: the same variables, the same
 * "environment wins" precedence (`${VAR:-config}`), resolved purely so it can
 * be tested, applied once at worker start.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { ConfigFile } from "../types.ts";

/** How the resolver sees the process. */
export interface OptionalFeatureEnvOptions {
  /** Read an environment variable; undefined when unset. */
  env: (name: string) => string | undefined;
}

/**
 * The environment entries the config file asks for and the process does not
 * already carry. Pure — no I/O.
 *
 * @param raw - The parsed `.config.json`
 * @param options - Environment reader and container flag
 * @returns Name → value for every variable to set
 */
export function resolveOptionalFeatureEnv(
  raw: ConfigFile,
  options: OptionalFeatureEnvOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  const want = (name: string, value: string | undefined) => {
    if (value === undefined || value === "") return;
    const ambient = options.env(name);
    if (ambient !== undefined && ambient !== "") return; // environment wins
    out[name] = value;
  };

  want("VIBE_IMGBB_API_KEY", raw.imgbb_api_key);
  // Documented default true (docs/CONFIGURATION.md) — exactly what
  // load-config exported.
  want(
    "UPDATE_GH_USER_STATUS",
    raw.update_gh_user_status === undefined
      ? "true"
      : String(raw.update_gh_user_status),
  );
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
 * @returns The variables applied
 */
export async function applyOptionalFeatureEnv(
  configPath: string,
  setEnv: (name: string, value: string) => void = (name, value) =>
    Deno.env.set(name, value),
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
        return Deno.env.get(name);
      } catch {
        return undefined;
      }
    },
  });
  for (const [name, value] of Object.entries(resolved)) {
    setEnv(name, value);
  }
  return resolved;
}
