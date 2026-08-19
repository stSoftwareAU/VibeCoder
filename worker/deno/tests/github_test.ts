/**
 * Tests for the GitHub client module.
 *
 * Following TDD: These tests are written first to define expected behaviour.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { buildIssueCommentsPageArgs } from "../lib/issue_comment_pages.ts";
import {
  createGitHubClient,
  filterReservedLabels,
  hasVisibleContent,
  parseCreatedCommentJson,
  parseGhCommentsJson,
  parseGhIssueJson,
  parseGhRawCommentsJson,
  runGhCommand,
  runGhCommandRaw,
} from "../lib/github.ts";
import {
  _resetWriteRepoAllowlistSinks,
  _setWriteRepoAllowlistSinks,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
  WriteRepoBlockedError,
} from "../lib/write_repo_allowlist.ts";
import { RESERVED_LABELS } from "../lib/config_defaults.ts";
import type { Logger } from "../types.ts";

// Mock logger for tests
function createMockLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

Deno.test("github - parseGhIssueJson parses valid issue JSON", () => {
  const json = {
    number: 123,
    title: "Test Issue",
    body: "Issue description",
    labels: [{ name: "bug" }, { name: "help wanted" }],
    author: { login: "testuser" },
    assignees: [{ login: "dev1" }],
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T12:00:00Z",
  };

  const issue = parseGhIssueJson(json);

  assertEquals(issue.number, 123);
  assertEquals(issue.title, "Test Issue");
  assertEquals(issue.body, "Issue description");
  assertEquals(issue.labels, ["bug", "help wanted"]);
  assertEquals(issue.author, "testuser");
  assertEquals(issue.assignees, ["dev1"]);
  assertEquals(issue.createdAt, "2024-01-15T10:00:00Z");
  assertEquals(issue.updatedAt, "2024-01-15T12:00:00Z");
});

Deno.test("github - parseGhIssueJson handles missing body", () => {
  const json = {
    number: 123,
    title: "Test Issue",
    body: null,
    labels: [],
    author: { login: "testuser" },
    assignees: [],
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T12:00:00Z",
  };

  const issue = parseGhIssueJson(json);
  assertEquals(issue.body, "");
});

Deno.test("github - parseGhCommentsJson parses valid comments JSON", () => {
  const json = [
    {
      id: 1,
      body: "Comment 1",
      author: { login: "user1" },
      createdAt: "2024-01-15T10:00:00Z",
      reactions: {
        "+1": 2,
        eyes: 1,
        confused: 0,
      },
    },
    {
      id: 2,
      body: "Comment 2",
      author: { login: "user2" },
      createdAt: "2024-01-15T11:00:00Z",
      reactions: {
        "+1": 0,
        eyes: 0,
        confused: 1,
      },
    },
  ];

  const comments = parseGhCommentsJson(json);

  assertEquals(comments.length, 2);
  assertEquals(comments[0]!.id, 1);
  assertEquals(comments[0]!.body, "Comment 1");
  assertEquals(comments[0]!.author, "user1");
  assertEquals(comments[0]!.reactions.thumbsUp, 2);
  assertEquals(comments[0]!.reactions.eyes, 1);
  assertEquals(comments[0]!.reactions.confused, 0);
  assertEquals(comments[1]!.reactions.confused, 1);
});

Deno.test("github - parseGhCommentsJson handles empty array", () => {
  const comments = parseGhCommentsJson([]);
  assertEquals(comments.length, 0);
});

// --- Issue #1881: comment pagination tests ---

Deno.test(
  "github - comment page args request per_page=100 with an explicit page (Issues #1881, #3709)",
  () => {
    // Issue #1881: without per_page=100, gh defaults to 30 comments per page
    // and the grill-me workflow silently misses recent developer replies.
    // Issue #3709 replaced the unbounded `--paginate` flag with explicit,
    // capped page requests (see `fetchIssueCommentPages`), so the args no
    // longer carry `--paginate`.
    const args = buildIssueCommentsPageArgs("owner/repo", 1881, 2);

    const endpoint = args.find((a: string) => a.includes("/comments"));
    assertEquals(typeof endpoint, "string", "expected an endpoint argument");
    assertEquals(
      endpoint?.includes("per_page=100"),
      true,
      `expected per_page=100 in endpoint, got: ${endpoint}`,
    );
    assertEquals(
      endpoint?.includes("repos/owner/repo/issues/1881/comments"),
      true,
      `expected canonical comments endpoint, got: ${endpoint}`,
    );
    assertEquals(
      endpoint?.includes("page=2"),
      true,
      `expected the explicit page number in endpoint, got: ${endpoint}`,
    );

    assertEquals(
      args.includes("--paginate"),
      false,
      `expected no unbounded --paginate flag, got: ${JSON.stringify(args)}`,
    );

    // Issue #1881: --jq must NOT be present. gh applies --jq per page, so
    // combining pagination with --jq 'map(...)' produces multiple arrays
    // which break JSON.parse. Transformation happens in
    // parseGhRawCommentsJson instead.
    assertEquals(
      args.includes("--jq"),
      false,
      `expected --jq absent (gh applies --jq per page), got: ${
        JSON.stringify(args)
      }`,
    );
  },
);

Deno.test(
  "github - parseGhRawCommentsJson maps GitHub REST shape to GitHubComment (Issue #1881)",
  () => {
    // Raw shape from `gh api repos/.../comments` (without --jq) — uses
    // user.login and created_at, not author.login/createdAt.
    const raw = [
      {
        id: 100,
        body: "First comment",
        user: { login: "alice" },
        created_at: "2026-05-09T08:00:00Z",
        reactions: { "+1": 1, "eyes": 0, "confused": 0 },
      },
      {
        id: 101,
        body: "Second comment",
        user: { login: "bob" },
        created_at: "2026-05-09T08:30:00Z",
        reactions: { "+1": 0, "eyes": 2, "confused": 0 },
      },
    ];

    const parsed = parseGhRawCommentsJson(raw);

    assertEquals(parsed.length, 2);
    assertEquals(parsed[0]!.id, 100);
    assertEquals(parsed[0]!.body, "First comment");
    assertEquals(parsed[0]!.author, "alice");
    assertEquals(parsed[0]!.createdAt, "2026-05-09T08:00:00Z");
    assertEquals(parsed[0]!.reactions.thumbsUp, 1);
    assertEquals(parsed[1]!.author, "bob");
    assertEquals(parsed[1]!.reactions.eyes, 2);
  },
);

Deno.test(
  "github - parseGhRawCommentsJson preserves order across a 50-comment page (Issue #1881)",
  () => {
    // Regression: the previous getIssueComments was capped at 30
    // comments. Build a 50-element raw array (what `gh api --paginate`
    // would return for a long grill-me thread) and confirm every
    // entry survives the transform.
    const raw = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      body: `Comment ${i + 1}`,
      user: { login: `user${i + 1}` },
      created_at: `2026-05-09T08:${String(i % 60).padStart(2, "0")}:00Z`,
      reactions: { "+1": 0, "eyes": 0, "confused": 0 },
    }));

    const parsed = parseGhRawCommentsJson(raw);

    assertEquals(parsed.length, 50);
    assertEquals(parsed[0]!.body, "Comment 1");
    assertEquals(parsed[29]!.body, "Comment 30");
    assertEquals(
      parsed[30]!.body,
      "Comment 31",
      "31st comment must not be silently dropped",
    );
    assertEquals(parsed[49]!.body, "Comment 50");
  },
);

Deno.test(
  "github - parseGhRawCommentsJson handles missing reactions and accepts empty array",
  () => {
    // GitHub REST may omit the reactions object on some endpoints;
    // missing fields must default to 0 rather than throwing.
    const raw = [
      {
        id: 1,
        body: "No reactions",
        user: { login: "alice" },
        created_at: "2026-05-09T08:00:00Z",
        reactions: {},
      },
    ];
    const parsed = parseGhRawCommentsJson(raw);
    assertEquals(parsed.length, 1);
    assertEquals(parsed[0]!.reactions.thumbsUp, 0);
    assertEquals(parsed[0]!.reactions.eyes, 0);
    assertEquals(parsed[0]!.reactions.confused, 0);

    assertEquals(parseGhRawCommentsJson([]).length, 0);
  },
);

Deno.test(
  "github - parseGhRawCommentsJson rejects non-array input",
  () => {
    let threw = false;
    try {
      parseGhRawCommentsJson({ not: "an array" });
    } catch {
      threw = true;
    }
    assertEquals(threw, true, "expected non-array input to throw");
  },
);

Deno.test("github - createGitHubClient returns client with all methods", () => {
  const client = createGitHubClient(createMockLogger());

  assertEquals(typeof client.getIssue, "function");
  assertEquals(typeof client.getIssueComments, "function");
  assertEquals(typeof client.addLabel, "function");
  assertEquals(typeof client.removeLabel, "function");
  assertEquals(typeof client.postComment, "function");
  assertEquals(typeof client.editIssue, "function");
  assertEquals(typeof client.assignIssue, "function");
  assertEquals(typeof client.unassignIssue, "function");
});

// --- parseGhIssueJson edge cases ---

Deno.test("github - parseGhIssueJson handles empty labels array", () => {
  const json = {
    number: 1,
    title: "No labels",
    body: "body",
    labels: [],
    author: { login: "user" },
    assignees: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const issue = parseGhIssueJson(json);
  assertEquals(issue.labels, []);
});

Deno.test("github - parseGhIssueJson handles multiple assignees", () => {
  const json = {
    number: 42,
    title: "Team issue",
    body: "body",
    labels: [{ name: "bug" }],
    author: { login: "author" },
    assignees: [{ login: "dev1" }, { login: "dev2" }, { login: "dev3" }],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const issue = parseGhIssueJson(json);
  assertEquals(issue.assignees, ["dev1", "dev2", "dev3"]);
});

Deno.test("github - parseGhIssueJson handles empty string body", () => {
  const json = {
    number: 1,
    title: "Empty body",
    body: "",
    labels: [],
    author: { login: "user" },
    assignees: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  const issue = parseGhIssueJson(json);
  assertEquals(issue.body, "");
});

// --- parseGhCommentsJson edge cases ---

Deno.test("github - parseGhCommentsJson handles single comment", () => {
  const json = [
    {
      id: 99,
      body: "Single comment",
      author: { login: "commenter" },
      createdAt: "2024-06-15T08:30:00Z",
      reactions: { "+1": 5, eyes: 0, confused: 0 },
    },
  ];

  const comments = parseGhCommentsJson(json);
  assertEquals(comments.length, 1);
  assertEquals(comments[0]!.id, 99);
  assertEquals(comments[0]!.reactions.thumbsUp, 5);
});

Deno.test("github - parseGhCommentsJson maps reaction keys correctly", () => {
  const json = [
    {
      id: 1,
      body: "Reactions test",
      author: { login: "user" },
      createdAt: "2024-01-01T00:00:00Z",
      reactions: { "+1": 10, eyes: 3, confused: 7 },
    },
  ];

  const comments = parseGhCommentsJson(json);
  assertEquals(comments[0]!.reactions.thumbsUp, 10);
  assertEquals(comments[0]!.reactions.eyes, 3);
  assertEquals(comments[0]!.reactions.confused, 7);
});

// --- runGhCommandRaw edge cases ---

Deno.test("github - runGhCommandRaw rejects for non-existent command", async () => {
  const { runGhCommandRaw } = await import("../lib/github.ts");
  await assertRejects(
    () => runGhCommandRaw(["nonexistent-subcommand-xyz123"]),
    Error,
  );
});

// --- createGitHubIssuesWithPartialFailures edge cases ---

Deno.test("github - createGitHubIssuesWithPartialFailures handles output without issue number", async () => {
  const { createGitHubIssuesWithPartialFailures } = await import(
    "../lib/github.ts"
  );

  const improvements = [
    {
      title: "Test",
      description: "Test desc",
      category: "testing" as const,
      labels: ["enhancement"],
    },
  ];

  // Return output that doesn't contain an issue number URL
  const mockGh = async (_args: string[]): Promise<string> => {
    return "Created issue successfully";
  };

  const result = await createGitHubIssuesWithPartialFailures(
    improvements,
    "org/repo",
    mockGh,
  );

  // Should not crash, but also not capture an issue number
  assertEquals(result.createdIssues.length, 0);
  assertEquals(result.failures.length, 0);
});

Deno.test("github - createGitHubIssuesWithPartialFailures passes non-reserved labels as args", async () => {
  const { createGitHubIssuesWithPartialFailures } = await import(
    "../lib/github.ts"
  );

  const improvements = [
    {
      title: "Multi-label",
      description: "Test desc",
      category: "testing" as const,
      labels: ["bug", "enhancement"],
    },
  ];

  let capturedArgs: string[] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    capturedArgs = args;
    return "https://github.com/org/repo/issues/1";
  };

  await createGitHubIssuesWithPartialFailures(
    improvements,
    "org/repo",
    mockGh,
  );

  // Verify label args are passed correctly (2 non-reserved labels)
  const labelIndices = capturedArgs.reduce<number[]>((acc, arg, i) => {
    if (arg === "--label") acc.push(i);
    return acc;
  }, []);
  assertEquals(labelIndices.length, 2);
});

Deno.test("github - createGitHubIssuesWithPartialFailures handles non-Error throws", async () => {
  const { createGitHubIssuesWithPartialFailures } = await import(
    "../lib/github.ts"
  );

  const improvements = [
    {
      title: "String throw",
      description: "desc",
      category: "testing" as const,
      labels: [],
    },
  ];

  const mockGh = async (_args: string[]): Promise<string> => {
    throw "string error message";
  };

  const result = await createGitHubIssuesWithPartialFailures(
    improvements,
    "org/repo",
    mockGh,
  );

  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0]!.error, "string error message");
});

// --- Reserved label filtering (Issue #297) ---

Deno.test("github - filterReservedLabels removes help wanted label", () => {
  const labels = ["enhancement", "help wanted", "bug"];
  const filtered = filterReservedLabels(labels);
  assertEquals(filtered, ["enhancement", "bug"]);
});

Deno.test("github - filterReservedLabels removes work-on label", () => {
  const labels = ["enhancement", "work-on"];
  const filtered = filterReservedLabels(labels);
  assertEquals(filtered, ["enhancement"]);
});

Deno.test("github - filterReservedLabels removes claude label", () => {
  const labels = ["claude", "enhancement"];
  const filtered = filterReservedLabels(labels);
  assertEquals(filtered, ["enhancement"]);
});

Deno.test("github - filterReservedLabels removes all operational labels", () => {
  const labels = [
    "enhancement",
    "help wanted",
    "work-on",
    "claude",
    "failed",
    "failed-once",
    "needs-clarification",
    "refine-issue",
    "planning",
    "question",
    "answered",
  ];
  const filtered = filterReservedLabels(labels);
  assertEquals(filtered, ["enhancement"]);
});

Deno.test("github - filterReservedLabels preserves non-reserved labels", () => {
  const labels = ["enhancement", "bug", "documentation"];
  const filtered = filterReservedLabels(labels);
  assertEquals(filtered, ["enhancement", "bug", "documentation"]);
});

Deno.test("github - filterReservedLabels handles empty array", () => {
  const filtered = filterReservedLabels([]);
  assertEquals(filtered, []);
});

Deno.test("github - filterReservedLabels is case-insensitive (Issue #3088)", () => {
  // GitHub treats label names case-insensitively, so a non-lower-case
  // canonical reserved label (e.g. `Planning`, `WORK-ON`) must still be
  // stripped. Previously these slipped through the case-sensitive match.
  const labels = ["Help Wanted", "WORK-ON", "Claude", "Planning"];
  const filtered = filterReservedLabels(labels);
  assertEquals(filtered, []);
});

Deno.test("github - filterReservedLabels keeps non-reserved mixed-case labels", () => {
  const labels = ["Enhancement", "Bug", "Documentation"];
  const filtered = filterReservedLabels(labels);
  assertEquals(filtered, ["Enhancement", "Bug", "Documentation"]);
});

Deno.test("github - RESERVED_LABELS includes help wanted and work-on", () => {
  assertEquals(RESERVED_LABELS.includes("help wanted"), true);
  assertEquals(RESERVED_LABELS.includes("work-on"), true);
  assertEquals(RESERVED_LABELS.includes("claude"), true);
});

Deno.test("github - createGitHubIssuesWithPartialFailures strips reserved labels", async () => {
  const { createGitHubIssuesWithPartialFailures } = await import(
    "../lib/github.ts"
  );

  const improvements = [
    {
      title: "Test reserved",
      description: "Test desc",
      category: "testing" as const,
      labels: ["enhancement", "help wanted", "work-on", "claude"],
    },
  ];

  let capturedArgs: string[] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    capturedArgs = args;
    return "https://github.com/org/repo/issues/42";
  };

  await createGitHubIssuesWithPartialFailures(
    improvements,
    "org/repo",
    mockGh,
  );

  // Only "enhancement" should remain — reserved labels stripped
  const labelArgs: string[] = [];
  for (let i = 0; i < capturedArgs.length; i++) {
    if (capturedArgs[i] === "--label" && i + 1 < capturedArgs.length) {
      labelArgs.push(capturedArgs[i + 1]!);
    }
  }
  assertEquals(labelArgs, ["enhancement"]);
});

Deno.test("github - createGitHubIssuesWithPartialFailures warns once per stripped reserved label (Issue #2825)", async () => {
  const { createGitHubIssuesWithPartialFailures } = await import(
    "../lib/github.ts"
  );
  const { createLogger } = await import("../lib/logger.ts");

  const improvements = [
    {
      title: "Test reserved",
      description: "Test desc",
      category: "testing" as const,
      labels: ["enhancement", "work-on", "claude"],
    },
  ];

  const lines: string[] = [];
  const logger = createLogger({ write: (msg) => lines.push(msg) });

  const mockGh = (_args: string[]): Promise<string> =>
    Promise.resolve("https://github.com/org/repo/issues/42");

  await createGitHubIssuesWithPartialFailures(
    improvements,
    "org/repo",
    mockGh,
    logger,
  );

  // One WARNING per stripped reserved label, naming the label + context.
  const warnings = lines.filter((l) => l.includes("WARNING"));
  assertEquals(warnings.length, 2);
  assertEquals(warnings.some((l) => l.includes("work-on")), true);
  assertEquals(warnings.some((l) => l.includes("claude")), true);
  assertEquals(
    warnings.every((l) => l.includes("suggest-improvements")),
    true,
  );
  // The kept label is never warned about.
  assertEquals(warnings.some((l) => l.includes("enhancement")), false);
});

// ---------------------------------------------------------------------------
// hasVisibleContent (Issue #1659)
//
// Bodies that render as blank on GitHub (empty, whitespace, HTML-comment-only)
// must be rejected so the worker does not post "blank" comments.
// ---------------------------------------------------------------------------

Deno.test("github - hasVisibleContent returns false for empty string", () => {
  assertEquals(hasVisibleContent(""), false);
});

Deno.test("github - hasVisibleContent returns false for whitespace only", () => {
  assertEquals(hasVisibleContent("   \n\t  "), false);
});

Deno.test("github - hasVisibleContent returns false for HTML comment only", () => {
  assertEquals(
    hasVisibleContent("<!-- PR_COMMENT_CLAIM:worker:123 -->"),
    false,
  );
});

Deno.test("github - hasVisibleContent returns false for multiple HTML comments and whitespace", () => {
  const body = "<!-- A -->\n  <!-- B -->\n";
  assertEquals(hasVisibleContent(body), false);
});

Deno.test("github - hasVisibleContent returns false for multi-line HTML comment", () => {
  const body = "<!--\n  multi-line\n  comment\n-->";
  assertEquals(hasVisibleContent(body), false);
});

Deno.test("github - hasVisibleContent returns true for plain text", () => {
  assertEquals(hasVisibleContent("hello"), true);
});

Deno.test("github - hasVisibleContent returns true for HTML comment plus visible line", () => {
  const body = "<!-- CLAIM_LOCK:worker -->\nClaimed by `worker`";
  assertEquals(hasVisibleContent(body), true);
});

Deno.test("github - hasVisibleContent returns true for visible text between comments", () => {
  const body = "<!-- A -->visible<!-- B -->";
  assertEquals(hasVisibleContent(body), true);
});

// --- parseCreatedCommentJson (Issue #1843) ---

Deno.test("github - parseCreatedCommentJson parses a valid REST POST response", () => {
  const raw = JSON.stringify({
    id: 4242,
    body: "## Round 1\n\nWhich format?",
    user: { login: "vibecoder-bot" },
    created_at: "2026-05-04T12:00:00Z",
    reactions: { "+1": 1, eyes: 0, confused: 0 },
  });
  const c = parseCreatedCommentJson(raw);
  assertEquals(c?.id, 4242);
  assertEquals(c?.body, "## Round 1\n\nWhich format?");
  assertEquals(c?.author, "vibecoder-bot");
  assertEquals(c?.createdAt, "2026-05-04T12:00:00Z");
  assertEquals(c?.reactions.thumbsUp, 1);
});

Deno.test("github - parseCreatedCommentJson defaults missing reactions to zero", () => {
  const raw = JSON.stringify({
    id: 7,
    body: "hi",
    user: { login: "u" },
    created_at: "2026-05-04T12:00:00Z",
  });
  const c = parseCreatedCommentJson(raw);
  assertEquals(c?.reactions.thumbsUp, 0);
  assertEquals(c?.reactions.eyes, 0);
  assertEquals(c?.reactions.confused, 0);
});

Deno.test("github - parseCreatedCommentJson returns undefined for malformed JSON", () => {
  assertEquals(parseCreatedCommentJson("not json"), undefined);
  assertEquals(parseCreatedCommentJson(""), undefined);
});

Deno.test("github - parseCreatedCommentJson returns undefined when required fields are missing", () => {
  // No id → cannot satisfy GitHubComment shape.
  const raw = JSON.stringify({
    body: "hi",
    user: { login: "u" },
    created_at: "2026-05-04T12:00:00Z",
  });
  assertEquals(parseCreatedCommentJson(raw), undefined);
});

Deno.test("github - parseCreatedCommentJson returns undefined for non-object payloads", () => {
  assertEquals(parseCreatedCommentJson("null"), undefined);
  assertEquals(parseCreatedCommentJson("[1,2,3]"), undefined);
  assertEquals(parseCreatedCommentJson('"a string"'), undefined);
});

// Integration tests that require gh CLI (skipped by default)
Deno.test({
  name: "github - runGhCommand handles missing gh CLI",
  ignore: Deno.env.get("RUN_INTEGRATION_TESTS") !== "true",
  fn: async () => {
    // This test verifies error handling when gh is not available
    // or returns an error
    await assertRejects(
      async () => {
        await runGhCommand(["api", "/nonexistent/endpoint"]);
      },
      Error,
    );
  },
});

// Issue #3311 — egress containment wired at the real chokepoint.
// runGhCommandRaw must refuse an off-allowlist write BEFORE spawning gh,
// so the specific WriteRepoBlockedError surfaces (not a gh-exec error).
// This proves the allowlist check sits on the shared comment/label/PR path.
Deno.test("github - runGhCommandRaw blocks an off-allowlist write before spawning gh (Issue #3311)", async () => {
  _setWriteRepoAllowlistSinks({
    record: () => Promise.resolve({ ok: true, value: undefined as never }),
    log: () => {},
  });
  seedWriteRepoAllowlist("me/target");
  try {
    await assertRejects(
      () =>
        runGhCommandRaw([
          "issue",
          "comment",
          "1",
          "-R",
          "attacker/public-repo",
          "--body",
          "leak",
        ]),
      WriteRepoBlockedError,
    );
  } finally {
    resetWriteRepoAllowlist();
    _resetWriteRepoAllowlistSinks();
  }
});
