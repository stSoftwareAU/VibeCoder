/**
 * Tests for workflow setup prompt template (Issue #1394).
 *
 * Verifies prompt template loading, placeholder validation, and builder
 * function for the workflow_setup prompt category.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  getOptionalPlaceholders,
  getRequiredPlaceholders,
  loadPrompt,
  validateAllPromptTemplates,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { buildWorkflowSetupPrompt } from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- prompt_manager: workflow_setup registration tests ---

Deno.test("prompt manager - returns required placeholders for workflow_setup", () => {
  const result = getRequiredPlaceholders("workflow_setup");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.includes("REPO"), true);
    assertEquals(result.value.includes("LANGUAGES"), true);
    assertEquals(result.value.includes("MISSING_WORKFLOWS"), true);
    assertEquals(result.value.includes("DEFAULT_BRANCH"), true);
    assertEquals(result.value.includes("EXISTING_WORKFLOWS"), true);
  }
});

Deno.test("prompt manager - returns optional placeholders for workflow_setup", () => {
  const result = getOptionalPlaceholders("workflow_setup");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.includes("VERBOSITY_INSTRUCTIONS"), true);
  }
});

// --- prompt template loading tests ---

Deno.test("prompt manager - loads workflow_setup template", async () => {
  const result = await loadPrompt("workflow_setup", undefined, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("prompt manager - loads workflow_setup v1 specifically", async () => {
  const result = await loadPrompt("workflow_setup", "v1", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "{{REPO}}");
    assertStringIncludes(result.value, "{{LANGUAGES}}");
    assertStringIncludes(result.value, "{{MISSING_WORKFLOWS}}");
    assertStringIncludes(result.value, "{{DEFAULT_BRANCH}}");
    assertStringIncludes(result.value, "{{EXISTING_WORKFLOWS}}");
  }
});

Deno.test("prompt manager - workflow_setup template passes validation", async () => {
  const loadResult = await loadPrompt("workflow_setup", undefined, PROMPTS_DIR);
  assertEquals(loadResult.ok, true);
  if (loadResult.ok) {
    const validateResult = validatePromptTemplate(
      "workflow_setup",
      loadResult.value,
    );
    assertEquals(validateResult.ok, true);
  }
});

Deno.test("prompt manager - validateAllPromptTemplates includes workflow_setup", async () => {
  const result = await validateAllPromptTemplates(PROMPTS_DIR);
  assertEquals(result.ok, true);
});

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
    "## Repository Context: AGENTS.md\n\nUse NEAT-AI patterns.";
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
    assertStringIncludes(result.value.prompt, "Use NEAT-AI patterns.");
    assertEquals(
      result.value.systemPrompt.includes("Use NEAT-AI patterns."),
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

Deno.test("prompt builder - workflow setup prompt template mentions workflow YAML generation", async () => {
  const result = await loadPrompt("workflow_setup", "v1", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Template should instruct Claude to generate workflow YAML
    assertStringIncludes(result.value, "workflow");
    assertStringIncludes(result.value, "YAML");
  }
});

// --- v2 template tests (Issue #1581) ---
//
// v2 folds in CI hardening lessons learnt from NEAT-AI-scorer issues #18–#24.
// v1 is frozen (per Issue #235 prompt immutability) and must remain unchanged.

Deno.test("prompt manager - loads workflow_setup v2 specifically", async () => {
  const result = await loadPrompt("workflow_setup", "v2", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // All v1 placeholders must also be present in v2
    assertStringIncludes(result.value, "{{REPO}}");
    assertStringIncludes(result.value, "{{LANGUAGES}}");
    assertStringIncludes(result.value, "{{MISSING_WORKFLOWS}}");
    assertStringIncludes(result.value, "{{DEFAULT_BRANCH}}");
    assertStringIncludes(result.value, "{{EXISTING_WORKFLOWS}}");
    assertStringIncludes(result.value, "{{CODING_GUIDELINES}}");
    assertStringIncludes(result.value, "{{VERBOSITY_INSTRUCTIONS}}");
  }
});

Deno.test("prompt manager - workflow_setup v2 contains CI Hardening Defaults section", async () => {
  const result = await loadPrompt("workflow_setup", "v2", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "CI Hardening Defaults");
    // Concrete NEAT-AI-scorer learnings codified in v2
    assertStringIncludes(
      result.value,
      "Pin actions to fully-qualified versions",
    );
    assertStringIncludes(result.value, "workspace-relative checkout paths");
    assertStringIncludes(result.value, "PR diff");
    assertStringIncludes(result.value, "needs:");
    assertStringIncludes(result.value, "preflight");
    assertStringIncludes(result.value, "ignore list");
  }
});

Deno.test("prompt manager - workflow_setup v2 passes placeholder validation", async () => {
  const result = await loadPrompt("workflow_setup", "v2", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const validateResult = validatePromptTemplate(
      "workflow_setup",
      result.value,
    );
    assertEquals(validateResult.ok, true);
  }
});

Deno.test("prompt manager - workflow_setup v1 remains unchanged (immutability)", async () => {
  // v1 must still load and contain its original sections — v2 must not
  // disturb v1 content.
  const result = await loadPrompt("workflow_setup", "v1", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // v1 does NOT contain the new section (sanity check that v1 was not edited)
    assertEquals(result.value.includes("CI Hardening Defaults"), false);
    // v1 still contains its original Security Workflows section
    assertStringIncludes(result.value, "### Security Workflows");
    assertStringIncludes(result.value, "### Quality Workflows");
  }
});

// --- v3 template tests (Issue #1756) ---
//
// v3 codifies the canonical NEAT-AI gitleaks pattern in two ways:
//   1. SHA-pinned third-party actions and a wired-through GITLEAKS_LICENSE
//      secret (avoids ErrLicense and supply-chain tag hijack).
//   2. An explicit "Fetch base branch" step before gitleaks-action runs so
//      the action's computed `<base_sha>^..<head_sha>` rev-range resolves
//      on the PR runner (avoids "fatal: Invalid revision range").
// v1 and v2 are frozen (per Issue #235 prompt immutability).

Deno.test("prompt manager - loads workflow_setup v3 specifically", async () => {
  const result = await loadPrompt("workflow_setup", "v3", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // All required placeholders must still be present in v3
    assertStringIncludes(result.value, "{{REPO}}");
    assertStringIncludes(result.value, "{{LANGUAGES}}");
    assertStringIncludes(result.value, "{{MISSING_WORKFLOWS}}");
    assertStringIncludes(result.value, "{{DEFAULT_BRANCH}}");
    assertStringIncludes(result.value, "{{EXISTING_WORKFLOWS}}");
    assertStringIncludes(result.value, "{{CODING_GUIDELINES}}");
    assertStringIncludes(result.value, "{{VERBOSITY_INSTRUCTIONS}}");
  }
});

Deno.test(
  "prompt manager - workflow_setup v3 documents NEAT-AI gitleaks pattern",
  async () => {
    const result = await loadPrompt("workflow_setup", "v3", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      // The new section must point to NEAT-AI as canonical
      assertStringIncludes(result.value, "Gitleaks Reference Implementation");
      assertStringIncludes(result.value, "example-org/private-repo-29");
      // The two concrete failures the prompt must prevent
      assertStringIncludes(result.value, "GITLEAKS_LICENSE");
      assertStringIncludes(result.value, "ErrLicense");
      // The hardening rule the v2 template let slip through. The prompt
      // wraps "40-character" and "commit SHA" across two lines, so allow
      // any whitespace between them.
      assertEquals(
        /40-character\s+commit SHA/.test(result.value),
        true,
        "v3 should require a 40-character commit SHA pin",
      );
      // The fetch-base-branch fix from NEAT-AI quality.yml
      assertStringIncludes(result.value, "Fetch base branch");
      assertStringIncludes(result.value, "github.base_ref");
      assertStringIncludes(result.value, "Invalid revision range");
      // v3 retains the v2 hardening section
      assertStringIncludes(result.value, "CI Hardening Defaults");
    }
  },
);

Deno.test("prompt manager - workflow_setup v3 passes placeholder validation", async () => {
  const result = await loadPrompt("workflow_setup", "v3", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const validateResult = validatePromptTemplate(
      "workflow_setup",
      result.value,
    );
    assertEquals(validateResult.ok, true);
  }
});

Deno.test(
  "prompt manager - workflow_setup v2 remains unchanged (immutability for v3)",
  async () => {
    // v2 must NOT mention the v3-only NEAT-AI gitleaks fixes — they live
    // in v3 only. This guards against accidental edits to v2.
    const result = await loadPrompt("workflow_setup", "v2", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(
        result.value.includes("Gitleaks Reference Implementation"),
        false,
        "v2 must not contain the v3 Gitleaks Reference Implementation section",
      );
      assertEquals(result.value.includes("Fetch base branch"), false);
      assertEquals(result.value.includes("Invalid revision range"), false);
      // v2 still contains its existing CI Hardening Defaults section
      assertStringIncludes(result.value, "CI Hardening Defaults");
    }
  },
);

Deno.test(
  "prompt manager - default workflow_setup version resolves to the latest",
  async () => {
    // Issue #3286: assert the version-resolution contract (default == latest)
    // rather than grepping mutable prose on the newest prompt. The prompt body
    // and which vN is newest both change over time (Issue #2282), so coupling
    // to a heading string is a HOW-test that breaks on pure documentation
    // edits. loadPrompt without an explicit version must return exactly the
    // content of the version getLatestVersion resolves to.
    const latest = await getLatestVersion("workflow_setup", PROMPTS_DIR);
    assertEquals(latest.ok, true);

    const defaultLoad = await loadPrompt(
      "workflow_setup",
      undefined,
      PROMPTS_DIR,
    );
    assertEquals(defaultLoad.ok, true);

    if (latest.ok && defaultLoad.ok) {
      const explicitLoad = await loadPrompt(
        "workflow_setup",
        latest.value,
        PROMPTS_DIR,
      );
      assertEquals(explicitLoad.ok, true);
      if (explicitLoad.ok) {
        assertEquals(defaultLoad.value, explicitLoad.value);
      }
    }
  },
);
