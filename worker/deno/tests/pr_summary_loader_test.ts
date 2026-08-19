/**
 * Tests for pr_summary_loader.ts — PR summary file loading with precedence.
 *
 * Issue #1186: Load PR summary content from file system during completion phase.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { loadPrSummary } from "../lib/pr_summary_loader.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "pr-summary-test-" });
}

async function writeFile(
  dir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = `${dir}/${relativePath}`;
  const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await Deno.mkdir(parentDir, { recursive: true });
  await Deno.writeTextFile(fullPath, content);
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Tests — file loading precedence
// ---------------------------------------------------------------------------

Deno.test("loadPrSummary - loads from docs/archive/pr-summaries/ (canonical, Issue #2173)", async () => {
  const dir = await createTempDir();
  try {
    const content = "## Summary\nArchive location content.";
    await writeFile(dir, "docs/archive/pr-summaries/pr-summary-42.md", content);

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, content);
      assertEquals(
        result.value.source,
        "docs/archive/pr-summaries/pr-summary-42.md",
      );
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - falls back to legacy docs/pr-summary-{N}.md", async () => {
  const dir = await createTempDir();
  try {
    const content = "## Summary\nLegacy loose-docs location content.";
    await writeFile(dir, "docs/pr-summary-42.md", content);

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, content);
      assertEquals(result.value.source, "docs/pr-summary-42.md");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - falls back to .pr_summary (legacy)", async () => {
  const dir = await createTempDir();
  try {
    const content = "Legacy PR summary content.";
    await writeFile(dir, ".pr_summary", content);

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, content);
      assertEquals(result.value.source, ".pr_summary");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - canonical archive takes precedence over legacy loose docs/ (Issue #2173)", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(dir, "docs/pr-summary-42.md", "Legacy loose content.");
    await writeFile(
      dir,
      "docs/archive/pr-summaries/pr-summary-42.md",
      "Archive content.",
    );
    await writeFile(dir, ".pr_summary", "Root legacy content.");

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "Archive content.");
      assertEquals(
        result.value.source,
        "docs/archive/pr-summaries/pr-summary-42.md",
      );
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - loose docs/ takes precedence over .pr_summary root legacy", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(dir, "docs/pr-summary-42.md", "Loose docs content.");
    await writeFile(dir, ".pr_summary", "Root legacy content.");

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "Loose docs content.");
      assertEquals(result.value.source, "docs/pr-summary-42.md");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - returns not_found when no summary file exists", async () => {
  const dir = await createTempDir();
  try {
    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "");
      assertEquals(result.value.source, "not_found");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - skips empty files", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(dir, "docs/archive/pr-summaries/pr-summary-42.md", "");
    await writeFile(dir, "docs/pr-summary-42.md", "Loose content.");

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "Loose content.");
      assertEquals(result.value.source, "docs/pr-summary-42.md");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - skips whitespace-only files", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(
      dir,
      "docs/archive/pr-summaries/pr-summary-42.md",
      "   \n  \n  ",
    );
    await writeFile(dir, "docs/pr-summary-42.md", "   \n  \n  ");
    await writeFile(dir, ".pr_summary", "Legacy content.");

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "Legacy content.");
      assertEquals(result.value.source, ".pr_summary");
    }
  } finally {
    await cleanupDir(dir);
  }
});
