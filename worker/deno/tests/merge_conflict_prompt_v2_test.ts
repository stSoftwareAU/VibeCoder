/**
 * Tests for the merge_conflict prompt (Issue #467).
 *
 * The template documents the deterministic dependency rules as an explicit,
 * bounded carve-out from the never-side-pick contract: the worker settles
 * dependency-version conflicts in known manifest files before the agent is
 * asked anything, regenerates lock files rather than merging them, and lists
 * only the deferred paths in `{{CONFLICTED_FILES}}`. The carve-out is limited
 * to dependency-version hunks — the contradictory-constant worked example
 * still instructs abort-and-escalate.
 *
 * Australian English is used throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildMergeConflictPrompt } from "../lib/prompt_builder.ts";
import { loadPrompt, validatePromptTemplate } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadMergeConflict(): Promise<string> {
  const result = await loadPrompt("merge_conflict", PROMPTS_DIR);
  assertEquals(result.ok, true, "merge_conflict failed to load");
  if (!result.ok) throw new Error("merge_conflict failed to load");
  return result.value;
}

// --- Loading contract ---

Deno.test("merge_conflict - loads via loadPrompt", async () => {
  const body = await loadMergeConflict();
  assert(body.length > 0);
});

Deno.test("merge_conflict - satisfies the placeholder contract", async () => {
  const body = await loadMergeConflict();
  const validation = validatePromptTemplate("merge_conflict", body);
  assertEquals(validation.ok, true, JSON.stringify(validation));
});

Deno.test("merge_conflict - carries every required placeholder plus verbosity", async () => {
  const body = await loadMergeConflict();
  for (
    const placeholder of [
      "PR_NUMBER",
      "QUALITY_INSTRUCTIONS",
      "BASE_BRANCH",
      "CONFLICTED_FILES",
      "VERBOSITY_INSTRUCTIONS",
    ]
  ) {
    assertStringIncludes(body, `{{${placeholder}}}`);
  }
});

Deno.test("merge_conflict - builds with every placeholder substituted", async () => {
  const built = await buildMergeConflictPrompt({
    repo: "stSoftwareAU/VibeCoder",
    prNumber: "4321",
    baseBranch: "main",
    conflictedFiles: ["worker/deno/lib/foo.ts"],
    qualityInstructions: "Run ./quality.sh",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;

  const { prompt, systemPrompt } = built.value;
  assertEquals(
    /\{\{[A-Z_]+\}\}/.test(prompt),
    false,
    `unsubstituted placeholder in prompt: ${
      prompt.match(/\{\{[A-Z_]+\}\}/g)?.join(", ")
    }`,
  );
  assert(systemPrompt.length > 0);
  assertStringIncludes(prompt, "PR #4321");
  assertStringIncludes(prompt, "`main`");
  assertStringIncludes(prompt, "worker/deno/lib/foo.ts");
  assertStringIncludes(prompt, "Run ./quality.sh");
});

// --- The never-side-pick contract survives ---

Deno.test("merge_conflict - keeps the never-side-pick contract", async () => {
  const body = await loadMergeConflict();
  assertStringIncludes(body, "Never side-pick");
  assertStringIncludes(body, "git merge -X ours");
  assertStringIncludes(body, "git checkout --ours");
  assertStringIncludes(body, "duplicate");
});

Deno.test("merge_conflict - the contradictory timeout example still aborts and escalates", async () => {
  const body = await loadMergeConflict();
  const start = body.indexOf("30s to 60s");
  assert(start >= 0, "the timeout worked example is missing");
  const end = body.indexOf("</example>", start);
  assert(end > start, "the timeout worked example is unterminated");
  const example = body.slice(start, end);
  assertStringIncludes(example, "git merge --abort");
  assertStringIncludes(example, "human");
});

// --- The bounded dependency carve-out ---

Deno.test("merge_conflict - names the carve-out in the contract section", async () => {
  const body = await loadMergeConflict();
  const start = body.indexOf("## The Contract — Both Sides Survive");
  const end = body.indexOf("## What To Do", start);
  assert(start >= 0 && end > start, "contract section missing");
  const contract = body.slice(start, end);
  assertStringIncludes(contract, "carve-out");
  assertStringIncludes(contract, "dependency-version");
});

Deno.test("merge_conflict - the carve-out is bounded to dependency-version hunks in known manifests", async () => {
  const body = await loadMergeConflict();
  assertStringIncludes(body, "only");
  for (
    const manifest of ["deno.json", "package.json", "Cargo.toml", "go.mod"]
  ) {
    assertStringIncludes(body, manifest);
  }
  // A source-code constant is explicitly outside the carve-out.
  assertStringIncludes(body, "source code");
});

Deno.test("merge_conflict - states the rules run before this prompt and take the higher version", async () => {
  const body = await loadMergeConflict();
  assertStringIncludes(body, "before");
  assertStringIncludes(body, "higher");
  assertStringIncludes(body, "semver");
});

Deno.test("merge_conflict - says lock files are regenerated, never merged", async () => {
  const body = await loadMergeConflict();
  assertStringIncludes(body, "regenerate");
  for (
    const lock of ["deno.lock", "package-lock.json", "Cargo.lock", "go.sum"]
  ) {
    assertStringIncludes(body, lock);
  }
});

Deno.test("merge_conflict - tells the agent rule-resolved files are not in the conflicted list", async () => {
  const body = await loadMergeConflict();
  const start = body.indexOf("## The Contract — Both Sides Survive");
  const end = body.indexOf("## What To Do", start);
  const contract = body.slice(start, end);
  assertStringIncludes(contract, "conflicted-file list");
  assertStringIncludes(contract, "not listed");
  // The placeholder itself is injected once, at the end of the template.
  assertEquals(body.split("{{CONFLICTED_FILES}}").length - 1, 1);
});

Deno.test("merge_conflict - gives the total-order rationale so the carve-out is not generalised", async () => {
  const body = await loadMergeConflict();
  assertStringIncludes(body, "total order");
  assertStringIncludes(body, "rule");
  assertStringIncludes(body, "judgement");
});
