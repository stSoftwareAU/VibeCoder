/**
 * Tests for coding_guidelines v42 (Issue #373).
 *
 * `buildCodingGuidelines()` loads the *latest* `coding_guidelines` version for
 * every run, whichever provider serves it — so a section headed after one
 * model generation ("Opus 5 Working Style", v34–v41) told the Codex and Gemini
 * providers they were a Claude generation and that they "self-verify as you
 * work". v42 keeps all four working-style directives and drops the
 * generation-specific framing; the observations that justified it live in
 * `docs/MODEL-AND-CACHING.md` § "Model-generation prompt tuning".
 *
 * The assertions below run against the *latest* version, not v42 alone, so a
 * future copy-forward that re-introduces a model name — or quietly drops a
 * directive — fails in CI.
 *
 * Australian English throughout (behaviour, generalisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { findModelGenerationNames } from "../lib/model_generation_name_check.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Foreign-provider generation names, complementing the Claude-family check. */
const FOREIGN_GENERATION_PATTERN = /\b(?:gpt|gemini)\b/gi;

/** Load a coding_guidelines version, failing loudly when it is missing. */
async function loadGuidelines(version?: string): Promise<string> {
  const result = await loadPrompt("coding_guidelines", version, PROMPTS_DIR);
  assertEquals(
    result.ok,
    true,
    `coding_guidelines ${version ?? "latest"} failed to load`,
  );
  if (!result.ok) throw new Error("coding_guidelines failed to load");
  return result.value;
}

/** Collapse Markdown line wrapping so phrase assertions survive rewrapping. */
function unwrapped(text: string): string {
  return text.replace(/\s+/g, " ");
}

Deno.test("coding_guidelines v42 - loads via loadPrompt", async () => {
  const text = await loadGuidelines("v42");
  assertEquals(text.length > 0, true);
});

Deno.test("coding_guidelines v42 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 42,
    true,
    `Expected coding_guidelines >= v42, got ${result.value}`,
  );
});

Deno.test("coding_guidelines v42 - satisfies the placeholder contract", async () => {
  const text = await loadGuidelines("v42");
  assertEquals(validatePromptTemplate("coding_guidelines", text).ok, true);
});

Deno.test("latest coding_guidelines - names no Claude model generation", async () => {
  const text = await loadGuidelines();
  const hits = findModelGenerationNames("coding_guidelines (latest)", text);
  assertEquals(
    hits.length,
    0,
    `Latest coding_guidelines names a model generation: ${
      hits.map((h) => `line ${h.line} "${h.name}": ${h.content}`).join("; ")
    }`,
  );
});

Deno.test("latest coding_guidelines - names no foreign model generation", async () => {
  const text = await loadGuidelines();
  const hits = text
    .split("\n")
    .flatMap((line, i) =>
      (line.match(FOREIGN_GENERATION_PATTERN) ?? []).map((name) =>
        `line ${i + 1} "${name}": ${line.trim()}`
      )
    );
  assertEquals(
    hits.length,
    0,
    `Latest coding_guidelines names a model generation: ${hits.join("; ")}`,
  );
});

Deno.test("latest coding_guidelines - working-style heading is model-agnostic", async () => {
  const text = await loadGuidelines();
  assertStringIncludes(text, "\n## Working Style\n");
  assertEquals(
    /^##+ .*(?:opus|fable|sonnet|haiku|gpt|gemini)/im.test(text),
    false,
    "A heading in the latest coding_guidelines names a model generation",
  );
});

Deno.test("latest coding_guidelines - keeps all four working-style directives", async () => {
  const flat = unwrapped(await loadGuidelines());
  // 1. Scope discipline.
  assertStringIncludes(flat, "**Stay in scope.**");
  assertStringIncludes(flat, "Implement exactly what the issue asks");
  // 2. Delegation cap.
  assertStringIncludes(flat, "**Cap delegation.**");
  assertStringIncludes(flat, "subagent");
  // 3. Deliverable length.
  assertStringIncludes(flat, "**Keep deliverables tight.**");
  assertStringIncludes(flat, "Match response, comment, and file length");
  // 4. No ritual re-verification — restated as the rule, not as a claim
  //    about what the model already does.
  assertStringIncludes(flat, "**Trust the quality gate.**");
  assertStringIncludes(flat, "green quality gate is the signal to stop");
  assertEquals(
    flat.includes("You already check your work as you go"),
    false,
    "Latest coding_guidelines still asserts the model self-verifies",
  );
});

Deno.test("latest coding_guidelines - drops the model-generation premise", async () => {
  const flat = unwrapped(await loadGuidelines());
  assertEquals(
    flat.includes("You self-verify as you work, delegate readily"),
    false,
    "Latest coding_guidelines still asserts traits of one model generation",
  );
});

Deno.test("coding_guidelines v42 - differs from v41 only in the working-style section", async () => {
  const v41 = await loadGuidelines("v41");
  const v42 = await loadGuidelines("v42");
  const SUFFIX_ANCHOR = "## Long-Horizon Runs";

  const prefixOf = (text: string, heading: string) =>
    text.slice(0, text.indexOf(heading));
  const suffixOf = (text: string) => text.slice(text.indexOf(SUFFIX_ANCHOR));

  assertEquals(
    prefixOf(v42, "## Working Style"),
    prefixOf(v41, "## Opus 5 Working Style"),
    "v42 changed content before the working-style section",
  );
  assertEquals(
    suffixOf(v42),
    suffixOf(v41),
    "v42 changed content after the working-style section",
  );
});

Deno.test("coding_guidelines v41 - stays immutable", async () => {
  const v41 = await loadGuidelines("v41");
  assertStringIncludes(v41, "## Opus 5 Working Style");
});

Deno.test("coding_guidelines v42 - carries v41 sections forward", async () => {
  const v41 = await loadGuidelines("v41");
  const v42 = await loadGuidelines("v42");
  const headings = (text: string) =>
    text.split("\n").filter((line) => /^#{2,3} /.test(line));

  const carried = headings(v41).filter((h) => h !== "## Opus 5 Working Style");
  for (const heading of carried) {
    assert(
      headings(v42).includes(heading),
      `v42 dropped the section "${heading}"`,
    );
  }
});

Deno.test("MODEL-AND-CACHING.md records the working-style framing move", async () => {
  const text = await Deno.readTextFile(
    new URL("../../../docs/MODEL-AND-CACHING.md", import.meta.url),
  );
  const section = text.slice(
    text.indexOf("#### Model-generation prompt tuning"),
  );
  assert(section.length > 0, "Model-generation prompt tuning section missing");
  assertStringIncludes(section, "v42");
  assertStringIncludes(
    unwrapped(section),
    "coding_guidelines` template is model-agnostic",
  );
});
