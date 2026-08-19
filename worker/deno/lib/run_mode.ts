/**
 * The run-mode setting — container, and only container (Issue #4, parent
 * #4145, milestone #4060).
 *
 * Containment is mandatory: the worker runs inside the Vibe Coder container.
 * The former `native` mode (a host-native run, Issue #4148) and the macOS
 * `seatbelt` mode (native under a `sandbox-exec` profile, Issue #4300) were
 * removed by Issue #4 — a host-mode run sits outside the #4060 boundary this
 * project's risk profile is written against, and the fleet ran the two
 * host-mode branches only long enough to prove the container one.
 *
 * This module is still the single spelling of the setting, so a configuration
 * that names a removed mode fails **loud** in one place — the launchers and
 * `setup.sh` resolve through it (via the `run-mode` Deno subcommand) — rather
 * than being silently coerced to a container run the operator did not know
 * they were getting (Issue #3234).
 *
 * ```mermaid
 * flowchart LR
 *     E["VIBE_RUN_MODE"] -->|wins| R["resolveRunMode()"]
 *     C[".config.json<br/>run_mode"] --> R
 *     D["default: container"] --> R
 *     R --> M{"container"}
 *     M -->|native / seatbelt| X["throw — removed (Issue #4)"]
 *     M -->|anything else| Y["throw — not a run mode"]
 * ```
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/** Where the worker runs: inside the container. The only member. */
export type RunMode = "container";

/** Every run mode the worker supports. */
export const RUN_MODES: readonly RunMode[] = ["container"];

/** The default — and only — run mode. */
export const DEFAULT_RUN_MODE: RunMode = "container";

/**
 * Run modes that once existed and were removed (Issue #4). Named so a
 * configuration still carrying one gets the removal explained, not a generic
 * "not a run mode".
 */
export const REMOVED_RUN_MODES: readonly string[] = ["native", "seatbelt"];

/** `.config.json` key that selects the run mode. */
export const RUN_MODE_CONFIG_KEY = "run_mode";

/** Environment variable that overrides the configuration for one run. */
export const RUN_MODE_ENV = "VIBE_RUN_MODE";

/** Type guard: is `value` a run mode the worker supports? */
export function isRunMode(value: unknown): value is RunMode {
  return typeof value === "string" &&
    (RUN_MODES as readonly string[]).includes(value);
}

/**
 * Parse a run-mode string, failing loud on anything but a supported mode.
 *
 * @param value - The raw setting
 * @param source - Where it came from, for the error message
 * @returns The run mode
 * @throws When the value names a removed mode, or is not a run mode at all
 */
export function parseRunMode(value: string, source: string): RunMode {
  const wanted = value.trim();
  if (isRunMode(wanted)) return wanted;
  if (REMOVED_RUN_MODES.includes(wanted)) {
    throw new Error(
      `${source} names the removed run mode ${JSON.stringify(wanted)}: ` +
        `containment is mandatory (Issue #4) — the worker runs only inside ` +
        `the container. Remove "${RUN_MODE_CONFIG_KEY}" from .config.json ` +
        `(or unset ${RUN_MODE_ENV}); ./setup.sh installs the container ` +
        `runtime.`,
    );
  }
  throw new Error(
    `${source} is not a run mode: ${JSON.stringify(value)}. ` +
      `The only run mode is ${DEFAULT_RUN_MODE}; leave it unset.`,
  );
}

/** Inputs to {@link resolveRunMode}. */
export interface RunModeSelection {
  /** The `.config.json` {@link RUN_MODE_CONFIG_KEY} value, when set. */
  configured?: string;
  /** Environment lookup (defaults to the process environment). */
  env?: (name: string) => string | undefined;
}

/**
 * Resolve the run mode: `VIBE_RUN_MODE`, then `.config.json`, then the
 * default. Every value is parsed through {@link parseRunMode}, so a removed
 * or misspelled mode fails loud wherever it was set.
 */
export function resolveRunMode(selection: RunModeSelection = {}): RunMode {
  const env = selection.env ?? ((name: string) => Deno.env.get(name));

  const override = env(RUN_MODE_ENV)?.trim();
  if (override) return parseRunMode(override, RUN_MODE_ENV);

  const configured = selection.configured?.trim();
  if (configured) {
    return parseRunMode(
      configured,
      `Configuration key "${RUN_MODE_CONFIG_KEY}"`,
    );
  }

  return DEFAULT_RUN_MODE;
}
