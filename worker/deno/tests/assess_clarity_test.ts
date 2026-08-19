/**
 * Tests for the assess-clarity command.
 *
 * Following TDD: These tests are written first to define expected behaviour.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  analyseIssueClarity,
  assessClarityCommand,
  detectComplexity,
} from "../commands/assess_clarity.ts";
import type { WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

// Mock config for tests
// Note: defaultBranch removed in Issue #140 - now fetched per-repo via GitHub API
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

Deno.test("assess-clarity - clear issue with specific action", () => {
  const result = analyseIssueClarity(
    "Fix typo in README.md",
    "Change 'teh' to 'the' on line 42 of README.md",
    [],
  );

  assertEquals(result.isClear, true);
  assertEquals(result.reason, "specific");
});

Deno.test("assess-clarity - clear issue with file path and line number", () => {
  const result = analyseIssueClarity(
    "Fix null pointer in user.ts",
    "In src/user.ts:123, add null check before accessing user.name",
    [],
  );

  assertEquals(result.isClear, true);
});

Deno.test("assess-clarity - clear issue with code snippet", () => {
  const result = analyseIssueClarity(
    "Add timeout to API call",
    "Update the fetch call in api.ts to include a 30-second timeout:\n```javascript\nfetch(url, { timeout: 30000 })\n```",
    [],
  );

  assertEquals(result.isClear, true);
});

Deno.test("assess-clarity - vague issue without specifics", () => {
  const result = analyseIssueClarity(
    "fix bug",
    "Something is broken and needs to be fixed",
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "vague");
  assertStringIncludes((result.questions[0] ?? "").toLowerCase(), "bug");
});

Deno.test("assess-clarity - issue asking to improve performance without details", () => {
  const result = analyseIssueClarity(
    "Improve performance",
    "The app is slow, please make it faster",
    [],
  );

  assertEquals(result.isClear, false);
  // Question should ask about which specific operation is slow (case-insensitive check)
  assertStringIncludes(result.questions.join(" ").toLowerCase(), "which");
});

Deno.test("assess-clarity - issue missing critical implementation details", () => {
  const result = analyseIssueClarity(
    "Add authentication",
    "Add authentication to the application",
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "missing_details");
});

Deno.test("assess-clarity - issue too broad in scope", () => {
  const result = analyseIssueClarity(
    "Multiple unrelated changes",
    "We need to add logging and also add monitoring and also add alerting as well as add dashboards. Additionally please add tests.",
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_broad");
});

Deno.test("assess-clarity - command returns CLEAR for clear issues", async () => {
  const result = await assessClarityCommand.execute(
    {
      title: "Fix typo on line 5",
      body: "Change 'recieve' to 'receive' in src/utils.ts line 5",
      labels: [],
      comments: [],
    },
    createMockConfig(),
  );

  assertEquals(result.success, true);
  assertEquals(result.message, "CLEAR");
});

Deno.test("assess-clarity - command returns questions for unclear issues", async () => {
  const result = await assessClarityCommand.execute(
    {
      title: "Fix bug",
      body: "Something is broken",
      labels: [],
      comments: [],
    },
    createMockConfig(),
  );

  assertEquals(result.success, true);
  assertEquals(result.message.startsWith("CLEAR"), false);
  assertStringIncludes(result.message, "?");
});

// =============================================================================
// Issue #190 — Ensure unclear results always contain actual questions
// =============================================================================

Deno.test("assess-clarity - unclear result questions always contain question marks", () => {
  // Vague issue should produce questions with '?' in each one
  const result = analyseIssueClarity(
    "fix bug",
    "Something is broken and needs to be fixed",
    [],
  );

  assertEquals(result.isClear, false);
  // Every question must contain a question mark
  for (const question of result.questions) {
    assertStringIncludes(question, "?");
  }
  // Must have at least one question
  assertEquals(result.questions.length > 0, true);
});

Deno.test("assess-clarity - missing details result always has questions with question marks", () => {
  const result = analyseIssueClarity(
    "Add authentication",
    "Add authentication to the application",
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.questions.length > 0, true);
  for (const question of result.questions) {
    assertStringIncludes(question, "?");
  }
});

Deno.test("assess-clarity - too broad result always has questions with question marks", () => {
  const result = analyseIssueClarity(
    "Multiple unrelated changes",
    "We need to add logging and also add monitoring and also add alerting as well as add dashboards. Additionally please add tests.",
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.questions.length > 0, true);
  for (const question of result.questions) {
    assertStringIncludes(question, "?");
  }
});

Deno.test("assess-clarity - command message for unclear issues always contains question marks", async () => {
  const result = await assessClarityCommand.execute(
    {
      title: "Fix bug",
      body: "Something is broken",
      labels: [],
      comments: [],
    },
    createMockConfig(),
  );

  assertEquals(result.success, true);
  // The message must contain at least one question mark
  assertStringIncludes(result.message, "?");
  // Should not start with CLEAR
  assertEquals(result.message.startsWith("CLEAR"), false);
});

Deno.test("assess-clarity - documentation label bypasses assessment", async () => {
  const config = createMockConfig();
  const result = await assessClarityCommand.execute(
    {
      title: "Fix bug",
      body: "Something is broken",
      labels: ["documentation"],
      comments: [],
    },
    config,
  );

  assertEquals(result.success, true);
  assertEquals(result.message, "CLEAR");
});

// =============================================================================
// Issue #556 — Complexity detection heuristics (too_complex)
// =============================================================================

Deno.test("assess-clarity - detects too_complex when multiple directories referenced", () => {
  const result = analyseIssueClarity(
    "Refactor test organisation across directories",
    `## Directories in scope
- test/Compact/
- test/optimize/
- test/optimization/
- test/performance/

Update all test files to use the new naming convention.`,
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
  assertEquals(result.questions.length > 0, true);
});

Deno.test("assess-clarity - detects too_complex with high file counts", () => {
  const result = analyseIssueClarity(
    "Update test naming conventions",
    `This issue covers ~64 files across 5 directories with ~193 test cases that need updating.`,
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
});

Deno.test("assess-clarity - detects too_complex with many acceptance criteria checkboxes", () => {
  const result = analyseIssueClarity(
    "Implement comprehensive logging",
    `## Acceptance criteria
- [ ] Add structured logging to API layer
- [ ] Add request tracing middleware
- [ ] Add database query logging
- [ ] Add error reporting integration
- [ ] Add log rotation configuration
- [ ] Add log level filtering
- [ ] Add metrics collection
- [ ] Add alerting integration
- [ ] Add dashboard configuration
- [ ] Add audit trail logging
- [ ] Add performance profiling hooks`,
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
});

Deno.test("assess-clarity - too_complex message mentions automatic planning escalation", () => {
  const result = analyseIssueClarity(
    "Audit test coverage",
    `## Directories in scope
- src/auth/
- src/api/
- src/models/
- src/utils/

~47 files with ~423 tests need review.`,
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
  // Message should mention planning mode / automatic breakdown
  const message = result.questions.join(" ").toLowerCase();
  assertStringIncludes(message, "sub-issues");
});

Deno.test("assess-clarity - too_complex questions contain question marks", () => {
  const result = analyseIssueClarity(
    "Refactor across directories",
    `## Directories
- test/a/
- test/b/
- test/c/
- test/d/

Covers ~100 files.`,
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
  for (const question of result.questions) {
    assertStringIncludes(question, "?");
  }
});

Deno.test("assess-clarity - too_broad behaviour unchanged", () => {
  const result = analyseIssueClarity(
    "Multiple unrelated changes",
    "We need to add logging and also add monitoring and also add alerting as well as add dashboards. Additionally please add tests.",
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_broad");
  assertStringIncludes(result.questions[0] ?? "", "break it into smaller");
});

Deno.test("assess-clarity - does not flag too_complex for small directory count", () => {
  const result = analyseIssueClarity(
    "Update two test files",
    `Fix tests in:
- test/unit/
- test/integration/

Update the assertion format.`,
    [],
  );

  // Two directories should not trigger too_complex
  assertEquals(result.reason !== "too_complex", true);
});

Deno.test("assess-clarity - detects too_complex with mixed indicators", () => {
  const result = analyseIssueClarity(
    "Comprehensive test audit",
    `## Summary
Audit all test directories and ensure coverage.

## Directories in scope
- test/Compact/
- test/optimize/
- test/optimization/

## Acceptance criteria
- [ ] Review compact tests
- [ ] Review optimise tests
- [ ] Review optimisation tests
- [ ] Update naming conventions
- [ ] Add missing coverage`,
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
});

Deno.test("assess-clarity - specific issue with directories is not too_complex", () => {
  // A specific issue that mentions directories but has clear, focused scope
  const result = analyseIssueClarity(
    "Fix import path in test/unit/auth.test.ts",
    "The import in `test/unit/auth.test.ts` on line 5 references a moved module. Update the path.",
    [],
  );

  assertEquals(result.isClear, true);
  assertEquals(result.reason, "specific");
});

// =============================================================================
// Issue #862 — Semantic complexity heuristics
// =============================================================================

// --- Question/request counting ---

Deno.test("assess-clarity - detectComplexity counts distinct questions", () => {
  const result = detectComplexity(
    "Is the API working? Does it handle errors? What about timeouts? Are there tests?",
  );

  assertEquals(result.questionCount >= 4, true);
});

Deno.test("assess-clarity - detectComplexity counts numbered action items", () => {
  const result = detectComplexity(
    `1. Add logging to the API layer
2. Fix the timeout handling
3. Update the error messages
4. Add unit tests`,
  );

  assertEquals(result.questionCount >= 3, true);
});

Deno.test("assess-clarity - detectComplexity counts imperative sentences", () => {
  const result = detectComplexity(
    "Add a new endpoint for users. Fix the broken auth middleware. Check the database connection. Remove the deprecated routes.",
  );

  assertEquals(result.questionCount >= 3, true);
});

Deno.test("assess-clarity - detectComplexity does not over-count with few requests", () => {
  const result = detectComplexity(
    "Fix the typo in the README.",
  );

  assertEquals(result.questionCount < 3, true);
});

// --- Cross-repo reference detection ---

Deno.test("assess-clarity - detectComplexity detects owner/repo#N cross-repo references", () => {
  const result = detectComplexity(
    "This relates to example-org/private-repo-39#45 and also example-org/private-repo-43#12.",
  );

  assertEquals(result.crossRepoRefs >= 2, true);
});

Deno.test("assess-clarity - detectComplexity detects GitHub URL cross-repo references", () => {
  const result = detectComplexity(
    "See https://github.com/other-org/other-repo/issues/99 for context.",
  );

  assertEquals(result.crossRepoRefs >= 1, true);
});

Deno.test("assess-clarity - detectComplexity does not count same-repo issue references", () => {
  // Plain #123 references are same-repo, not cross-repo
  const result = detectComplexity(
    "This relates to #45 and #12.",
  );

  assertEquals(result.crossRepoRefs, 0);
});

// --- Vague/research-oriented language detection ---

Deno.test("assess-clarity - detectComplexity detects vague investigative phrases", () => {
  const result = detectComplexity(
    "Please check if there are any other instances. Investigate whether we should update all references.",
  );

  assertEquals(result.vagueLanguageCount >= 2, true);
});

Deno.test("assess-clarity - detectComplexity detects research-oriented questions", () => {
  const result = detectComplexity(
    "Should we migrate to a new framework? Could we use a different approach? What about performance?",
  );

  assertEquals(result.vagueLanguageCount >= 2, true);
});

Deno.test("assess-clarity - detectComplexity detects 'find out' and 'look into' phrases", () => {
  const result = detectComplexity(
    "Look into why the tests are failing. Find out if we can improve the build time.",
  );

  assertEquals(result.vagueLanguageCount >= 2, true);
});

Deno.test("assess-clarity - detectComplexity does not flag direct implementation language", () => {
  const result = detectComplexity(
    "Add a 30-second timeout to the API call in api.ts on line 42.",
  );

  assertEquals(result.vagueLanguageCount, 0);
});

// --- Combined scoring ---

Deno.test("assess-clarity - issue with multiple questions and vague language is complex", () => {
  const result = analyseIssueClarity(
    "Investigate API issues",
    `Please check if the API is returning correct responses.
Are there any other endpoints affected?
Should we also look into the authentication flow?
Could we find out if the database queries are optimised?`,
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
});

Deno.test("assess-clarity - issue with cross-repo refs triggers complexity", () => {
  const result = analyseIssueClarity(
    "Coordinate dependency update",
    `We need to update the shared library. This affects example-org/private-repo-39#100 and example-org/private-repo-42#55.
Please check if https://github.com/external/lib/issues/30 is also relevant.`,
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
});

Deno.test("assess-clarity - research-oriented issue flagged as complex", () => {
  const result = analyseIssueClarity(
    "Investigate logging gaps",
    `Please check if there are any gaps in our logging.
Look into whether we have sufficient coverage.
Are there any other areas that need attention?
Find out if anything else is missing.`,
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
});

Deno.test("assess-clarity - two questions plus vague language triggers complexity", () => {
  const result = analyseIssueClarity(
    "Review error handling",
    `Should we update the error handling approach?
Please check if there are any other places that need fixing.
Is there anything else we should investigate?`,
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
});

Deno.test("assess-clarity - single question without vague language is not complex", () => {
  const result = detectComplexity(
    "Can we add a timeout to the fetch call?",
  );

  // One question, no vague language — should not be semantically complex
  assertEquals(result.isComplex, false);
});

// =============================================================================
// Issue #872 — Relaxed semantic complexity thresholds
// =============================================================================

Deno.test("assess-clarity - simple issue with 3 imperative sentences is not complex (Issue #872)", () => {
  // A simple issue with 3 action steps should not be flagged as complex.
  // Previously QUESTION_COUNT_THRESHOLD=3 would flag this.
  const result = analyseIssueClarity(
    "Update error handling",
    "Fix the error handler in the API layer. Update the error messages to be more descriptive. Ensure the tests pass.",
    [],
  );

  // 3 imperative sentences is a normal, focused issue — not complex
  assertEquals(result.reason !== "too_complex", true);
});

Deno.test("assess-clarity - issue with 4 imperative sentences is not complex (Issue #872)", () => {
  const result = analyseIssueClarity(
    "Improve API responses",
    "Add proper status codes to all endpoints. Fix the error response format. Update the validation messages. Remove the deprecated warning header.",
    [],
  );

  // 4 imperative sentences describing a single focused task — not complex
  assertEquals(result.reason !== "too_complex", true);
});

Deno.test("assess-clarity - issue with 2 cross-repo refs is not complex (Issue #872)", () => {
  // Referencing 2 external issues for context is normal — not complex
  const result = analyseIssueClarity(
    "Fix shared utility bug",
    "The shared utility has a bug. See example-org/private-repo-39#45 and example-org/private-repo-43#12 for related context.",
    [],
  );

  assertEquals(result.reason !== "too_complex", true);
});

Deno.test("assess-clarity - issue with 2 questions and 2 vague phrases is not complex (Issue #872)", () => {
  // A small amount of investigative language in an otherwise simple issue
  // should not trigger complexity. Previously the combined heuristic
  // (questionCount >= 2 && vagueLanguageCount >= 2) would flag this.
  const result = analyseIssueClarity(
    "Check timeout configuration",
    "Should we increase the timeout? Please check if the current value is too low.",
    [],
  );

  assertEquals(result.reason !== "too_complex", true);
});

Deno.test("assess-clarity - truly complex issue with 5+ requests still detected (Issue #872)", () => {
  const result = analyseIssueClarity(
    "Major refactoring task",
    "Add a new authentication layer. Fix the session management. Create a migration script. Implement the new user model. Update all API endpoints. Refactor the middleware chain.",
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
});

Deno.test("assess-clarity - issue with 3+ cross-repo refs still detected (Issue #872)", () => {
  const result = analyseIssueClarity(
    "Coordinate multi-repo update",
    "This affects example-org/private-repo-50#1, example-org/private-repo-51#2, and example-org/private-repo-52#3. All must be updated together.",
    [],
  );

  assertEquals(result.isClear, false);
  assertEquals(result.reason, "too_complex");
});

// =============================================================================
// Issue #630 — Edge cases and boundary conditions
// (Merged from assess_clarity_edge_test.ts — Issue #1305)
// =============================================================================

// --- Extremely short titles ---

Deno.test("assess-clarity edge - single word title with no body", () => {
  const result = analyseIssueClarity("Bug", "", []);
  // A single-word title with no body lacks specifics
  assertEquals(result.isClear, true); // "has_context" — not obviously vague
  assertEquals(result.reason, "has_context");
});

Deno.test("assess-clarity edge - empty title and empty body", () => {
  const result = analyseIssueClarity("", "", []);
  // Empty title and body — still passes has_context (no vague or complex signals)
  assertEquals(result.isClear, true);
  assertEquals(result.reason, "has_context");
});

Deno.test("assess-clarity edge - single character title", () => {
  const result = analyseIssueClarity("X", "", []);
  assertEquals(result.isClear, true);
  assertEquals(result.reason, "has_context");
});

Deno.test("assess-clarity edge - very short vague title with vague body", () => {
  // "something is broken" matches the vague pattern
  const result = analyseIssueClarity("Fix issue", "Something is broken", []);
  assertEquals(result.isClear, false);
  assertEquals(result.reason, "vague");
});

// --- Very long bodies ---

Deno.test("assess-clarity edge - long body with file path is clear", () => {
  const longBody = "A".repeat(10000) + "\nFix the issue in src/config.ts\n" +
    "B".repeat(10000);
  const result = analyseIssueClarity("Fix configuration loading", longBody, []);
  assertEquals(result.isClear, true);
  assertEquals(result.reason, "specific");
});

Deno.test("assess-clarity edge - long body without specifics remains vague", () => {
  const longBody = "Something is broken. ".repeat(500);
  const result = analyseIssueClarity("Fix bug", longBody, []);
  assertEquals(result.isClear, false);
  assertEquals(result.reason, "vague");
});

// --- Code-only issues ---

Deno.test("assess-clarity edge - code-only body with backtick block is clear", () => {
  const body = "```typescript\nconst x = 1;\nconsole.log(x);\n```";
  const result = analyseIssueClarity("Add logging", body, []);
  assertEquals(result.isClear, true);
  assertEquals(result.reason, "specific");
});

Deno.test("assess-clarity edge - inline code snippet is clear", () => {
  const result = analyseIssueClarity(
    "Fix the parsing",
    "The function `parseConfig` should return null instead of throwing",
    [],
  );
  assertEquals(result.isClear, true);
  assertEquals(result.reason, "specific");
});

// --- Issues with only file paths ---

Deno.test("assess-clarity edge - title containing only a filename is clear", () => {
  const result = analyseIssueClarity("config.json", "", []);
  assertEquals(result.isClear, true);
  assertEquals(result.reason, "specific");
});

Deno.test("assess-clarity edge - body with line number reference is clear", () => {
  const result = analyseIssueClarity(
    "Fix error",
    "See line 42 for the issue",
    [],
  );
  assertEquals(result.isClear, true);
  assertEquals(result.reason, "specific");
});

// --- Issues with error messages ---

Deno.test("assess-clarity edge - body containing error message is clear", () => {
  const result = analyseIssueClarity(
    "Fix crash",
    "Getting error: TypeError when parsing input",
    [],
  );
  assertEquals(result.isClear, true);
  assertEquals(result.reason, "specific");
});

// --- Edge case: title has specific patterns but body is vague ---

Deno.test("assess-clarity edge - specific title with vague body is still clear", () => {
  const result = analyseIssueClarity(
    "Fix typo in README.md",
    "Something needs fixing",
    [],
  );
  assertEquals(result.isClear, true);
  assertEquals(result.reason, "specific");
});

// --- Unicode and special characters ---

Deno.test("assess-clarity edge - unicode title and body handled correctly", () => {
  const result = analyseIssueClarity(
    "Fix encoding in données.ts",
    "The file données.ts has encoding issues on line 5",
    [],
  );
  assertEquals(result.isClear, true);
  assertEquals(result.reason, "specific");
});

Deno.test("assess-clarity edge - body with only URLs is has_context", () => {
  const result = analyseIssueClarity(
    "Update dependency",
    "https://example.com/some/long/url\nhttps://example.com/another/url",
    [],
  );
  assertEquals(result.isClear, true);
  assertEquals(result.reason, "has_context");
});
