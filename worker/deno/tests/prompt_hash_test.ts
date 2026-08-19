/**
 * Tests for prompt content SHA-256 computation utility (Issue #1271).
 *
 * Written TDD-first — these tests define the expected behaviour
 * of computePromptHash() and computeStaticPromptHash().
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  computePromptHash,
  computeStaticPromptHash,
} from "../lib/prompt_hash.ts";

// Resolve the prompts directory relative to this test file
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- computePromptHash tests ---

Deno.test("prompt hash - identical content produces the same hash", async () => {
  const content = "Hello, world!";
  const hash1 = await computePromptHash(content);
  const hash2 = await computePromptHash(content);
  assertEquals(hash1, hash2);
});

Deno.test("prompt hash - different content produces different hashes", async () => {
  const hash1 = await computePromptHash("content A");
  const hash2 = await computePromptHash("content B");
  assertNotEquals(hash1, hash2);
});

Deno.test("prompt hash - returns a 64-character hex string (SHA-256)", async () => {
  const hash = await computePromptHash("test content");
  assertEquals(hash.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(hash), true);
});

Deno.test("prompt hash - empty string produces a valid hash", async () => {
  const hash = await computePromptHash("");
  assertEquals(hash.length, 64);
  // Known SHA-256 of empty string
  assertEquals(
    hash,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

Deno.test("prompt hash - known SHA-256 value is correct", async () => {
  // SHA-256 of "abc" is well-known
  const hash = await computePromptHash("abc");
  assertEquals(
    hash,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

// --- computeStaticPromptHash tests ---

Deno.test("prompt hash - static hash succeeds with valid prompts directory", async () => {
  const result = await computeStaticPromptHash(PROMPTS_DIR, "org/test-repo");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 64);
    assertEquals(/^[0-9a-f]{64}$/.test(result.value), true);
  }
});

Deno.test("prompt hash - static hash is deterministic for same inputs", async () => {
  const result1 = await computeStaticPromptHash(PROMPTS_DIR, "org/repo");
  const result2 = await computeStaticPromptHash(PROMPTS_DIR, "org/repo");
  assertEquals(result1.ok, true);
  assertEquals(result2.ok, true);
  if (result1.ok && result2.ok) {
    assertEquals(result1.value, result2.value);
  }
});

Deno.test("prompt hash - per-repo custom instructions affect the hash", async () => {
  const result1 = await computeStaticPromptHash(PROMPTS_DIR, "org/repo");
  const result2 = await computeStaticPromptHash(
    PROMPTS_DIR,
    "org/repo",
    "Use tabs instead of spaces",
  );
  assertEquals(result1.ok, true);
  assertEquals(result2.ok, true);
  if (result1.ok && result2.ok) {
    assertNotEquals(result1.value, result2.value);
  }
});

Deno.test("prompt hash - different custom instructions produce different hashes", async () => {
  const result1 = await computeStaticPromptHash(
    PROMPTS_DIR,
    "org/repo",
    "Custom instructions A",
  );
  const result2 = await computeStaticPromptHash(
    PROMPTS_DIR,
    "org/repo",
    "Custom instructions B",
  );
  assertEquals(result1.ok, true);
  assertEquals(result2.ok, true);
  if (result1.ok && result2.ok) {
    assertNotEquals(result1.value, result2.value);
  }
});

Deno.test("prompt hash - different repo names produce different hashes", async () => {
  const result1 = await computeStaticPromptHash(PROMPTS_DIR, "org/repo-a");
  const result2 = await computeStaticPromptHash(PROMPTS_DIR, "org/repo-b");
  assertEquals(result1.ok, true);
  assertEquals(result2.ok, true);
  if (result1.ok && result2.ok) {
    assertNotEquals(result1.value, result2.value);
  }
});

Deno.test("prompt hash - returns error for missing prompts directory", async () => {
  const result = await computeStaticPromptHash(
    "/nonexistent/prompts/dir",
    "org/repo",
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error instanceof Error, true);
  }
});

Deno.test("prompt hash - hash changes when prompt template versions change", async () => {
  // Create a temporary prompts directory with controlled content
  const tmpDir = await Deno.makeTempDir();
  const codingDir = `${tmpDir}/coding_guidelines`;
  const issueDir = `${tmpDir}/issue`;
  await Deno.mkdir(codingDir);
  await Deno.mkdir(issueDir);

  // Write initial versions
  await Deno.writeTextFile(`${codingDir}/v1.md`, "Guidelines version 1");
  await Deno.writeTextFile(`${issueDir}/v1.md`, "Issue template version 1");

  const result1 = await computeStaticPromptHash(tmpDir, "org/repo");
  assertEquals(result1.ok, true);

  // Add a new version of coding_guidelines (simulates a prompt update)
  await Deno.writeTextFile(
    `${codingDir}/v2.md`,
    "Guidelines version 2 — updated",
  );

  const result2 = await computeStaticPromptHash(tmpDir, "org/repo");
  assertEquals(result2.ok, true);

  if (result1.ok && result2.ok) {
    assertNotEquals(
      result1.value,
      result2.value,
      "Hash should change when prompt template version changes",
    );
  }

  // Clean up
  await Deno.remove(tmpDir, { recursive: true });
});

// --- Repo context inclusion in hash (Issue #1325) ---

Deno.test("prompt hash - static hash changes when repo context content changes", async () => {
  const promptsDir = new URL("../../../prompts", import.meta.url).pathname;

  const result1 = await computeStaticPromptHash(
    promptsDir,
    "org/repo",
    undefined,
    "## AGENTS.md\nFirst version.",
  );
  const result2 = await computeStaticPromptHash(
    promptsDir,
    "org/repo",
    undefined,
    "## AGENTS.md\nSecond version.",
  );

  assertEquals(result1.ok, true);
  assertEquals(result2.ok, true);
  if (result1.ok && result2.ok) {
    assertNotEquals(
      result1.value,
      result2.value,
      "Hash should change when repo context content changes",
    );
  }
});

Deno.test("prompt hash - static hash differs with and without repo context", async () => {
  const promptsDir = new URL("../../../prompts", import.meta.url).pathname;

  const resultWithout = await computeStaticPromptHash(
    promptsDir,
    "org/repo",
  );
  const resultWith = await computeStaticPromptHash(
    promptsDir,
    "org/repo",
    undefined,
    "## AGENTS.md\nSome content.",
  );

  assertEquals(resultWithout.ok, true);
  assertEquals(resultWith.ok, true);
  if (resultWithout.ok && resultWith.ok) {
    assertNotEquals(
      resultWithout.value,
      resultWith.value,
      "Hash should differ with and without repo context",
    );
  }
});

Deno.test("prompt hash - static hash stable when repo context is identical", async () => {
  const promptsDir = new URL("../../../prompts", import.meta.url).pathname;
  const context = "## AGENTS.md\nStable content.";

  const result1 = await computeStaticPromptHash(
    promptsDir,
    "org/repo",
    undefined,
    context,
  );
  const result2 = await computeStaticPromptHash(
    promptsDir,
    "org/repo",
    undefined,
    context,
  );

  assertEquals(result1.ok, true);
  assertEquals(result2.ok, true);
  if (result1.ok && result2.ok) {
    assertEquals(
      result1.value,
      result2.value,
      "Hash should be stable for identical repo context",
    );
  }
});
