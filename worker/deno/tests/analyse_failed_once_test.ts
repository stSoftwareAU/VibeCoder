/**
 * Tests for the analyse-failed-once command (Issue #1547).
 *
 * Surveys recent `failed-once` issues across configured repos and
 * aggregates `**Category:**` counts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  analyseFailedOnce,
  analyseFailedOnceCommand,
  formatMarkdownReport,
  parseCategoryFromComment,
} from "../commands/analyse_failed_once.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const config = buildDefaultWorkerConfig();

// ============================================================================
// Command metadata
// ============================================================================

Deno.test("analyseFailedOnceCommand - has correct name", () => {
  assertEquals(analyseFailedOnceCommand.name, "analyse-failed-once");
});

Deno.test("analyseFailedOnceCommand - has description", () => {
  assertEquals(typeof analyseFailedOnceCommand.description, "string");
  assertEquals(analyseFailedOnceCommand.description.length > 0, true);
});

// ============================================================================
// parseCategoryFromComment
// ============================================================================

Deno.test("parseCategoryFromComment - extracts category from first-attempt comment", () => {
  const body = `## Automated Processing Failed (First Attempt)

**Category:** \`quality-failure\`

The automated worker was unable to complete this issue on the first attempt.`;
  assertEquals(parseCategoryFromComment(body), "quality-failure");
});

Deno.test("parseCategoryFromComment - returns unknown when Category line missing", () => {
  const body = `## Automated Processing Failed (First Attempt)

The automated worker was unable to complete this issue on the first attempt.`;
  assertEquals(parseCategoryFromComment(body), "unknown");
});

Deno.test("parseCategoryFromComment - handles no-output category", () => {
  const body = `## Automated Processing Failed (First Attempt)

**Category:** \`no-output\`

Details.`;
  assertEquals(parseCategoryFromComment(body), "no-output");
});

// ============================================================================
// analyseFailedOnce — happy path
// ============================================================================

Deno.test("analyseFailedOnce - aggregates categories across multiple repos", async () => {
  const fixtures: Record<string, unknown[]> = {
    "org/repoA": [
      {
        number: 1,
        title: "Issue 1",
        state: "OPEN",
        comments: [
          {
            body:
              "## Automated Processing Failed (First Attempt)\n\n**Category:** `quality-failure`\n\nDetails.",
          },
        ],
      },
      {
        number: 2,
        title: "Issue 2",
        state: "CLOSED",
        comments: [
          {
            body:
              "## Automated Processing Failed (First Attempt)\n\n**Category:** `quality-failure`\n",
          },
        ],
      },
      {
        number: 3,
        title: "Issue 3",
        state: "OPEN",
        comments: [
          {
            body:
              "## Automated Processing Failed (First Attempt)\n\n**Category:** `no-output`\n",
          },
        ],
      },
    ],
    "org/repoB": [
      {
        number: 11,
        title: "Issue 11",
        state: "CLOSED",
        comments: [
          {
            body:
              "## Automated Processing Failed (First Attempt)\n\n**Category:** `timeout`\n",
          },
        ],
      },
    ],
  };

  const ghCommandFn = async (args: string[]): Promise<string> => {
    const repoIdx = args.indexOf("--repo");
    const repo = args[repoIdx + 1]!;
    await Promise.resolve();
    return JSON.stringify(fixtures[repo] ?? []);
  };

  const result = await analyseFailedOnce({
    repos: ["org/repoA", "org/repoB"],
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(result.value.byCategory["quality-failure"], 2);
  assertEquals(result.value.byCategory["no-output"], 1);
  assertEquals(result.value.byCategory["timeout"], 1);

  assertEquals(result.value.byRepo["org/repoA"]!["quality-failure"], 2);
  assertEquals(result.value.byRepo["org/repoA"]!["no-output"], 1);
  assertEquals(result.value.byRepo["org/repoB"]!["timeout"], 1);

  // Resolution: 2 closed (succeeded), 2 open (still failed)
  assertEquals(result.value.succeeded, 2);
  assertEquals(result.value.stillFailed, 2);
  assertEquals(result.value.totalIssues, 4);
});

// ============================================================================
// analyseFailedOnce — empty repo
// ============================================================================

Deno.test("analyseFailedOnce - empty repo returns empty report without error", async () => {
  const ghCommandFn = async (_args: string[]): Promise<string> => {
    await Promise.resolve();
    return "[]";
  };

  const result = await analyseFailedOnce({
    repos: ["org/empty"],
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.totalIssues, 0);
  assertEquals(Object.keys(result.value.byCategory).length, 0);
  assertEquals(result.value.byRepo["org/empty"], {});
});

// ============================================================================
// analyseFailedOnce — malformed comment
// ============================================================================

Deno.test("analyseFailedOnce - malformed comment without Category counted as unknown", async () => {
  const fixture = [
    {
      number: 42,
      title: "Broken comment",
      state: "OPEN",
      comments: [
        {
          body:
            "## Automated Processing Failed (First Attempt)\n\nNo category line here.",
        },
      ],
    },
  ];

  const ghCommandFn = async (_args: string[]): Promise<string> => {
    await Promise.resolve();
    return JSON.stringify(fixture);
  };

  const result = await analyseFailedOnce({
    repos: ["org/broken"],
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.byCategory["unknown"], 1);
  assertEquals(result.value.totalIssues, 1);
});

// ============================================================================
// analyseFailedOnce — ignores non-first-attempt comments
// ============================================================================

Deno.test("analyseFailedOnce - ignores issues without first-attempt marker", async () => {
  const fixture = [
    {
      number: 1,
      title: "Second-attempt only",
      state: "OPEN",
      comments: [
        {
          body:
            "## Automated Processing Failed (Second Attempt - Permanently Failed)\n\n**Category:** `quality-failure`\n",
        },
      ],
    },
    {
      number: 2,
      title: "Unrelated",
      state: "OPEN",
      comments: [{ body: "Just a random comment." }],
    },
  ];

  const ghCommandFn = async (_args: string[]): Promise<string> => {
    await Promise.resolve();
    return JSON.stringify(fixture);
  };

  const result = await analyseFailedOnce({
    repos: ["org/filter"],
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.totalIssues, 0);
});

// ============================================================================
// analyseFailedOnce — gh command failure
// ============================================================================

Deno.test("analyseFailedOnce - returns error when gh command throws", async () => {
  const ghCommandFn = async (_args: string[]): Promise<string> => {
    await Promise.resolve();
    throw new Error("gh: not authenticated");
  };

  const result = await analyseFailedOnce({
    repos: ["org/repo"],
    ghCommandFn,
  });

  assertEquals(result.ok, false);
});

// ============================================================================
// formatMarkdownReport
// ============================================================================

Deno.test("formatMarkdownReport - produces Markdown with category table", () => {
  const report = {
    byCategory: { "quality-failure": 3, "no-output": 1 },
    byRepo: {
      "org/a": { "quality-failure": 2 },
      "org/b": { "quality-failure": 1, "no-output": 1 },
    },
    succeeded: 1,
    stillFailed: 3,
    totalIssues: 4,
  };
  const md = formatMarkdownReport(report);
  assertStringIncludes(md, "Failed-once Category Report");
  assertStringIncludes(md, "quality-failure");
  assertStringIncludes(md, "| 3 |");
  assertStringIncludes(md, "org/a");
  assertStringIncludes(md, "org/b");
  assertStringIncludes(md, "Total issues");
});

// ============================================================================
// Command execute — missing repos
// ============================================================================

Deno.test("analyseFailedOnceCommand - fails when no repos available", async () => {
  const emptyConfig = { ...config, repos: [] };
  const result = await analyseFailedOnceCommand.execute({}, emptyConfig);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "repos");
});
