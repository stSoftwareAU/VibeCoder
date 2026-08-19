/**
 * Tests for command-specific Args types and validation (Issue #630).
 *
 * Verifies that commands validate their arguments at execute time
 * and return clear error messages for invalid/missing args.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import type { WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { assessClarityCommand } from "../commands/assess_clarity.ts";
import { suggestImprovementsCommand } from "../commands/suggest_improvements.ts";
import { versionCommand } from "../commands/version.ts";
import {
  validateAssessClarityArgs,
  validateCheckParentDepsArgs,
  validateCheckRepoAvailabilityArgs,
  validateSuggestImprovementsArgs,
} from "../lib/command_args.ts";

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
// validateAssessClarityArgs tests
// =============================================================================

Deno.test("command_args - validateAssessClarityArgs accepts valid args", () => {
  const result = validateAssessClarityArgs({
    title: "Fix bug",
    body: "Description",
    labels: ["bug"],
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.title, "Fix bug");
    assertEquals(result.value.body, "Description");
    assertEquals(result.value.labels, ["bug"]);
  }
});

Deno.test("command_args - validateAssessClarityArgs defaults missing title to empty string", () => {
  const result = validateAssessClarityArgs({
    body: "Description",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.title, "");
  }
});

Deno.test("command_args - validateAssessClarityArgs defaults missing body to empty string", () => {
  const result = validateAssessClarityArgs({
    title: "Title",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.body, "");
  }
});

Deno.test("command_args - validateAssessClarityArgs defaults missing labels to empty array", () => {
  const result = validateAssessClarityArgs({
    title: "Title",
    body: "Body",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.labels, []);
  }
});

Deno.test("command_args - validateAssessClarityArgs rejects non-string title", () => {
  const result = validateAssessClarityArgs({
    title: 123,
    body: "Description",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("title"), true);
  }
});

Deno.test("command_args - validateAssessClarityArgs rejects non-string body", () => {
  const result = validateAssessClarityArgs({
    title: "Title",
    body: 456,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("body"), true);
  }
});

Deno.test("command_args - validateAssessClarityArgs rejects non-array labels", () => {
  const result = validateAssessClarityArgs({
    title: "Title",
    body: "Body",
    labels: "not-an-array",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("labels"), true);
  }
});

// =============================================================================
// validateCheckParentDepsArgs tests
// =============================================================================

Deno.test("command_args - validateCheckParentDepsArgs accepts valid args", () => {
  const result = validateCheckParentDepsArgs({
    repo: "owner/repo",
    issue: 123,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.repo, "owner/repo");
    assertEquals(result.value.issue, 123);
  }
});

Deno.test("command_args - validateCheckParentDepsArgs rejects missing repo", () => {
  const result = validateCheckParentDepsArgs({
    issue: 123,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("repo"), true);
  }
});

Deno.test("command_args - validateCheckParentDepsArgs rejects missing issue", () => {
  const result = validateCheckParentDepsArgs({
    repo: "owner/repo",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("issue"), true);
  }
});

Deno.test("command_args - validateCheckParentDepsArgs rejects non-string repo", () => {
  const result = validateCheckParentDepsArgs({
    repo: 123,
    issue: 1,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("repo"), true);
  }
});

Deno.test("command_args - validateCheckParentDepsArgs rejects non-number issue", () => {
  const result = validateCheckParentDepsArgs({
    repo: "owner/repo",
    issue: "not-a-number",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("issue"), true);
  }
});

// =============================================================================
// validateSuggestImprovementsArgs tests
// =============================================================================

Deno.test("command_args - validateSuggestImprovementsArgs accepts valid args", () => {
  const result = validateSuggestImprovementsArgs({
    repo: "owner/repo",
    "dry-run": true,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.repo, "owner/repo");
    assertEquals(result.value.dryRun, true);
  }
});

Deno.test("command_args - validateSuggestImprovementsArgs defaults dry-run to false", () => {
  const result = validateSuggestImprovementsArgs({
    repo: "owner/repo",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.dryRun, false);
  }
});

Deno.test("command_args - validateSuggestImprovementsArgs allows missing repo", () => {
  const result = validateSuggestImprovementsArgs({});
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.repo, undefined);
  }
});

// =============================================================================
// validateCheckRepoAvailabilityArgs tests
// =============================================================================

Deno.test("command_args - validateCheckRepoAvailabilityArgs accepts valid args", () => {
  const result = validateCheckRepoAvailabilityArgs({
    repo: "owner/repo",
    "github-user": "worker-bot",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.repo, "owner/repo");
    assertEquals(result.value.githubUser, "worker-bot");
  }
});

Deno.test("command_args - validateCheckRepoAvailabilityArgs rejects missing repo", () => {
  const result = validateCheckRepoAvailabilityArgs({
    "github-user": "worker-bot",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("repo"), true);
  }
});

Deno.test("command_args - validateCheckRepoAvailabilityArgs rejects missing github-user", () => {
  const result = validateCheckRepoAvailabilityArgs({
    repo: "owner/repo",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("github-user"), true);
  }
});

Deno.test("command_args - validateCheckRepoAvailabilityArgs rejects non-string repo", () => {
  const result = validateCheckRepoAvailabilityArgs({
    repo: 123,
    "github-user": "worker-bot",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("repo"), true);
  }
});

Deno.test("command_args - validateCheckRepoAvailabilityArgs rejects non-string github-user", () => {
  const result = validateCheckRepoAvailabilityArgs({
    repo: "owner/repo",
    "github-user": 123,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("github-user"), true);
  }
});

// =============================================================================
// Command execute with invalid args returns failure result
// =============================================================================

Deno.test("command_args - assess-clarity returns failure for non-string title arg", async () => {
  const result = await assessClarityCommand.execute(
    { title: 123, body: "test", labels: [] },
    createMockConfig(),
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("title"), true);
});

Deno.test("command_args - version command accepts empty args", async () => {
  const result = await versionCommand.execute({}, createMockConfig());
  assertEquals(result.success, true);
});

Deno.test("command_args - suggest-improvements handles valid dry-run", async () => {
  const result = await suggestImprovementsCommand.execute(
    { "dry-run": true },
    createMockConfig(),
  );
  assertEquals(result.success, true);
});
