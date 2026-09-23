/**
 * Tests for the held-issue gate comment upsert loop in find_oldest_issue.ts
 * (Issue #2535, part of milestone #2527).
 *
 * Covers the new gate-comment reporting system that replaces the legacy
 * chain-root-unworkable comments. Tests gate construction, cache management,
 * legacy-comment cleanup, and upsert-failure handling.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createDiagnostics } from "../lib/issue_finder_logger.ts";
import { buildHeldIssueGateComment } from "../lib/held_issue_gate_comment.ts";
import type { WorkerConfig } from "../types.ts";

const ALICE = { login: "alice" };

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "find-oldest-gate-" });
  return new IssueCache(dir, 600);
}

function captureDiagnostics(): {
  diag: ReturnType<typeof createDiagnostics>;
  output: string[];
} {
  const output: string[] = [];
  const diag = createDiagnostics({
    enabled: false,
    write: (msg: string) => output.push(msg),
  });
  return { diag, output };
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    workDir: Deno.makeTempDirSync({ prefix: "find-oldest-workdir-" }),
    repos: ["owner/repo-a"],
    issueLabels: ["top-priority", "help-wanted"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    lowPriorityLabel: "low-priority",
    failedLabel: "failed",
    failedOnceLabel: "failed-once",
    refineIssueLabel: "refine-issue",
    planningLabel: "planning",
    questionLabel: "question",
    needsRevisionLabel: "needs-revision",
    needsHumanLabel: "needs-human",
    shuffleRepos: false,
    ...overrides,
  };
}

interface RepoFixture {
  issues: Record<string, unknown>[];
  timeline?: Record<string, unknown>[];
  milestones?: Record<string, unknown>[];
  /** Comments that exist when reading. */
  comments?: Record<string, unknown>[];
}

interface GhCall {
  method: "POST" | "PATCH" | "DELETE" | "GET";
  endpoint: string;
  args: string[];
}

/**
 * Mock gh that tracks POST/PATCH/DELETE/GET separately for gate-comment tests.
 * Supports:
 * - GET comment threads (--paginate for marker read)
 * - POST new comments
 * - PATCH existing comments (edit)
 * - DELETE comments (cleanup)
 * - Issue list, timeline, milestones (pass through to base fixture)
 */
function createGateCommentMockGh(
  fixtures: Record<string, RepoFixture>,
): {
  calls: GhCall[];
  ghFn: (args: string[]) => Promise<string>;
} {
  const calls: GhCall[] = [];

  function resolveRepo(args: string[]): string {
    const repoIdx = args.indexOf("--repo");
    if (repoIdx >= 0) return args[repoIdx + 1] ?? "";
    for (const arg of args) {
      const match = arg.match(/^repos\/([^/]+\/[^/]+)\//);
      if (match) return match[1] ?? "";
    }
    return "";
  }

  return {
    calls,
    ghFn: async (args: string[]): Promise<string> => {
      const command = args.join(" ");
      const repo = resolveRepo(args);
      const fixture = fixtures[repo];

      // Issue list
      if (command.includes("issue list")) {
        return JSON.stringify(fixture?.issues ?? []);
      }

      // Issue view
      if (command.includes("issue view")) {
        const number = Number(args[args.indexOf("view") + 1]);
        const issue = fixture?.issues.find((i) => i.number === number);
        return JSON.stringify({
          number,
          state: issue ? "OPEN" : "CLOSED",
          title: issue?.title ?? "",
          body: issue?.body ?? "",
          milestone: issue?.milestone ?? null,
        });
      }

      // PR list
      if (command.includes("pr list")) {
        return "[]";
      }

      // Timeline
      if (command.includes("timeline")) {
        return JSON.stringify(fixture?.timeline ?? []);
      }

      // Milestones
      if (command.includes("/milestones")) {
        return JSON.stringify(fixture?.milestones ?? []);
      }

      // Comment operations
      if (command.includes("/comments")) {
        const isPost = args.includes("-X") &&
          args[args.indexOf("-X") + 1] === "POST";
        const isPatch = args.includes("-X") &&
          args[args.indexOf("-X") + 1] === "PATCH";
        const isDelete = args.includes("-X") &&
          args[args.indexOf("-X") + 1] === "DELETE";
        const isGet = !isPost && !isPatch && !isDelete &&
          args.includes("--paginate");

        if (isPost) {
          calls.push({
            method: "POST",
            endpoint: `repos/${repo}/issues/\${N}/comments`,
            args,
          });
          return "{}";
        }

        if (isPatch) {
          calls.push({
            method: "PATCH",
            endpoint: "repos/*/issues/comments/*",
            args,
          });
          return "{}";
        }

        if (isDelete) {
          calls.push({
            method: "DELETE",
            endpoint: "repos/*/issues/comments/*",
            args,
          });
          return "{}";
        }

        if (isGet) {
          // Paginated comment read, return existing comments
          calls.push({
            method: "GET",
            endpoint: "repos/*/issues/\${N}/comments",
            args,
          });
          const comments = fixture?.comments ?? [];
          return JSON.stringify(comments);
        }
      }

      return "[]";
    },
  };
}

/** Held issue with optional dependency blocker. */
function heldIssue(
  number: number,
  labels: string[],
  createdAt: string,
  body = "",
  blockingRepo = "owner/repo-a",
  blockingNumber: number | null = null,
): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/owner/repo-a/issues/${number}`,
    assignees: [],
    labels: labels.map((name) => ({ name })),
    createdAt,
    author: ALICE,
    milestone: null,
    body: blockingNumber
      ? `Depends on ${blockingRepo}#${blockingNumber}`
      : body,
  };
}

/** Standard timeline for issue events. */
const HELD_ISSUE_TIMELINE = [
  { event: "labeled", label: { name: "top-priority" }, actor: ALICE },
  { event: "labeled", label: { name: "work-on" }, actor: ALICE },
  { event: "labeled", label: { name: "low-priority" }, actor: ALICE },
];

Deno.test(
  "findOldestIssue - posts one held-issue gate comment for blocked top-priority (Issue #2535)",
  async () => {
    // #100 (top-priority) blocked on #200 (low-priority, in same repo).
    // Gate comment should be posted on #100, named as dependency.
    const config = makeConfig({ repos: ["owner/repo-a"] });
    const blocked = heldIssue(
      100,
      ["top-priority"],
      "2024-01-01T00:00:00Z",
      "",
      "owner/repo-a",
      200,
    );
    const blocker = heldIssue(200, ["low-priority"], "2024-06-01T00:00:00Z");

    const { calls, ghFn } = createGateCommentMockGh({
      "owner/repo-a": {
        issues: [blocked, blocker],
        timeline: HELD_ISSUE_TIMELINE,
      },
    });

    const { diag } = captureDiagnostics();
    await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: ghFn,
      cache: createTestCache(),
      diagnostics: diag,
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    // Verify gate comment was posted
    const postCalls = calls.filter((c) => c.method === "POST");
    assertEquals(
      postCalls.length,
      1,
      `Expected 1 POST, got ${postCalls.length}`,
    );
    assertStringIncludes(
      postCalls[0]?.args.join(" ") ?? "",
      "vibe-held-issue-gate",
      "Gate comment should carry the marker",
    );
  },
);

Deno.test(
  "findOldestIssue - does not post gate comment for held low-priority issue (Issue #2535)",
  async () => {
    // #100 (low-priority) blocked on #200 (low-priority).
    // Low-priority held issues do not get gate comments.
    const config = makeConfig({ repos: ["owner/repo-a"] });
    const blocked = heldIssue(
      100,
      ["low-priority"],
      "2024-01-01T00:00:00Z",
      "",
      "owner/repo-a",
      200,
    );
    const blocker = heldIssue(200, ["low-priority"], "2024-06-01T00:00:00Z");

    const { calls, ghFn } = createGateCommentMockGh({
      "owner/repo-a": {
        issues: [blocked, blocker],
        timeline: HELD_ISSUE_TIMELINE,
      },
    });

    const { diag } = captureDiagnostics();
    await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: ghFn,
      cache: createTestCache(),
      diagnostics: diag,
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    // No gate comment should be posted for low-priority
    const postCalls = calls.filter((c) => c.method === "POST");
    assertEquals(
      postCalls.length,
      0,
      "Low-priority held issue should not get gate comment",
    );
  },
);

Deno.test(
  "findOldestIssue - skips thread read when gate unchanged within 24h (cache) (Issue #2535)",
  async () => {
    // Run scan twice with same state. First run posts the comment.
    // Second run should skip thread read because cache shows gate unchanged
    // within 24 hours — the cache key and gate key match.
    const config = makeConfig({ repos: ["owner/repo-a"] });
    const blocked = heldIssue(
      100,
      ["top-priority"],
      "2024-01-01T00:00:00Z",
      "",
      "owner/repo-a",
      200,
    );
    const blocker = heldIssue(200, ["low-priority"], "2024-06-01T00:00:00Z");

    const { calls: calls1, ghFn: ghFn1 } = createGateCommentMockGh({
      "owner/repo-a": {
        issues: [blocked, blocker],
        timeline: HELD_ISSUE_TIMELINE,
      },
    });

    const cache = createTestCache();
    const { diag: diag1 } = captureDiagnostics();

    // First scan: posts comment
    await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: ghFn1,
      cache,
      diagnostics: diag1,
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    const getCalls1 = calls1.filter((c) => c.method === "GET");
    assertEquals(
      getCalls1.length > 0,
      true,
      "First scan should read the thread",
    );

    // Second scan with same cache: should skip thread read
    const { calls: calls2, ghFn: ghFn2 } = createGateCommentMockGh({
      "owner/repo-a": {
        issues: [blocked, blocker],
        timeline: HELD_ISSUE_TIMELINE,
      },
    });

    const { diag: diag2 } = captureDiagnostics();
    await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: ghFn2,
      cache,
      diagnostics: diag2,
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    const getCalls2 = calls2.filter((c) => c.method === "GET");
    assertEquals(
      getCalls2.length,
      0,
      "Second scan should skip thread read (cache hit)",
    );
  },
);

Deno.test(
  "findOldestIssue - edits gate comment when gate changes, deletes legacy comment (Issue #2535)",
  async () => {
    // #100 depends on #200 and #300. Scan 1 names #200; #200 then closes and
    // scan 2 names #300. The body never changes — an edited body is refused
    // by the content-integrity gate, not re-gated.
    // Gate comment should be edited (PATCH), not re-posted (POST).
    // Legacy vibe-chain-root-unworkable comments should be deleted (DELETE).
    const config = makeConfig({ repos: ["owner/repo-a"] });
    const blocked = heldIssue(
      100,
      ["top-priority"],
      "2024-01-01T00:00:00Z",
      "Depends on #200\nDepends on #300",
    );
    const blocker1 = heldIssue(200, ["low-priority"], "2024-06-01T00:00:00Z");
    const blocker2 = heldIssue(300, ["low-priority"], "2024-06-02T00:00:00Z");

    const cache = createTestCache();

    // First scan: gate on #200
    const { calls: calls1, ghFn: ghFn1 } = createGateCommentMockGh({
      "owner/repo-a": {
        issues: [blocked, blocker1, blocker2],
        timeline: HELD_ISSUE_TIMELINE,
      },
    });

    const { diag: diag1 } = captureDiagnostics();
    await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: ghFn1,
      cache,
      diagnostics: diag1,
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    const postCalls1 = calls1.filter((c) => c.method === "POST");
    assertEquals(postCalls1.length, 1, "First scan posts gate comment");

    // Second scan: #200 has closed, so #300 holds. The thread holds the gate
    // comment scan 1 posted and a legacy chain-root comment, both written by
    // the fleet, in the shape `fetchMarkerComments`' --jq projection returns.
    const scanOneGate = {
      id: 998,
      body: buildHeldIssueGateComment({
        kind: "dependency",
        dependency: { repo: "owner/repo-a", number: 200 },
      }).body,
      created_at: new Date().toISOString(),
      author: "bot",
    };
    const legacyComment = {
      id: 999,
      body: '<!-- vibe-chain-root-unworkable key="..." -->',
      created_at: new Date().toISOString(),
      author: "bot",
    };

    const { calls: calls2, ghFn: ghFn2 } = createGateCommentMockGh({
      "owner/repo-a": {
        issues: [blocked, blocker2],
        timeline: HELD_ISSUE_TIMELINE,
        comments: [scanOneGate, legacyComment],
      },
    });

    // The issue listing has moved on (its 600 s TTL expires in real use); the
    // gate memo in the same cache is what must not hide the change.
    await cache.invalidate("owner/repo-a", "issues_all");

    const { diag: diag2 } = captureDiagnostics();
    await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: ghFn2,
      cache,
      diagnostics: diag2,
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    const patchCalls = calls2.filter((c) => c.method === "PATCH");
    const deleteCalls = calls2.filter((c) => c.method === "DELETE");

    assertEquals(
      patchCalls.length,
      1,
      "Changed gate should be edited, not re-posted",
    );
    assertEquals(
      deleteCalls.length,
      1,
      "Legacy chain-root comment should be deleted",
    );
  },
);

Deno.test(
  "findOldestIssue - warns on upsert failure, continues scanning (Issue #2535)",
  async () => {
    // Gate-comment upsert fails (e.g., thread read permission denied).
    // Scan should log the failure but continue — not abort selection.
    const config = makeConfig({ repos: ["owner/repo-a"] });
    const blocked = heldIssue(
      100,
      ["top-priority"],
      "2024-01-01T00:00:00Z",
      "",
      "owner/repo-a",
      200,
    );
    const blocker = heldIssue(200, ["low-priority"], "2024-06-01T00:00:00Z");

    let shouldFail = false;
    const { ghFn: baseGhFn } = createGateCommentMockGh({
      "owner/repo-a": {
        issues: [blocked, blocker],
        timeline: HELD_ISSUE_TIMELINE,
      },
    });

    const failingGhFn = async (args: string[]): Promise<string> => {
      // Simulate failure on comment read
      if (
        args.some((a) => a.includes("/comments")) &&
        args.includes("--paginate") && shouldFail
      ) {
        throw new Error("Permission denied: cannot read comments");
      }
      return baseGhFn(args);
    };

    shouldFail = true;
    const { diag } = captureDiagnostics();
    const result = await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: failingGhFn,
      cache: createTestCache(),
      diagnostics: diag,
      selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
    });

    // Scan should still find a candidate despite the gate-comment failure
    assertEquals(
      result.found,
      true,
      "Scan should continue despite gate-comment failure",
    );
  },
);
