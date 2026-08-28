/**
 * Tests for workflow setup prompt template (Issue #1394).
 *
 * Verifies prompt template loading, placeholder validation, and builder
 * function for the workflow_setup prompt category.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildWorkflowSetupPrompt } from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- prompt_manager: workflow_setup registration tests ---

// --- prompt template loading tests ---

// --- prompt builder: buildWorkflowSetupPrompt tests ---

Deno.test("prompt builder - workflow setup prompt includes repo and languages", async () => {
  const result = await buildWorkflowSetupPrompt({
    repo: "owner/repo",
    languages: "TypeScript, JavaScript",
    missingWorkflows: "- lint (quality)\n- test (quality)",
    defaultBranch: "main",
    existingWorkflows: "ci.yml (build)",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "owner/repo");
    assertStringIncludes(result.value.prompt, "TypeScript, JavaScript");
    assertStringIncludes(result.value.prompt, "lint (quality)");
    assertStringIncludes(result.value.prompt, "main");
    assertStringIncludes(result.value.prompt, "ci.yml (build)");
  }
});

Deno.test("prompt builder - workflow setup prompt returns PromptParts with coding guidelines in systemPrompt", async () => {
  const result = await buildWorkflowSetupPrompt({
    repo: "owner/repo",
    languages: "Python",
    missingWorkflows: "- security-scan (security)",
    defaultBranch: "main",
    existingWorkflows: "none",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(typeof result.value.systemPrompt, "string");
    assertEquals(typeof result.value.prompt, "string");
    // System prompt should contain coding guidelines (static, cacheable)
    assertStringIncludes(result.value.systemPrompt, "Australian English");
  }
});

// Issue #3706: repo context moved from the system prompt to a fenced block in
// the user turn — it is repository-supplied and therefore untrusted.
Deno.test("prompt builder - workflow setup prompt injects repo context into the user turn", async () => {
  const repoContext =
    "## Repository Context: AGENTS.md\n\nUse private-repo-14 patterns.";
  const result = await buildWorkflowSetupPrompt({
    repo: "owner/repo",
    languages: "Go",
    missingWorkflows: "- lint",
    defaultBranch: "main",
    existingWorkflows: "none",
    repoContextContent: repoContext,
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "Use private-repo-14 patterns.");
    assertEquals(
      result.value.systemPrompt.includes("Use private-repo-14 patterns."),
      false,
    );
    assertStringIncludes(result.value.systemPrompt, "Australian English");
  }
});

Deno.test("prompt builder - workflow setup prompt system prompts are identical for different repos", async () => {
  const result1 = await buildWorkflowSetupPrompt({
    repo: "owner/repo1",
    languages: "TypeScript",
    missingWorkflows: "- lint",
    defaultBranch: "main",
    existingWorkflows: "none",
    promptsDir: PROMPTS_DIR,
  });
  const result2 = await buildWorkflowSetupPrompt({
    repo: "owner/repo2",
    languages: "Python",
    missingWorkflows: "- test",
    defaultBranch: "develop",
    existingWorkflows: "ci.yml",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result1.ok, true);
  assertEquals(result2.ok, true);
  if (result1.ok && result2.ok) {
    // System prompts should be identical for cache hits
    assertEquals(result1.value.systemPrompt, result2.value.systemPrompt);
    // User prompts should differ (different repo content)
    assertEquals(result1.value.prompt !== result2.value.prompt, true);
  }
});

Deno.test("prompt builder - workflow setup prompt supports verbosity level", async () => {
  const result = await buildWorkflowSetupPrompt({
    repo: "owner/repo",
    languages: "Rust",
    missingWorkflows: "- lint",
    defaultBranch: "main",
    existingWorkflows: "none",
    verbosityLevel: "concise",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "Verbosity");
  }
});

// --- v2 template tests (Issue #1581) ---
//
// v2 folds in CI hardening lessons learnt from private-repo-22 issues #18–#24.
// v1 is frozen (per Issue #235 prompt immutability) and must remain unchanged.

// --- v3 template tests (Issue #1756) ---
//
// v3 codifies the canonical private-repo-14 gitleaks pattern in two ways:
//   1. SHA-pinned third-party actions and a wired-through GITLEAKS_LICENSE
//      secret (avoids ErrLicense and supply-chain tag hijack).
//   2. An explicit "Fetch base branch" step before gitleaks-action runs so
//      the action's computed `<base_sha>^..<head_sha>` rev-range resolves
//      on the PR runner (avoids "fatal: Invalid revision range").
// v1 and v2 are frozen (per Issue #235 prompt immutability).
