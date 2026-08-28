/**
 * Tests for merge_conflict prompt v2 (Issue #467).
 *
 * v2 documents the deterministic dependency rules as an explicit, bounded
 * carve-out from the never-side-pick contract: the worker settles
 * dependency-version conflicts in known manifest files before the agent is
 * asked anything, regenerates lock files rather than merging them, and lists
 * only the deferred paths in `{{CONFLICTED_FILES}}`. The carve-out is limited
 * to dependency-version hunks — the contradictory-constant worked example
 * still instructs abort-and-escalate. v1 stays immutable and is the negative
 * control.
 *
 * Australian English is used throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildMergeConflictPrompt } from "../lib/prompt_builder.ts";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadMergeConflict(version: string): Promise<string> {
  const result = await loadPrompt("merge_conflict", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `merge_conflict ${version} failed to load`);
  if (!result.ok) throw new Error(`merge_conflict ${version} failed to load`);
  return result.value;
}

const loadV2 = () => loadMergeConflict("v2");

// --- Loading contract ---

Deno.test("merge_conflict v2 - loads via loadPrompt", async () => {
  const body = await loadV2();
  assert(body.length > 0);
});

Deno.test("merge_conflict v2 - is the latest version on disk", async () => {
  const result = await getLatestVersion("merge_conflict", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 2,
    true,
    `expected merge_conflict >= v2, got ${result.value}`,
  );
});

Deno.test("merge_conflict v2 - satisfies the placeholder contract", async () => {
  const body = await loadV2();
  const validation = validatePromptTemplate("merge_conflict", body);
  assertEquals(validation.ok, true, JSON.stringify(validation));
});

Deno.test("merge_conflict v2 - carries every required placeholder plus verbosity", async () => {
  const body = await loadV2();
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

Deno.test("merge_conflict v2 - builds with every placeholder substituted", async () => {
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

Deno.test("merge_conflict v2 - keeps the never-side-pick contract", async () => {
  const body = await loadV2();
  assertStringIncludes(body, "Never side-pick");
  assertStringIncludes(body, "git merge -X ours");
  assertStringIncludes(body, "git checkout --ours");
  assertStringIncludes(body, "duplicate");
});

Deno.test("merge_conflict v2 - the contradictory timeout example still aborts and escalates", async () => {
  const body = await loadV2();
  const start = body.indexOf("30s to 60s");
  assert(start >= 0, "the timeout worked example is missing");
  const end = body.indexOf("</example>", start);
  assert(end > start, "the timeout worked example is unterminated");
  const example = body.slice(start, end);
  assertStringIncludes(example, "git merge --abort");
  assertStringIncludes(example, "human");
});

// --- The bounded dependency carve-out ---

Deno.test("merge_conflict v2 - names the carve-out in the contract section", async () => {
  const body = await loadV2();
  const start = body.indexOf("## The Contract — Both Sides Survive");
  const end = body.indexOf("## What To Do", start);
  assert(start >= 0 && end > start, "contract section missing");
  const contract = body.slice(start, end);
  assertStringIncludes(contract, "carve-out");
  assertStringIncludes(contract, "dependency-version");
});

Deno.test("merge_conflict v2 - the carve-out is bounded to dependency-version hunks in known manifests", async () => {
  const body = await loadV2();
  assertStringIncludes(body, "only");
  for (
    const manifest of ["deno.json", "package.json", "Cargo.toml", "go.mod"]
  ) {
    assertStringIncludes(body, manifest);
  }
  // A source-code constant is explicitly outside the carve-out.
  assertStringIncludes(body, "source code");
});

Deno.test("merge_conflict v2 - states the rules run before this prompt and take the higher version", async () => {
  const body = await loadV2();
  assertStringIncludes(body, "before");
  assertStringIncludes(body, "higher");
  assertStringIncludes(body, "semver");
});

Deno.test("merge_conflict v2 - says lock files are regenerated, never merged", async () => {
  const body = await loadV2();
  assertStringIncludes(body, "regenerate");
  for (
    const lock of ["deno.lock", "package-lock.json", "Cargo.lock", "go.sum"]
  ) {
    assertStringIncludes(body, lock);
  }
});

Deno.test("merge_conflict v2 - tells the agent rule-resolved files are not in the conflicted list", async () => {
  const body = await loadV2();
  const start = body.indexOf("## The Contract — Both Sides Survive");
  const end = body.indexOf("## What To Do", start);
  const contract = body.slice(start, end);
  assertStringIncludes(contract, "conflicted-file list");
  assertStringIncludes(contract, "not listed");
  // The placeholder itself is injected once, at the end of the template.
  assertEquals(body.split("{{CONFLICTED_FILES}}").length - 1, 1);
});

Deno.test("merge_conflict v2 - gives the total-order rationale so the carve-out is not generalised", async () => {
  const body = await loadV2();
  assertStringIncludes(body, "total order");
  assertStringIncludes(body, "rule");
  assertStringIncludes(body, "judgement");
});

// --- v1 is the negative control ---

Deno.test("merge_conflict v1 - does not mention the dependency carve-out", async () => {
  const body = await loadMergeConflict("v1");
  assertEquals(body.includes("carve-out"), false);
  assertEquals(body.includes("dependency-version"), false);
});
