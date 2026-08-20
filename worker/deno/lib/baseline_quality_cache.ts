/**
 * Content-keyed baseline quality cache (Issue #4283).
 *
 * A single issue used to run the full quality gate up to three times: the
 * worker's baseline gate before the agent, the agent's own `./quality.sh`,
 * and the worker's post-Claude gate. On the worker's own 13k-test suite the
 * baseline run alone costs several minutes, and it is pure duplicate work
 * whenever consecutive issues start from the same freshly-reset checkout.
 *
 * This cache removes that duplicate work without removing coverage: the
 * recorded baseline outcome is reused only when the tree content is
 * provably identical — same repo, same HEAD SHA, and a clean working tree
 * (`git status --porcelain` empty, which also rules out untracked files).
 * Any ambiguity — dirty tree, a git command that fails, a malformed SHA, a
 * corrupt cache file, an entry past its TTL — yields no key or no entry, and
 * the caller falls back to running the full gate.
 *
 * Reuse is safe in both directions: a cached PASS makes the post-Claude gate
 * stricter (every failure counts as new), and a cached FAIL carries the same
 * findings the re-run would have produced from byte-identical content.
 *
 * Set `VIBE_CODER_BASELINE_QUALITY_CACHE=0` to disable reuse entirely.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { GitCommandOutput } from "./git_timeout.ts";
import { legacyHomeCachePath, workerCachePath } from "./worker_cache_dir.ts";
import type { DiffableCheck, GenericFinding } from "./baseline_gate.ts";

/**
 * 24-hour time-to-live. Identical content yields an identical gate result,
 * but the toolchain around it (Deno version, container image, remote
 * dependencies) does drift, so entries are not kept indefinitely.
 */
export const BASELINE_QUALITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Keep the cache file small — one entry per repo/SHA recently gated. */
export const MAX_BASELINE_QUALITY_CACHE_ENTRIES = 20;

/** Cap on the stored gate output; the tail carries the failure summary. */
export const MAX_CACHED_OUTPUT_CHARS = 20_000;

/** Bumped whenever the entry shape or the gate options change. */
export const BASELINE_QUALITY_CACHE_VERSION = 1;

/** Environment variable that disables baseline reuse when falsy. */
export const BASELINE_QUALITY_CACHE_ENV = "VIBE_CODER_BASELINE_QUALITY_CACHE";

const DISABLING_VALUES = new Set(["0", "false", "off", "no"]);
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const DIFFABLE_CHECKS: ReadonlySet<string> = new Set([
  "mermaid",
  "markdownlint",
  "docs",
]);

/** One recorded baseline outcome. */
export interface BaselineQualityCacheEntry {
  version: number;
  /** Whether the baseline gate passed on this exact tree. */
  passed: boolean;
  /** Gate output (tail-truncated); empty when the gate passed. */
  output: string;
  /**
   * Diffable findings captured alongside the gate (Issue #2604). Absent
   * when the baseline-aware gate was disabled or capture failed — the
   * caller then treats the entry as unusable for that purpose.
   */
  findings?: GenericFinding[];
  /** Epoch milliseconds the entry was written. */
  storedAt: number;
  /**
   * Monotonically increasing write sequence (Issue #4342). `storedAt` alone
   * cannot order a burst of writes that shares a millisecond on a fast host,
   * so the prune orders by this instead. Absent on entries written before
   * the sequence existed; those fall back to `storedAt`.
   */
  seq?: number;
}

/** The outcome fields a caller records; the rest is filled in here. */
export interface BaselineQualityOutcome {
  passed: boolean;
  output: string;
  findings?: GenericFinding[];
}

/** Minimal git runner — matches `runGitCommand` from `git_timeout.ts`. */
export type GitRunner = (
  args: string[],
  options?: { cwd?: string },
) => Promise<Result<GitCommandOutput>>;

/** Injectable environment reader so the kill switch is unit-testable. */
export interface BaselineQualityCacheKeyDeps {
  readEnv?: (key: string) => string | undefined;
}

/** Whether baseline reuse is enabled (kill switch off). */
export function isBaselineQualityCacheEnabled(
  readEnv: (key: string) => string | undefined = (key) => Deno.env.get(key),
): boolean {
  let raw: string | undefined;
  try {
    raw = readEnv(BASELINE_QUALITY_CACHE_ENV);
  } catch {
    // No env permission — treat the cache as enabled; reuse still requires
    // a clean tree and a matching key.
    return true;
  }
  return !DISABLING_VALUES.has((raw ?? "").trim().toLowerCase());
}

/**
 * Path of the persistent cache file — on the durable work volume (Issue
 * #4318): `$HOME/.vibe-coder` is root-owned in container mode, so writes
 * there failed silently every issue and the cache never persisted.
 * Returns `undefined` when `WORK_DIR` is unset — there is no cache
 * directory then, and the whole cache is a no-op (Issues #131, #133):
 * nothing is read, nothing is written, and no directory is ever created
 * on the host.
 */
export function baselineQualityCachePath(): string | undefined {
  return workerCachePath(BASELINE_QUALITY_CACHE_FILE);
}

/** File name of the cache within the worker cache directory. */
export const BASELINE_QUALITY_CACHE_FILE = "baseline-quality-cache.json";

/**
 * Compute the content key for the checkout at `repoPath`, or `null` when the
 * content cannot be pinned down exactly (dirty tree, git failure, malformed
 * SHA, cache disabled). A `null` key means "run the full gate".
 */
export async function computeBaselineQualityCacheKey(
  repo: string,
  repoPath: string,
  runGit: GitRunner,
  deps: BaselineQualityCacheKeyDeps = {},
): Promise<string | null> {
  if (!isBaselineQualityCacheEnabled(deps.readEnv)) return null;

  const status = await runGit(["status", "--porcelain"], { cwd: repoPath });
  if (!status.ok || status.value.code !== 0) return null;
  // Any modification, staged change, or untracked file makes the tree
  // content differ from the commit — no reuse.
  if (status.value.stdout.trim() !== "") return null;

  const head = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
  if (!head.ok || head.value.code !== 0) return null;

  const sha = head.value.stdout.trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) return null;

  return `${repo}@${sha}`;
}

/** Read the whole cache file, dropping anything malformed. */
async function loadCache(
  path: string | undefined,
): Promise<Map<string, BaselineQualityCacheEntry>> {
  // No cache directory (WORK_DIR unset — Issue #133): report "no cached
  // baseline" without touching the filesystem, so the caller re-runs the
  // baseline gate — the correct uncached behaviour on a host-side run.
  if (path === undefined) return new Map();

  let text: string | null = null;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    // Fall through to the legacy location below.
  }
  if (text === null) {
    // Legacy-location fallback (Issue #4318): a native host that cached
    // under $HOME/.vibe-coder keeps its warm cache across the move. Read
    // only — it never creates a directory.
    if (path === baselineQualityCachePath()) {
      try {
        text = await Deno.readTextFile(
          legacyHomeCachePath(BASELINE_QUALITY_CACHE_FILE),
        );
      } catch {
        return new Map();
      }
    } else {
      return new Map();
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return new Map();
  }

  const cache = new Map<string, BaselineQualityCacheEntry>();
  for (const [key, value] of Object.entries(parsed)) {
    const entry = validateEntry(value);
    if (entry) cache.set(key, entry);
  }
  return cache;
}

/** Validate one persisted entry; returns null when the shape is wrong. */
function validateEntry(value: unknown): BaselineQualityCacheEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.passed !== "boolean" ||
    typeof record.output !== "string" ||
    typeof record.storedAt !== "number" ||
    typeof record.version !== "number"
  ) {
    return null;
  }

  const entry: BaselineQualityCacheEntry = {
    version: record.version,
    passed: record.passed,
    output: record.output,
    storedAt: record.storedAt,
  };

  if (record.seq !== undefined) {
    // A malformed sequence would corrupt the prune order — drop the entry
    // rather than silently guessing a position for it.
    if (typeof record.seq !== "number" || !Number.isFinite(record.seq)) {
      return null;
    }
    entry.seq = record.seq;
  }

  if (record.findings !== undefined) {
    const findings = validateFindings(record.findings);
    if (!findings) return null;
    entry.findings = findings;
  }
  return entry;
}

/** Validate the persisted diffable findings list. */
function validateFindings(value: unknown): GenericFinding[] | null {
  if (!Array.isArray(value)) return null;
  const findings: GenericFinding[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.check !== "string" ||
      !DIFFABLE_CHECKS.has(record.check) ||
      typeof record.key !== "string" ||
      typeof record.display !== "string"
    ) {
      return null;
    }
    findings.push({
      check: record.check as DiffableCheck,
      key: record.key,
      display: record.display,
    });
  }
  return findings;
}

/**
 * Return the recorded outcome for `key` when it is present, current, and
 * written by this cache version; otherwise `null`. An `undefined` path (no
 * cache directory — WORK_DIR unset, Issue #133) always misses, so the
 * caller re-runs the baseline gate.
 */
export async function readBaselineQualityCache(
  key: string,
  path: string | undefined = baselineQualityCachePath(),
): Promise<BaselineQualityCacheEntry | null> {
  const entry = (await loadCache(path)).get(key);
  if (!entry) return null;
  if (entry.version !== BASELINE_QUALITY_CACHE_VERSION) return null;
  if (Date.now() - entry.storedAt >= BASELINE_QUALITY_CACHE_TTL_MS) return null;
  return entry;
}

/**
 * Next write sequence for `cache`: one past the highest one already stored.
 * Monotonic per cache file, so the order survives writes that share a
 * millisecond and re-loads that reshuffle the map's insertion order.
 */
function nextSequence(cache: Map<string, BaselineQualityCacheEntry>): number {
  let highest = 0;
  for (const entry of cache.values()) {
    if (entry.seq !== undefined && entry.seq > highest) highest = entry.seq;
  }
  return highest + 1;
}

/**
 * Record the baseline outcome for `key`, pruning the oldest entries so the
 * file stays bounded. Throws only if the file cannot be written — callers
 * treat a write failure as non-fatal. An `undefined` path (no cache
 * directory — WORK_DIR unset, Issue #133) returns without creating any
 * directory or file, and without throwing: an absent cache dir is expected
 * on a host-side run, not a fault, so no warning is logged either.
 */
export async function writeBaselineQualityCache(
  key: string,
  outcome: BaselineQualityOutcome,
  path: string | undefined = baselineQualityCachePath(),
): Promise<void> {
  if (path === undefined) return;
  const cache = await loadCache(path);
  cache.set(key, {
    version: BASELINE_QUALITY_CACHE_VERSION,
    passed: outcome.passed,
    output: outcome.output.slice(-MAX_CACHED_OUTPUT_CHARS),
    ...(outcome.findings ? { findings: outcome.findings } : {}),
    storedAt: Date.now(),
    seq: nextSequence(cache),
  });

  // Newest first, ordered by the write sequence rather than the clock: a
  // burst of writes inside one millisecond ties on `storedAt`, so ordering
  // by time alone pruned an arbitrary subset (Issue #4342). Entries written
  // before the sequence existed have no `seq`; they sort below every
  // sequenced entry and fall back to `storedAt` among themselves.
  const kept = [...cache.entries()]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      (b.entry[1].seq ?? 0) - (a.entry[1].seq ?? 0) ||
      b.entry[1].storedAt - a.entry[1].storedAt ||
      b.index - a.index
    )
    .slice(0, MAX_BASELINE_QUALITY_CACHE_ENTRIES)
    .map(({ entry }) => entry);

  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    await Deno.mkdir(path.slice(0, slash), { recursive: true });
  }
  await Deno.writeTextFile(
    path,
    JSON.stringify(Object.fromEntries(kept), null, 2),
  );
}
