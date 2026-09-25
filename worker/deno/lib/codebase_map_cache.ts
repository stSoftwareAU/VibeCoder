/**
 * Per-repo codebase map cache (Issue #4281).
 *
 * Generating the map costs a `git ls-files` plus a bounded set of file-head
 * reads. That is cheap, but it is not free and the result is identical run
 * after run, so it is cached on disk exactly as the compiled prompt is
 * (Issue #1272) — same {@link PromptCache} store, keyed by the repository's
 * **tree hash** instead of a prompt SHA:
 *
 * - **Structure change** — a file added, removed, or moved changes the tree
 *   hash, so the next run regenerates.
 * - **Cadence refresh** — the TTL bounds drift the tree hash cannot see, such
 *   as an edited docstring inside an otherwise unchanged tree.
 *
 * A generation fault is returned to the caller, never swallowed into an empty
 * map (Issue #3234): the caller logs it and runs without the map, which is the
 * pre-#4281 behaviour rather than a silently blank index.
 *
 * An optional brief runner (Issue #2602) adds Cargo commands for a repository
 * with a root `Cargo.toml`. With no runner the map, the cache key and the
 * behaviour are exactly the pre-#2602 ones:
 *
 * ```mermaid
 * flowchart TD
 *   A[list files, tree hash] --> B{runner passed?}
 *   B -- no --> K1["key = treeHash · brief off: no runner"]
 *   B -- yes --> C{root Cargo.toml?}
 *   C -- no --> K2["key = treeHash · brief off: no Cargo.toml"]
 *   C -- yes --> K3["key = hash(treeHash, brief on, version)"]
 *   K3 --> H{cache hit?}
 *   H -- yes --> O1["brief ok · cached, 0s — brief not spawned"]
 *   H -- no --> R[run brief]
 *   R -- ok --> O2[render with Cargo block, cache, brief ok · seconds]
 *   R -- failed --> O3[warn, render today's map, do NOT cache]
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  type CodebaseMapOptions,
  computeTreeHash,
  listRepoFiles,
  renderCodebaseMap,
} from "./codebase_map.ts";
import { PromptCache } from "./prompt_cache.ts";
import { sharedTmpStateDir } from "./private_cache_dir.ts";
import type { BriefRunner, BriefRunResult } from "./brief_toolchain.ts";
import { computePromptHash } from "./prompt_hash.ts";
import { createLogger } from "./logger.ts";

/**
 * Default cache directory for generated codebase maps (Issue #1215).
 *
 * Was the fixed literal `/tmp/vibe-codebase-map-deno` — one path for every
 * account on the host, holding text that is injected verbatim into the
 * agent's prompt. It now carries a per-account suffix, and `PromptCache`
 * ownership-checks any directory under the shared temporary root.
 */
export function defaultCodebaseMapCacheDir(
  lookup?: (key: string) => string | undefined,
): string {
  return lookup === undefined
    ? sharedTmpStateDir("vibe-codebase-map-deno")
    : sharedTmpStateDir("vibe-codebase-map-deno", lookup);
}

/**
 * Default cadence refresh in seconds (6 hours).
 *
 * Shorter than the prompt cache's 24 hours: the tree hash misses content-only
 * drift, so the TTL is the only thing that keeps stale docstrings out.
 */
export const DEFAULT_CODEBASE_MAP_TTL_SECONDS = 21_600;

/** A codebase map served from cache or freshly generated. */
export interface CachedCodebaseMap {
  /** The rendered map. */
  content: string;
  /** Tree hash the map was generated from — the cache key. */
  treeHash: string;
  /** Whether the map came from cache rather than being generated. */
  cacheHit: boolean;
  /** What brief contributed to this map (Issue #2602), for run reporting. */
  brief: BriefOutcome;
}

/** brief's part in one map (Issue #2602). */
export type BriefOutcome =
  | { status: "ok"; seconds: number; cached?: true }
  | { status: "failed"; reason: string }
  | { status: "off"; reason: "no runner" | "no Cargo.toml" };

/** The brief runner and the version it runs — the version keys the cache. */
export interface BriefMapSource {
  runner: BriefRunner;
  version: string;
}

/** Options for {@link getOrGenerateCodebaseMap}. */
export interface GetOrGenerateCodebaseMapOptions extends CodebaseMapOptions {
  /** Repository identifier (e.g. "org/repo") used in the cache key. */
  repo: string;
  /** Path to the repository checkout. */
  repoDir: string;
  /** Cache instance. Omit to build one from `cacheDir`/`ttlSeconds`. */
  cache?: PromptCache;
  /** Cache directory when no instance is supplied. */
  cacheDir?: string;
  /** Cadence refresh in seconds when no instance is supplied. */
  ttlSeconds?: number;
  /** brief runner and version (Issue #2602). Omit for today's map. */
  brief?: BriefMapSource;
  /** Warning sink for a failed brief run (default: the worker logger). */
  warn?: (message: string) => void;
}

/**
 * Return the repository's codebase map, generating it only when needed.
 *
 * @param options - Repository, cache, and map-size settings
 * @returns Result containing the map, its tree hash, and the cache verdict
 */
export async function getOrGenerateCodebaseMap(
  options: GetOrGenerateCodebaseMapOptions,
): Promise<Result<CachedCodebaseMap>> {
  const {
    repo,
    repoDir,
    cache,
    cacheDir,
    ttlSeconds,
    brief,
    warn,
    ...mapOptions
  } = options;

  const filesResult = await listRepoFiles(repoDir);
  if (!filesResult.ok) return filesResult;

  const files = filesResult.value;
  const treeHash = await computeTreeHash(files);

  const store = cache ?? new PromptCache({
    cacheDir: cacheDir ?? defaultCodebaseMapCacheDir(),
    ttlSeconds: ttlSeconds ?? DEFAULT_CODEBASE_MAP_TTL_SECONDS,
  });

  // brief runs only for a repository with a root Cargo.toml; otherwise its
  // map is today's, so it shares today's bare tree-hash key.
  const briefOn = brief !== undefined && files.includes("Cargo.toml");
  const off: BriefOutcome = {
    status: "off",
    reason: brief === undefined ? "no runner" : "no Cargo.toml",
  };
  const cacheKey = briefOn
    ? await computePromptHash(
      `${treeHash}\nbrief=on\nversion=${brief.version}`,
    )
    : treeHash;

  const cached = await store.get(repo, cacheKey);
  if (cached.ok && cached.value !== null) {
    return {
      ok: true,
      value: {
        content: cached.value,
        treeHash,
        cacheHit: true,
        brief: briefOn ? { status: "ok", cached: true, seconds: 0 } : off,
      },
    };
  }

  let outcome: BriefOutcome = off;
  let briefCommands: string[] | undefined;
  if (briefOn) {
    const run = await runBrief(brief.runner, repoDir);
    if (run.status === "ok") {
      briefCommands = run.commands;
      outcome = { status: "ok", seconds: run.seconds };
    } else {
      (warn ?? ((m) => createLogger().warn(m)))(
        `brief failed for ${repo} (codebase map falls back to no Cargo commands): ${run.reason}`,
      );
      outcome = { status: "failed", reason: run.reason };
    }
  }

  const rendered = await renderCodebaseMap(
    repoDir,
    files,
    briefCommands === undefined ? mapOptions : { ...mapOptions, briefCommands },
  );
  if (!rendered.ok) return rendered;

  // A map rendered after brief failed is never cached, so the next run tries
  // brief again rather than serving the fallback for the whole TTL.
  if (outcome.status !== "failed") {
    // Drop superseded entries for this repo before writing the new one, so a
    // long-lived worker does not accumulate a map per tree hash on disk.
    await store.cleanupRepo(repo);
    await store.set(repo, cacheKey, rendered.value.content);
  }

  return {
    ok: true,
    value: {
      content: rendered.value.content,
      treeHash,
      cacheHit: false,
      brief: outcome,
    },
  };
}

/** Call the runner, turning a throw from a non-conforming runner into `failed`. */
async function runBrief(
  runner: BriefRunner,
  repoDir: string,
): Promise<BriefRunResult> {
  try {
    return await runner(repoDir);
  } catch (err) {
    return {
      status: "failed",
      reason: `brief runner threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
