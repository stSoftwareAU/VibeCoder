/**
 * The one place the config-versus-environment precedence rule is stated
 * (Issue #874).
 *
 * Issue #289 already settled the rule for every knob the worker has: **the
 * `.config.json` key wins over the environment variable, and the default
 * applies only when neither states a usable value.** What #289 did not settle
 * was where that rule lives, so each call site implemented it again, and by
 * the time #874 was filed the three sites that resolve both sources disagreed:
 * `host_disk.ts` followed the rule, while `optional_feature_env.ts` (the
 * bash-era `${VAR:-config}` expansion) and `agent_provider.ts` resolved
 * `env ?? config`.
 *
 * All three now resolve through {@link resolveSetting} (Issue #1032), so the
 * rule is stated once and an operator who sets both sources gets the file
 * whichever setting it is.
 *
 * Nothing here removes an environment fallback. Removing them is an
 * incompatible change and belongs in 2.0.0, as #874 says; until then the
 * variable still works and {@link resolveSetting} reports that it was used, so
 * {@link warnDeprecatedEnvSetting} names the key that replaces it — once per
 * setting per run, because a warning on every read is noise operators learn
 * to filter.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { EnvLookup } from "./env_lookup.ts";

/** Where a resolved value came from. */
export type SettingSource = "config" | "env" | "default";

/** A resolved setting, and the origin that decided it. */
export interface ResolvedSetting<T> {
  /** The value in force. */
  readonly value: T;
  /** Which source supplied it. */
  readonly source: SettingSource;
  /**
   * The environment variable that supplied the value, when `source` is
   * `"env"`. Present so a caller can warn once, naming both the deprecated
   * variable and {@link ResolveSettingOptions.configKey} that replaces it.
   */
  readonly deprecatedEnvVar?: string;
}

/** One setting to resolve. */
export interface ResolveSettingOptions<T> {
  /** The `.config.json` key, for the deprecation message. */
  readonly configKey: string;
  /** The `VIBE_*` variable that still works, and should not. */
  readonly envVar: string;
  /** The environment. */
  readonly env: EnvLookup;
  /** The value the config file states, if any. */
  readonly configured?: T | null;
  /** The value when neither source states a usable one. */
  readonly fallback: T;
  /**
   * Parse and validate an environment string.
   *
   * Returns `null` for a value that cannot be used, which is treated exactly
   * as absent: an unparseable override falls through to the default rather
   * than failing the run, because a typo in one variable must not stop a host
   * claiming work. {@link ResolvedSetting.source} then reads `"default"`, so
   * a caller that logs the source still shows the operator their value did
   * not take effect.
   *
   * A parse **may** throw instead, and one does: `agent_provider` refuses an
   * unregistered provider id rather than falling back (Issue #3234), because
   * the fallback there is not a number that is merely wrong — it is running a
   * different vendor's agent under an operator's explicit selection. The
   * distinction is the blast radius of the default, so it belongs to the
   * setting, not to this helper: fall through where the default is harmless,
   * throw where it is not.
   */
  readonly parse: (raw: string) => T | null;
  /**
   * Whether a value may be used at all.
   *
   * Applied to the config value **and** the parsed environment value, so a
   * bad number is refused wherever it was written — a `.config.json` key is
   * no more trustworthy than a variable, and a negative floor read from the
   * file would silently disable the check it configures. Defaults to
   * accepting anything, which suits a string setting; numeric callers want
   * {@link isNonNegative}.
   */
  readonly accept?: (value: T) => boolean;
}

/**
 * Resolve one setting under the stated rule: config, then environment, then
 * default.
 *
 * @param options - The key, the variable, the sources and how to read them
 * @returns The value in force and where it came from
 */
export function resolveSetting<T>(
  options: ResolveSettingOptions<T>,
): ResolvedSetting<T> {
  const accept = options.accept ?? (() => true);
  const usable = (value: T | null | undefined): value is T =>
    value !== null && value !== undefined && accept(value);

  if (usable(options.configured)) {
    return { value: options.configured, source: "config" };
  }

  const raw = options.env(options.envVar)?.trim() ?? "";
  if (raw !== "") {
    const parsed = options.parse(raw);
    if (usable(parsed)) {
      return {
        value: parsed,
        source: "env",
        deprecatedEnvVar: options.envVar,
      };
    }
  }

  return { value: options.fallback, source: "default" };
}

/**
 * Parse a number from an environment string — the
 * {@link ResolveSettingOptions.parse} most `VIBE_*` tunables want.
 *
 * Deliberately does **not** range-check: that is
 * {@link ResolveSettingOptions.accept}'s job, and doing it here would apply it
 * to the environment value only, leaving a bad config value to bind. Pair it
 * with {@link isNonNegative}.
 *
 * @param raw - The environment string
 * @returns The number, or `null` when the string is not one
 */
export function parseNumber(raw: string): number | null {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A finite, non-negative number — the {@link ResolveSettingOptions.accept}
 * every numeric tunable here wants, applied to both sources.
 *
 * @param value - The candidate
 * @returns Whether it may be used
 */
export function isNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * The one-line warning for a setting still coming from the environment.
 *
 * Names both halves, because "deprecated" without the replacement leaves the
 * operator to search for it.
 *
 * @param resolved - A setting {@link resolveSetting} returned
 * @param configKey - The `.config.json` key that replaces the variable
 * @returns The message, or `null` when the value did not come from the
 *   environment and there is nothing to warn about
 */
export function deprecationWarning<T>(
  resolved: ResolvedSetting<T>,
  configKey: string,
): string | null {
  if (resolved.source !== "env" || resolved.deprecatedEnvVar === undefined) {
    return null;
  }
  return `${resolved.deprecatedEnvVar} is deprecated and will stop being ` +
    `read in 2.0.0 — state "${configKey}" in .config.json instead ` +
    "(Issue #874). The environment value is in force for this run.";
}

/**
 * The settings already warned about, once per worker process.
 *
 * Keyed by `.config.json` key rather than by variable: the operator has one
 * setting to move whichever name they wrote it under, and a resolver a run
 * calls hundreds of times (the provider seam resolves per invocation) must
 * still state it once.
 */
const _warnedSettings = new Set<string>();

/**
 * Clear the per-process deprecation-warning state (Issue #1032).
 *
 * Exposed so a test — or any caller deliberately re-running a resolution as a
 * fresh scenario — can observe the first warning again.
 */
export function clearDeprecatedEnvWarnings(): void {
  _warnedSettings.clear();
}

/**
 * Warn once that a setting was taken from its deprecated environment variable.
 *
 * Says nothing at all when the file supplied the value or the default applied
 * — there is no deprecation to report, and an operator who has already moved
 * the setting must not be told to move it again.
 *
 * @param resolved - A setting {@link resolveSetting} returned
 * @param configKey - The `.config.json` key that replaces the variable
 * @returns The message emitted, or `null` when nothing was warned about
 *   (either the value did not come from the environment, or this setting has
 *   already been reported this run)
 */
export function warnDeprecatedEnvSetting<T>(
  resolved: ResolvedSetting<T>,
  configKey: string,
): string | null {
  const message = deprecationWarning(resolved, configKey);
  if (message === null || _warnedSettings.has(configKey)) return null;
  _warnedSettings.add(configKey);
  console.warn(message);
  return message;
}
