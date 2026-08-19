/**
 * Tests for verbosity instruction injection into prompts (Issue #1332).
 *
 * Verifies that the {{VERBOSITY_INSTRUCTIONS}} placeholder is correctly
 * substituted in all prompt types for each verbosity level. Also tests
 * backward compatibility — "standard" level produces output identical
 * to omitting verbosity entirely.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  buildCiFixPrompt,
  buildIssuePrompt,
  buildPlanningPrompt,
  buildPrFeedbackPrompt,
  buildQuestionPrompt,
  buildSpellingFixPrompt,
  buildVerbosityBlock,
} from "../lib/prompt_builder.ts";
import { computeStaticPromptHash } from "../lib/prompt_hash.ts";
import {
  getOptionalPlaceholders,
  OPTIONAL_PLACEHOLDERS,
} from "../lib/prompt_manager.ts";
import type { VerbosityLevel } from "../types.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// =============================================================================
// buildVerbosityBlock tests
// =============================================================================

// Issue #3813 (Gap 3): standard and an omitted level used to return an empty
// string. Every level now emits a block, so no surface is silent about the
// output it publishes. Omitting the level still behaves exactly like standard.
Deno.test("verbosity block - standard level returns section with instructions", () => {
  const block = buildVerbosityBlock("standard");
  assertStringIncludes(block, "## Response Verbosity");
  assertStringIncludes(block, "Summarise what you changed");
});

Deno.test("verbosity block - undefined matches standard (backward compatible)", () => {
  assertEquals(buildVerbosityBlock(undefined), buildVerbosityBlock("standard"));
});

Deno.test("verbosity block - minimal level returns section with instructions", () => {
  const block = buildVerbosityBlock("minimal");
  assertStringIncludes(block, "## Response Verbosity");
  assertStringIncludes(block, "single sentence");
});

Deno.test("verbosity block - concise level returns section with instructions", () => {
  const block = buildVerbosityBlock("concise");
  assertStringIncludes(block, "## Response Verbosity");
  assertStringIncludes(block, "brief");
});

Deno.test("verbosity block - verbose level returns section with instructions", () => {
  const block = buildVerbosityBlock("verbose");
  assertStringIncludes(block, "## Response Verbosity");
  assertStringIncludes(block, "detailed explanations");
});

// =============================================================================
// Issue prompt verbosity injection tests
// =============================================================================

Deno.test("issue prompt - minimal verbosity injects instructions", async () => {
  const result = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "Test",
    issueBody: "Body",
    issueLabels: "test",
    qualityInstructions: "",
    verbosityLevel: "minimal",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "Response Verbosity");
    assertStringIncludes(result.value.prompt, "single sentence");
  }
});

// Issue #3813 (Gap 3): standard now carries an explicit verbosity block.
Deno.test("issue prompt - standard verbosity injects the summarise-at-the-end block", async () => {
  const result = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "Test",
    issueBody: "Body",
    issueLabels: "test",
    qualityInstructions: "",
    verbosityLevel: "standard",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "Response Verbosity");
    assertStringIncludes(result.value.prompt, "Summarise what you changed");
  }
});

Deno.test("issue prompt - omitted verbosity behaves like standard (backward compatible)", async () => {
  const withStandard = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "Test",
    issueBody: "Body",
    issueLabels: "test",
    qualityInstructions: "",
    verbosityLevel: "standard",
    promptsDir: PROMPTS_DIR,
  });
  const withoutLevel = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "Test",
    issueBody: "Body",
    issueLabels: "test",
    qualityInstructions: "",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(withStandard.ok, true);
  assertEquals(withoutLevel.ok, true);
  if (withStandard.ok && withoutLevel.ok) {
    // Both resolve to the standard block (randomised delimiters prevent exact
    // string comparison, but the verbosity behaviour must be identical).
    assertStringIncludes(withStandard.value.prompt, "Response Verbosity");
    assertStringIncludes(withoutLevel.value.prompt, "Response Verbosity");
    assertEquals(
      withStandard.value.prompt.includes("{{VERBOSITY_INSTRUCTIONS}}"),
      false,
    );
    assertEquals(
      withoutLevel.value.prompt.includes("{{VERBOSITY_INSTRUCTIONS}}"),
      false,
    );
    // System prompts should be identical (no randomised content there)
    assertEquals(
      withStandard.value.systemPrompt,
      withoutLevel.value.systemPrompt,
    );
  }
});

Deno.test("issue prompt - no leftover VERBOSITY_INSTRUCTIONS placeholder", async () => {
  const levels: (VerbosityLevel | undefined)[] = [
    "minimal",
    "concise",
    "standard",
    "verbose",
    undefined,
  ];
  for (const level of levels) {
    const result = await buildIssuePrompt({
      repo: "owner/repo",
      issueNumber: "1",
      issueTitle: "T",
      issueBody: "B",
      issueLabels: "t",
      qualityInstructions: "",
      verbosityLevel: level,
      promptsDir: PROMPTS_DIR,
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(
        result.value.prompt.includes("{{VERBOSITY_INSTRUCTIONS}}"),
        false,
        `Leftover placeholder found for level '${level}'`,
      );
    }
  }
});

Deno.test("issue prompt - verbose level includes detailed explanation instructions", async () => {
  const result = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "Test",
    issueBody: "Body",
    issueLabels: "test",
    qualityInstructions: "",
    verbosityLevel: "verbose",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "detailed explanations");
    assertStringIncludes(result.value.prompt, "trade-offs");
  }
});

// =============================================================================
// Planning prompt verbosity injection tests
// =============================================================================

Deno.test("planning prompt - concise verbosity injects instructions", async () => {
  const result = await buildPlanningPrompt({
    repo: "owner/repo",
    issueNumber: "99",
    issueTitle: "Plan feature",
    issueBody: "Details",
    issueLabels: "planning",
    verbosityLevel: "concise",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "Response Verbosity");
    assertStringIncludes(result.value.prompt, "brief");
  }
});

// Issue #3813 (Gap 3): standard now carries an explicit verbosity block.
Deno.test("planning prompt - standard verbosity injects the summarise-at-the-end block", async () => {
  const result = await buildPlanningPrompt({
    repo: "owner/repo",
    issueNumber: "99",
    issueTitle: "Plan feature",
    issueBody: "Details",
    issueLabels: "planning",
    verbosityLevel: "standard",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "Response Verbosity");
    assertStringIncludes(result.value.prompt, "Summarise what you changed");
  }
});

Deno.test("planning prompt - no leftover VERBOSITY_INSTRUCTIONS placeholder", async () => {
  const result = await buildPlanningPrompt({
    repo: "owner/repo",
    issueNumber: "99",
    issueTitle: "Plan",
    issueBody: "Body",
    issueLabels: "planning",
    verbosityLevel: "minimal",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.prompt.includes("{{VERBOSITY_INSTRUCTIONS}}"),
      false,
    );
  }
});

// =============================================================================
// Question prompt verbosity injection tests
// =============================================================================

Deno.test("question prompt - verbose verbosity injects instructions", async () => {
  const result = await buildQuestionPrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "How does X work?",
    issueBody: "Explain X.",
    issueLabels: "question",
    verbosityLevel: "verbose",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "Response Verbosity");
    assertStringIncludes(result.value.prompt, "detailed explanations");
  }
});

Deno.test("question prompt - no leftover VERBOSITY_INSTRUCTIONS placeholder", async () => {
  const result = await buildQuestionPrompt({
    repo: "owner/repo",
    issueNumber: "1",
    issueTitle: "Q",
    issueBody: "B",
    issueLabels: "question",
    verbosityLevel: "concise",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.prompt.includes("{{VERBOSITY_INSTRUCTIONS}}"),
      false,
    );
  }
});

// =============================================================================
// PR feedback prompt verbosity injection tests
// =============================================================================

Deno.test("PR feedback prompt - minimal verbosity injects instructions", async () => {
  const result = await buildPrFeedbackPrompt({
    repo: "owner/repo",
    prNumber: "55",
    commentBody: "Please fix this.",
    verbosityLevel: "minimal",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "Response Verbosity");
    assertStringIncludes(result.value.prompt, "single sentence");
  }
});

Deno.test("PR feedback prompt - no leftover VERBOSITY_INSTRUCTIONS placeholder", async () => {
  const result = await buildPrFeedbackPrompt({
    repo: "owner/repo",
    prNumber: "5",
    commentBody: "Fix this",
    verbosityLevel: "verbose",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.prompt.includes("{{VERBOSITY_INSTRUCTIONS}}"),
      false,
    );
  }
});

// =============================================================================
// Spelling fix prompt verbosity injection tests
// =============================================================================

Deno.test("spelling fix prompt - concise verbosity injects instructions", async () => {
  const result = await buildSpellingFixPrompt({
    repo: "owner/repo",
    prNumber: "33",
    checkName: "cspell-check",
    annotationDetails: "Misspelled: behaviur",
    verbosityLevel: "concise",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "Response Verbosity");
    assertStringIncludes(result.value.prompt, "brief");
  }
});

Deno.test("spelling fix prompt - no leftover VERBOSITY_INSTRUCTIONS placeholder", async () => {
  const result = await buildSpellingFixPrompt({
    repo: "owner/repo",
    prNumber: "33",
    checkName: "cspell",
    annotationDetails: "Details",
    verbosityLevel: "standard",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.prompt.includes("{{VERBOSITY_INSTRUCTIONS}}"),
      false,
    );
  }
});

// =============================================================================
// CI fix prompt verbosity injection tests
// =============================================================================

Deno.test("CI fix prompt - verbose verbosity injects instructions", async () => {
  const result = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "77",
    checkName: "ci/test",
    annotationDetails: "Test failed",
    verbosityLevel: "verbose",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "Response Verbosity");
    assertStringIncludes(result.value.prompt, "detailed explanations");
  }
});

Deno.test("CI fix prompt - no leftover VERBOSITY_INSTRUCTIONS placeholder", async () => {
  const result = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "77",
    checkName: "ci/test",
    annotationDetails: "Failed",
    verbosityLevel: "minimal",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.prompt.includes("{{VERBOSITY_INSTRUCTIONS}}"),
      false,
    );
  }
});

// =============================================================================
// Prompt hash verbosity differentiation tests (Issue #1332)
// =============================================================================

Deno.test("prompt hash - different verbosity levels produce different hashes", async () => {
  const hashStandard = await computeStaticPromptHash(PROMPTS_DIR, "org/repo");
  const hashMinimal = await computeStaticPromptHash(
    PROMPTS_DIR,
    "org/repo",
    undefined,
    undefined,
    "minimal",
  );
  const hashVerbose = await computeStaticPromptHash(
    PROMPTS_DIR,
    "org/repo",
    undefined,
    undefined,
    "verbose",
  );

  assertEquals(hashStandard.ok, true);
  assertEquals(hashMinimal.ok, true);
  assertEquals(hashVerbose.ok, true);

  if (hashStandard.ok && hashMinimal.ok && hashVerbose.ok) {
    assertNotEquals(
      hashStandard.value,
      hashMinimal.value,
      "standard and minimal should produce different hashes",
    );
    assertNotEquals(
      hashStandard.value,
      hashVerbose.value,
      "standard and verbose should produce different hashes",
    );
    assertNotEquals(
      hashMinimal.value,
      hashVerbose.value,
      "minimal and verbose should produce different hashes",
    );
  }
});

Deno.test("prompt hash - standard verbosity matches no verbosity (backward compatible)", async () => {
  const hashNone = await computeStaticPromptHash(PROMPTS_DIR, "org/repo");
  const hashStandard = await computeStaticPromptHash(
    PROMPTS_DIR,
    "org/repo",
    undefined,
    undefined,
    "standard",
  );

  assertEquals(hashNone.ok, true);
  assertEquals(hashStandard.ok, true);

  if (hashNone.ok && hashStandard.ok) {
    assertEquals(
      hashNone.value,
      hashStandard.value,
      "standard level should produce same hash as omitting verbosity",
    );
  }
});

Deno.test("prompt hash - same verbosity level produces deterministic hash", async () => {
  const hash1 = await computeStaticPromptHash(
    PROMPTS_DIR,
    "org/repo",
    undefined,
    undefined,
    "concise",
  );
  const hash2 = await computeStaticPromptHash(
    PROMPTS_DIR,
    "org/repo",
    undefined,
    undefined,
    "concise",
  );

  assertEquals(hash1.ok, true);
  assertEquals(hash2.ok, true);

  if (hash1.ok && hash2.ok) {
    assertEquals(hash1.value, hash2.value);
  }
});

// =============================================================================
// Prompt manager optional placeholder tests (Issue #1332)
// =============================================================================

Deno.test("prompt manager - VERBOSITY_INSTRUCTIONS is optional for issue templates", () => {
  const result = getOptionalPlaceholders("issue");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.includes("VERBOSITY_INSTRUCTIONS"), true);
  }
});

Deno.test("prompt manager - VERBOSITY_INSTRUCTIONS is optional for all relevant template types", () => {
  const types = [
    "issue",
    "pr_feedback",
    "spelling_fix",
    "planning",
    "question",
    "ci_fix",
  ];
  for (const type of types) {
    const result = getOptionalPlaceholders(type);
    assertEquals(result.ok, true, `Failed for type '${type}'`);
    if (result.ok) {
      assertEquals(
        result.value.includes("VERBOSITY_INSTRUCTIONS"),
        true,
        `VERBOSITY_INSTRUCTIONS missing from optional placeholders for '${type}'`,
      );
    }
  }
});

Deno.test("prompt manager - coding_guidelines has no optional placeholders", () => {
  const result = getOptionalPlaceholders("coding_guidelines");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 0);
  }
});

Deno.test("prompt manager - OPTIONAL_PLACEHOLDERS constant is exported", () => {
  assertEquals(typeof OPTIONAL_PLACEHOLDERS, "object");
  assertEquals(Array.isArray(OPTIONAL_PLACEHOLDERS["issue"]), true);
});

// =============================================================================
// Integration: end-to-end prompt assembly with verbosity
// =============================================================================

Deno.test("integration - issue prompt with each verbosity level assembles correctly", async () => {
  const levels: VerbosityLevel[] = [
    "minimal",
    "concise",
    "standard",
    "verbose",
  ];

  for (const level of levels) {
    const result = await buildIssuePrompt({
      repo: "owner/repo",
      issueNumber: "42",
      issueTitle: "Integration test",
      issueBody: "Body content",
      issueLabels: "enhancement",
      qualityInstructions: "Run ./quality.sh",
      verbosityLevel: level,
      promptsDir: PROMPTS_DIR,
    });

    assertEquals(result.ok, true, `Failed for level '${level}'`);
    if (result.ok) {
      // All levels should produce a valid prompt with issue details
      assertStringIncludes(result.value.prompt, "#42");
      assertStringIncludes(result.value.prompt, "owner/repo");

      // No leftover placeholders
      assertEquals(
        result.value.prompt.includes("{{VERBOSITY_INSTRUCTIONS}}"),
        false,
        `Leftover placeholder for level '${level}'`,
      );

      // System prompt should contain coding guidelines
      assertStringIncludes(result.value.systemPrompt, "Australian English");

      // Every level carries a verbosity section (Issue #3813, Gap 3)
      assertStringIncludes(result.value.prompt, "Response Verbosity");
    }
  }
});

Deno.test("integration - system prompt is identical across verbosity levels (verbosity goes in user prompt)", async () => {
  const resultMinimal = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "Test",
    issueBody: "Body",
    issueLabels: "test",
    qualityInstructions: "",
    verbosityLevel: "minimal",
    promptsDir: PROMPTS_DIR,
  });
  const resultVerbose = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "Test",
    issueBody: "Body",
    issueLabels: "test",
    qualityInstructions: "",
    verbosityLevel: "verbose",
    promptsDir: PROMPTS_DIR,
  });

  assertEquals(resultMinimal.ok, true);
  assertEquals(resultVerbose.ok, true);
  if (resultMinimal.ok && resultVerbose.ok) {
    // System prompt (coding guidelines) should be identical
    assertEquals(
      resultMinimal.value.systemPrompt,
      resultVerbose.value.systemPrompt,
    );
    // User prompts should differ due to verbosity instructions
    assertNotEquals(resultMinimal.value.prompt, resultVerbose.value.prompt);
  }
});
