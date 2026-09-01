/**
 * The one `.config.json` a host uses, resolved the same way by every side
 * (Issue #750).
 *
 * The two halves of a deployment used to read different environment variables.
 * `setup.sh`, `setup.ps1` and `setup/setup_cli.ts` read **`CONFIG_FILE`**;
 * `resolveContainerLaunchHostPaths` read **`CONFIG_PATH`**. A host that
 * relocated its configuration and set only one of them had setup reading and
 * writing `<checkout>/.config.json` while `./run.sh` staged the relocated file
 * — two different files, and nothing reported the split. A relative value made
 * it worse: the Deno side resolved it against the checkout, `setup.sh` against
 * whatever directory the operator happened to be in.
 *
 * `CONFIG_FILE` is canonical — it is what setup has always documented — and
 * `CONFIG_PATH` is accepted as its alias, because hosts configured against the
 * launcher's spelling must keep working. Setting both is allowed only while
 * they name the same file once resolved; naming two different files is a
 * deployment fault and is reported as one rather than silently answered
 * differently on each side.
 *
 * `CONFIG_PATH` keeps its second, unrelated meaning **inside** the container,
 * where the launcher sets it to the staged read-only copy. That path is
 * absolute and no `CONFIG_FILE` is set beside it, so the rule here answers it
 * unchanged.
 *
 * The function is pure — the caller supplies the environment reader — so every
 * combination is unit-tested without touching a real host.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  isAbsolutePath,
  joinPath,
  type LauncherPathStyle,
  normalisePath,
  pathStyleFor,
} from "./host_path_style.ts";

/** The variable setup has always documented, and the one to prefer. */
export const CONFIG_PATH_ENV = "CONFIG_FILE";

/** The launcher's older spelling, still accepted so hosts do not break. */
export const CONFIG_PATH_ENV_ALIAS = "CONFIG_PATH";

/** The file name used when neither variable names one. */
export const DEFAULT_CONFIG_FILENAME = ".config.json";

/** A value that is set to something, rather than set to nothing. */
function stated(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Resolve the host's configuration file from the environment.
 *
 * `CONFIG_FILE` wins, `CONFIG_PATH` is its alias, and a relative value in
 * either resolves against `baseDir` — the worker checkout — so both sides of a
 * deployment name the same file.
 *
 * @param opts.baseDir - The worker checkout, the base for a relative value
 * @param opts.env - Environment reader (injectable for tests)
 * @param opts.style - How this host spells its paths; inferred from `baseDir`
 * @returns The absolute path of the configuration file
 * @throws When both variables are set and resolve to different files
 */
export function resolveHostConfigPath(opts: {
  baseDir: string;
  env: (name: string) => string | undefined;
  style?: LauncherPathStyle;
}): string {
  const style = opts.style ?? pathStyleFor(opts.baseDir);
  const base = normalisePath(opts.baseDir, style);
  const resolve = (value: string): string =>
    normalisePath(
      isAbsolutePath(value, style) ? value : joinPath(base, value, style),
      style,
    );

  const canonical = stated(opts.env(CONFIG_PATH_ENV));
  const alias = stated(opts.env(CONFIG_PATH_ENV_ALIAS));
  const resolvedCanonical = canonical === null ? null : resolve(canonical);
  const resolvedAlias = alias === null ? null : resolve(alias);

  if (
    resolvedCanonical !== null && resolvedAlias !== null &&
    resolvedCanonical !== resolvedAlias
  ) {
    throw new Error(
      `${CONFIG_PATH_ENV} and ${CONFIG_PATH_ENV_ALIAS} are both set and name ` +
        `different files: ${CONFIG_PATH_ENV}=${resolvedCanonical}, ` +
        `${CONFIG_PATH_ENV_ALIAS}=${resolvedAlias}. Setup would read one and ` +
        `the launcher stage the other — set one, or set both to the same file.`,
    );
  }

  return resolvedCanonical ?? resolvedAlias ??
    resolve(DEFAULT_CONFIG_FILENAME);
}
