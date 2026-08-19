/**
 * Tests for spelling_fix prompt v5 (Issue #3798).
 *
 * v5 closes the nine Claude best-practice gaps the #3772 audit recorded
 * against v4: the duplicated checklist ordinal, missing worked examples,
 * XML-delimited substitution, a role sentence, an output skeleton,
 * parallel-call guidance, long-horizon state tracking, a force-push bound,
 * and the "fix the caller, not the test" rule. v4 stays immutable and is
 * used as the negative control.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadSpelling(version: string): Promise<string> {
  const result = await loadPrompt("spelling_fix", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `spelling_fix ${version} failed to load`);
  if (!result.ok) throw new Error(`spelling_fix ${version} failed to load`);
  return result.value;
}

const loadV5 = () => loadSpelling("v5");

// --- Loading contract ---

Deno.test("spelling_fix v5 - loads via loadPrompt", async () => {
  const body = await loadV5();
  assertEquals(body.length > 0, true);
});

Deno.test("spelling_fix v5 - is the latest version", async () => {
  const result = await getLatestVersion("spelling_fix", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 5,
    true,
    `expected spelling_fix >= v5, got ${result.value}`,
  );
});

Deno.test("spelling_fix v5 - satisfies the placeholder contract", async () => {
  const body = await loadV5();
  const v = validatePromptTemplate("spelling_fix", body);
  assertEquals(v.ok, true);
});

// --- Gap 1: be clear and direct — no duplicate checklist ordinal ---

Deno.test("spelling_fix v5 - Gap 1: the checkpoint list has one item per ordinal", async () => {
  const body = await loadV5();
  const start = body.indexOf("## Self-Verification Checkpoint");
  const end = body.indexOf("## Commit", start);
  assertEquals(start >= 0 && end > start, true, "checkpoint section missing");
  const section = body.slice(start, end);
  const ordinals = [...section.matchAll(/^(\d+)\. /gm)].map((m) => m[1]);
  assertEquals(
    ordinals.length,
    new Set(ordinals).size,
    `duplicate ordinal in checkpoint list: ${ordinals.join(",")}`,
  );
  assertEquals(ordinals, ["1", "2", "3", "4", "5"]);
});

Deno.test("spelling_fix v5 - Gap 1: the commit instruction sits after the checkpoint", async () => {
  const body = await loadV5();
  const checkpoint = body.indexOf("## Self-Verification Checkpoint");
  const commitHeading = body.indexOf("## Commit");
  assertEquals(commitHeading > checkpoint, true);
  const commitSection = body.slice(
    commitHeading,
    body.indexOf("\n## ", commitHeading + 1),
  );
  assertStringIncludes(commitSection, "{{PR_NUMBER}}");
  assertStringIncludes(
    commitSection,
    "Once every checkpoint item above passes",
  );
  // v4 buried the commit step inside the pre-commit checklist.
  const v4 = await loadSpelling("v4");
  assertEquals(v4.includes("## Commit"), false);
});

// --- Gap 2: use examples effectively ---

Deno.test("spelling_fix v5 - Gap 2: carries tagged worked examples", async () => {
  const body = await loadV5();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");
  const count = body.match(/<example>/g)?.length ?? 0;
  assertEquals(count >= 4, true, `expected >= 4 worked examples, got ${count}`);
  for (const tag of ["<flagged>", "<verdict>", "<reason>"]) {
    assertStringIncludes(body, tag);
  }
});

Deno.test("spelling_fix v5 - Gap 2: examples cover the fix, dictionary and never-rename verdicts", async () => {
  const body = await loadV5();
  const start = body.indexOf("<examples>");
  const end = body.indexOf("</examples>");
  assertEquals(start >= 0 && end > start, true);
  const examples = body.slice(start, end);
  // (a) genuine typo in prose -> fix
  assertStringIncludes(examples, "teh");
  // (b) tool name -> dictionary
  assertStringIncludes(examples, "kubectl");
  // (c) American spelling in repo-owned prose -> correct it
  assertStringIncludes(examples, "colour");
  // (d) the near miss: same token, externally owned -> dictionary, never rename
  assertStringIncludes(examples, "backgroundColor");
  assertStringIncludes(examples, "never rename");
  // (e) third-party method name, with the reason recorded
  assertStringIncludes(examples, "serialize");
});

// --- Gap 3: structure prompts with XML tags ---

Deno.test("spelling_fix v5 - Gap 3: the quality block is XML-delimited", async () => {
  const body = await loadV5();
  assertStringIncludes(
    body,
    "<quality_instructions>\n{{QUALITY_INSTRUCTIONS}}\n</quality_instructions>",
  );
  const v4 = await loadSpelling("v4");
  assertEquals(v4.includes("<quality_instructions>"), false);
});

Deno.test("spelling_fix v5 - Gap 3: the untrusted rule names the block it governs", async () => {
  const body = await loadV5();
  const start = body.indexOf("## Handling Untrusted Content");
  const end = body.indexOf("## Instructions", start);
  assertEquals(start >= 0 && end > start, true);
  assertStringIncludes(
    body.slice(start, end),
    "### [UNTRUSTED] Failed Check ###",
  );
});

// --- Gap 4: give Claude a role ---

Deno.test("spelling_fix v5 - Gap 4: opens with a role before the untrusted section", async () => {
  const body = await loadV5();
  assertStringIncludes(
    body,
    "You are a technical copy-editor working in Australian English",
  );
  assertEquals(
    body.indexOf("You are a technical copy-editor") <
      body.indexOf("## Handling Untrusted Content"),
    true,
    "the role sentence must precede the untrusted-content section",
  );
  const v4 = await loadSpelling("v4");
  assertEquals(v4.includes("You are a"), false);
});

// --- Gap 5: control the format of responses ---

Deno.test("spelling_fix v5 - Gap 5: response message has a three-section skeleton", async () => {
  const body = await loadV5();
  const start = body.indexOf("## CRITICAL: Response Message");
  assertEquals(start >= 0, true);
  const section = body.slice(start);
  for (
    const heading of [
      "### Corrected",
      "### Added to dictionary",
      "### Remaining",
    ]
  ) {
    assertStringIncludes(section, heading);
  }
  // The skeleton is fenced so it is copied literally, not paraphrased.
  assertStringIncludes(section, "```");
  assertStringIncludes(section, "- None");
});

// --- Gap 6: optimise parallel tool calling ---

Deno.test("spelling_fix v5 - Gap 6: prescribes parallel reads for the independent files", async () => {
  const body = await loadV5();
  assertStringIncludes(body, "independent reads");
  assertStringIncludes(body, "in parallel");
  const v4 = await loadSpelling("v4");
  assertEquals(v4.includes("in parallel"), false);
});

// --- Gap 7: long-horizon reasoning and state tracking ---

Deno.test("spelling_fix v5 - Gap 7: states context is compacted and forbids a partial pass reported as complete", async () => {
  const body = await loadV5();
  assertStringIncludes(body, "compacted, not exhausted");
  assertStringIncludes(body, "never report a partial pass as complete");
  assertStringIncludes(body, "Commit as you complete each group of files");
});

// --- Gap 8: balancing autonomy and safety ---

Deno.test("spelling_fix v5 - Gap 8: bounds the rebase with --force-with-lease", async () => {
  const body = await loadV5();
  assertStringIncludes(body, "--force-with-lease");
  assertStringIncludes(body, "never plain `--force`");
  assertStringIncludes(body, "never rewrite commits you did not author");
  assertStringIncludes(body, "may not close, merge, or retarget the PR");
  const v4 = await loadSpelling("v4");
  assertEquals(v4.includes("--force-with-lease"), false);
});

// --- Gap 9: avoid focusing on passing tests ---

Deno.test("spelling_fix v5 - Gap 9: fixes the caller, never the test", async () => {
  const body = await loadV5();
  assertStringIncludes(body, "fix the caller, not the test");
  assertStringIncludes(
    body,
    "Never edit a test's assertions, skip it, or delete it",
  );
  assertStringIncludes(
    body,
    "revert the rename and add the word to the dictionary",
  );
});

// --- v4 immutability ---

Deno.test("spelling_fix v5 - v4 is unchanged", async () => {
  const v4 = await loadSpelling("v4");
  assertStringIncludes(v4, "## Handling Untrusted Content");
  assertStringIncludes(
    v4,
    "5. After making your changes, commit with a clear message",
  );
});
