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
 * The cache keys each dimension on a **content digest** of its input set:
 *
 * - `deno tests` is keyed on the whole working tree as git sees it
 *   ({@link computeWorkingTreeDigest}, Issue #3392), because the tests read
 *   non-TS inputs too (CODING-STANDARDS.md, docs, prompts, workflows and
 *   container files). A `.ts`-only key reused a stale PASS after such an edit.
 * - `deno check` is keyed on {@link computeQualityInputDigest} (every `.ts`
 *   file under `worker/deno`, ignored or not, plus `deno.json`, `deno.lock`
 *   and the pinned `.deno-version`) **and** on {@link computeWorkingTreeDigest}
 *   (PR #3522 review). It type-checks `tests/**`, which import `.ts` files
 *   outside `worker/deno` (`.claude/skills/review-fleet-prs/scripts/*.ts`),
 *   and `deno test` runs with `--no-check`, so this stage is the only type
 *   check. See `denoCheckDigest` in `quality_gate.ts`.
 *
 * A cached PASS is reused only when the current digest is byte-for-byte
 * identical to the one that last passed. A FAIL is never cached, so a broken
 * tree is re-checked every time until it is fixed. A skip is only as sound as
 * its key, though: an input outside the key (an ignored or excluded file,
 * environment variables, the network, files outside the repository) can still
 * change a result without busting the cache.
 *
 * The cache lives in the worker's cache directory on the work volume, so it
 * survives between the agent's repeated in-session runs but is disposable.
 * When no cache directory is resolvable (a host dev run), caching is simply
 * off — never a source of a wrong answer.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { runGitCommand } from "./git_timeout.ts";

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
 * Compute the `.ts` half of the `deno check` input digest: every `.ts` file
 * under `denoDir`, plus the dependency/config/toolchain pins. Path is folded in
 * with content so a rename changes the digest. It does not see `.ts` files
 * outside `denoDir` that the checked files import; `denoCheckDigest` pairs it
 * with {@link computeWorkingTreeDigest} for those.
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

/** Run git via the spawn chokepoint; trimmed stdout on exit 0, else null. */
async function runGit(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string | null> {
  const result = await runGitCommand(args, { cwd, env });
  return result.ok && result.value.code === 0
    ? result.value.stdout.trim()
    : null;
}

/**
 * Compute the `deno tests` input digest (Issue #3392): the git tree object id
 * of the whole working tree, so an edit to any file git would track (tracked
 * plus untracked non-ignored, including `deno.lock` and `.deno-version`)
 * changes it. Files ignored by `.gitignore` or `.git/info/exclude` are not
 * covered.
 *
 * It stages into a private copy of the index (`GIT_INDEX_FILE`), so the real
 * index is only read, never written (the copy keeps the real index's mtime so
 * git's racy-clean check still works). It does write blob objects into the
 * object store, which is additive only. The `git-tree:` prefix means a bare
 * sha-256 key from the older `.ts`-only scheme can never match.
 *
 * @param repoRoot - The repository root (working tree top level).
 * @param tempRoot - Directory to hold the private index copy; defaults to the
 *   system temp directory. A seam so a test can assert on a directory it owns.
 * @returns `git-tree:<oid>`, or null when it cannot be computed (not a git
 *   repo, git failure): caching is then off.
 */
export async function computeWorkingTreeDigest(
  repoRoot: string,
  tempRoot?: string,
): Promise<string | null> {
  let tmp: string | undefined;
  try {
    const rel = await runGit(["rev-parse", "--git-path", "index"], repoRoot);
    if (!rel) return null;
    const realIndex = rel.startsWith("/") ? rel : `${repoRoot}/${rel}`;
    tmp = await Deno.makeTempDir({
      prefix: "vibe_gate_index_",
      ...(tempRoot ? { dir: tempRoot } : {}),
    });
    const tmpIndex = `${tmp}/index`;
    try {
      await Deno.copyFile(realIndex, tmpIndex);
      // copyFile stamps the copy "now"; carry the real index's timestamps over
      // so git's racy-clean check still re-hashes an entry edited in the same
      // second as the index write (same size, in place). PR #3522 review.
      const st = await Deno.stat(realIndex);
      if (st.mtime) await Deno.utime(tmpIndex, st.atime ?? st.mtime, st.mtime);
    } catch (error) {
      // A fresh repo has no index yet: start empty.
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const env = { GIT_INDEX_FILE: tmpIndex };
    if (await runGit(["add", "-A"], repoRoot, env) === null) return null;
    const oid = await runGit(["write-tree"], repoRoot, env);
    if (oid === null) return null;
    return `git-tree:${oid}`;
  } catch (error) {
    console.warn(
      `Quality gate cache is off for this run (could not digest the working tree): ${error}`,
    );
    return null;
  } finally {
    if (tmp) {
      const dir = tmp;
      await Deno.remove(dir, { recursive: true }).catch((error) =>
        console.warn(`Could not remove ${dir}: ${error}`)
      );
    }
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
