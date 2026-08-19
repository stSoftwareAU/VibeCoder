/**
 * Tests for cached prompt builder integration (Issue #1273).
 *
 * Written TDD-first — these tests define the expected behaviour of the
 * prompt cache integration into the prompt builder pipeline.
 *
 * Tests verify:
 * - Cache hit skips template re-assembly; cache miss triggers normal assembly
 * - Dynamic content is never included in the cached portion
 * - SHA and cache hit/miss metadata are returned
 * - SHA change triggers a logged notice
 * - Two invocations for same repo produce byte-identical static prefix
 * - Logging captures SHA and cache status
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCachedIssuePrompt,
  type CachedPromptParts,
  logPromptCacheInfo,
  resetShaTracker,
} from "../lib/prompt_builder_cache.ts";
import { PromptCache } from "../lib/prompt_cache.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Create a temporary cache directory and a PromptCache instance. */
async function createTestCache(
  options?: { ttlSeconds?: number; nowFn?: () => number },
): Promise<{ cache: PromptCache; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "prompt-builder-cache-test-" });
  const cache = new PromptCache({
    cacheDir: dir,
    ttlSeconds: options?.ttlSeconds,
    now: options?.nowFn,
  });
  return { cache, dir };
}

/** Clean up a temporary directory. */
async function cleanup(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore — may already be removed
  }
}

// --- Cache miss triggers normal assembly ---

Deno.test("prompt builder cache - cache miss assembles prompt normally", async () => {
  const { cache, dir } = await createTestCache();
  try {
    resetShaTracker();
    const result = await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "42",
      issueTitle: "Fix the bug",
      issueBody: "The bug needs fixing.",
      issueLabels: "bug",
      qualityInstructions: "Run ./quality.sh",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      // Should have all the normal prompt content
      assertStringIncludes(result.value.prompt, "#42");
      assertStringIncludes(result.value.prompt, "org/repo");
      assertStringIncludes(result.value.prompt, "Fix the bug");
      // System prompt should contain coding guidelines
      assertStringIncludes(result.value.systemPrompt, "Australian English");
      // Cache miss on first call
      assertEquals(result.value.cacheHit, false);
      // SHA should be a 64-char hex string
      assertEquals(result.value.promptSha.length, 64);
      assertEquals(/^[0-9a-f]{64}$/.test(result.value.promptSha), true);
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Cache hit skips re-assembly ---

Deno.test("prompt builder cache - cache hit returns cached system prompt", async () => {
  const { cache, dir } = await createTestCache();
  try {
    resetShaTracker();
    // First call — cache miss, assembles normally
    const result1 = await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "1",
      issueTitle: "First issue",
      issueBody: "Body one",
      issueLabels: "bug",
      qualityInstructions: "",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    // Second call — should be a cache hit
    const result2 = await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "2",
      issueTitle: "Second issue",
      issueBody: "Body two",
      issueLabels: "enhancement",
      qualityInstructions: "",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    assertEquals(result1.ok, true);
    assertEquals(result2.ok, true);
    if (result1.ok && result2.ok) {
      assertEquals(result1.value.cacheHit, false);
      assertEquals(result2.value.cacheHit, true);
      // System prompts should be byte-identical
      assertEquals(result1.value.systemPrompt, result2.value.systemPrompt);
      // SHAs should be identical
      assertEquals(result1.value.promptSha, result2.value.promptSha);
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Dynamic content excluded from cache ---

Deno.test("prompt builder cache - dynamic content is not in the cached system prompt", async () => {
  const { cache, dir } = await createTestCache();
  try {
    resetShaTracker();
    const result = await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "99",
      issueTitle: "My unique title XYZ123",
      issueBody: "Dynamic body content ABCDEF",
      issueLabels: "dynamic-label",
      qualityInstructions: "",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      // Dynamic content should NOT be in the system prompt
      assertEquals(
        result.value.systemPrompt.includes("My unique title XYZ123"),
        false,
      );
      assertEquals(
        result.value.systemPrompt.includes("Dynamic body content ABCDEF"),
        false,
      );
      assertEquals(result.value.systemPrompt.includes("#99"), false);
      // Dynamic content should be in the user prompt
      assertStringIncludes(result.value.prompt, "My unique title XYZ123");
      assertStringIncludes(result.value.prompt, "Dynamic body content ABCDEF");
      assertStringIncludes(result.value.prompt, "#99");
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Byte-identical static prefix ---

Deno.test("prompt builder cache - two invocations produce byte-identical static prefix", async () => {
  const { cache, dir } = await createTestCache();
  try {
    resetShaTracker();
    const result1 = await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "10",
      issueTitle: "Issue A",
      issueBody: "Body A",
      issueLabels: "bug",
      qualityInstructions: "Run tests",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    const result2 = await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "20",
      issueTitle: "Issue B",
      issueBody: "Body B",
      issueLabels: "enhancement",
      qualityInstructions: "Run lint",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    assertEquals(result1.ok, true);
    assertEquals(result2.ok, true);
    if (result1.ok && result2.ok) {
      // System prompts must be byte-identical
      assertEquals(result1.value.systemPrompt, result2.value.systemPrompt);
      // Byte-for-byte comparison
      const enc = new TextEncoder();
      const bytes1 = enc.encode(result1.value.systemPrompt);
      const bytes2 = enc.encode(result2.value.systemPrompt);
      assertEquals(bytes1.length, bytes2.length);
      for (let i = 0; i < bytes1.length; i++) {
        assertEquals(bytes1[i], bytes2[i]);
      }
    }
  } finally {
    await cleanup(dir);
  }
});

// --- CachedPromptParts includes required metadata ---

Deno.test("prompt builder cache - CachedPromptParts has sha and cacheHit fields", async () => {
  const { cache, dir } = await createTestCache();
  try {
    resetShaTracker();
    const result = await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "1",
      issueTitle: "Test",
      issueBody: "Body",
      issueLabels: "test",
      qualityInstructions: "",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      // Type check — the result should have all PromptParts fields plus cache metadata
      const parts: CachedPromptParts = result.value;
      assertEquals(typeof parts.systemPrompt, "string");
      assertEquals(typeof parts.prompt, "string");
      assertEquals(typeof parts.promptSha, "string");
      assertEquals(typeof parts.cacheHit, "boolean");
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Works without cache (fallback) ---

Deno.test("prompt builder cache - works without cache instance (fallback to normal assembly)", async () => {
  resetShaTracker();
  const result = await buildCachedIssuePrompt({
    repo: "org/repo",
    issueNumber: "7",
    issueTitle: "No cache test",
    issueBody: "Body",
    issueLabels: "test",
    qualityInstructions: "",
    promptsDir: PROMPTS_DIR,
    // No cache provided
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "#7");
    assertStringIncludes(result.value.systemPrompt, "Australian English");
    assertEquals(result.value.cacheHit, false);
    assertEquals(result.value.promptSha.length, 64);
  }
});

// --- SHA change detection ---

Deno.test("prompt builder cache - SHA change triggers logged notice", async () => {
  const { cache, dir } = await createTestCache();
  try {
    resetShaTracker();
    const logMessages: string[] = [];
    const logger = {
      info: (msg: string) => logMessages.push(msg),
      warn: () => {},
      error: () => {},
      debug: () => {},
      security: () => {},
      skipReason: () => {},
      timing: () => {},
      scanSummary: () => {},
      workerSummary: () => {},
    };

    // First call — establishes initial SHA
    await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "1",
      issueTitle: "Test",
      issueBody: "Body",
      issueLabels: "test",
      qualityInstructions: "",
      promptsDir: PROMPTS_DIR,
      cache,
      logger,
    });

    // Second call with different customInstructions changes the SHA
    await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "2",
      issueTitle: "Test 2",
      issueBody: "Body 2",
      issueLabels: "test",
      qualityInstructions: "",
      customInstructions: "Use Python 3.12 only.",
      promptsDir: PROMPTS_DIR,
      cache,
      logger,
    });

    // Should have logged a SHA change notice
    const shaChangeLog = logMessages.find((msg) =>
      msg.includes("Prompt SHA changed") && msg.includes("org/repo")
    );
    assertEquals(
      shaChangeLog !== undefined,
      true,
      `Expected SHA change log but got: ${JSON.stringify(logMessages)}`,
    );
  } finally {
    await cleanup(dir);
  }
});

// --- logPromptCacheInfo formatting ---

Deno.test("prompt builder cache - logPromptCacheInfo logs SHA and cache status", () => {
  const logMessages: string[] = [];
  const logger = {
    info: (msg: string) => logMessages.push(msg),
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };

  logPromptCacheInfo({
    repo: "org/repo",
    promptSha: "a".repeat(64),
    cacheHit: true,
    logger,
  });

  assertEquals(logMessages.length >= 1, true);
  const shaLog = logMessages.find((msg) => msg.includes("aaaaaaaaaaaa"));
  assertEquals(shaLog !== undefined, true);
  const hitLog = logMessages.find((msg) => msg.includes("hit"));
  assertEquals(hitLog !== undefined, true);
});

Deno.test("prompt builder cache - logPromptCacheInfo logs miss status", () => {
  const logMessages: string[] = [];
  const logger = {
    info: (msg: string) => logMessages.push(msg),
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };

  logPromptCacheInfo({
    repo: "org/repo",
    promptSha: "b".repeat(64),
    cacheHit: false,
    logger,
  });

  const missLog = logMessages.find((msg) => msg.includes("miss"));
  assertEquals(missLog !== undefined, true);
});

// --- Custom instructions affect SHA ---

Deno.test("prompt builder cache - custom instructions change the SHA", async () => {
  const { cache, dir } = await createTestCache();
  try {
    resetShaTracker();
    const result1 = await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "1",
      issueTitle: "Test",
      issueBody: "Body",
      issueLabels: "test",
      qualityInstructions: "",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    const result2 = await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "2",
      issueTitle: "Test 2",
      issueBody: "Body 2",
      issueLabels: "test",
      qualityInstructions: "",
      customInstructions: "Use TypeScript strict mode.",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    assertEquals(result1.ok, true);
    assertEquals(result2.ok, true);
    if (result1.ok && result2.ok) {
      // Different custom instructions should produce different SHAs
      assertEquals(result1.value.promptSha !== result2.value.promptSha, true);
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Different repos produce different SHAs ---

Deno.test("prompt builder cache - different repos produce different SHAs", async () => {
  const { cache, dir } = await createTestCache();
  try {
    resetShaTracker();
    const result1 = await buildCachedIssuePrompt({
      repo: "org/repo-a",
      issueNumber: "1",
      issueTitle: "Test",
      issueBody: "Body",
      issueLabels: "test",
      qualityInstructions: "",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    const result2 = await buildCachedIssuePrompt({
      repo: "org/repo-b",
      issueNumber: "1",
      issueTitle: "Test",
      issueBody: "Body",
      issueLabels: "test",
      qualityInstructions: "",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    assertEquals(result1.ok, true);
    assertEquals(result2.ok, true);
    if (result1.ok && result2.ok) {
      // Different repos should produce different SHAs (repo name is in hash input)
      assertEquals(result1.value.promptSha !== result2.value.promptSha, true);
    }
  } finally {
    await cleanup(dir);
  }
});

// --- Cache stats reflect usage ---

Deno.test("prompt builder cache - cache statistics reflect hit/miss counts", async () => {
  const { cache, dir } = await createTestCache();
  try {
    resetShaTracker();
    cache.resetStats();

    // First call — miss
    await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "1",
      issueTitle: "Test",
      issueBody: "Body",
      issueLabels: "test",
      qualityInstructions: "",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    assertEquals(cache.getStats().misses >= 1, true);

    const missesAfterFirst = cache.getStats().misses;

    // Second call — hit
    await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "2",
      issueTitle: "Test 2",
      issueBody: "Body 2",
      issueLabels: "test",
      qualityInstructions: "",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    // Hits should have increased
    assertEquals(cache.getStats().hits >= 1, true);
    // Misses should not have increased further
    assertEquals(cache.getStats().misses, missesAfterFirst);
  } finally {
    await cleanup(dir);
  }
});

// --- Milestone and screenshot options work with cache ---

Deno.test("prompt builder cache - milestone instructions included in dynamic prompt with cache", async () => {
  const { cache, dir } = await createTestCache();
  try {
    resetShaTracker();
    const result = await buildCachedIssuePrompt({
      repo: "org/repo",
      issueNumber: "10",
      issueTitle: "Milestone feature",
      issueBody: "Implementation",
      issueLabels: "enhancement",
      qualityInstructions: "",
      milestoneBranch: "milestone/v2",
      promptsDir: PROMPTS_DIR,
      cache,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value.prompt, "milestone/v2");
      // The branch is fenced untrusted data and the example command uses the
      // `<milestone-branch>` placeholder (Issue #16).
      assertStringIncludes(result.value.prompt, '--base "<milestone-branch>"');
      // Milestone instructions are dynamic, not in system prompt
      assertEquals(result.value.systemPrompt.includes("milestone/v2"), false);
    }
  } finally {
    await cleanup(dir);
  }
});
