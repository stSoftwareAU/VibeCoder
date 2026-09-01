/**
 * The host's claiming-floor configuration, read from `.config.json`
 * (Issue #732).
 *
 * The launcher runs on the **host**, before the worker has loaded its
 * configuration, so it holds no config handle — this module is the one place
 * that reads the two floor keys off disk, exactly as
 * `agent_provider_config.ts` does for the provider selection. The launcher
 * resolves the floor once (environment → `.config.json` → defaults) and hands
 * the answer to every consumer, so the number that refuses a claim is the
 * number the operator configured.
 *
 * Fail loud (Issue #3234): a key of the wrong type, a negative floor or a
 * percentage outside 0–100 stops the launch with the offending value named.
 * Silently falling back to the default would leave the host gating on a floor
 * the operator did not choose — the very defect this issue is about.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  type ConfiguredDiskFloors,
  HOST_DISK_LOW_FLOOR_GB_KEY,
  HOST_DISK_LOW_FLOOR_PERCENT_KEY,
} from "./host_disk.ts";

/** Read one numeric floor key, or throw naming what is wrong with it. */
function numericKey(
  record: Record<string, unknown>,
  key: string,
  configFile: string,
  maximum?: number,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `Cannot launch: ${configFile} key "${key}" must be a number, got ` +
        `${JSON.stringify(value)}.`,
    );
  }
  if (value < 0 || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? "0 or more" : `0–${maximum}`;
    throw new Error(
      `Cannot launch: ${configFile} key "${key}" must be ${range}, got ` +
        `${value}.`,
    );
  }
  return value;
}

/**
 * Pull the two floor keys out of a parsed `.config.json` object.
 *
 * @param record - The parsed configuration object
 * @param configFile - Path named in any error, for the operator
 * @returns The configured floors — either term, or neither
 * @throws When a key is present but is not a usable floor
 */
export function parseConfiguredDiskFloors(
  record: Record<string, unknown>,
  configFile: string,
): ConfiguredDiskFloors {
  const lowFloorGb = numericKey(record, HOST_DISK_LOW_FLOOR_GB_KEY, configFile);
  const lowFloorPercent = numericKey(
    record,
    HOST_DISK_LOW_FLOOR_PERCENT_KEY,
    configFile,
    100,
  );
  return {
    ...(lowFloorGb !== undefined ? { lowFloorGb } : {}),
    ...(lowFloorPercent !== undefined ? { lowFloorPercent } : {}),
  };
}

/**
 * Read the configured floors from the host's `.config.json`.
 *
 * @param configFile - Host path of the worker configuration file
 * @returns The configured floors — either term, or neither
 * @throws When the file is unparseable, holds no object, or carries a floor
 *   key that is not a usable floor
 */
export async function readConfiguredDiskFloors(
  configFile: string,
): Promise<ConfiguredDiskFloors> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(configFile));
  } catch (error) {
    throw new Error(
      `Cannot launch: ${configFile} is not readable JSON ` +
        `(${(error as Error).message}). Fix it, or re-run ./setup.sh.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Cannot launch: ${configFile} does not hold a JSON object.`,
    );
  }
  return parseConfiguredDiskFloors(
    parsed as Record<string, unknown>,
    configFile,
  );
}
