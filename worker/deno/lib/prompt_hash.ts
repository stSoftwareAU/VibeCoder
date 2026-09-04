/**
 * Prompt content SHA-256 computation utility (Issue #1271, #1325).
 *
 * Computes SHA-256 hashes of static prompt template content on a per-repo
 * basis. Since system and agent prompts seldom change, their SHA can be
 * used as a stable cache key to avoid recomputation and maximise Claude's
 * token caching.
 *
 * Issue #1325: Includes injected CLAUDE.md/AGENTS.md content in the hash
 * so the cache correctly invalidates when these files change.
 *
 * Uses Deno's built-in crypto.subtle API (Web Crypto) — no external
 * dependencies required.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { loadPrompt } from "./prompt_manager.ts";
import { loadCustomPromptTemplate } from "./custom_prompt_loader.ts";

/** Static prompt component names whose content forms the hash input. */
const STATIC_PROMPT_COMPONENTS = ["coding_guidelines", "issue"] as const;

/**
 * Compute the SHA-256 hex digest of the given content string.
 *
 * Uses Deno's built-in Web Crypto API — deterministic and dependency-free.
 *
 * @param content - The string content to hash
 * @returns The lowercase hex SHA-256 digest (64 characters)
 */
export async function computePromptHash(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute a SHA-256 hash of the combined static prompt content for a repo.
 *
 * Loads the static prompt components (coding guidelines, issue template) via
 * prompt_manager, concatenates them with the repo name and any per-repo
 * custom instructions, and returns the hash.
 *
 * The hash covers only static content that rarely changes between
 * invocations. Dynamic content (issue number, title, body, labels) is
 * intentionally excluded.
 *
 * @param promptsDir - Path to the prompts directory
 * @param repoName - Repository identifier (e.g. "org/repo") for per-repo differentiation
 * @param customInstructions - Optional per-repo custom instructions
 * @param repoContextContent - Optional CLAUDE.md/AGENTS.md content (Issue #1325)
 * @param verbosityLevel - Optional verbosity level for cache differentiation (Issue #1332)
 * @param customPromptPath - Optional operator custom prompt template path
 *   (Issue #848). Its **content** joins the hash input, so editing the
 *   operator's file invalidates the cached system prompt exactly as editing a
 *   built-in template does. A file that cannot be loaded fails the hash rather
 *   than silently hashing the built-in templates alone.
 * @returns Result containing the 64-character hex SHA-256 digest, or an error
 */
export async function computeStaticPromptHash(
  promptsDir: string,
  repoName: string,
  customInstructions?: string,
  repoContextContent?: string,
  verbosityLevel?: string,
  customPromptPath?: string,
): Promise<Result<string>> {
  const parts: string[] = [];

  // Include repo name for per-repo differentiation
  parts.push(`repo:${repoName}`);

  // Load each static prompt component. Issue #844: the template content is
  // itself hashed, so an edit to `prompt.md` changes the key without needing
  // a version identifier alongside it.
  for (const component of STATIC_PROMPT_COMPONENTS) {
    const loadResult = await loadPrompt(component, promptsDir);
    if (!loadResult.ok) {
      return {
        ok: false,
        error: new Error(
          `Failed to load prompt '${component}': ${loadResult.error.message}`,
        ),
      };
    }

    parts.push(`${component}:${loadResult.value}`);
  }

  // The operator's custom prompt replaces the built-in `issue` template for
  // this run (Issue #848), so its content belongs in the key: an edit to the
  // file must invalidate the cached prompt, and two labels pointing at
  // different files must not share one cache entry.
  if (customPromptPath) {
    const customResult = await loadCustomPromptTemplate(customPromptPath);
    if (!customResult.ok) {
      return {
        ok: false,
        error: new Error(
          `Failed to load the custom prompt: ${customResult.error.message}`,
        ),
      };
    }
    parts.push(`custom-prompt:${customPromptPath}:${customResult.value}`);
  }

  // Append per-repo custom instructions if provided
  if (customInstructions) {
    parts.push(`custom:${customInstructions}`);
  }

  // Include repo context (CLAUDE.md/AGENTS.md) in the hash (Issue #1325)
  if (repoContextContent) {
    parts.push(`repo-context:${repoContextContent}`);
  }

  // Include verbosity level in the hash so different levels produce
  // different cache keys (Issue #1332). Only non-standard levels are
  // included — omitting it for "standard" preserves backward compatibility
  // with existing cache entries.
  if (verbosityLevel && verbosityLevel !== "standard") {
    parts.push(`verbosity:${verbosityLevel}`);
  }

  const combined = parts.join("\n---\n");
  const hash = await computePromptHash(combined);
  return { ok: true, value: hash };
}
