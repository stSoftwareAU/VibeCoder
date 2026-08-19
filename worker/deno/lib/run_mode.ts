/**
 * The run-mode setting — container by default, native by explicit opt-in
 * (Issue #4146, parent #4145, milestone #4060).
 *
 * Containment is the default: the worker runs inside the Vibe Coder container
 * unless a host explicitly asks for a host-native run. The one deployment that
 * genuinely needs native is a host monitoring a repo whose build shells out to
 * `docker` — the image ships no docker client and `container_launch.ts`
 * refuses both runtime-socket mounts and `--privileged`, so that build cannot
 * run inside the container.
 *
 * This module is the single spelling of that setting. Both launchers and
 * `setup.sh` resolve through it (via the `run-mode` Deno subcommand), so no
 * shell parses `.config.json` and the precedence cannot drift between hosts.
 *
 * Two invariants make the setting trustworthy:
 *
 * - **Fail loud (Issue #3234).** An unrecognised value throws, naming both
 *   valid modes. A typo must never be coerced to a default — that would run a
 *   host in the mode it did not ask for.
 * - **No auto-fallback.** Nothing here may select `native` because a container
 *   runtime is absent. A missing runtime in container mode stays the fatal
 *   error it is today; the only route to native is an explicit opt-in. This
 *   module therefore consults no runtime at all — it reads a string and
 *   nothing else.
 *
 * ```mermaid
 * flowchart LR
 *     E["VIBE_RUN_MODE"] -->|wins| R["resolveRunMode()"]
 *     C[".config.json<br/>run_mode"] --> R
 *     D["default: container"] --> R
 *     R --> M{"container | native"}
 *     M -->|unrecognised| X["throw — names both modes"]
 * ```
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/** Where the worker runs: inside the container, or natively on the host. */
export type RunMode = "container" | "native" | "seatbelt";

/**
 * The run modes every host can exercise, in the order operator messages
 * list them. These are the modes CI must cover on every platform (Issue
 * #4150 — `run_mode_ci_coverage.ts` iterates this list).
 */
export const RUN_MODES: readonly RunMode[] = ["container", "native"];

/**
 * Platform-specific opt-in modes (Issue #4300). `seatbelt` is native mode
 * with the filesystem confined by a macOS Seatbelt profile — full CPU/GPU,
 * no VM tax, deny-by-default file access. macOS only, never the default,
 * and not something Linux CI can exercise, hence its own list.
 */
export const PLATFORM_RUN_MODES: readonly RunMode[] = ["seatbelt"];

/** All accepted run modes: universal first, then platform-specific. */
export const ALL_RUN_MODES: readonly RunMode[] = [
  ...RUN_MODES,
  ...PLATFORM_RUN_MODES,
];

/** The mode used when neither configuration nor environment selects one. */
export const DEFAULT_RUN_MODE: RunMode = "container";

/** `.config.json` key that selects the run mode. */
export const RUN_MODE_CONFIG_KEY = "run_mode";

/** Environment variable that overrides the configured run mode. */
export const RUN_MODE_ENV = "VIBE_RUN_MODE";

/**
 * Report whether a value is one of the two run modes.
 *
 * @param value - Candidate value, typically straight from parsed JSON.
 * @returns True when the value is exactly `container` or `native`.
 */
export function isRunMode(value: unknown): value is RunMode {
  return typeof value === "string" &&
    (ALL_RUN_MODES as readonly string[]).includes(value);
}

/**
 * Parse one run-mode value, naming where it came from.
 *
 * Surrounding whitespace is tolerated — a shell that exports a padded value
 * still means the mode it names — but nothing else is normalised: `Native` is
 * rejected rather than folded, so what an operator wrote and what runs are the
 * same string.
 *
 * @param value - Raw value from configuration, the environment, or a caller.
 * @param source - Operator-facing description of where it came from.
 * @returns The parsed mode.
 * @throws When the value is not one of the accepted modes — naming them all, so the
 *   operator sees what to write instead (Issue #3234).
 */
export function parseRunMode(value: string, source: string): RunMode {
  const wanted = value.trim();
  if (isRunMode(wanted)) return wanted;
  throw new Error(
    `${source} is not a run mode: ${JSON.stringify(value)}. ` +
      `Valid run modes: ${ALL_RUN_MODES.join(", ")}. ` +
      `Leave it unset for ${DEFAULT_RUN_MODE} (the default), or set ` +
      `"${RUN_MODE_CONFIG_KEY}" in .config.json (or ${RUN_MODE_ENV}) to one ` +
      `of those values (seatbelt is macOS-only).`,
  );
}

/** Where a run-mode selection may come from. */
export interface RunModeSelection {
  /** The `.config.json` {@link RUN_MODE_CONFIG_KEY} value, when set. */
  configured?: string;
  /** Environment lookup (defaults to the process environment). */
  env?: (name: string) => string | undefined;
}

/**
 * Resolve the run mode for this host.
 *
 * Precedence: {@link RUN_MODE_ENV} (an explicit per-run override), then the
 * `.config.json` {@link RUN_MODE_CONFIG_KEY} key, then
 * {@link DEFAULT_RUN_MODE}. A value that is set but blank is not a selection
 * and falls through to the next source; a value that is set and unrecognised
 * throws.
 *
 * @param selection - Configured value and environment lookup.
 * @returns The resolved run mode.
 * @throws When either source names something other than an accepted mode.
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
