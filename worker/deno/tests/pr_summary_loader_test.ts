/**
 * Tests for pr_summary_loader.ts — PR summary file loading with precedence.
 *
 * Issue #1186: Load PR summary content from file system during completion phase.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { loadPrSummary } from "../lib/pr_summary_loader.ts";
import { normaliseSummaryVersionBumps } from "../lib/pr_summary_facts.ts";

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

Deno.test("loadPrSummary - project bump statements stay valid across later workflow bumps (Issue #3954)", async () => {
  const dir = await createTempDir();
  const path = "docs/archive/pr-summaries/pr-summary-42.md";
  try {
    const durable =
      "## Summary\n\nVersion bump: `VERSION` updated for this change; the merged commit records the final version.\n";
    for (const pair of ["1.2.3 → 1.2.4", "1.2.4 → 1.2.5", "1.2.3 → 1.3.0"]) {
      await writeFile(
        dir,
        path,
        `## Summary\n\nVersion bump: \`VERSION\` ${pair}\n`,
      );
      const result = await loadPrSummary(dir, 42);
      assertEquals(result.ok, true);
      if (result.ok) assertEquals(result.value.content, durable);
    }
    await writeFile(dir, path, durable);
    const repeat = await loadPrSummary(dir, 42);
    assertEquals(repeat.ok && repeat.value.content, durable);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - meaningful exact versions and non-bump prose survive (Issue #3954)", async () => {
  const dir = await createTempDir();
  try {
    const content = [
      "## Summary",
      "",
      "Dependency pin: `zod` 3.0.0 → 4.0.0",
      "",
      "Version bump: `zod` 3.0.0 → 4.0.0",
      "",
      "No automatic bump: VERSION remains 1.2.3.",
      "",
      "```md",
      "Version bump: `VERSION` 1.2.3 → 1.2.4",
      "```",
      "",
      "``Wrapped example",
      "Version bump: `VERSION` 1.2.3 → 1.2.4",
      "end``",
      "",
      "## Evidence",
      "",
      "Release evidence: version 1.2.4 at commit abc123.",
      "Version bump: `VERSION` 1.2.3 → 1.2.4 (release abc123).",
      "",
      "## Changelog",
      "",
      "Version bump: `VERSION` 1.2.3 → 1.2.4",
      "",
      "## Migration",
      "",
      "Migrate from 1.2.3 to 2.0.0.",
      "",
    ].join("\n");
    await writeFile(dir, "docs/archive/pr-summaries/pr-summary-42.md", content);
    const result = await loadPrSummary(dir, 42);
    assertEquals(result.ok && result.value.content, content);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("version normalisation preserves scope and layout across manifest and policy shapes (Issue #3954)", () => {
  for (
    const [header, line, expected] of [
      [
        "",
        "Version bump: `Cargo.toml` 1.2.3 → 1.3.0",
        "Version bump: `Cargo.toml`",
      ],
      [
        "## Test Plan\n\n",
        "- **Version bump:** `package.json` `1.2.3` -> `2.0.0`.",
        "- **Version bump:** `package.json`",
      ],
      [
        "## Summary\r\n\r\n",
        "Version bump: `deno.jsonc` v1.2.3 → v1.2.4",
        "Version bump: `deno.jsonc`",
      ],
      [
        "    literal example\n---\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "Version bump: `VERSION`",
      ],
      [
        "> ## Evidence\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "Version bump: `VERSION`",
      ],
      [
        "## Summary\n\nPreface\n\n---\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "Version bump: `VERSION`",
      ],
      [
        "## Summary\n\nPreface\n***\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "Version bump: `VERSION`",
      ],
      [
        "Summary\n=======\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "Version bump: `VERSION`",
      ],
      [
        "## Summary ##\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "Version bump: `VERSION`",
      ],
      [
        "# PR Summary\n## Summary\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "Version bump: `VERSION`",
      ],
      [
        "## Evidence\n\nRelease evidence: abc123.\n\n## Summary\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "Version bump: `VERSION`",
      ],
    ] as const
  ) {
    const content = header + line + "\r\n";
    const result = normaliseSummaryVersionBumps(content);
    assertEquals(
      result,
      header + expected +
        " updated for this change; the merged commit records the final version.\r\n",
    );
    assertEquals(normaliseSummaryVersionBumps(result), result);
  }
});

Deno.test("version normalisation preserves ambiguous ownership and release continuations (Issue #3954)", async () => {
  const dir = await createTempDir();
  const path = "docs/archive/pr-summaries/pr-summary-42.md";
  const pair = "Version bump: `VERSION` 1.2.3 → 1.2.4";
  try {
    for (
      const content of [
        `## Changelog\n### Summary\n${pair}\n`,
        `## Evidence\n### Summary\n${pair}\n`,
        `## PR Summary\n\n${pair}\n`,
        `## Summary###\n\n${pair}\n`,
        `# Historical reproduction\n## Summary\n${pair}\n`,
        `Historical reproduction\n-----------------------\n${pair}\n`,
        `## Summary\n\n    ${pair}\n`,
        `## Summary\n\n\t${pair}\n`,
        `## Summary\n\n${pair}\n(release abc123).\n`,
        "## Summary\n\nVersion bump: `vendor/sdk/package.json` 1.2.3 → 2.0.0\n",
      ]
    ) {
      await writeFile(dir, path, content);
      const result = await loadPrSummary(dir, 42);
      assertEquals(result.ok && result.value.content, content);
    }
  } finally {
    await cleanupDir(dir);
  }
});
