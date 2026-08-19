/**
 * Tests for runtime JSON schema validation.
 *
 * Validates that type guard functions correctly identify valid and invalid
 * gh CLI JSON responses and config file structures (Issue #214).
 */

import { assertEquals } from "@std/assert";
import {
  validateConfigFileJson,
  validateDefaultBranchCacheJson,
  validateGhCommentJson,
  validateGhCommentsJson,
  validateGhIssueJson,
  validateGhIssueViewJson,
  validateGitHubMilestonesJson,
  validateIssueBodyJson,
  validateIssueLabelsJson,
  validateIssueMilestoneJson,
  validateIssueNumberListJson,
  validateIssueStateJson,
  validateTimelineLabelEventsJson,
} from "../lib/validation.ts";

// --- GhIssueJson validation tests ---

Deno.test("validation - validateGhIssueJson accepts valid issue JSON", () => {
  const input = {
    number: 42,
    title: "Test Issue",
    body: "Description",
    labels: [{ name: "bug" }],
    author: { login: "testuser" },
    assignees: [{ login: "dev1" }],
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T12:00:00Z",
  };

  const result = validateGhIssueJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.number, 42);
    assertEquals(result.value.title, "Test Issue");
  }
});

Deno.test("validation - validateGhIssueJson accepts null body from gh CLI", () => {
  const input = {
    number: 1,
    title: "No body",
    body: null,
    labels: [],
    author: { login: "user" },
    assignees: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const result = validateGhIssueJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.body, null);
  }
});

Deno.test("validation - validateGhIssueJson rejects non-object input", () => {
  const result = validateGhIssueJson("not an object");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "root");
  }
});

Deno.test("validation - validateGhIssueJson rejects null input", () => {
  const result = validateGhIssueJson(null);
  assertEquals(result.ok, false);
});

Deno.test("validation - validateGhIssueJson rejects missing number", () => {
  const input = {
    title: "Test",
    body: "Body",
    labels: [],
    author: { login: "user" },
    assignees: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const result = validateGhIssueJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "number");
  }
});

Deno.test("validation - validateGhIssueJson rejects non-number issue number", () => {
  const input = {
    number: "42",
    title: "Test",
    body: "Body",
    labels: [],
    author: { login: "user" },
    assignees: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const result = validateGhIssueJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "number");
  }
});

Deno.test("validation - validateGhIssueJson rejects missing title", () => {
  const input = {
    number: 1,
    body: "Body",
    labels: [],
    author: { login: "user" },
    assignees: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const result = validateGhIssueJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "title");
  }
});

Deno.test("validation - validateGhIssueJson rejects missing author", () => {
  const input = {
    number: 1,
    title: "Test",
    body: "Body",
    labels: [],
    assignees: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const result = validateGhIssueJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "author");
  }
});

Deno.test("validation - validateGhIssueJson rejects author without login", () => {
  const input = {
    number: 1,
    title: "Test",
    body: "Body",
    labels: [],
    author: { name: "user" },
    assignees: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const result = validateGhIssueJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "author.login");
  }
});

Deno.test("validation - validateGhIssueJson rejects non-array labels", () => {
  const input = {
    number: 1,
    title: "Test",
    body: "Body",
    labels: "bug",
    author: { login: "user" },
    assignees: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const result = validateGhIssueJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "labels");
  }
});

Deno.test("validation - validateGhIssueJson rejects label without name", () => {
  const input = {
    number: 1,
    title: "Test",
    body: "Body",
    labels: [{ colour: "red" }],
    author: { login: "user" },
    assignees: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const result = validateGhIssueJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "labels[0].name");
  }
});

Deno.test("validation - validateGhIssueJson rejects missing createdAt", () => {
  const input = {
    number: 1,
    title: "Test",
    body: "Body",
    labels: [],
    author: { login: "user" },
    assignees: [],
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const result = validateGhIssueJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "createdAt");
  }
});

Deno.test("validation - validateGhIssueJson rejects assignee without login", () => {
  const input = {
    number: 1,
    title: "Test",
    body: "Body",
    labels: [],
    author: { login: "user" },
    assignees: [{ name: "dev" }],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const result = validateGhIssueJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "assignees[0].login");
  }
});

// --- GhCommentJson validation tests ---

Deno.test("validation - validateGhCommentJson accepts valid comment", () => {
  const input = {
    id: 1,
    body: "Comment text",
    author: { login: "user1" },
    createdAt: "2024-01-15T10:00:00Z",
    reactions: { "+1": 2, eyes: 1, confused: 0 },
  };

  const result = validateGhCommentJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.id, 1);
    assertEquals(result.value.body, "Comment text");
  }
});

Deno.test("validation - validateGhCommentJson rejects string id (GraphQL node ID)", () => {
  const input = {
    id: "IC_kwDOGxPCCM77kEg6",
    body: "Comment text",
    author: { login: "user1" },
    createdAt: "2024-01-15T10:00:00Z",
    reactions: { "+1": 0, eyes: 0, confused: 0 },
  };

  const result = validateGhCommentJson(input);
  assertEquals(result.ok, false);
});

Deno.test("validation - validateGhCommentJson rejects non-object input", () => {
  const result = validateGhCommentJson(42);
  assertEquals(result.ok, false);
});

Deno.test("validation - validateGhCommentJson rejects missing id", () => {
  const input = {
    body: "Comment",
    author: { login: "user" },
    createdAt: "2024-01-01T00:00:00Z",
    reactions: { "+1": 0, eyes: 0, confused: 0 },
  };

  const result = validateGhCommentJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "id");
  }
});

Deno.test("validation - validateGhCommentJson rejects missing body", () => {
  const input = {
    id: 1,
    author: { login: "user" },
    createdAt: "2024-01-01T00:00:00Z",
    reactions: { "+1": 0, eyes: 0, confused: 0 },
  };

  const result = validateGhCommentJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "body");
  }
});

Deno.test("validation - validateGhCommentJson rejects missing reactions", () => {
  const input = {
    id: 1,
    body: "Comment",
    author: { login: "user" },
    createdAt: "2024-01-01T00:00:00Z",
  };

  const result = validateGhCommentJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "reactions");
  }
});

Deno.test("validation - validateGhCommentJson handles null reactions values as zero", () => {
  const input = {
    id: 1,
    body: "Comment",
    author: { login: "user" },
    createdAt: "2024-01-01T00:00:00Z",
    reactions: { "+1": null, eyes: null, confused: null },
  };

  const result = validateGhCommentJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.reactions["+1"], 0);
    assertEquals(result.value.reactions.eyes, 0);
    assertEquals(result.value.reactions.confused, 0);
  }
});

Deno.test("validation - validateGhCommentJson handles missing reaction fields as zero", () => {
  const input = {
    id: 1,
    body: "Comment",
    author: { login: "user" },
    createdAt: "2024-01-01T00:00:00Z",
    reactions: {},
  };

  const result = validateGhCommentJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.reactions["+1"], 0);
    assertEquals(result.value.reactions.eyes, 0);
    assertEquals(result.value.reactions.confused, 0);
  }
});

// --- Comments array validation tests ---

Deno.test("validation - validateGhCommentsJson accepts valid array", () => {
  const input = [
    {
      id: 1,
      body: "First",
      author: { login: "user1" },
      createdAt: "2024-01-01T00:00:00Z",
      reactions: { "+1": 0, eyes: 0, confused: 0 },
    },
    {
      id: 2,
      body: "Second",
      author: { login: "user2" },
      createdAt: "2024-01-02T00:00:00Z",
      reactions: { "+1": 1, eyes: 0, confused: 0 },
    },
  ];

  const result = validateGhCommentsJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 2);
  }
});

Deno.test("validation - validateGhCommentsJson accepts empty array", () => {
  const result = validateGhCommentsJson([]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 0);
  }
});

Deno.test("validation - validateGhCommentsJson rejects non-array", () => {
  const result = validateGhCommentsJson("not an array");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "root");
  }
});

Deno.test("validation - validateGhCommentsJson rejects array with invalid comment", () => {
  const input = [
    {
      id: 1,
      body: "Valid",
      author: { login: "user" },
      createdAt: "2024-01-01T00:00:00Z",
      reactions: { "+1": 0, eyes: 0, confused: 0 },
    },
    {
      id: "invalid",
      body: "Bad",
      author: { login: "user" },
      createdAt: "2024-01-01T00:00:00Z",
      reactions: { "+1": 0, eyes: 0, confused: 0 },
    },
  ];

  const result = validateGhCommentsJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "comments[1].id");
  }
});

// --- ConfigFile validation tests ---

Deno.test("validation - validateConfigFileJson accepts valid config", () => {
  const input = {
    allowed_authors: ["user1", "user2"],
    repos: ["org/repo1"],
    issue_labels: ["claude"],
  };

  const result = validateConfigFileJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed_authors, ["user1", "user2"]);
    assertEquals(result.value.repos, ["org/repo1"]);
  }
});

Deno.test("validation - validateConfigFileJson accepts empty object", () => {
  const result = validateConfigFileJson({});
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.repos, undefined);
  }
});

Deno.test("validation - validateConfigFileJson rejects non-object", () => {
  const result = validateConfigFileJson("not an object");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "root");
  }
});

Deno.test("validation - validateConfigFileJson rejects null", () => {
  const result = validateConfigFileJson(null);
  assertEquals(result.ok, false);
});

Deno.test("validation - validateConfigFileJson rejects array", () => {
  const result = validateConfigFileJson([1, 2, 3]);
  assertEquals(result.ok, false);
});

Deno.test("validation - validateConfigFileJson rejects non-array allowed_authors", () => {
  const input = { allowed_authors: "not-an-array" };
  const result = validateConfigFileJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "allowed_authors");
  }
});

Deno.test("validation - validateConfigFileJson rejects non-array repos", () => {
  const input = { repos: "org/repo" };
  const result = validateConfigFileJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "repos");
  }
});

Deno.test("validation - validateConfigFileJson rejects repos with non-string elements", () => {
  const input = { repos: [42, "org/repo"] };
  const result = validateConfigFileJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "repos[0]");
  }
});

Deno.test("validation - validateConfigFileJson rejects non-string label fields", () => {
  // Issue #1834: work_on_label is no longer a recognised key. Use the
  // still-validated `failed_label` to exercise the type-check path.
  const input = { failed_label: 123 };
  const result = validateConfigFileJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "failed_label");
  }
});

Deno.test("validation - validateConfigFileJson accepts config with allowed_authors array", () => {
  const input = {
    allowed_authors: ["user1", "user2"],
    repos: ["org/repo"],
  };

  const result = validateConfigFileJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.allowed_authors, ["user1", "user2"]);
  }
});

Deno.test("validation - validateConfigFileJson rejects non-string array in allowed_authors", () => {
  const input = { allowed_authors: ["valid", 42] };
  const result = validateConfigFileJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "allowed_authors[1]");
  }
});

// --- Operational number field validation (Issue #277) ---

Deno.test("validation - validateConfigFileJson accepts operational number fields", () => {
  const input = {
    allowed_authors: ["user1"],
    repos: ["org/repo"],
    claude_timeout: 7200,
    sleep_interval: 60,
    max_clarification_rounds: 5,
    planning_timeout: 1200,
    feature_check_timeout: 10,
  };

  const result = validateConfigFileJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claude_timeout, 7200);
    assertEquals(result.value.sleep_interval, 60);
    assertEquals(result.value.max_clarification_rounds, 5);
  }
});

Deno.test("validation - validateConfigFileJson rejects non-number claude_timeout", () => {
  const input = { claude_timeout: "not-a-number" };
  const result = validateConfigFileJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "claude_timeout");
  }
});

Deno.test("validation - validateConfigFileJson rejects non-number sleep_interval", () => {
  const input = { sleep_interval: true };
  const result = validateConfigFileJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "sleep_interval");
  }
});

Deno.test("validation - validateConfigFileJson accepts planning_label string field", () => {
  const input = { planning_label: "custom-planning" };
  const result = validateConfigFileJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.planning_label, "custom-planning");
  }
});

// =============================================================================
// Issue #1532 — shared gh CLI validators
// =============================================================================

// --- validateGitHubMilestonesJson ---

Deno.test("validation - validateGitHubMilestonesJson accepts valid array", () => {
  const input = [
    { title: "v1.0", number: 1 },
    { title: "v2.0", number: 2 },
  ];
  const result = validateGitHubMilestonesJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 2);
    assertEquals(result.value[0]?.title, "v1.0");
  }
});

Deno.test("validation - validateGitHubMilestonesJson accepts empty array", () => {
  const result = validateGitHubMilestonesJson([]);
  assertEquals(result.ok, true);
});

Deno.test("validation - validateGitHubMilestonesJson rejects non-array", () => {
  const result = validateGitHubMilestonesJson({ title: "v1" });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "root");
  }
});

Deno.test("validation - validateGitHubMilestonesJson rejects null", () => {
  const result = validateGitHubMilestonesJson(null);
  assertEquals(result.ok, false);
});

Deno.test("validation - validateGitHubMilestonesJson rejects missing title", () => {
  const result = validateGitHubMilestonesJson([{ number: 1 }]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "milestones[0].title");
  }
});

Deno.test("validation - validateGitHubMilestonesJson rejects wrong number type", () => {
  const result = validateGitHubMilestonesJson([{ title: "v1", number: "1" }]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "milestones[0].number");
  }
});

// --- validateIssueNumberListJson ---

Deno.test("validation - validateIssueNumberListJson accepts valid array", () => {
  const input = [{ number: 1 }, { number: 42 }];
  const result = validateIssueNumberListJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 2);
  }
});

Deno.test("validation - validateIssueNumberListJson accepts empty array", () => {
  const result = validateIssueNumberListJson([]);
  assertEquals(result.ok, true);
});

Deno.test("validation - validateIssueNumberListJson rejects non-array", () => {
  const result = validateIssueNumberListJson(null);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "root");
  }
});

Deno.test("validation - validateIssueNumberListJson rejects wrong number type", () => {
  const result = validateIssueNumberListJson([{ number: "1" }]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "items[0].number");
  }
});

// --- validateIssueLabelsJson ---

Deno.test("validation - validateIssueLabelsJson accepts valid labels", () => {
  const input = { labels: [{ name: "bug" }, { name: "priority" }] };
  const result = validateIssueLabelsJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.labels.length, 2);
  }
});

Deno.test("validation - validateIssueLabelsJson accepts empty labels", () => {
  const result = validateIssueLabelsJson({ labels: [] });
  assertEquals(result.ok, true);
});

Deno.test("validation - validateIssueLabelsJson rejects missing labels", () => {
  const result = validateIssueLabelsJson({});
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "labels");
  }
});

Deno.test("validation - validateIssueLabelsJson rejects label without name", () => {
  const result = validateIssueLabelsJson({ labels: [{ colour: "red" }] });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "labels[0].name");
  }
});

Deno.test("validation - validateIssueLabelsJson rejects null root", () => {
  const result = validateIssueLabelsJson(null);
  assertEquals(result.ok, false);
});

// --- validateTimelineLabelEventsJson ---

Deno.test("validation - validateTimelineLabelEventsJson accepts labeled events", () => {
  const input = [
    { event: "labeled", label: { name: "bug" }, actor: { login: "user1" } },
    { event: "closed" },
  ];
  const result = validateTimelineLabelEventsJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 2);
  }
});

Deno.test("validation - validateTimelineLabelEventsJson accepts empty array", () => {
  const result = validateTimelineLabelEventsJson([]);
  assertEquals(result.ok, true);
});

Deno.test("validation - validateTimelineLabelEventsJson rejects non-array", () => {
  const result = validateTimelineLabelEventsJson({ event: "labeled" });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "root");
  }
});

Deno.test("validation - validateTimelineLabelEventsJson rejects missing event field", () => {
  const result = validateTimelineLabelEventsJson([{}]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "timeline[0].event");
  }
});

Deno.test("validation - validateTimelineLabelEventsJson rejects label without name", () => {
  const result = validateTimelineLabelEventsJson([
    { event: "labeled", label: { colour: "red" } },
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "timeline[0].label.name");
  }
});

// --- validateIssueMilestoneJson ---

Deno.test("validation - validateIssueMilestoneJson accepts milestone with title", () => {
  const result = validateIssueMilestoneJson({ milestone: { title: "v1.0" } });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.milestone?.title, "v1.0");
  }
});

Deno.test("validation - validateIssueMilestoneJson accepts null milestone", () => {
  const result = validateIssueMilestoneJson({ milestone: null });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.milestone, null);
  }
});

Deno.test("validation - validateIssueMilestoneJson accepts missing milestone", () => {
  const result = validateIssueMilestoneJson({});
  assertEquals(result.ok, true);
});

Deno.test("validation - validateIssueMilestoneJson rejects non-object root", () => {
  const result = validateIssueMilestoneJson("not an object");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "root");
  }
});

Deno.test("validation - validateIssueMilestoneJson rejects milestone without title", () => {
  const result = validateIssueMilestoneJson({ milestone: { number: 1 } });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "milestone.title");
  }
});

// --- validateIssueBodyJson ---

Deno.test("validation - validateIssueBodyJson accepts body string", () => {
  const result = validateIssueBodyJson({ body: "Hello" });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.body, "Hello");
  }
});

Deno.test("validation - validateIssueBodyJson accepts missing body", () => {
  const result = validateIssueBodyJson({});
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.body, undefined);
  }
});

Deno.test("validation - validateIssueBodyJson accepts null body", () => {
  const result = validateIssueBodyJson({ body: null });
  assertEquals(result.ok, true);
});

Deno.test("validation - validateIssueBodyJson rejects non-object root", () => {
  const result = validateIssueBodyJson(null);
  assertEquals(result.ok, false);
});

Deno.test("validation - validateIssueBodyJson rejects wrong body type", () => {
  const result = validateIssueBodyJson({ body: 42 });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "body");
  }
});

// --- validateIssueStateJson ---

Deno.test("validation - validateIssueStateJson accepts valid issue state", () => {
  const input = { number: 42, state: "OPEN", title: "Test" };
  const result = validateIssueStateJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.state, "OPEN");
    assertEquals(result.value.number, 42);
  }
});

Deno.test("validation - validateIssueStateJson rejects missing number", () => {
  const result = validateIssueStateJson({ state: "OPEN", title: "Test" });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "number");
  }
});

Deno.test("validation - validateIssueStateJson rejects wrong state type", () => {
  const result = validateIssueStateJson({ number: 1, state: 1, title: "Test" });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "state");
  }
});

Deno.test("validation - validateIssueStateJson rejects non-object root", () => {
  const result = validateIssueStateJson(null);
  assertEquals(result.ok, false);
});

// --- validateGhIssueViewJson ---

Deno.test("validation - validateGhIssueViewJson accepts full issue view", () => {
  const input = {
    number: 1,
    title: "Test",
    url: "https://github.com/o/r/issues/1",
    assignees: [{ login: "dev" }],
    labels: [{ name: "bug" }],
    createdAt: "2024-01-01T00:00:00Z",
    author: { login: "user" },
    milestone: { title: "v1.0" },
  };
  const result = validateGhIssueViewJson(input);
  assertEquals(result.ok, true);
});

Deno.test("validation - validateGhIssueViewJson accepts null milestone", () => {
  const input = {
    number: 1,
    title: "Test",
    url: "",
    assignees: [],
    labels: [],
    createdAt: "2024-01-01T00:00:00Z",
    author: { login: "user" },
    milestone: null,
  };
  const result = validateGhIssueViewJson(input);
  assertEquals(result.ok, true);
});

Deno.test("validation - validateGhIssueViewJson rejects missing number", () => {
  const input = {
    title: "Test",
    url: "",
    assignees: [],
    labels: [],
    createdAt: "2024-01-01T00:00:00Z",
    author: { login: "user" },
  };
  const result = validateGhIssueViewJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "number");
  }
});

Deno.test("validation - validateGhIssueViewJson rejects wrong author type", () => {
  const input = {
    number: 1,
    title: "Test",
    url: "",
    assignees: [],
    labels: [],
    createdAt: "2024-01-01T00:00:00Z",
    author: "user",
  };
  const result = validateGhIssueViewJson(input);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "author");
  }
});

Deno.test("validation - validateGhIssueViewJson rejects null root", () => {
  const result = validateGhIssueViewJson(null);
  assertEquals(result.ok, false);
});

// --- validateDefaultBranchCacheJson ---

Deno.test("validation - validateDefaultBranchCacheJson accepts valid cache", () => {
  const input = {
    "owner/repo": { branch: "main", fetchedAt: 1700000000000 },
  };
  const result = validateDefaultBranchCacheJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value["owner/repo"]?.branch, "main");
  }
});

Deno.test("validation - validateDefaultBranchCacheJson accepts empty record", () => {
  const result = validateDefaultBranchCacheJson({});
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(Object.keys(result.value).length, 0);
  }
});

Deno.test("validation - validateDefaultBranchCacheJson rejects null root", () => {
  const result = validateDefaultBranchCacheJson(null);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "root");
  }
});

Deno.test("validation - validateDefaultBranchCacheJson drops malformed entries", () => {
  const input = {
    "good/repo": { branch: "main", fetchedAt: 1 },
    "bad/repo": { branch: "main" }, // missing fetchedAt
    "also-bad/repo": "not an object",
  };
  const result = validateDefaultBranchCacheJson(input);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(Object.keys(result.value).length, 1);
    assertEquals(result.value["good/repo"]?.branch, "main");
  }
});
