/**
 * Tests for Mermaid gitGraph validator (Issue #914).
 *
 * Migrated from tests/mermaid-gitgraph.bats.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  extractGitgraphBlocks,
  extractMermaidBlocksByType,
  extractSequenceDiagramBlocks,
  validateGitgraphFile,
  validateGitgraphSyntax,
  validateSequenceDiagramFile,
  validateSequenceDiagramSyntax,
} from "../lib/mermaid_validator.ts";

// --- validateGitgraphSyntax tests ---

Deno.test("mermaid validator - accepts simple gitGraph with commits", () => {
  const block = "gitGraph\n  commit\n  commit\n  commit";
  const result = validateGitgraphSyntax(block);
  assertEquals(result.valid, true);
  assertEquals(result.error, undefined);
});

Deno.test("mermaid validator - accepts gitGraph with branches and merges", () => {
  const block = `gitGraph
  commit
  branch develop
  checkout develop
  commit
  checkout main
  merge develop
  commit`;
  const result = validateGitgraphSyntax(block);
  assertEquals(result.valid, true);
});

Deno.test("mermaid validator - accepts commit messages and metadata", () => {
  const block = `gitGraph
  commit id: "Initial"
  commit id: "Feature" type: HIGHLIGHT
  commit tag: "v1.0"`;
  const result = validateGitgraphSyntax(block);
  assertEquals(result.valid, true);
});

Deno.test("mermaid validator - accepts LR direction specification", () => {
  const block = "gitGraph LR\n  commit\n  commit";
  const result = validateGitgraphSyntax(block);
  assertEquals(result.valid, true);
});

Deno.test("mermaid validator - accepts cherry-pick operations", () => {
  const block = `gitGraph
  commit id: "A"
  branch develop
  commit id: "B"
  checkout main
  cherry-pick id: "B"`;
  const result = validateGitgraphSyntax(block);
  assertEquals(result.valid, true);
});

Deno.test("mermaid validator - accepts comments", () => {
  const block = `gitGraph
  %% This is a comment
  commit
  %% Another comment
  commit`;
  const result = validateGitgraphSyntax(block);
  assertEquals(result.valid, true);
});

Deno.test("mermaid validator - rejects empty input", () => {
  const result = validateGitgraphSyntax("");
  assertEquals(result.valid, false);
  assertEquals(result.error, "Empty gitGraph block");
});

Deno.test("mermaid validator - rejects whitespace-only input", () => {
  const result = validateGitgraphSyntax("   \n  \n  ");
  assertEquals(result.valid, false);
  assertEquals(result.error, "Empty gitGraph block");
});

Deno.test("mermaid validator - rejects blocks not starting with gitGraph", () => {
  const block = "flowchart LR\n  A --> B";
  const result = validateGitgraphSyntax(block);
  assertEquals(result.valid, false);
  assertEquals(
    result.error,
    "Block must start with 'gitGraph', got: flowchart LR",
  );
});

Deno.test("mermaid validator - rejects invalid commands", () => {
  const block = "gitGraph\n  commit\n  invalid-command";
  const result = validateGitgraphSyntax(block);
  assertEquals(result.valid, false);
  assertEquals(
    result.error,
    "Invalid gitGraph command on line 3: invalid-command",
  );
});

Deno.test("mermaid validator - rejects gitGraph with no commits", () => {
  const block = "gitGraph\n  branch develop\n  checkout develop";
  const result = validateGitgraphSyntax(block);
  assertEquals(result.valid, false);
  assertEquals(result.error, "gitGraph block must contain at least one commit");
});

Deno.test("mermaid validator - handles empty lines in block", () => {
  const block = "gitGraph\n\n  commit\n\n  commit\n";
  const result = validateGitgraphSyntax(block);
  assertEquals(result.valid, true);
});

// --- extractGitgraphBlocks tests ---

Deno.test("mermaid validator - extracts gitGraph blocks from markdown", () => {
  const markdown = `# Documentation

Some text.

\`\`\`mermaid
gitGraph
  commit
  commit
\`\`\`

More text.

\`\`\`mermaid
gitGraph LR
  commit
  branch dev
  commit
\`\`\`
`;
  const blocks = extractGitgraphBlocks(markdown);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0]!.includes("commit"), true);
  assertEquals(blocks[1]!.includes("branch dev"), true);
});

Deno.test("mermaid validator - ignores non-gitGraph mermaid blocks", () => {
  const markdown = `\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

\`\`\`mermaid
gitGraph
  commit
\`\`\`
`;
  const blocks = extractGitgraphBlocks(markdown);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]!.includes("commit"), true);
});

Deno.test("mermaid validator - returns empty array for no mermaid blocks", () => {
  const markdown = "# Just text\n\nNo diagrams here.\n";
  const blocks = extractGitgraphBlocks(markdown);
  assertEquals(blocks.length, 0);
});

Deno.test("mermaid validator - handles indented mermaid fences", () => {
  const markdown = `  \`\`\`mermaid
gitGraph
  commit
  \`\`\`
`;
  const blocks = extractGitgraphBlocks(markdown);
  assertEquals(blocks.length, 1);
});

// --- validateSequenceDiagramSyntax tests (Issue #1663) ---

Deno.test("sequenceDiagram validator - accepts a clean diagram", () => {
  const block = `sequenceDiagram
  participant A
  participant B
  A->>B: hello
  B-->>A: world`;
  const result = validateSequenceDiagramSyntax(block);
  assertEquals(result.valid, true);
  assertEquals(result.error, undefined);
});

Deno.test("sequenceDiagram validator - rejects empty block", () => {
  const result = validateSequenceDiagramSyntax("");
  assertEquals(result.valid, false);
  assertEquals(result.error, "Empty sequenceDiagram block");
});

Deno.test("sequenceDiagram validator - rejects block missing declaration", () => {
  const block = `flowchart LR
  A --> B`;
  const result = validateSequenceDiagramSyntax(block);
  assertEquals(result.valid, false);
  assertStringIncludes(result.error ?? "", "must start with 'sequenceDiagram'");
});

Deno.test("sequenceDiagram validator - rejects ';' inside arrow message (Issue #1663)", () => {
  // This is the exact failure mode that broke the published grill-me page:
  // `;` inside `TL;DR` is parsed by Mermaid as a statement separator.
  const block = `sequenceDiagram
  participant U as User
  participant W as Worker
  W->>U: post Round 1<br/>(TL;DR + Understanding + lettered choices)`;
  const result = validateSequenceDiagramSyntax(block);
  assertEquals(result.valid, false);
  assertStringIncludes(result.error ?? "", "unescaped ';'");
  assertStringIncludes(result.error ?? "", "Line 4");
});

Deno.test("sequenceDiagram validator - rejects ';' inside Note text", () => {
  const block = `sequenceDiagram
  participant A
  participant B
  Note over A,B: do step 1; then step 2`;
  const result = validateSequenceDiagramSyntax(block);
  assertEquals(result.valid, false);
  assertStringIncludes(result.error ?? "", "unescaped ';'");
});

Deno.test("sequenceDiagram validator - allows ';' on non-message lines", () => {
  // Comments (`%%`) and other non-message lines are not validated.
  const block = `sequenceDiagram
  %% reminder: do not use ; in messages
  participant A
  participant B
  A->>B: hello`;
  const result = validateSequenceDiagramSyntax(block);
  assertEquals(result.valid, true);
});

Deno.test("sequenceDiagram validator - accepts dashed em-dash separator", () => {
  // The fix replaces `;` with ` — ` (or `,`). Verify the cleaned form passes.
  const block = `sequenceDiagram
  participant W
  participant U
  W->>U: post Round 1 — TLDR + Understanding + lettered choices`;
  const result = validateSequenceDiagramSyntax(block);
  assertEquals(result.valid, true);
});

// --- extractSequenceDiagramBlocks tests ---

Deno.test("sequenceDiagram extractor - extracts only sequenceDiagram blocks", () => {
  const markdown = `# doc

\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant A
  participant B
  A->>B: hi
\`\`\`

\`\`\`mermaid
gitGraph
  commit
\`\`\`
`;
  const blocks = extractSequenceDiagramBlocks(markdown);
  assertEquals(blocks.length, 1);
  assertStringIncludes(blocks[0]!, "sequenceDiagram");
  assertStringIncludes(blocks[0]!, "A->>B: hi");
});

Deno.test("sequenceDiagram extractor - returns empty array when none present", () => {
  const markdown = "# nothing\n\nplain text\n";
  const blocks = extractSequenceDiagramBlocks(markdown);
  assertEquals(blocks.length, 0);
});

// --- Reserved keyword participant detection (Issue #1989) ---

Deno.test(
  "sequenceDiagram validator - rejects participant whose ID matches a reserved keyword (Issue #1989)",
  () => {
    const block = `sequenceDiagram
    participant Loop as run_core
    participant Repo as monitored repo
    Loop->>Repo: hello`;
    const result = validateSequenceDiagramSyntax(block);
    assertEquals(result.valid, false);
    assertStringIncludes(result.error ?? "", "Loop");
    assertStringIncludes(result.error ?? "", "reserved");
  },
);

Deno.test(
  "sequenceDiagram validator - rejects reserved keyword check is case-insensitive (Issue #1989)",
  () => {
    const block = `sequenceDiagram
    participant LOOP
    participant B
    LOOP->>B: hi`;
    const result = validateSequenceDiagramSyntax(block);
    assertEquals(result.valid, false);
    assertStringIncludes(result.error ?? "", "LOOP");
  },
);

Deno.test(
  "sequenceDiagram validator - rejects 'Note' as participant ID (Issue #1989)",
  () => {
    const block = `sequenceDiagram
    participant Note as logger
    participant B
    Note->>B: hi`;
    const result = validateSequenceDiagramSyntax(block);
    assertEquals(result.valid, false);
    assertStringIncludes(result.error ?? "", "Note");
  },
);

Deno.test(
  "sequenceDiagram validator - rejects 'actor' shorthand declarations too (Issue #1989)",
  () => {
    const block = `sequenceDiagram
    actor End as terminator
    participant B
    End->>B: bye`;
    const result = validateSequenceDiagramSyntax(block);
    assertEquals(result.valid, false);
    assertStringIncludes(result.error ?? "", "End");
  },
);

Deno.test(
  "sequenceDiagram validator - accepts non-reserved participant IDs (Issue #1989)",
  () => {
    const block = `sequenceDiagram
    participant Main as run_core
    participant Repo as monitored repo
    Main->>Repo: hello`;
    const result = validateSequenceDiagramSyntax(block);
    assertEquals(result.valid, true);
  },
);

Deno.test(
  "sequenceDiagram validator - accepts 'as <reserved>' alias (display label, not ID)",
  () => {
    // The alias after `as` is display text, not an identifier the parser uses
    // as a keyword. Only the participant ID before `as` must be checked.
    const block = `sequenceDiagram
    participant Worker as Loop runner
    participant Repo
    Worker->>Repo: hi`;
    const result = validateSequenceDiagramSyntax(block);
    assertEquals(result.valid, true);
  },
);

Deno.test(
  "SECURITY-SCAN.md - all mermaid blocks render cleanly (Issue #1989)",
  async () => {
    const url = new URL("../../../docs/SECURITY-SCAN.md", import.meta.url);
    const filePath = decodeURIComponent(url.pathname);
    const result = await validateSequenceDiagramFile(filePath);
    if (!result.ok) {
      throw new Error(`Could not read ${filePath}: ${result.error.message}`);
    }
    const failures = result.value.filter((r) => !r.valid);
    assertEquals(
      failures.length,
      0,
      `Expected all sequenceDiagram blocks in SECURITY-SCAN.md to be valid, ` +
        `but got: ${failures.map((f) => f.error).join("; ")}`,
    );
  },
);

// --- extractMermaidBlocksByType tests (Issue #3038) ---

Deno.test("extractMermaidBlocksByType - returns only blocks of the requested type", () => {
  const markdown = `# doc

\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`

\`\`\`mermaid
gitGraph
  commit
\`\`\`

\`\`\`mermaid
gitGraph LR
  commit
  branch dev
\`\`\`
`;
  const blocks = extractMermaidBlocksByType(markdown, "gitGraph");
  assertEquals(blocks.length, 2);
  assertEquals(blocks.every((b) => b.includes("gitGraph")), true);
  assertEquals(blocks.some((b) => b.includes("flowchart")), false);
});

Deno.test("extractMermaidBlocksByType - matches declaration with trailing options", () => {
  // The keyword boundary check accepts `flowchart TD` but not `flowcharts`.
  const markdown = `\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`
`;
  assertEquals(extractMermaidBlocksByType(markdown, "flowchart").length, 1);
});

Deno.test("extractMermaidBlocksByType - does not match on a keyword prefix", () => {
  // `graph` must not match a block declared as `gitGraph` (prefix overlap is
  // avoided by the boundary check, and these are distinct keywords anyway).
  const markdown = `\`\`\`mermaid
sequenceDiagrammar
  not a real type
\`\`\`
`;
  assertEquals(
    extractMermaidBlocksByType(markdown, "sequenceDiagram").length,
    0,
  );
});

Deno.test("extractMermaidBlocksByType - returns empty array when type absent", () => {
  const markdown = "# nothing\n\nplain text\n";
  assertEquals(extractMermaidBlocksByType(markdown, "gitGraph").length, 0);
});

// --- validateGitgraphFile tests (Issue #3038) ---

Deno.test("validateGitgraphFile - validates a known-good fixture", async () => {
  const path = await Deno.makeTempFile({ suffix: ".md" });
  try {
    await Deno.writeTextFile(
      path,
      "# doc\n\n```mermaid\ngitGraph\n  commit\n  commit\n```\n",
    );
    const result = await validateGitgraphFile(path);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.length, 1);
      assertEquals(result.value[0]!.valid, true);
    }
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("validateGitgraphFile - reports a malformed block as invalid", async () => {
  const path = await Deno.makeTempFile({ suffix: ".md" });
  try {
    // A gitGraph with no commit is invalid per validateGitgraphSyntax.
    await Deno.writeTextFile(
      path,
      "```mermaid\ngitGraph\n  branch dev\n  checkout dev\n```\n",
    );
    const result = await validateGitgraphFile(path);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.length, 1);
      assertEquals(result.value[0]!.valid, false);
      assertStringIncludes(result.value[0]!.error ?? "", "at least one commit");
    }
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("validateGitgraphFile - returns error for a missing file", async () => {
  const result = await validateGitgraphFile("/no/such/file-3038.md");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "File not found");
  }
});

Deno.test("validateGitgraphFile - returns empty array when no gitGraph blocks", async () => {
  const path = await Deno.makeTempFile({ suffix: ".md" });
  try {
    await Deno.writeTextFile(path, "# doc\n\nNo diagrams here.\n");
    const result = await validateGitgraphFile(path);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.length, 0);
    }
  } finally {
    await Deno.remove(path);
  }
});

// --- Regression test for grill-me.md (Issue #1663) ---

Deno.test(
  "grill-me workflow doc - all sequenceDiagram blocks parse cleanly (Issue #1663)",
  async () => {
    const url = new URL(
      "../../../docs/workflows/grill-me.md",
      import.meta.url,
    );
    const filePath = decodeURIComponent(url.pathname);
    const result = await validateSequenceDiagramFile(filePath);
    if (!result.ok) {
      throw new Error(`Could not read ${filePath}: ${result.error.message}`);
    }
    const failures = result.value.filter((r) => !r.valid);
    assertEquals(
      failures.length,
      0,
      `Expected all sequenceDiagram blocks in grill-me.md to be valid, ` +
        `but got: ${failures.map((f) => f.error).join("; ")}`,
    );
  },
);
