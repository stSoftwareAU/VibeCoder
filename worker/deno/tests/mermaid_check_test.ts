/**
 * Tests for the repo-wide mermaid check (Issue #1683).
 *
 * Covers:
 *   - clean repo (passes),
 *   - single bad block (fails),
 *   - bad block in nested docs/** directory (fails),
 *   - empty repo (skipped),
 *   - existing repo state (PASSED — regression guard).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  collectMarkdownFiles,
  isSkippedMermaidFixturePath,
  runMermaidCheck,
} from "../lib/mermaid_check.ts";
import {
  extractMermaidBlocks,
  validateGenericMermaidBlock,
  validateMermaidBlock,
  validateMermaidFile,
} from "../lib/mermaid_validator.ts";

async function makeTempRepo(
  files: Record<string, string>,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "mermaid_check_" });
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = `${dir}/${relPath}`;
    const slash = absPath.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(absPath.slice(0, slash), { recursive: true });
    }
    await Deno.writeTextFile(absPath, content);
  }
  return dir;
}

// --- collectMarkdownFiles ---

Deno.test("collectMarkdownFiles - finds top-level and nested .md files", async () => {
  const dir = await makeTempRepo({
    "README.md": "# r",
    "docs/a.md": "# a",
    "docs/sub/b.md": "# b",
    "docs/sub/c.txt": "ignored",
    "node_modules/x.md": "ignored",
    ".git/info/x.md": "ignored",
  });
  try {
    const files = await collectMarkdownFiles(dir);
    assertEquals(files, ["README.md", "docs/a.md", "docs/sub/b.md"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("collectMarkdownFiles - returns [] when no .md files exist", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mermaid_check_empty_" });
  try {
    const files = await collectMarkdownFiles(dir);
    assertEquals(files, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isSkippedMermaidFixturePath - matches FLEET known-bad fixture tree", () => {
  assertEquals(
    isSkippedMermaidFixturePath("test/fixtures/mermaid/invalid.md"),
    true,
  );
  assertEquals(isSkippedMermaidFixturePath("test/fixtures/mermaid/"), true);
  assertEquals(isSkippedMermaidFixturePath("test/fixtures/mermaid"), true);
  assertEquals(isSkippedMermaidFixturePath("docs/readme.md"), false);
  assertEquals(
    isSkippedMermaidFixturePath("test/fixtures/other/invalid.md"),
    false,
  );
});

Deno.test(
  "collectMarkdownFiles - skips intentional known-bad Mermaid fixtures (#3328)",
  async () => {
    const dir = await makeTempRepo({
      "README.md": "# r",
      "docs/ok.md": [
        "```mermaid",
        "flowchart LR",
        "  A --> B",
        "```",
      ].join("\n"),
      // Deliberately broken — same shape as FLEET's CI self-regression fixture.
      "test/fixtures/mermaid/invalid.md": [
        "```mermaid",
        "sequenceDiagram",
        "  participant SR",
        "  participant Ck",
        "  SR->>Ck: load; restore 84 results",
        "```",
      ].join("\n"),
    });
    try {
      const files = await collectMarkdownFiles(dir);
      assertEquals(files, ["README.md", "docs/ok.md"]);

      const result = await runMermaidCheck(dir);
      assertEquals(result.status, "PASSED");
      assertEquals(
        result.failures.some((f) => f.file.includes("fixtures/mermaid")),
        false,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// --- extractMermaidBlocks ---

Deno.test("extractMermaidBlocks - records block type and start line", () => {
  const md = [
    "# heading",
    "",
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "",
    "more text",
    "",
    "```mermaid",
    "gitGraph",
    "  commit",
    "```",
  ].join("\n");
  const blocks = extractMermaidBlocks(md);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0]!.type, "flowchart");
  assertEquals(blocks[0]!.startLine, 3);
  assertEquals(blocks[1]!.type, "gitGraph");
  assertEquals(blocks[1]!.startLine, 10);
});

// --- validateMermaidBlock dispatch ---

Deno.test("validateMermaidBlock - dispatches gitGraph to its validator", () => {
  const result = validateMermaidBlock({
    type: "gitGraph",
    content: "gitGraph\n  commit",
    startLine: 1,
  });
  assertEquals(result.valid, true);
});

Deno.test("validateMermaidBlock - dispatches sequenceDiagram to its validator", () => {
  const result = validateMermaidBlock({
    type: "sequenceDiagram",
    content: "sequenceDiagram\n  participant A\n  A->>A: TL;DR",
    startLine: 1,
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.error ?? "", "unescaped ';'");
});

Deno.test("validateMermaidBlock - rejects empty block content", () => {
  const result = validateMermaidBlock({
    type: "",
    content: "",
    startLine: 1,
  });
  assertEquals(result.valid, false);
});

// --- validateGenericMermaidBlock ---

Deno.test("validateGenericMermaidBlock - accepts well-formed flowchart", () => {
  const result = validateGenericMermaidBlock({
    type: "flowchart",
    content: 'flowchart LR\n  A["foo (bar)"] --> B{decide}',
    startLine: 1,
  });
  assertEquals(result.valid, true);
});

Deno.test("validateGenericMermaidBlock - rejects empty body", () => {
  const result = validateGenericMermaidBlock({
    type: "flowchart",
    content: "flowchart LR\n",
    startLine: 1,
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.error ?? "", "Empty flowchart body");
});

Deno.test("validateGenericMermaidBlock - rejects unmatched braces", () => {
  const result = validateGenericMermaidBlock({
    type: "flowchart",
    content: "flowchart LR\n  A{unclosed --> B",
    startLine: 1,
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.error ?? "", "Unmatched braces");
});

Deno.test("validateGenericMermaidBlock - rejects unmatched brackets", () => {
  const result = validateGenericMermaidBlock({
    type: "flowchart",
    content: "flowchart LR\n  A[unclosed --> B",
    startLine: 1,
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.error ?? "", "Unmatched brackets");
});

Deno.test("validateGenericMermaidBlock - rejects unknown diagram type", () => {
  const result = validateGenericMermaidBlock({
    type: "totallyMadeUp",
    content: "totallyMadeUp\n  A --> B",
    startLine: 1,
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.error ?? "", "Unknown Mermaid diagram type");
});

Deno.test("validateGenericMermaidBlock - allows brackets inside quoted labels", () => {
  // Real-world case: `A["foo (bar) [baz]"]` — quoted text contains literal
  // brackets that should not affect the count.
  const result = validateGenericMermaidBlock({
    type: "flowchart",
    content: 'flowchart LR\n  A["foo (bar) [baz]"] --> B',
    startLine: 1,
  });
  assertEquals(result.valid, true);
});

Deno.test("validateGenericMermaidBlock - ignores mismatches in %% comments", () => {
  const result = validateGenericMermaidBlock({
    type: "flowchart",
    content: "flowchart LR\n  %% TODO {add edge case\n  A --> B",
    startLine: 1,
  });
  assertEquals(result.valid, true);
});

// --- validateMermaidFile ---

Deno.test("validateMermaidFile - returns failures with reported path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mermaid_file_" });
  try {
    const filePath = `${dir}/bad.md`;
    await Deno.writeTextFile(
      filePath,
      [
        "# bad",
        "",
        "```mermaid",
        "flowchart LR",
        "  A{unclosed --> B",
        "```",
      ].join("\n"),
    );
    const result = await validateMermaidFile(filePath, "bad.md");
    if (!result.ok) throw new Error(`unexpected: ${result.error.message}`);
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0]!.file, "bad.md");
    assertEquals(result.value[0]!.startLine, 3);
    assertEquals(result.value[0]!.type, "flowchart");
    assertStringIncludes(result.value[0]!.error, "Unmatched braces");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- runMermaidCheck ---

Deno.test("runMermaidCheck - PASSES on clean repo", async () => {
  const dir = await makeTempRepo({
    "README.md": "# r\n",
    "docs/a.md": [
      "# a",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "",
      "```mermaid",
      "gitGraph",
      "  commit",
      "```",
    ].join("\n"),
  });
  try {
    const result = await runMermaidCheck(dir);
    assertEquals(result.status, "PASSED");
    assertEquals(result.failures.length, 0);
    assertEquals(result.filesScanned, 2);
    assertEquals(result.blocksScanned, 2);
    assertStringIncludes(result.output, "PASSED");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runMermaidCheck - FAILS on a single bad block", async () => {
  const dir = await makeTempRepo({
    "README.md": [
      "# r",
      "",
      "```mermaid",
      "flowchart LR",
      "  A{unclosed --> B",
      "```",
    ].join("\n"),
  });
  try {
    const result = await runMermaidCheck(dir);
    assertEquals(result.status, "FAILED");
    assertEquals(result.failures.length, 1);
    assertEquals(result.failures[0]!.file, "README.md");
    assertEquals(result.failures[0]!.startLine, 3);
    assertEquals(result.failures[0]!.type, "flowchart");
    assertStringIncludes(result.failures[0]!.error, "Unmatched braces");
    assertStringIncludes(result.output, "FAILED");
    assertStringIncludes(result.output, "README.md:3");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runMermaidCheck - FAILS on bad block in nested docs/** directory", async () => {
  const dir = await makeTempRepo({
    "README.md": "# clean\n",
    "docs/workflows/nested.md": [
      "# nested",
      "",
      "intro line",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  participant A",
      "  participant B",
      "  A->>B: do step 1; then step 2",
      "```",
    ].join("\n"),
  });
  try {
    const result = await runMermaidCheck(dir);
    assertEquals(result.status, "FAILED");
    assertEquals(result.failures.length, 1);
    assertEquals(result.failures[0]!.file, "docs/workflows/nested.md");
    assertEquals(result.failures[0]!.startLine, 5);
    assertEquals(result.failures[0]!.type, "sequenceDiagram");
    assertStringIncludes(result.failures[0]!.error, "unescaped ';'");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runMermaidCheck - SKIPPED when no .md files present", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mermaid_skip_" });
  try {
    const result = await runMermaidCheck(dir);
    assertEquals(result.status, "SKIPPED");
    assertEquals(result.filesScanned, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Regression: the live repo state passes ---

Deno.test(
  "runMermaidCheck - VibeCoder repo passes (regression guard)",
  async () => {
    const url = new URL("../../..", import.meta.url);
    const repoRoot = decodeURIComponent(url.pathname).replace(/\/$/, "");
    const result = await runMermaidCheck(repoRoot);
    assertEquals(
      result.status === "PASSED" || result.status === "SKIPPED",
      true,
      `Expected PASSED or SKIPPED, got ${result.status}: ${result.output}`,
    );
  },
);
