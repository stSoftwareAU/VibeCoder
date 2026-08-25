/**
 * Tests for the model-agnostic docs check (Issue #371).
 *
 * `CODING-STANDARDS.md` must name no model generation — the routing chain,
 * the fallback self-heal, and every generation-specific tuning live once in
 * `docs/MODEL-AND-CACHING.md`. Without a guard the next prompt-tuning PR
 * quietly re-introduces a model name and the standard drifts back.
 *
 * Covers:
 *   - clean content (passes),
 *   - each name in the `opus|fable|sonnet|haiku` family (fails),
 *   - `claude-<digit>` model ids (fails),
 *   - case-insensitive matching and multiple hits on one line,
 *   - unrelated words that merely contain a name (not flagged),
 *   - SKIPPED on a repo without the documents,
 *   - the actual repository tree passes (regression guard).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  findModelGenerationNames,
  MODEL_AGNOSTIC_DOCS,
  runModelAgnosticDocsCheck,
} from "../lib/model_generation_name_check.ts";

// --- findModelGenerationNames ---

Deno.test("findModelGenerationNames - model-agnostic prose has no hits", () => {
  const content = [
    "The guidance below is model-generation-agnostic good practice.",
    "See docs/MODEL-AND-CACHING.md for the per-phase routing chain.",
    "",
    "- **Calibrate response length.** Say so explicitly.",
  ].join("\n");
  assertEquals(findModelGenerationNames("CODING-STANDARDS.md", content), []);
});

Deno.test("findModelGenerationNames - each generation name is flagged", () => {
  for (const name of ["Opus", "Fable", "Sonnet", "Haiku"]) {
    const hits = findModelGenerationNames(
      "CODING-STANDARDS.md",
      `Routes to **${name} 5** for the top-tier phases.\n`,
    );
    assertEquals(hits.length, 1, `"${name}" was not flagged`);
    assertEquals(hits[0]!.line, 1);
    assertEquals(hits[0]!.name.toLowerCase(), name.toLowerCase());
  }
});

Deno.test("findModelGenerationNames - claude-<digit> model id is flagged", () => {
  const hits = findModelGenerationNames(
    "CODING-STANDARDS.md",
    "Pin the alias to `claude-5-20260101` in the config.\n",
  );
  assertEquals(hits.length, 1);
  assertEquals(hits[0]!.name.toLowerCase(), "claude-5");
});

Deno.test("findModelGenerationNames - `claude` without a version digit is not flagged", () => {
  // The agent is called Claude everywhere in the standards — only a
  // versioned model id names a generation.
  assertEquals(
    findModelGenerationNames(
      "CODING-STANDARDS.md",
      "The worker invokes Claude with the compiled prompt.\n",
    ),
    [],
  );
});

Deno.test("findModelGenerationNames - matching is case-insensitive", () => {
  const hits = findModelGenerationNames(
    "CODING-STANDARDS.md",
    "the fable-unavailable self-heal reroutes to OPUS\n",
  );
  assertEquals(hits.length, 2);
  assertEquals(hits.map((h) => h.name), ["fable", "OPUS"]);
});

Deno.test("findModelGenerationNames - reports line number and trimmed context", () => {
  const content = "clean line\n\n   Falls back to Opus when unavailable.  \n";
  const hits = findModelGenerationNames("CODING-STANDARDS.md", content);
  assertEquals(hits.length, 1);
  assertEquals(hits[0]!.line, 3);
  assertEquals(hits[0]!.file, "CODING-STANDARDS.md");
  assertEquals(hits[0]!.content, "Falls back to Opus when unavailable.");
});

Deno.test("findModelGenerationNames - word that merely contains a name is not flagged", () => {
  assertEquals(
    findModelGenerationNames(
      "CODING-STANDARDS.md",
      "A magnum opusculum of sonneteering is not a model name.\n",
    ),
    [],
  );
});

Deno.test("findModelGenerationNames - empty content yields no hits", () => {
  assertEquals(findModelGenerationNames("CODING-STANDARDS.md", ""), []);
});

// --- runModelAgnosticDocsCheck ---

async function makeFixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "model_agnostic_docs_" });
  for (const [relPath, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${relPath}`, content);
  }
  return dir;
}

Deno.test("runModelAgnosticDocsCheck - clean document passes", async () => {
  const dir = await makeFixture({
    "CODING-STANDARDS.md":
      "# Standards\n\nSee docs/MODEL-AND-CACHING.md for routing.\n",
  });
  try {
    const result = await runModelAgnosticDocsCheck(dir);
    assertEquals(result.status, "PASSED");
    assertEquals(result.hits.length, 0);
    assertEquals(result.filesScanned, 1);
    assertStringIncludes(result.output, "model-agnostic docs: PASSED");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runModelAgnosticDocsCheck - a re-introduced model name fails with a clear message", async () => {
  const dir = await makeFixture({
    "CODING-STANDARDS.md": "# Standards\n\n" +
      "Routes to **Fable 5**, falling back to **Opus 5**.\n",
  });
  try {
    const result = await runModelAgnosticDocsCheck(dir);
    assertEquals(result.status, "FAILED");
    assertEquals(result.hits.length, 2);
    assertEquals(result.hits[0]!.line, 3);
    assertStringIncludes(result.output, "CODING-STANDARDS.md:3");
    assertStringIncludes(result.output, "docs/MODEL-AND-CACHING.md");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runModelAgnosticDocsCheck - SKIPPED when the document is absent", async () => {
  const dir = await makeFixture({});
  try {
    const result = await runModelAgnosticDocsCheck(dir);
    assertEquals(result.status, "SKIPPED");
    assertEquals(result.filesScanned, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Regression guard against the actual repository ---

Deno.test("runModelAgnosticDocsCheck - the live CODING-STANDARDS.md names no model generation", async () => {
  // tests/ → worker/deno/ → worker/ → repo root
  const moduleDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  const repoRoot = `${moduleDir}/../../..`;
  const result = await runModelAgnosticDocsCheck(repoRoot);
  if (result.status === "FAILED") {
    throw new Error(
      `Model-generation name(s) re-introduced:\n${result.output}`,
    );
  }
  assertEquals(result.status, "PASSED", result.output);
  assertEquals(result.filesScanned, MODEL_AGNOSTIC_DOCS.length);
});

Deno.test("CODING-STANDARDS.md defers routing to docs/MODEL-AND-CACHING.md", async () => {
  const url = new URL("../../../CODING-STANDARDS.md", import.meta.url);
  const text = await Deno.readTextFile(url);
  const section = text.slice(text.indexOf("## Prompt Engineering Guidance"));
  assert(
    section.includes("docs/MODEL-AND-CACHING.md#model-selection"),
    "Prompt Engineering Guidance does not link to the Model Selection " +
      "section that owns the per-phase routing chain",
  );
  assert(
    section.includes(
      "docs/MODEL-AND-CACHING.md#model-generation-prompt-tuning",
    ),
    "Prompt Engineering Guidance does not link to the model-generation " +
      "prompt-tuning section that owns generation-specific findings",
  );
});
