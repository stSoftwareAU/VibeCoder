/**
 * Tests for repo context reader module (Issue #1325).
 *
 * Tests reading CLAUDE.md and AGENTS.md from a repository directory
 * for injection into the system prompt.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_MAX_REPO_CONTEXT_CHARS,
  readRepoContext,
} from "../lib/repo_context_reader.ts";

/** Create a temporary directory with optional files for testing. */
async function createTestDir(
  files: Record<string, string>,
): Promise<string> {
  const tmpDir = await Deno.makeTempDir({ prefix: "repo-context-test-" });
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${tmpDir}/${name}`, content);
  }
  return tmpDir;
}

// --- readRepoContext: file present ---

Deno.test("repo context reader - returns CLAUDE.md content when present", async () => {
  const dir = await createTestDir({
    "CLAUDE.md": "# Project Instructions\nUse Australian English.",
  });
  try {
    const result = await readRepoContext(dir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value.content, "Project Instructions");
      assertStringIncludes(result.value.content, "Australian English");
      assertEquals(result.value.filesIncluded, ["CLAUDE.md"]);
      assertEquals(result.value.truncated, false);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo context reader - returns AGENTS.md content when present", async () => {
  const dir = await createTestDir({
    "AGENTS.md": "# Agent Guidelines\nFollow TDD.",
  });
  try {
    const result = await readRepoContext(dir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value.content, "Agent Guidelines");
      assertStringIncludes(result.value.content, "Follow TDD");
      assertEquals(result.value.filesIncluded, ["AGENTS.md"]);
      assertEquals(result.value.truncated, false);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo context reader - returns both files when both present", async () => {
  const dir = await createTestDir({
    "CLAUDE.md": "# Claude Instructions\nBe helpful.",
    "AGENTS.md": "# Agent Rules\nWrite tests.",
  });
  try {
    const result = await readRepoContext(dir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value.content, "Claude Instructions");
      assertStringIncludes(result.value.content, "Agent Rules");
      assertEquals(result.value.filesIncluded, ["CLAUDE.md", "AGENTS.md"]);
      assertEquals(result.value.truncated, false);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- readRepoContext: file absent ---

Deno.test("repo context reader - returns empty content when no files exist", async () => {
  const dir = await createTestDir({});
  try {
    const result = await readRepoContext(dir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "");
      assertEquals(result.value.filesIncluded, []);
      assertEquals(result.value.truncated, false);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo context reader - returns empty when directory does not exist", async () => {
  const result = await readRepoContext("/nonexistent/directory/path");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.content, "");
    assertEquals(result.value.filesIncluded, []);
    assertEquals(result.value.truncated, false);
  }
});

Deno.test("repo context reader - skips empty files", async () => {
  const dir = await createTestDir({
    "CLAUDE.md": "",
    "AGENTS.md": "# Has content",
  });
  try {
    const result = await readRepoContext(dir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.filesIncluded, ["AGENTS.md"]);
      assertStringIncludes(result.value.content, "Has content");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo context reader - skips whitespace-only files", async () => {
  const dir = await createTestDir({
    "CLAUDE.md": "   \n\n  ",
    "AGENTS.md": "# Real content",
  });
  try {
    const result = await readRepoContext(dir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.filesIncluded, ["AGENTS.md"]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- readRepoContext: size guard ---

Deno.test("repo context reader - truncates content exceeding size limit", async () => {
  const largeContent = "A".repeat(500);
  const dir = await createTestDir({
    "CLAUDE.md": largeContent,
  });
  try {
    const result = await readRepoContext(dir, 100);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.truncated, true);
      assertStringIncludes(result.value.content, "content truncated");
      assertStringIncludes(result.value.content, "100 characters");
      // Content should be longer than maxChars due to truncation notice
      assertEquals(result.value.content.length > 100, true);
      // But the main body should be cut
      assertEquals(result.value.content.includes("A".repeat(500)), false);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo context reader - does not truncate content within limit", async () => {
  const dir = await createTestDir({
    "CLAUDE.md": "Short content.",
  });
  try {
    const result = await readRepoContext(dir, 10000);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.truncated, false);
      assertEquals(result.value.content.includes("truncated"), false);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo context reader - default max chars constant is reasonable", () => {
  // Default should be 20,000 characters (~5,000 tokens)
  assertEquals(DEFAULT_MAX_REPO_CONTEXT_CHARS, 20_000);
});

// --- readRepoContext: content formatting ---

Deno.test("repo context reader - formats content with section headers", async () => {
  const dir = await createTestDir({
    "CLAUDE.md": "Claude rules.",
  });
  try {
    const result = await readRepoContext(dir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(
        result.value.content,
        "## Repository Context: CLAUDE.md",
      );
      assertStringIncludes(result.value.content, "Claude rules.");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo context reader - separates multiple files with dividers", async () => {
  const dir = await createTestDir({
    "CLAUDE.md": "Claude content.",
    "AGENTS.md": "Agent content.",
  });
  try {
    const result = await readRepoContext(dir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value.content, "---");
      assertStringIncludes(
        result.value.content,
        "## Repository Context: CLAUDE.md",
      );
      assertStringIncludes(
        result.value.content,
        "## Repository Context: AGENTS.md",
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
