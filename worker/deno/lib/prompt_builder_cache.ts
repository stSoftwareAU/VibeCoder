/**
 * Cached prompt builder integration (Issue #1273, #1325).
 *
 * Wraps prompt_builder.ts with SHA-based prompt caching from prompt_cache.ts
 * and prompt_hash.ts. On cache hit, the static system prompt (coding
 * guidelines + repo context) is returned from disk without re-reading and
 * re-assembling templates. On cache miss, the prompt is assembled normally,
 * cached for future invocations, and returned.
 *
 * Issue #1325: Includes CLAUDE.md/AGENTS.md content in the SHA hash
 * so the cache correctly invalidates when these files change.
 *
 * This integration ensures byte-identical static prompt content across
 * consecutive Claude invocations for the same repository, maximising
 * Claude's built-in token caching hit rate (70-90% cost reduction).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import {
  buildIssuePrompt,
  type IssuePromptOptions,
  type PromptParts,
} from "./prompt_builder.ts";
import { PromptCache } from "./prompt_cache.ts";
import { computeStaticPromptHash } from "./prompt_hash.ts";
import { promptOverrideForPhase } from "./prompt_override_resolver.ts";
import {
  describeVolatileTokens,
  findVolatilePrefixTokens,
} from "./prompt_prefix.ts";

/**
 * Extended PromptParts with SHA-based cache metadata for monitoring (Issue #1273).
 *
 * Includes all fields from PromptParts plus:
 * - `promptSha`: The SHA-256 hash of the static prompt components
 * - `cacheHit`: Whether the system prompt was served from cache
 */
export interface CachedPromptParts extends PromptParts {
  /** SHA-256 hash of the static prompt content (64-character hex). */
  promptSha: string;
  /** Whether the prompt cache was hit (true) or missed (false). */
  cacheHit: boolean;
}

/**
 * Options for building a cached issue prompt.
 *
 * Extends IssuePromptOptions with optional cache and logger dependencies.
 */
export interface CachedIssuePromptOptions extends IssuePromptOptions {
  /** Prompt compilation cache instance. Omit to skip caching. */
  cache?: PromptCache;
  /** Logger for SHA and cache status messages. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Per-repo SHA change tracking
// ---------------------------------------------------------------------------

/**
 * Tracks the last known SHA per repository for change detection.
 *
 * When a repo's SHA changes (e.g. because templates or custom instructions
 * were updated), a notice is logged so operators can see that the prompt
 * cache was invalidated.
 */
const lastKnownSha = new Map<string, string>();

/**
 * Reset the SHA tracker. Primarily for testing isolation.
 */
export function resetShaTracker(): void {
  lastKnownSha.clear();
}

// ---------------------------------------------------------------------------
// Cached prompt building
// ---------------------------------------------------------------------------

/**
 * Build an issue prompt with SHA-based cache integration.
 *
 * This is the primary integration point between the prompt builder pipeline
 * and the SHA-based prompt cache. It:
 *
 * 1. Computes the SHA-256 hash of static prompt components (coding guidelines,
 *    issue template, repo name, custom instructions)
 * 2. Checks the prompt cache for a cached system prompt matching the SHA
 * 3. On cache hit: returns the cached system prompt (skipping re-assembly)
 * 4. On cache miss: delegates to `buildIssuePrompt()` for normal assembly,
 *    caches the resulting system prompt, and returns it
 * 5. Returns a `CachedPromptParts` with SHA and cache hit/miss metadata
 *
 * If no `cache` instance is provided, falls back to uncached assembly
 * (equivalent to calling `buildIssuePrompt()` directly, plus SHA computation).
 *
 * @param options - Issue prompt options extended with cache and logger
 * @returns Result containing CachedPromptParts with SHA and cache metadata
 */
export async function buildCachedIssuePrompt(
  options: CachedIssuePromptOptions,
): Promise<Result<CachedPromptParts>> {
  const { cache, logger, ...issueOptions } = options;
  const {
    repo,
    customInstructions,
    promptsDir,
    repoContextContent,
    verbosityLevel,
    customPromptPath,
    promptOverrides,
  } = issueOptions;

  // Step 1: Compute SHA of static prompt components (including repo context — Issue #1325,
  // verbosity level — Issue #1332, an operator's custom prompt — Issue #848).
  // A `work-on` override (Issue #849) is the same substitution by another
  // route, so it joins the key too — otherwise editing the override would
  // re-serve a hash that names the built-in template.
  const operatorTemplate = customPromptPath ??
    promptOverrideForPhase(promptOverrides, "issue")?.promptPath;
  const shaResult = await computeStaticPromptHash(
    promptsDir ?? "prompts",
    repo,
    customInstructions,
    repoContextContent,
    verbosityLevel,
    operatorTemplate,
  );
  if (!shaResult.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to compute prompt SHA: ${shaResult.error.message}`,
      ),
    };
  }

  const sha = shaResult.value;

  // Step 2: Detect SHA change and log notice
  const previousSha = lastKnownSha.get(repo);
  if (previousSha !== undefined && previousSha !== sha) {
    logger?.info(
      `Prompt SHA changed for ${repo}: ${previousSha.slice(0, 12)}... -> ${
        sha.slice(0, 12)
      }... (cache invalidated)`,
    );
  }
  lastKnownSha.set(repo, sha);

  // Step 3: Build the full prompt (we always need the dynamic part)
  // If cache is available, try to serve the system prompt from cache.
  const built = cache
    ? await buildWithCache(cache, sha, issueOptions, logger)
    : await buildWithoutCache(sha, issueOptions);

  // Step 4: Guard the cacheable prefix (Issue #4282). A volatile token here
  // defeats Anthropic prompt caching for everything behind it.
  if (built.ok) {
    warnOnVolatileSystemPrompt(built.value.systemPrompt, repo, logger);
  }

  return built;
}

/**
 * Build the prompt with cache integration.
 *
 * Checks the cache for the system prompt. On hit, builds only the dynamic
 * portion. On miss, builds everything and caches the system prompt.
 */
async function buildWithCache(
  cache: PromptCache,
  sha: string,
  issueOptions: IssuePromptOptions,
  logger?: Logger,
): Promise<Result<CachedPromptParts>> {
  const { repo } = issueOptions;

  // Record stats before the cache lookup to determine hit/miss
  const statsBefore = cache.getStats();

  // Use getOrSet for the system prompt — the assembler is called on miss
  const cachedSystemPrompt = await cache.getOrSet(
    repo,
    sha,
    async () => {
      // Assemble system prompt by building the full prompt and extracting
      // the system prompt portion.
      const fullResult = await buildIssuePrompt(issueOptions);
      if (!fullResult.ok) return fullResult;
      return { ok: true as const, value: fullResult.value.systemPrompt };
    },
  );

  if (!cachedSystemPrompt.ok) {
    return {
      ok: false,
      error: cachedSystemPrompt.error,
    };
  }

  // Determine cache hit by comparing stats
  const statsAfter = cache.getStats();
  const cacheHit = statsAfter.hits > statsBefore.hits;

  // Build the dynamic part (always fresh)
  const dynamicResult = await buildIssuePrompt(issueOptions);
  if (!dynamicResult.ok) return dynamicResult;

  // Log cache status
  if (logger) {
    logPromptCacheInfo({ repo, promptSha: sha, cacheHit, logger });
  }

  return {
    ok: true,
    value: {
      systemPrompt: cachedSystemPrompt.value,
      prompt: dynamicResult.value.prompt,
      promptSha: sha,
      cacheHit,
    },
  };
}

/**
 * Build the prompt without cache (fallback path).
 */
async function buildWithoutCache(
  sha: string,
  issueOptions: IssuePromptOptions,
): Promise<Result<CachedPromptParts>> {
  const fullResult = await buildIssuePrompt(issueOptions);
  if (!fullResult.ok) return fullResult;

  return {
    ok: true,
    value: {
      systemPrompt: fullResult.value.systemPrompt,
      prompt: fullResult.value.prompt,
      promptSha: sha,
      cacheHit: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Stable-prefix guard (Issue #4282)
// ---------------------------------------------------------------------------

/**
 * Warn when the cached system prompt carries a token that cannot repeat.
 *
 * The system prompt is the one part of the request that is byte-stable across
 * runs, which is exactly why Anthropic can serve it from cache. A timestamp, a
 * run id, or a stray fence nonce landing in it silently drops the whole prompt
 * behind it back to full input price — so the guard names the offending tokens
 * rather than letting the spend double quietly.
 *
 * Reports rather than throws: a noisy prefix is a cost regression, not a reason
 * to abandon a run that would otherwise succeed.
 *
 * @param systemPrompt - The assembled system prompt
 * @param repo - Repository the prompt was built for
 * @param logger - Logger for the warning
 * @returns True when volatile tokens were found (and warned about)
 */
export function warnOnVolatileSystemPrompt(
  systemPrompt: string,
  repo: string,
  logger?: Logger,
): boolean {
  const tokens = findVolatilePrefixTokens(systemPrompt);
  if (tokens.length === 0) return false;
  logger?.warn(
    `Prompt prefix is not cacheable for ${repo}: the system prompt carries ` +
      `${tokens.length} volatile token(s) — ${
        describeVolatileTokens(tokens)
      }. Anthropic prompt caching only reuses a byte-identical prefix, so ` +
      `every token after the first of these is re-charged at full input price.`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Logging utilities
// ---------------------------------------------------------------------------

/**
 * Log prompt SHA and cache hit/miss status.
 *
 * Call this at each Claude invocation to track prompt stability and cache
 * effectiveness over time. The log output includes:
 * - Repository identifier
 * - Truncated SHA (first 12 characters) for readability
 * - Cache hit/miss status
 *
 * @param options - Logging context
 */
export function logPromptCacheInfo(options: {
  repo: string;
  promptSha: string;
  cacheHit: boolean;
  logger: Logger;
}): void {
  const { repo, promptSha, cacheHit, logger } = options;
  const shaPrefix = promptSha.slice(0, 12);
  const status = cacheHit ? "hit" : "miss";
  logger.info(
    `Prompt cache: repo=${repo} sha=${shaPrefix}... status=${status}`,
  );
}
