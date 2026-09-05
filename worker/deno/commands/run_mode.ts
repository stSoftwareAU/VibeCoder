/**
 * run-mode command (Issue #4146).
 *
 * Prints the resolved run mode — `container` or `native` — so `run.sh` and
 * `run.ps1` never parse `.config.json` in shell, mirroring how they already
 * delegate to `container-launch-plan`.
 *
 * Usage:
 *   deno run --allow-env --allow-read mod.ts run-mode [--config .config.json]
 *
 * Stdout carries exactly the mode and nothing else, so a launcher can capture
 * it with `MODE=$(… mod.ts run-mode)`. An unrecognised value — in the file or
 * in `VIBE_RUN_MODE` — throws, which `mod.ts` reports on stderr and exits
 * non-zero for: stdout stays empty rather than feeding a launcher an error
 * message it would treat as a mode (Issue #3234).
 *
 * The configuration file is read here rather than through the loaded
 * `WorkerConfig`: `mod.ts` falls back to the default configuration when a
 * config-optional command cannot load one, which would turn an invalid
 * `run_mode` into a silent `container`. Launchers also call this before any
 * configuration is guaranteed to exist.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  resolveRunMode,
  RUN_MODE_CONFIG_KEY,
  type RunMode,
} from "../lib/run_mode.ts";
import { type EnvLookup, processEnvLookup } from "../lib/env_lookup.ts";

/** What the command reports alongside the printed mode. */
export interface RunModeResult {
  /** The resolved mode, the same string printed on stdout. */
  mode: RunMode;
  /** Configuration file consulted (whether or not it existed). */
  configFile: string;
}

/**
 * Read the run-mode selection out of a configuration file.
 *
 * @param configFile - Host path of the worker configuration file.
 * @returns The configured value, or undefined when the file does not exist or
 *   does not set the key.
 * @throws When the file exists but is unreadable, is not JSON, does not hold
 *   an object, or sets the key to a non-string — a launcher must not fall back
 *   to the default because the file it was pointed at is broken (Issue #3234).
 */
export async function readConfiguredRunMode(
  configFile: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    // No configuration yet (a launcher running before ./setup.sh) is a
    // legitimate "nothing selected"; anything else is a real fault.
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new Error(
      `Cannot resolve the run mode: ${configFile} is unreadable ` +
        `(${(error as Error).message}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot resolve the run mode: ${configFile} is not readable JSON ` +
        `(${(error as Error).message}). Fix it, or re-run ./setup.sh.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Cannot resolve the run mode: ${configFile} does not hold a JSON object.`,
    );
  }

  const value = (parsed as Record<string, unknown>)[RUN_MODE_CONFIG_KEY];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(
      `Cannot resolve the run mode: ${configFile} key ` +
        `"${RUN_MODE_CONFIG_KEY}" must be a string.`,
    );
  }
  return value;
}

/**
 * The run-mode command, widened with the environment it reads (Issue #969).
 *
 * `CONFIG_PATH` and `VIBE_RUN_MODE` used to be reached through `Deno.env` and
 * could only be stated by a test that wrote them into the process — a mutation
 * every parallel worker shares, which is what kept this suite in the gate's
 * slow serial pass (Issues #880, #944). The extra parameter is optional and
 * defaults to the process environment, so the registry, `mod.ts` and every
 * launcher see the {@link Command} interface they always did.
 */
export interface RunModeCommand extends Command {
  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
    env?: EnvLookup,
  ): Promise<CommandResult<RunModeResult>>;
}

export const runModeCommand: RunModeCommand = {
  name: "run-mode",
  description:
    "Print the resolved run mode — container, the only one (Issues #4146, #4)",
  /**
   * @param args - Command arguments; `--config` names the configuration file.
   * @param _config - The loaded worker configuration, deliberately unused: the
   *   file is re-read here so an invalid `run_mode` cannot be masked by
   *   `mod.ts` falling back to the default configuration.
   * @param env - Where `CONFIG_PATH` and `VIBE_RUN_MODE` are read from
   *   (Issue #969). Defaults to the process environment.
   * @returns The resolved mode, printed verbatim on stdout.
   */
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
    env: EnvLookup = processEnvLookup,
  ): Promise<CommandResult<RunModeResult>> {
    const configFile = typeof args["config"] === "string"
      ? (args["config"] as string)
      : env("CONFIG_PATH") ?? ".config.json";

    // Both the read and the resolution throw on a bad value: the registry
    // turns that into a non-zero exit with the reason on stderr, leaving the
    // launcher's `$(...)` capture empty.
    const mode = resolveRunMode({
      configured: await readConfiguredRunMode(configFile),
      env,
    });

    return {
      success: true,
      message: mode,
      data: { mode, configFile },
    };
  },
};
