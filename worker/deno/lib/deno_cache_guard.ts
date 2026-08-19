/**
 * Size guard for the durable Deno cache (Issue #4302).
 *
 * The container entrypoint points DENO_DIR at
 * `${workDir}/.deno-cache` so the module/emit cache survives the
 * per-cycle container replacement — every launch after the first is a
 * warm start instead of re-downloading and re-type-checking the whole
 * worker graph. A cache on a durable volume needs a bound, though: this
 * guard wipes the directory outright when it exceeds the cap. Wiping —
 * rather than trimming — is correct for a cache: the only cost of losing
 * it is one cold start, and Deno's cache layout is not safely trimmable
 * from outside.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Default cap. A healthy worker cache is a few hundred MB; two GiB means
 * something is accreting (orphaned versions after many dependency bumps)
 * and a cold start is cheaper than the disk.
 */
export const DEFAULT_DENO_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Directory the entrypoint uses for the durable cache. */
export function denoCacheDir(workDir: string): string {
  return `${workDir}/.deno-cache`;
}

/** Outcome of a guard pass. */
export interface DenoCacheGuardResult {
  /** Total bytes found under the cache directory. */
  bytes: number;
  /** Whether the cache was wiped this pass. */
  wiped: boolean;
  /** Human-readable summary. */
  message: string;
}

/**
 * Measure `${workDir}/.deno-cache` and wipe it when it exceeds `maxBytes`.
 *
 * Never throws: a missing directory is a clean no-op, and a failed
 * removal is reported in the message rather than raised — housekeeping
 * must not abort startup.
 */
export async function guardDenoCache(options: {
  workDir: string;
  maxBytes?: number;
}): Promise<DenoCacheGuardResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_DENO_CACHE_MAX_BYTES;
  const dir = denoCacheDir(options.workDir);

  const bytes = await directorySize(dir);
  if (bytes === null) {
    return {
      bytes: 0,
      wiped: false,
      message: "deno cache absent — nothing to guard",
    };
  }
  if (bytes <= maxBytes) {
    return {
      bytes,
      wiped: false,
      message: `deno cache ${formatMb(bytes)} within the ${
        formatMb(maxBytes)
      } cap`,
    };
  }

  try {
    await Deno.remove(dir, { recursive: true });
  } catch (err) {
    return {
      bytes,
      wiped: false,
      message: `deno cache ${formatMb(bytes)} exceeds the ${
        formatMb(maxBytes)
      } cap but could not be removed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return {
    bytes,
    wiped: true,
    message: `deno cache ${formatMb(bytes)} exceeded the ${
      formatMb(maxBytes)
    } cap — wiped (next launch is a cold start)`,
  };
}

/** Recursive byte count; null when the root does not exist. */
async function directorySize(root: string): Promise<number | null> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(root);
  } catch {
    return null;
  }
  if (!stat.isDirectory) return stat.size;

  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = Deno.readDir(dir);
    } catch {
      return;
    }
    for await (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
      } else if (entry.isFile) {
        try {
          total += (await Deno.stat(path)).size;
        } catch {
          // Vanished mid-walk — skip.
        }
      }
    }
  };
  await walk(root);
  return total;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
