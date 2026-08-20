/**
 * Content-addressed cache for the quality gate's expensive checks
 * (Issue #86).
 *
 * The in-container gate runs sequentially (Issue #4267) and, until now,
 * re-ran the whole `deno test` suite and the whole-repo `deno check` on every
 * invocation — even the 2nd–4th time an agent ran `./quality.sh` in one
 * session with little changed between runs. Those two dimensions dominate the
 * ~6-minute cost.
 *
 * The cache keys each dimension on a **content digest** of its entire input
 * set (every `.ts` file under `worker/deno`, plus `deno.json`,
 * `deno.lock` and the pinned `.deno-version`). A cached PASS is reused only
 * when the current digest is byte-for-byte identical to the one that last
 * passed — so a false skip is impossible by construction: identical inputs,
 * identical toolchain ⟹ identical result. A FAIL is never cached, so a
 * broken tree is re-checked every time until it is fixed.
 *
 * The cache lives in the worker's cache directory on the work volume, so it
 * survives between the agent's repeated in-session runs but is disposable.
 * When no cache directory is resolvable (a host dev run), caching is simply
 * off — never a source of a wrong answer.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

/** One cached dimension outcome. */
interface CachedDimension {
  /** The input digest that produced this outcome. */
  digest: string;
  /** Only ever "PASSED" — failures are not cached. */
  status: "PASSED";
  /** ISO-8601 stamp of when it was cached, for the operator-facing line. */
  at: string;
}

type CacheFile = Record<string, CachedDimension>;

const CACHE_FILENAME = "quality-gate-cache.json";

/** Lowercase hex SHA-256 of a byte array (Uint8Array copy for a plain ArrayBuffer). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Recursively yield `.ts` file paths under `dir` (absolute), sorted-friendly. */
async function* walkTs(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTs(full);
    } else if (entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

/**
 * Compute the input digest shared by `deno test` and `deno check`: every
 * `.ts` file under `denoDir`, plus the dependency/config/toolchain pins. Path is
 * folded in with content so a rename changes the digest.
 *
 * @param denoDir - `worker/deno`
 * @returns A hex digest, or null when the tree cannot be read (caching off).
 */
export async function computeQualityInputDigest(
  denoDir: string,
): Promise<string | null> {
  try {
    const parts: string[] = [];
    const files: string[] = [];
    for await (const f of walkTs(denoDir)) files.push(f);
    files.sort();
    for (const f of files) {
      const rel = f.slice(denoDir.length + 1);
      const content = await Deno.readFile(f);
      parts.push(`${rel}\0${await sha256Hex(content)}`);
    }
    // Dependency / config / toolchain pins that change test or check results.
    for (
      const extra of [
        `${denoDir}/deno.json`,
        `${denoDir}/deno.lock`,
        `${denoDir}/../../.deno-version`,
      ]
    ) {
      try {
        parts.push(`${extra}\0${await sha256Hex(await Deno.readFile(extra))}`);
      } catch {
        parts.push(`${extra}\0absent`);
      }
    }
    return await sha256Hex(new TextEncoder().encode(parts.join("\n")));
  } catch {
    return null;
  }
}

/** Read the cache file; a missing/corrupt file is an empty cache. */
async function readCache(cacheDir: string): Promise<CacheFile> {
  try {
    const text = await Deno.readTextFile(`${cacheDir}/${CACHE_FILENAME}`);
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === "object") ? parsed as CacheFile : {};
  } catch {
    return {};
  }
}

/** Best-effort write; a failure to persist never fails the gate. */
async function writeCache(cacheDir: string, cache: CacheFile): Promise<void> {
  try {
    await Deno.mkdir(cacheDir, { recursive: true });
    await Deno.writeTextFile(
      `${cacheDir}/${CACHE_FILENAME}`,
      JSON.stringify(cache, null, 2),
    );
  } catch { /* disposable cache — never fatal */ }
}

/** A cached PASS whose digest matches, or null to run the check. */
export async function cachedPassAt(
  cacheDir: string | undefined,
  dimension: string,
  digest: string | null,
): Promise<string | null> {
  if (!cacheDir || digest === null) return null;
  const entry = (await readCache(cacheDir))[dimension];
  return (entry && entry.digest === digest && entry.status === "PASSED")
    ? entry.at
    : null;
}

/** Record a dimension's PASS under the given digest (best-effort). */
export async function recordPass(
  cacheDir: string | undefined,
  dimension: string,
  digest: string | null,
  nowIso: string,
): Promise<void> {
  if (!cacheDir || digest === null) return;
  const cache = await readCache(cacheDir);
  cache[dimension] = { digest, status: "PASSED", at: nowIso };
  await writeCache(cacheDir, cache);
}

/** Drop a dimension's cached entry (best-effort) — used when it does not pass. */
export async function invalidate(
  cacheDir: string | undefined,
  dimension: string,
): Promise<void> {
  if (!cacheDir) return;
  const cache = await readCache(cacheDir);
  if (cache[dimension]) {
    delete cache[dimension];
    await writeCache(cacheDir, cache);
  }
}
