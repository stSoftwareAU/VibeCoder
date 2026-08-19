/**
 * Tests for the suggest-improvements command.
 *
 * Following TDD: These tests are written first to define expected behaviour.
 * Issue #192 — Initial suggest improvements command.
 * Issue #209 — Updated with prompt and workflow improvement suggestions.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { WorkerConfig } from "../types.ts";
import type { Improvement } from "../commands/suggest_improvements.ts";
import {
  formatImprovementAsIssueBody,
  generateImprovements,
  suggestImprovementsCommand,
} from "../commands/suggest_improvements.ts";
import {
  buildDefaultWorkerConfig,
  RESERVED_LABELS,
} from "../lib/config_defaults.ts";

// Mock config for tests
function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["org/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
  }) as WorkerConfig;
}

// =============================================================================
// generateImprovements() — Core logic tests
// =============================================================================

Deno.test("suggest-improvements - generates a non-empty list of improvements", () => {
  const improvements = generateImprovements();

  assertEquals(improvements.length > 0, true);
});

Deno.test("suggest-improvements - each improvement has required fields", () => {
  const improvements = generateImprovements();

  for (const improvement of improvements) {
    assertEquals(typeof improvement.title, "string");
    assertEquals(improvement.title.length > 0, true);

    assertEquals(typeof improvement.description, "string");
    assertEquals(improvement.description.length > 0, true);

    assertEquals(typeof improvement.category, "string");
    assertEquals(improvement.category.length > 0, true);

    assertEquals(Array.isArray(improvement.labels), true);
    assertEquals(improvement.labels.length > 0, true);
  }
});

Deno.test("suggest-improvements - improvements have valid categories", () => {
  const validCategories = [
    "observability",
    "resilience",
    "testing",
    "developer-experience",
    "security",
    "maintainability",
  ];
  const improvements = generateImprovements();

  for (const improvement of improvements) {
    assertEquals(
      validCategories.includes(improvement.category),
      true,
      `Invalid category: ${improvement.category}`,
    );
  }
});

Deno.test("suggest-improvements - improvements have unique titles", () => {
  const improvements = generateImprovements();
  const titles = improvements.map((i) => i.title);
  const uniqueTitles = new Set(titles);

  assertEquals(titles.length, uniqueTitles.size, "Duplicate titles found");
});

Deno.test("suggest-improvements - all improvements include 'enhancement' label", () => {
  const improvements = generateImprovements();

  for (const improvement of improvements) {
    assertEquals(
      improvement.labels.includes("enhancement"),
      true,
      `Improvement "${improvement.title}" missing 'enhancement' label`,
    );
  }
});

// =============================================================================
// formatImprovementAsIssueBody() — Formatting tests
// =============================================================================

Deno.test("suggest-improvements - formats improvement as markdown issue body", () => {
  const improvement: Improvement = {
    title: "Add operational metrics",
    description: "Track success/failure counts and processing times.",
    category: "observability",
    labels: ["enhancement"],
  };

  const body = formatImprovementAsIssueBody(improvement);

  assertStringIncludes(body, "## Description");
  assertStringIncludes(body, improvement.description);
  assertStringIncludes(body, "## Category");
  assertStringIncludes(body, improvement.category);
});

Deno.test("suggest-improvements - formatted body uses Australian English", () => {
  const improvement: Improvement = {
    title: "Improve error handling",
    description: "Standardise error recovery behaviour across modules.",
    category: "resilience",
    labels: ["enhancement"],
  };

  const body = formatImprovementAsIssueBody(improvement);

  // Body should contain the description as-is (which uses Australian English)
  assertStringIncludes(body, "Standardise");
  assertStringIncludes(body, "behaviour");
});

// =============================================================================
// suggestImprovementsCommand.execute() — Command integration tests
// =============================================================================

Deno.test("suggest-improvements - command returns success with dry-run", async () => {
  const result = await suggestImprovementsCommand.execute(
    { "dry-run": true },
    createMockConfig(),
  );

  assertEquals(result.success, true);
  assertStringIncludes(result.message, "improvement");
});

Deno.test("suggest-improvements - command data contains improvements array", async () => {
  const result = await suggestImprovementsCommand.execute(
    { "dry-run": true },
    createMockConfig(),
  );

  assertEquals(result.success, true);
  const data = result.data as { improvements: Improvement[] };
  assertEquals(Array.isArray(data.improvements), true);
  assertEquals(data.improvements.length > 0, true);
});

Deno.test("suggest-improvements - command includes repo in args when provided", async () => {
  const result = await suggestImprovementsCommand.execute(
    { "dry-run": true, repo: "stSoftwareAU/VibeCoder" },
    createMockConfig(),
  );

  assertEquals(result.success, true);
  const data = result.data as { repo: string };
  assertEquals(data.repo, "stSoftwareAU/VibeCoder");
});

Deno.test("suggest-improvements - command name is correct", () => {
  assertEquals(suggestImprovementsCommand.name, "suggest-improvements");
});

Deno.test("suggest-improvements - command has a description", () => {
  assertEquals(typeof suggestImprovementsCommand.description, "string");
  assertEquals(suggestImprovementsCommand.description.length > 0, true);
});

// =============================================================================
// Issue #209 — Prompt and workflow improvement coverage
// =============================================================================

// Issue #1531 — The previous assertion required a "security" category entry.
// Both security-category entries in the Issue #209 list referenced retired
// shell files (`worker/shared/feature_availability.sh`, `worker/shared/security.sh`)
// and were removed during the post-Deno-migration refresh. This test now
// verifies that any security suggestion that is added does not regress to
// referencing the retired shell modules.
Deno.test("suggest-improvements - security suggestions do not reference retired shell modules", () => {
  const improvements = generateImprovements();
  const retiredShellFiles = [
    "worker/shared/feature_availability.sh",
    "worker/shared/security.sh",
    "worker/shared/retry.sh",
    "worker/shared/dry_run.sh",
    "worker/shared/claude_runner.sh",
    "prompt_builder.sh",
  ];

  for (const improvement of improvements) {
    for (const retired of retiredShellFiles) {
      assertEquals(
        improvement.description.includes(retired),
        false,
        `Improvement "${improvement.title}" references retired shell module "${retired}"`,
      );
    }
  }
});

Deno.test("suggest-improvements - includes prompt-related improvements", () => {
  const improvements = generateImprovements();
  const promptImprovements = improvements.filter(
    (i) =>
      i.title.toLowerCase().includes("prompt") ||
      i.description.toLowerCase().includes("prompt"),
  );

  assertEquals(
    promptImprovements.length > 0,
    true,
    "Should include at least one prompt-related improvement",
  );
});

Deno.test("suggest-improvements - includes testing category improvements", () => {
  const improvements = generateImprovements();
  const testImprovements = improvements.filter(
    (i) => i.category === "testing",
  );

  assertEquals(
    testImprovements.length > 0,
    true,
    "Should include at least one testing improvement",
  );
});

Deno.test("suggest-improvements - covers multiple categories", () => {
  const improvements = generateImprovements();
  const categories = new Set(improvements.map((i) => i.category));

  // Should cover at least 4 different categories
  assertEquals(
    categories.size >= 4,
    true,
    `Expected at least 4 categories, got ${categories.size}: ${
      [...categories].join(", ")
    }`,
  );
});

// =============================================================================
// Issue #297 — No reserved labels on generated improvements
// =============================================================================

Deno.test("suggest-improvements - no improvement uses reserved labels", () => {
  const improvements = generateImprovements();

  for (const improvement of improvements) {
    for (const label of improvement.labels) {
      assertEquals(
        RESERVED_LABELS.includes(label),
        false,
        `Improvement "${improvement.title}" uses reserved label "${label}" — ` +
          `reserved labels should only be applied by the repository owner`,
      );
    }
  }
});

// Issue #1531 — Every concrete file path mentioned in the suggestions must
// exist in the current working tree. This prevents the canned list drifting
// again after future migrations.
Deno.test("suggest-improvements - every referenced file path exists in the repo", async () => {
  const improvements = generateImprovements();
  // Resolve paths relative to the repo root (two levels above this test file).
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  // Match paths starting with known top-level directories of this repo.
  // We restrict to these roots to avoid false positives on fragments that
  // aren't real path references.
  const pathPattern =
    /\b(?:worker\/(?:deno|shared)|prompts|docs|tests|logs|hooks)\/[\w./-]+?\.(?:ts|sh|md|json|yml)\b/g;

  const missing: string[] = [];
  for (const improvement of improvements) {
    const haystack = `${improvement.title}\n${improvement.description}`;
    const matches = haystack.match(pathPattern) ?? [];
    const proposedIdx = haystack.indexOf("Proposed Solution");
    for (const candidate of matches) {
      // "Proposed Solution" sections may describe files that do not yet
      // exist (e.g., prompts/pr_feedback/v6.md, logs/prompt-versions.log).
      // Skip paths that appear only in that section.
      const appearsOnlyInProposal = proposedIdx >= 0 &&
        haystack.indexOf(candidate) >= proposedIdx;
      if (candidate.startsWith("logs/") && appearsOnlyInProposal) continue;
      if (/\/v\d+\.md$/.test(candidate) && appearsOnlyInProposal) continue;
      try {
        await Deno.stat(`${repoRoot}${candidate}`);
      } catch {
        missing.push(`"${improvement.title}" → ${candidate}`);
      }
    }
  }

  assertEquals(
    missing.length,
    0,
    `Suggestions reference files that do not exist:\n${missing.join("\n")}`,
  );
});

Deno.test("suggest-improvements - formatted body includes issue reference", () => {
  const improvement: Improvement = {
    title: "Test improvement",
    description: "Test description for validation.",
    category: "testing",
    labels: ["enhancement"],
  };

  const body = formatImprovementAsIssueBody(improvement);

  assertStringIncludes(body, "suggest-improvements");
  assertStringIncludes(body, "Issue #209");
});
