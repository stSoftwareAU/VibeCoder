/**
 * reclaim-host-caches command (Issue #4498).
 *
 * Called by the launchers when the host is below its disk claiming floor. It
 * removes stale cargo `target` directories (CACHEDIR.TAG-tagged build caches)
 * from the host's scratch and source roots, oldest first, until the estimated
 * free space clears the floor plus the configured headroom.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-write --allow-run \
 *     mod.ts reclaim-host-caches --config <path> \
 *     --free-kb <n> --floor-kb <n> [--protect <dir>]...
 *
 * Exit status: 0 whenever the command ran, including when the host is still
 * short afterwards. Non-zero only for bad arguments, an unreadable
 * configuration, or a process table that cannot be read (nothing is removed
 * in that case).
 *
 * The output is multi-line log text, one `[HOST_CACHE_RECLAIM]` line each for
 * removals, notable skips, and the summary. When the host is still below the
 * floor, a final `largest host directories:` line names where the space is.
 * The launchers parse that phrase, so it must not change.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  defaultCacheRoots,
  headroomBytesFor,
  type HostCacheReclaimConfig,
  type HostCacheReclaimDeps,
  type HostCacheReclaimResult,
  type HostDirectorySize,
  hostPathStyle,
  largestHostDirectories,
  minAgeMsFor,
  readHostCacheReclaimConfig,
  reclaimHostCaches,
} from "../lib/host_cache_reclaim.ts";

/** Prefix on every line of the command's message (run.sh parses it). */
export const HOST_CACHE_RECLAIM_TAG = "[HOST_CACHE_RECLAIM]";

const KB = 1024;
const MIB = 1_048_576;
const GIB = 1_073_741_824;
const HOUR_MS = 3_600_000;

/** Injection for tests. Production passes nothing. */
export interface ReclaimHostCachesDeps {
  /** The environment reader (TMPDIR, TEMP, TMP, HOME). */
  env?: (name: string) => string | undefined;
  /** The home directory; defaults to HOME, then USERPROFILE. */
  homeDir?: string;
  /** Replaces the built-in default roots; configured extras still apply. */
  defaultRoots?: string[];
  /** Replaces any reclaim dependency (process table, sizes, removal, fs). */
  reclaim?: Partial<HostCacheReclaimDeps>;
}

/** What the command reports back as structured data. */
export interface ReclaimHostCachesData {
  removed: HostCacheReclaimResult["removed"];
  skipped: HostCacheReclaimResult["skipped"];
  freeBytesAfter: number;
  targetBytes: number;
  shortBytes: number;
  largest?: HostDirectorySize[];
}

export const reclaimHostCachesCommand: Command = {
  name: "reclaim-host-caches",
  description:
    "Remove stale cargo build caches from the host's scratch and source " +
    "roots when the host is below its disk floor (Issue #4498)",

  execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ReclaimHostCachesData>> {
    return runReclaimHostCaches(args);
  },
};

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A non-negative whole kilobyte count from a flag, or null when it is not one.
 * Accepts a number or a digit string; anything else is garbage and refused.
 */
function parseKilobytes(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/**
 * The repeatable `--protect` flag: a single string or an array of them. Any
 * other shape, or an empty entry, is refused rather than dropped, because a
 * dropped protection would let a candidate be removed.
 */
function parseProtect(value: unknown): string[] | string {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  const paths: string[] = [];
  for (const entry of raw) {
    const trimmed = optionalString(entry);
    if (trimmed === undefined) {
      return `--protect must be a directory path, got ${JSON.stringify(entry)}`;
    }
    paths.push(trimmed);
  }
  return paths;
}

function megabytes(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MB`;
}

function gigabytes(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

function tagged(lines: string[]): string {
  return lines.map((line) => `${HOST_CACHE_RECLAIM_TAG} ${line}`).join("\n");
}

/**
 * Do the work. Separated so the tests can call it without the registry.
 *
 * @param args - `config`, `free-kb`, `floor-kb`, and repeatable `protect`
 * @param deps - Injection for tests; production passes nothing
 * @returns The command's result, with the log text as its message
 */
export async function runReclaimHostCaches(
  args: Record<string, unknown>,
  deps: ReclaimHostCachesDeps = {},
): Promise<CommandResult<ReclaimHostCachesData>> {
  const configPath = optionalString(args["config"]);
  if (!configPath) {
    return {
      success: false,
      message: "reclaim-host-caches requires --config <file>",
    };
  }

  const freeKb = parseKilobytes(args["free-kb"]);
  if (freeKb === null) {
    return {
      success: false,
      message: "reclaim-host-caches: --free-kb must be a non-negative whole " +
        `number of kilobytes, got ${JSON.stringify(args["free-kb"] ?? null)}`,
    };
  }
  const floorKb = parseKilobytes(args["floor-kb"]);
  if (floorKb === null) {
    return {
      success: false,
      message: "reclaim-host-caches: --floor-kb must be a non-negative whole " +
        `number of kilobytes, got ${JSON.stringify(args["floor-kb"] ?? null)}`,
    };
  }

  const protect = parseProtect(args["protect"]);
  if (typeof protect === "string") {
    return { success: false, message: `reclaim-host-caches: ${protect}` };
  }

  let config: HostCacheReclaimConfig;
  try {
    config = await readHostCacheReclaimConfig(configPath);
  } catch (error) {
    return {
      success: false,
      message: (error as Error).message,
    };
  }

  if (!config.enabled) {
    return {
      success: true,
      message: `${HOST_CACHE_RECLAIM_TAG} disabled by ` +
        `host_cache_reclaim_enabled=false in ${configPath}`,
    };
  }

  const freeBytes = freeKb * KB;
  const floorBytes = floorKb * KB;
  if (freeBytes >= floorBytes) {
    return {
      success: true,
      message: tagged([
        `nothing to do: ${megabytes(freeBytes)} free is at or above the ` +
        `floor of ${megabytes(floorBytes)}`,
      ]),
    };
  }

  const env = deps.env ?? ((name: string) => Deno.env.get(name));
  const style = hostPathStyle();
  const home = deps.homeDir ?? env("HOME") ?? env("USERPROFILE");
  const roots = [
    ...(deps.defaultRoots ??
      defaultCacheRoots(home, env, [], style)),
    ...config.extraRoots,
  ];

  const result = await reclaimHostCaches({
    freeBytes,
    floorBytes,
    headroomBytes: headroomBytesFor(config.headroomGb),
    minAgeMs: minAgeMsFor(config.minAgeHours),
    roots,
    protect,
  }, deps.reclaim ?? {});

  if (result.processTableError !== undefined) {
    return {
      success: false,
      message: tagged([
        "process table unreadable — removed nothing: " +
        result.processTableError,
      ]),
    };
  }

  const lines: string[] = [];
  let freedBytes = 0;
  for (const removal of result.removed) {
    const idleHours = (removal.idleMs / HOUR_MS).toFixed(1);
    if (removal.bytes === null) {
      lines.push(
        `removed ${removal.path} (size unmeasured, idle ${idleHours} h)`,
      );
    } else {
      freedBytes += removal.bytes;
      lines.push(
        `removed ${removal.path} (${
          megabytes(removal.bytes)
        }, idle ${idleHours} h)`,
      );
    }
  }
  for (const skip of result.skipped) {
    lines.push(`skipped ${skip.path}: ${skip.reason}`);
  }
  lines.push(
    `freed ${megabytes(freedBytes)}; est. free ${
      megabytes(result.freeBytesAfter)
    } vs floor ${megabytes(floorBytes)}`,
  );

  let largest: HostDirectorySize[] | undefined;
  if (result.freeBytesAfter < floorBytes) {
    largest = await largestHostDirectories(roots, deps.reclaim ?? {});
    const named = largest.length === 0
      ? "none found"
      : largest.map((dir) =>
        dir.bytes === null
          ? `${dir.path} (unmeasured)`
          : `${dir.path} (${gigabytes(dir.bytes)})`
      ).join("; ");
    lines.push(`largest host directories: ${named}`);
  }

  const data: ReclaimHostCachesData = {
    removed: result.removed,
    skipped: result.skipped,
    freeBytesAfter: result.freeBytesAfter,
    targetBytes: result.targetBytes,
    shortBytes: result.shortBytes,
    ...(largest ? { largest } : {}),
  };
  return { success: true, message: tagged(lines), data };
}
