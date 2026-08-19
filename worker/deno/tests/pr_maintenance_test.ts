/**
 * Tests for pr_maintenance.ts — PR scanning/maintenance functions.
 *
 * Issue #967: Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { alwaysLanded } from "./fixtures/merge_landing_stub.ts";
import {
  type AutoMergeOptions,
  type CiCheckScanOptions,
  closeIssuesForMergedPrs,
  type CloseIssuesOptions,
  ensureAutoMergeOnOpenPrs,
  extractIssueFromBranch,
  fetchCommentThumbsUpReactors,
  fetchFailedCheckRuns,
  fetchPrComments,
  findFailedCiChecks,
  findFailedPrChecks,
  findPrCommentsToFix,
  listMergedPrs,
  listOpenPrs,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import { resolveFleetMaintenanceAuthorSet } from "../lib/fleet_authors.ts";
import { INVITATION_PR_FIELDS } from "../lib/pr_invitation_lookup.ts";
import type { Logger } from "../types.ts";
import type { MergeAttemptOutcome } from "../lib/merge_block_escalation.ts";
import {
  computeFailureSignature,
  getAutoFixAttempts,
  recordAutoFixAttempt,
} from "../lib/auto_fix_attempt_tracker.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/**
 * Create a mock gh command function that returns predefined responses.
 */
function createMockGh(
  responses: Record<string, string>,
): (args: string[]) => Promise<string> {
  return async (args: string[]) => {
    const key = args.join(" ");
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) return response;
    }
    return "[]";
  };
}

function makeBaseScanOptions(
  overrides?: Partial<PrScanOptions>,
): PrScanOptions {
  return {
    githubUser: "testbot",
    repos: ["org/repo"],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: () => true,
    ghCommandFn: () => Promise.resolve("[]"),
    ...overrides,
  };
}

// ============================================================================
// extractIssueFromBranch
// ============================================================================

Deno.test("extractIssueFromBranch - extracts issue number from standard pattern", () => {
  assertEquals(extractIssueFromBranch("issue-42-fix-bug"), "42");
});

Deno.test("extractIssueFromBranch - extracts issue number with long suffix", () => {
  assertEquals(
    extractIssueFromBranch("issue-123-some-long-description"),
    "123",
  );
});

Deno.test("extractIssueFromBranch - returns null for non-matching branch", () => {
  assertEquals(extractIssueFromBranch("feature/add-logging"), null);
});

Deno.test("extractIssueFromBranch - returns null for partial match", () => {
  assertEquals(extractIssueFromBranch("not-issue-42-fix"), null);
});

// ============================================================================
// listOpenPrs
// ============================================================================

Deno.test("listOpenPrs - parses PR list response", async () => {
  const ghFn = createMockGh({
    "pr list": JSON.stringify([
      { number: 1, headRefName: "issue-1-fix" },
      { number: 2, headRefName: "issue-2-feat" },
    ]),
  });

  const prs = await listOpenPrs(
    "org/repo",
    "testbot",
    "number,headRefName",
    ghFn,
  );
  assertEquals(prs.length, 2);
  assertEquals(prs[0]!.number, 1);
  assertEquals(prs[1]!.headRefName, "issue-2-feat");
});

Deno.test("listOpenPrs - returns empty array on failure", async () => {
  const ghFn = () => Promise.reject(new Error("API error"));
  const prs = await listOpenPrs("org/repo", "testbot", "number", ghFn);
  assertEquals(prs.length, 0);
});

Deno.test("listOpenPrs - single author issues exactly one query", async () => {
  const calls: string[][] = [];
  const ghFn = (args: string[]) => {
    calls.push(args);
    return Promise.resolve(JSON.stringify([{ number: 1 }]));
  };
  const prs = await listOpenPrs("org/repo", "testbot", "number", ghFn);
  assertEquals(prs.length, 1);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.includes("testbot"), true);
});

Deno.test(
  "listOpenPrs - merges and de-duplicates PRs across fleet authors",
  async () => {
    // A sibling fleet host (stsvcbot) authored PR #510; this host
    // (VibeCoderBot) authored #1. PR #2 is (implausibly) returned by both
    // authors and must appear only once.
    const ghFn = (args: string[]) => {
      const key = args.join(" ");
      if (key.includes("--author VibeCoderBot")) {
        return Promise.resolve(
          JSON.stringify([{ number: 1 }, { number: 2 }]),
        );
      }
      if (key.includes("--author stsvcbot")) {
        return Promise.resolve(
          JSON.stringify([{ number: 510 }, { number: 2 }]),
        );
      }
      return Promise.resolve("[]");
    };
    const prs = await listOpenPrs(
      "org/repo",
      ["VibeCoderBot", "stsvcbot"],
      "number",
      ghFn,
    );
    const numbers = prs.map((p) => p.number).sort((a, b) =>
      (a ?? 0) - (b ?? 0)
    );
    assertEquals(numbers, [1, 2, 510]);
  },
);

Deno.test(
  "listOpenPrs - one failing author does not drop the others' PRs",
  async () => {
    const ghFn = (args: string[]) => {
      const key = args.join(" ");
      if (key.includes("--author stsvcbot")) {
        return Promise.reject(new Error("API error"));
      }
      return Promise.resolve(JSON.stringify([{ number: 1 }]));
    };
    const prs = await listOpenPrs(
      "org/repo",
      ["VibeCoderBot", "stsvcbot"],
      "number",
      ghFn,
    );
    assertEquals(prs.map((p) => p.number), [1]);
  },
);

Deno.test(
  "findPrCommentsToFix - queries fleet authors in addition to githubUser",
  async () => {
    const listCalls: string[][] = [];
    const ghFn = (args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") listCalls.push(args);
      return Promise.resolve("[]");
    };
    await findPrCommentsToFix(makeBaseScanOptions({
      githubUser: "VibeCoderBot",
      prAuthors: ["stsvcbot"],
      ghCommandFn: ghFn,
    }));
    const authorsQueried = listCalls
      .map((c) => c[c.indexOf("--author") + 1])
      .filter((a): a is string => typeof a === "string");
    assertEquals(authorsQueried.includes("VibeCoderBot"), true);
    assertEquals(authorsQueried.includes("stsvcbot"), true);
  },
);

// ============================================================================
// listMergedPrs
// ============================================================================

Deno.test("listMergedPrs - parses merged PR list", async () => {
  const ghFn = createMockGh({
    "pr list": JSON.stringify([
      { number: 10, title: "Fix bug (Issue #50)" },
    ]),
  });

  const prs = await listMergedPrs("org/repo", "testbot", ghFn);
  assertEquals(prs.length, 1);
  assertEquals(prs[0]!.title, "Fix bug (Issue #50)");
});

// ============================================================================
// fetchPrComments
// ============================================================================

Deno.test("fetchPrComments - parses review comments", async () => {
  const ghFn = createMockGh({
    "pulls/42/comments": JSON.stringify([
      { login: "reviewer", id: 100, body: "Fix this", thumbs_up: 1 },
    ]),
  });

  const comments = await fetchPrComments("org/repo", 42, "review", ghFn);
  assertEquals(comments.length, 1);
  assertEquals(comments[0]!.login, "reviewer");
  assertEquals(comments[0]!.thumbs_up, 1);
});

Deno.test("fetchPrComments - returns empty on error", async () => {
  const ghFn = () => Promise.reject(new Error("Network error"));
  const comments = await fetchPrComments("org/repo", 42, "issue", ghFn);
  assertEquals(comments.length, 0);
});

// ============================================================================
// fetchCommentThumbsUpReactors (Issue #2484)
// ============================================================================

Deno.test("fetchCommentThumbsUpReactors - resolves +1 reactor logins for review comment", async () => {
  let requestedPath = "";
  const ghFn = (args: string[]): Promise<string> => {
    requestedPath = args[1] ?? "";
    return Promise.resolve(JSON.stringify(["alice", "bob"]));
  };

  const reactors = await fetchCommentThumbsUpReactors(
    "org/repo",
    300,
    "review",
    ghFn,
  );
  assertEquals(reactors, ["alice", "bob"]);
  assertEquals(requestedPath, "repos/org/repo/pulls/comments/300/reactions");
});

Deno.test("fetchCommentThumbsUpReactors - uses issue-comment endpoint for issue comments", async () => {
  let requestedPath = "";
  const ghFn = (args: string[]): Promise<string> => {
    requestedPath = args[1] ?? "";
    return Promise.resolve("[]");
  };

  await fetchCommentThumbsUpReactors("org/repo", 42, "issue", ghFn);
  assertEquals(requestedPath, "repos/org/repo/issues/comments/42/reactions");
});

Deno.test("fetchCommentThumbsUpReactors - returns empty array on error", async () => {
  const ghFn = () => Promise.reject(new Error("Network error"));
  const reactors = await fetchCommentThumbsUpReactors(
    "org/repo",
    1,
    "issue",
    ghFn,
  );
  assertEquals(reactors, []);
});

// ============================================================================
// fetchFailedCheckRuns
// ============================================================================

Deno.test("fetchFailedCheckRuns - parses failed checks", async () => {
  const ghFn = createMockGh({
    "check-runs": JSON.stringify([
      { id: 1, name: "cspell", status: "completed", conclusion: "failure" },
      { id: 2, name: "CI / test", status: "completed", conclusion: "failure" },
    ]),
  });

  const checks = await fetchFailedCheckRuns("org/repo", "issue-1-fix", ghFn);
  assertEquals(checks.length, 2);
  assertEquals(checks[0]!.name, "cspell");
});

// ============================================================================
// findPrCommentsToFix
// ============================================================================

Deno.test("findPrCommentsToFix - returns null when no repos", async () => {
  const options = makeBaseScanOptions({ repos: [] });
  const result = await findPrCommentsToFix(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

Deno.test("findPrCommentsToFix - returns null when repo not allowed", async () => {
  const options = makeBaseScanOptions({ isRepoAllowed: () => false });
  const result = await findPrCommentsToFix(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

Deno.test("findPrCommentsToFix - finds authorised review comment", async () => {
  const callLog: string[] = [];
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    callLog.push(key);
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 10, headRefName: "issue-10-fix", headRefOid: "abc123" },
      ]);
    }
    if (key.includes("pulls/10/comments")) {
      return JSON.stringify([
        { login: "reviewer", id: 200, body: "Fix alignment", thumbs_up: 0 },
      ]);
    }
    return "[]";
  };

  const options = makeBaseScanOptions({
    ghCommandFn: ghFn,
    isAuthorisedCommenter: (author: string) => author === "reviewer",
  });

  const result = await findPrCommentsToFix(options);
  assertEquals(result.ok, true);
  if (result.ok && result.value) {
    assertEquals(result.value.repo, "org/repo");
    assertEquals(result.value.prNumber, 10);
    assertEquals(result.value.commentType, "review");
    assertEquals(result.value.commentId, "200");
  }
});

Deno.test("findPrCommentsToFix - skips own comments", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 10, headRefName: "issue-10-fix", headRefOid: "abc123" },
      ]);
    }
    if (key.includes("pulls/10/comments")) {
      return JSON.stringify([
        { login: "testbot", id: 200, body: "My own comment", thumbs_up: 0 },
      ]);
    }
    if (key.includes("issues/10/comments")) {
      return "[]";
    }
    if (key.includes("pulls/10/reviews")) {
      return "[]";
    }
    return "[]";
  };

  const options = makeBaseScanOptions({ ghCommandFn: ghFn });
  const result = await findPrCommentsToFix(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

// Behaviour change (Issue #2484): a thumbs-up count is no longer trusted
// on its own. The previous test asserted that an unauthorised user's
// comment with thumbs_up >= 1 was actionable — that was the trust-bypass
// vulnerability. The replacement tests below require the reactor to be an
// authorised user.

Deno.test("findPrCommentsToFix - finds thumbs-up comment reacted by an authorised user (Issue #2484)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 10, headRefName: "issue-10-fix", headRefOid: "abc123" },
      ]);
    }
    if (key.includes("pulls/10/comments")) {
      return JSON.stringify([
        { login: "stranger", id: 300, body: "Please fix", thumbs_up: 1 },
      ]);
    }
    // Reactions endpoint: the +1 came from an authorised maintainer.
    if (key.includes("pulls/comments/300/reactions")) {
      return JSON.stringify(["maintainer"]);
    }
    return "[]";
  };

  const options = makeBaseScanOptions({
    ghCommandFn: ghFn,
    isAuthorisedCommenter: (author: string) => author === "maintainer",
  });

  const result = await findPrCommentsToFix(options);
  assertEquals(result.ok, true);
  if (result.ok && result.value) {
    assertEquals(result.value.commentId, "300");
  } else {
    throw new Error("expected actionable comment with authorised thumbs-up");
  }
});

Deno.test("findPrCommentsToFix - ignores thumbs-up comment when reactor is not authorised (Issue #2484)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 10, headRefName: "issue-10-fix", headRefOid: "abc123" },
      ]);
    }
    if (key.includes("pulls/10/comments")) {
      return JSON.stringify([
        { login: "stranger", id: 300, body: "Please fix", thumbs_up: 1 },
      ]);
    }
    // The attacker self-reacted: the only +1 is from the comment author,
    // who is not an authorised user.
    if (key.includes("pulls/comments/300/reactions")) {
      return JSON.stringify(["stranger"]);
    }
    return "[]";
  };

  const options = makeBaseScanOptions({
    ghCommandFn: ghFn,
    isAuthorisedCommenter: () => false,
  });

  const result = await findPrCommentsToFix(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

Deno.test("findPrCommentsToFix - trusted-bot review comment is actionable without thumbs-up (Issue #1857)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 11, headRefName: "issue-11-fix", headRefOid: "sha11" },
      ]);
    }
    if (key.includes("pulls/11/comments")) {
      return JSON.stringify([
        {
          login: "github-code-quality[bot]",
          id: 400,
          body: "Useless conditional",
          thumbs_up: 0,
        },
      ]);
    }
    return "[]";
  };

  const options = makeBaseScanOptions({
    ghCommandFn: ghFn,
    isAuthorisedCommenter: () => false,
    trustedReviewBots: ["github-code-quality[bot]"],
  });

  const result = await findPrCommentsToFix(options);
  assertEquals(result.ok, true);
  if (result.ok && result.value) {
    assertEquals(result.value.prNumber, 11);
    assertEquals(result.value.commentType, "review");
    assertEquals(result.value.commentId, "400");
  } else {
    throw new Error("expected actionable trusted-bot review comment");
  }
});

Deno.test("findPrCommentsToFix - trusted-bot issue comment is still ignored without thumbs-up (Issue #1857)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 12, headRefName: "issue-12-fix", headRefOid: "sha12" },
      ]);
    }
    if (key.includes("pulls/12/comments")) {
      return "[]";
    }
    if (key.includes("issues/12/comments")) {
      return JSON.stringify([
        {
          login: "github-code-quality[bot]",
          id: 401,
          body: "General complaint",
          thumbs_up: 0,
        },
      ]);
    }
    return "[]";
  };

  const options = makeBaseScanOptions({
    ghCommandFn: ghFn,
    isAuthorisedCommenter: () => false,
    trustedReviewBots: ["github-code-quality[bot]"],
  });

  const result = await findPrCommentsToFix(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

Deno.test("findPrCommentsToFix - untrusted bot review comment is ignored without thumbs-up (Issue #1857)", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 13, headRefName: "issue-13-fix", headRefOid: "sha13" },
      ]);
    }
    if (key.includes("pulls/13/comments")) {
      return JSON.stringify([
        {
          login: "random-bot[bot]",
          id: 402,
          body: "Suggestion",
          thumbs_up: 0,
        },
      ]);
    }
    return "[]";
  };

  const options = makeBaseScanOptions({
    ghCommandFn: ghFn,
    isAuthorisedCommenter: () => false,
    trustedReviewBots: ["github-code-quality[bot]"],
  });

  const result = await findPrCommentsToFix(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

Deno.test("findPrCommentsToFix - trusted-bot review comment with eyes reaction is skipped as already-processed (Issue #1857)", async () => {
  // The fetchPrComments jq filter drops comments with reactions.eyes > 0,
  // so when GitHub returns a trusted-bot comment that has been seen, the
  // upstream fetch already excludes it. Mimic that here by returning an
  // empty list when the eyes filter is present, and assert no actionable
  // comment is found.
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 14, headRefName: "issue-14-fix", headRefOid: "sha14" },
      ]);
    }
    // Comment had an eyes reaction → fetchPrComments returns []
    return "[]";
  };

  const options = makeBaseScanOptions({
    ghCommandFn: ghFn,
    isAuthorisedCommenter: () => false,
    trustedReviewBots: ["github-code-quality[bot]"],
  });

  const result = await findPrCommentsToFix(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

// ============================================================================
// findFailedPrChecks (spelling)
// ============================================================================

Deno.test("findFailedPrChecks - finds spelling check failure", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 10, headRefName: "issue-10-fix" },
      ]);
    }
    if (key.includes("check-runs") && !key.includes("annotations")) {
      return JSON.stringify([
        { id: 100, name: "cspell", status: "completed", conclusion: "failure" },
        {
          id: 101,
          name: "CI / test",
          status: "completed",
          conclusion: "failure",
        },
      ]);
    }
    if (key.includes("annotations")) {
      return JSON.stringify([{ path: "a.ts", start_line: 1, message: "typo" }]);
    }
    return "[]";
  };

  const options = makeBaseScanOptions({ ghCommandFn: ghFn });
  const result = await findFailedPrChecks(options);
  assertEquals(result.ok, true);
  if (result.ok && result.value) {
    assertEquals(result.value.checkName, "cspell");
    assertEquals(result.value.prNumber, 10);
  }
});

Deno.test("findFailedPrChecks - returns null when no spelling checks fail", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 10, headRefName: "issue-10-fix" },
      ]);
    }
    if (key.includes("check-runs")) {
      return JSON.stringify([
        {
          id: 101,
          name: "CI / test",
          status: "completed",
          conclusion: "failure",
        },
      ]);
    }
    return "[]";
  };

  const options = makeBaseScanOptions({ ghCommandFn: ghFn });
  const result = await findFailedPrChecks(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, null);
  }
});

// ============================================================================
// findFailedCiChecks
// ============================================================================

Deno.test("findFailedCiChecks - finds CI failure excluding spelling", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("pr list")) {
        return JSON.stringify([
          { number: 10, headRefName: "issue-10-fix", baseRefName: "main" },
        ]);
      }
      if (key.includes("check-runs") && !key.includes("annotations")) {
        return JSON.stringify([
          {
            id: 100,
            name: "cspell",
            status: "completed",
            conclusion: "failure",
          },
          {
            id: 101,
            name: "CI / test",
            status: "completed",
            conclusion: "failure",
          },
        ]);
      }
      if (key.includes("annotations")) {
        return JSON.stringify([{
          path: "tests/test.ts",
          start_line: 5,
          message: "failed",
        }]);
      }
      return "[]";
    };

    const options: CiCheckScanOptions = {
      ...makeBaseScanOptions({ ghCommandFn: ghFn }),
      stateDir: `${tmpDir}/.ci_state`,
      maxRetries: 3,
    };

    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    if (result.ok && result.value) {
      assertEquals(result.value.checkName, "CI / test");
      assertEquals(result.value.prNumber, 10);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - prioritises default branch failures", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("pr list")) {
        return JSON.stringify([
          { number: 10, headRefName: "issue-10-fix", baseRefName: "develop" },
          { number: 20, headRefName: "issue-20-feat", baseRefName: "main" },
        ]);
      }
      if (key.includes("check-runs") && !key.includes("annotations")) {
        return JSON.stringify([
          {
            id: 200,
            name: "CI / build",
            status: "completed",
            conclusion: "failure",
          },
        ]);
      }
      if (key.includes("annotations")) {
        return "[]";
      }
      return "[]";
    };

    const options: CiCheckScanOptions = {
      ...makeBaseScanOptions({ ghCommandFn: ghFn }),
      stateDir: `${tmpDir}/.ci_state`,
      getDefaultBranch: () => Promise.resolve("main"),
    };

    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    if (result.ok && result.value) {
      // Should return the PR targeting main (default branch)
      assertEquals(result.value.prNumber, 20);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - skips checks exceeding max retries", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const stateDir = `${tmpDir}/.ci_state`;
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(`${stateDir}/org_repo_101.retries`, "3");

    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("pr list")) {
        return JSON.stringify([
          { number: 10, headRefName: "issue-10-fix", baseRefName: "main" },
        ]);
      }
      if (key.includes("check-runs") && !key.includes("annotations")) {
        return JSON.stringify([
          {
            id: 101,
            name: "CI / test",
            status: "completed",
            conclusion: "failure",
          },
        ]);
      }
      return "[]";
    };

    const options: CiCheckScanOptions = {
      ...makeBaseScanOptions({ ghCommandFn: ghFn }),
      stateDir,
      maxRetries: 3,
    };

    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, null);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// findFailedCiChecks — batched GraphQL (Issue #1806)
// ============================================================================

Deno.test("findFailedCiChecks - issues 1 GraphQL call for N PRs instead of N REST calls", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    let graphqlCalls = 0;
    let restCheckRunsCalls = 0;
    const ghFn = (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("pr list")) {
        return Promise.resolve(JSON.stringify([
          { number: 10, headRefName: "issue-10-a", baseRefName: "main" },
          { number: 20, headRefName: "issue-20-b", baseRefName: "main" },
          { number: 30, headRefName: "issue-30-c", baseRefName: "main" },
        ]));
      }
      if (args[0] === "api" && args[1] === "graphql") {
        graphqlCalls++;
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              n0: {
                commits: {
                  nodes: [{
                    commit: {
                      statusCheckRollup: {
                        state: "FAILURE",
                        contexts: {
                          nodes: [{
                            __typename: "CheckRun",
                            databaseId: 100,
                            name: "CI / build",
                            status: "COMPLETED",
                            conclusion: "FAILURE",
                          }],
                        },
                      },
                    },
                  }],
                },
              },
              n1: {
                commits: {
                  nodes: [{
                    commit: {
                      statusCheckRollup: {
                        state: "SUCCESS",
                        contexts: { nodes: [] },
                      },
                    },
                  }],
                },
              },
              n2: {
                commits: {
                  nodes: [{
                    commit: {
                      statusCheckRollup: {
                        state: "SUCCESS",
                        contexts: { nodes: [] },
                      },
                    },
                  }],
                },
              },
            },
          },
        }));
      }
      if (key.includes("check-runs") && !key.includes("annotations")) {
        restCheckRunsCalls++;
        return Promise.resolve("[]");
      }
      if (key.includes("annotations")) {
        return Promise.resolve("[]");
      }
      return Promise.resolve("[]");
    };

    const options: CiCheckScanOptions = {
      ...makeBaseScanOptions({ ghCommandFn: ghFn }),
      stateDir: `${tmpDir}/.ci_state`,
      maxRetries: 3,
    };

    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    if (result.ok && result.value) {
      assertEquals(result.value.prNumber, 10);
      assertEquals(result.value.checkName, "CI / build");
    }
    // Exactly one GraphQL call covers all 3 PRs — REST check-runs path skipped
    assertEquals(graphqlCalls, 1);
    assertEquals(restCheckRunsCalls, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("findFailedCiChecks - falls back to per-PR REST when GraphQL fails", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    let graphqlCalls = 0;
    let restCheckRunsCalls = 0;
    const ghFn = (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("pr list")) {
        return Promise.resolve(JSON.stringify([
          { number: 10, headRefName: "issue-10-a", baseRefName: "main" },
        ]));
      }
      if (args[0] === "api" && args[1] === "graphql") {
        graphqlCalls++;
        return Promise.reject(new Error("graphql down"));
      }
      if (key.includes("check-runs") && !key.includes("annotations")) {
        restCheckRunsCalls++;
        return Promise.resolve(JSON.stringify([
          {
            id: 101,
            name: "CI / test",
            status: "completed",
            conclusion: "failure",
          },
        ]));
      }
      if (key.includes("annotations")) {
        return Promise.resolve("[]");
      }
      return Promise.resolve("[]");
    };

    const options: CiCheckScanOptions = {
      ...makeBaseScanOptions({ ghCommandFn: ghFn }),
      stateDir: `${tmpDir}/.ci_state`,
      maxRetries: 3,
    };

    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    if (result.ok && result.value) {
      assertEquals(result.value.checkName, "CI / test");
    }
    assertEquals(graphqlCalls, 1);
    assertEquals(restCheckRunsCalls, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// ensureAutoMergeOnOpenPrs
// ============================================================================

Deno.test("ensureAutoMergeOnOpenPrs - enables auto-merge on PRs", async () => {
  const enabledPrs: number[] = [];
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 10, headRefName: "issue-10-fix", autoMergeRequest: null },
        {
          number: 20,
          headRefName: "issue-20-feat",
          autoMergeRequest: { mergeMethod: "SQUASH" },
        },
      ]);
    }
    return "[]";
  };

  const options: AutoMergeOptions = {
    ...makeBaseScanOptions({ ghCommandFn: ghFn }),
    getRepoConfig: () => "",
    enableAutoMergeFn: async (_repo: string, prNumber: number) => {
      enabledPrs.push(prNumber);
      return { result: "enabled", message: "OK" };
    },
  };

  const result = await ensureAutoMergeOnOpenPrs(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.enabledCount, 1);
    assertEquals(result.value.skippedCount, 1);
    assertEquals(enabledPrs, [10]);
  }
});

Deno.test("ensureAutoMergeOnOpenPrs - skips when skip_auto_merge configured", async () => {
  const options: AutoMergeOptions = {
    ...makeBaseScanOptions(),
    getRepoConfig: (_repo: string, key: string) =>
      key === "skip_auto_merge" ? "true" : "",
    enableAutoMergeFn: async () => ({ result: "enabled", message: "OK" }),
  };

  const result = await ensureAutoMergeOnOpenPrs(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.enabledCount, 0);
  }
});

Deno.test("ensureAutoMergeOnOpenPrs - skips when needs-screenshot label present", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 10, headRefName: "issue-42-fix", autoMergeRequest: null },
      ]);
    }
    if (key.includes("issue view")) {
      return "needs-screenshot,enhancement";
    }
    return "[]";
  };

  const options: AutoMergeOptions = {
    ...makeBaseScanOptions({ ghCommandFn: ghFn }),
    getRepoConfig: () => "",
    enableAutoMergeFn: async () => ({ result: "enabled", message: "OK" }),
  };

  const result = await ensureAutoMergeOnOpenPrs(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.enabledCount, 0);
    assertEquals(result.value.skippedCount, 1);
  }
});

// ----------------------------------------------------------------------------
// ensureAutoMergeOnOpenPrs — loud merge failures (Issue #3584)
// ----------------------------------------------------------------------------

/** gh stub returning a single open worker PR without auto-merge armed. */
function singleOpenPrGh(
  extra?: Record<string, string>,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: 10, headRefName: "issue-10-fix", autoMergeRequest: null },
      ]));
    }
    for (const [pattern, response] of Object.entries(extra ?? {})) {
      if (key.includes(pattern)) return Promise.resolve(response);
    }
    return Promise.resolve("[]");
  };
}

Deno.test("ensureAutoMergeOnOpenPrs - a merge that cannot be arranged escalates, never silence", async () => {
  const handled: MergeAttemptOutcome[] = [];
  const options: AutoMergeOptions = {
    ...makeBaseScanOptions({ ghCommandFn: singleOpenPrGh() }),
    getRepoConfig: () => "",
    enableAutoMergeFn: () =>
      Promise.resolve({
        result: "not_enabled_on_repo",
        message: "Auto-merge is not enabled on this repository",
      }),
    handleMergeAttemptFn: (opts) => {
      handled.push(opts.outcome);
      return Promise.resolve({
        disposition: "escalate",
        branchUpdateRequested: false,
        escalated: true,
      });
    },
  };

  const result = await ensureAutoMergeOnOpenPrs(options);
  assertEquals(result.ok, true);
  assertEquals(handled.length, 1);
  assertEquals(handled[0]!.kind, "merge_error");
  if (result.ok) {
    assertEquals(result.value.failedCount, 1);
    assertEquals(result.value.enabledCount, 0);
  }
});

Deno.test("ensureAutoMergeOnOpenPrs - a thrown auto-merge error becomes a loud merge error", async () => {
  const handled: MergeAttemptOutcome[] = [];
  const options: AutoMergeOptions = {
    ...makeBaseScanOptions({ ghCommandFn: singleOpenPrGh() }),
    getRepoConfig: () => "",
    enableAutoMergeFn: () => {
      throw new Error("HTTP 500 from GitHub");
    },
    handleMergeAttemptFn: (opts) => {
      handled.push(opts.outcome);
      return Promise.resolve({
        disposition: "escalate",
        branchUpdateRequested: false,
        escalated: true,
      });
    },
  };

  const result = await ensureAutoMergeOnOpenPrs(options);
  assertEquals(result.ok, true);
  assertEquals(handled.length, 1);
  assertEquals(handled[0], {
    kind: "merge_error",
    message: "HTTP 500 from GitHub",
  });
});

Deno.test("ensureAutoMergeOnOpenPrs - a stale-base direct merge is deferred, not counted as landed", async () => {
  const handled: MergeAttemptOutcome[] = [];
  const options: AutoMergeOptions = {
    ...makeBaseScanOptions({ ghCommandFn: singleOpenPrGh() }),
    getRepoConfig: () => "",
    enableAutoMergeFn: () =>
      Promise.resolve({ result: "not_allowed", message: "not allowed" }),
    directMergeFn: () =>
      Promise.resolve({ kind: "behind_target" } as MergeAttemptOutcome),
    handleMergeAttemptFn: (opts) => {
      handled.push(opts.outcome);
      return Promise.resolve({
        disposition: "update_branch",
        branchUpdateRequested: true,
        escalated: false,
      });
    },
  };

  const result = await ensureAutoMergeOnOpenPrs(options);
  assertEquals(result.ok, true);
  assertEquals(handled, [{ kind: "behind_target" }]);
  if (result.ok) {
    assertEquals(result.value.enabledCount, 0);
    assertEquals(result.value.failedCount, 0);
    assertEquals(result.value.skippedCount, 1);
  }
});

Deno.test("ensureAutoMergeOnOpenPrs - pending checks are deferred without escalation", async () => {
  const options: AutoMergeOptions = {
    ...makeBaseScanOptions({ ghCommandFn: singleOpenPrGh() }),
    getRepoConfig: () => "",
    enableAutoMergeFn: () =>
      Promise.resolve({ result: "not_allowed", message: "not allowed" }),
    directMergeFn: () =>
      Promise.resolve({ kind: "checks_pending" } as MergeAttemptOutcome),
    // Real handler — asserts the classification, not a stub's opinion.
    handleMergeAttemptFn: undefined,
  };

  const result = await ensureAutoMergeOnOpenPrs(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.enabledCount, 0);
    assertEquals(result.value.failedCount, 0);
    assertEquals(result.value.skippedCount, 1);
  }
});

Deno.test("ensureAutoMergeOnOpenPrs - a PR with requested reviewers still merges (review is informational)", async () => {
  const armed: number[] = [];
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        {
          number: 10,
          headRefName: "issue-10-fix",
          autoMergeRequest: null,
          reviewRequests: [{ login: "a-human" }],
        },
      ]));
    }
    return Promise.resolve("[]");
  };

  const options: AutoMergeOptions = {
    ...makeBaseScanOptions({ ghCommandFn: ghFn }),
    getRepoConfig: () => "",
    enableAutoMergeFn: (_repo: string, prNumber: number) => {
      armed.push(prNumber);
      return Promise.resolve({ result: "enabled", message: "OK" });
    },
  };

  const result = await ensureAutoMergeOnOpenPrs(options);
  assertEquals(result.ok, true);
  assertEquals(armed, [10]);
  if (result.ok) {
    assertEquals(result.value.enabledCount, 1);
  }
});

// ============================================================================
// closeIssuesForMergedPrs
// ============================================================================

Deno.test("closeIssuesForMergedPrs - closes open issues for merged PRs", async () => {
  const closedIssues: string[] = [];
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 100, title: "Fix login bug (Issue #50)" },
      ]);
    }
    if (key.includes("issue view")) {
      return "OPEN";
    }
    if (key.includes("issue close")) {
      closedIssues.push(args[2]!); // issue number
      return "";
    }
    return "[]";
  };

  const options: CloseIssuesOptions = {
    verifyMergeLandedFn: alwaysLanded, // Issue #4396: landing has its own tests
    ...makeBaseScanOptions({ ghCommandFn: ghFn }),
    extractIssueNumber: (title: string) => {
      const match = title.match(/Issue #(\d+)/);
      return match ? match[1]! : null;
    },
  };

  const result = await closeIssuesForMergedPrs(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.closedCount, 1);
    assertEquals(closedIssues, ["50"]);
  }
});

Deno.test("closeIssuesForMergedPrs - skips already closed issues", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 100, title: "Fix (Issue #50)" },
      ]);
    }
    if (key.includes("issue view")) {
      return "CLOSED";
    }
    return "[]";
  };

  const options: CloseIssuesOptions = {
    verifyMergeLandedFn: alwaysLanded, // Issue #4396: landing has its own tests
    ...makeBaseScanOptions({ ghCommandFn: ghFn }),
    extractIssueNumber: (title: string) => {
      const match = title.match(/Issue #(\d+)/);
      return match ? match[1]! : null;
    },
  };

  const result = await closeIssuesForMergedPrs(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.closedCount, 0);
  }
});

Deno.test("closeIssuesForMergedPrs - skips when no issue number in title", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return JSON.stringify([
        { number: 100, title: "Random PR without issue reference" },
      ]);
    }
    return "[]";
  };

  const options: CloseIssuesOptions = {
    verifyMergeLandedFn: alwaysLanded, // Issue #4396: landing has its own tests
    ...makeBaseScanOptions({ ghCommandFn: ghFn }),
    extractIssueNumber: () => null,
  };

  const result = await closeIssuesForMergedPrs(options);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.closedCount, 0);
  }
});

// ============================================================================
// findFailedCiChecks — green build clears the auto-fix budget (Issue #3582)
// ============================================================================

Deno.test("findFailedCiChecks - a green PR clears its auto-fix attempt counters", async () => {
  const tmpDir = await Deno.makeTempDir();
  const stateDir = `${tmpDir}/.ci_state`;
  try {
    const signature = computeFailureSignature({
      repo: "org/repo",
      locus: { kind: "pr", number: 10 },
      checkName: "CI / test",
      logExcerpt: "error: cannot find symbol",
    });
    await recordAutoFixAttempt(stateDir, signature, {
      repo: "org/repo",
      locus: { kind: "pr", number: 10 },
      checkName: "CI / test",
      diagnosis: "missing import",
      change: "added import",
      outcome: "still red",
    });
    assertEquals((await getAutoFixAttempts(stateDir, signature)).length, 1);

    // The PR now has no failing checks — the build is green.
    const ghFn = (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes("pr list")) {
        return Promise.resolve(JSON.stringify([
          { number: 10, headRefName: "issue-10-fix", baseRefName: "main" },
        ]));
      }
      return Promise.resolve("[]");
    };

    const options: CiCheckScanOptions = {
      ...makeBaseScanOptions({ ghCommandFn: ghFn }),
      stateDir,
      maxRetries: 3,
    };

    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    assertEquals(await getAutoFixAttempts(stateDir, signature), []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Fleet-author scoping of the maintenance scans
//
// Two behaviours are locked in together:
//   - sibling rescue (#3138/#4023): a PR authored by a sibling fleet host
//     (`fleet_pr_authors`) is still scanned by every host; and
//   - human-PR safety (#4074/#4076): a PR authored by a trusted human
//     (`allowed_authors`) is never queried, never returned, and never
//     written to — the TitlePage/tp-web-react#2312 regression.
// ============================================================================

/** Host login and fleet configuration used by the scoping cases. */
const HOST = "VibeCoderBot";
/** Sibling fleet host (`fleet_pr_authors`) — its PRs must still be rescued. */
const FLEET_MEMBER = "maintainer";
/** Trusted human (`allowed_authors`) — their PRs must never be adopted. */
const HUMAN_AUTHOR = "courtyen";
/** The human's PR number, mirroring TitlePage/tp-web-react#2312. */
const HUMAN_PR = 2312;

/**
 * Build a `gh` stub serving one sibling-fleet PR (#103) and one
 * human-authored PR (#2312).
 *
 * Each PR is returned only for its own `--author` query, so a scan scoped
 * to the push-capable maintenance set never sees the human's PR at all.
 * Every call is handed to `capture` so a test can assert nothing was ever
 * issued against the human PR.
 */
function makeFleetAuthoredPrGh(
  extras: Record<string, string> = {},
  capture?: (args: string[]) => void,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    capture?.(args);
    const key = args.join(" ");
    if (key.includes("pr list")) {
      if (key.includes(`--author ${FLEET_MEMBER}`)) {
        return Promise.resolve(JSON.stringify([
          {
            number: 103,
            headRefName: "milestone/69-cache",
            headRefOid: "sha103",
            baseRefName: "main",
            autoMergeRequest: null,
          },
        ]));
      }
      if (key.includes(`--author ${HUMAN_AUTHOR}`)) {
        return Promise.resolve(JSON.stringify([
          {
            number: HUMAN_PR,
            headRefName: "courtyen/hand-written-fix",
            headRefOid: "sha2312",
            baseRefName: "main",
            autoMergeRequest: null,
          },
        ]));
      }
      return Promise.resolve("[]");
    }
    for (const [pattern, response] of Object.entries(extras)) {
      if (key.includes(pattern)) return Promise.resolve(response);
    }
    return Promise.resolve("[]");
  };
}

/**
 * Whether a captured `gh` call is the *invitation* listing (Issue #4077).
 *
 * Both listings are `gh pr list --author …`; only the invitation listing
 * asks for the fields the invitation predicate needs, so the `--json`
 * argument tells them apart.
 */
function isInvitationListing(call: string[]): boolean {
  if (call[0] !== "pr" || call[1] !== "list") return false;
  const json = call[call.indexOf("--json") + 1] ?? "";
  return INVITATION_PR_FIELDS.every((field) => json.split(",").includes(field));
}

/** The `--author` value of a `pr list` call, when it has one. */
function authorOf(call: string[]): string | undefined {
  const idx = call.indexOf("--author");
  return idx >= 0 ? call[idx + 1] : undefined;
}

/**
 * The `--author` values a run of captured `gh` calls asked the
 * **maintenance** listing for.
 *
 * Issue #4077 added a second, separately-asserted listing for invited
 * human PRs, so this helper excludes it — a human login reaching the
 * maintenance listing is still the #4074 regression.
 */
function authorsQueried(calls: string[][]): string[] {
  return calls
    .filter((c) => c[0] === "pr" && c[1] === "list" && !isInvitationListing(c))
    .map((c) => authorOf(c))
    .filter((a): a is string => typeof a === "string");
}

/** The `--author` values the invitation listing asked for (Issue #4077). */
function invitationAuthorsQueried(calls: string[][]): string[] {
  return calls
    .filter(isInvitationListing)
    .map((c) => authorOf(c))
    .filter((a): a is string => typeof a === "string");
}

/**
 * Every captured `gh` call that mentions the human PR.
 *
 * All GitHub access — reads and writes alike — goes through the injected
 * runner, so an empty result proves no comment, label, reaction, merge or
 * push was issued against that PR.
 */
function callsMentioningHumanPr(calls: string[][]): string[] {
  return calls
    .map((c) => c.join(" "))
    .filter((key) => key.includes(String(HUMAN_PR)));
}

Deno.test("findPrCommentsToFix - sees a sibling fleet host's PR, never the human's (Issues #4023/#4076)", async () => {
  const calls: string[][] = [];
  const ghFn = makeFleetAuthoredPrGh({
    "issues/103/comments": JSON.stringify([
      {
        login: "reviewer",
        id: 900,
        body: "Please fix quality issues",
        thumbs_up: 0,
      },
    ]),
    [`issues/${HUMAN_PR}/comments`]: JSON.stringify([
      { login: "reviewer", id: 999, body: "Please fix CI", thumbs_up: 0 },
    ]),
  }, (args) => calls.push(args));

  const result = await findPrCommentsToFix(makeBaseScanOptions({
    githubUser: HOST,
    prAuthors: [FLEET_MEMBER],
    allowedAuthors: [HUMAN_AUTHOR],
    ghCommandFn: ghFn,
    isAuthorisedCommenter: (author: string) => author === "reviewer",
  }));

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value?.prNumber, 103);
    assertEquals(result.value?.commentId, "900");
  }
  assertEquals(authorsQueried(calls), [HOST, FLEET_MEMBER]);
  assertEquals(callsMentioningHumanPr(calls), []);
  // Issue #4077: the human is asked about *only* through the invitation
  // listing, and — carrying no invitation — is admitted by neither.
  assertEquals(invitationAuthorsQueried(calls), [HUMAN_AUTHOR]);
});

Deno.test("findFailedCiChecks - sees a sibling fleet host's PR, never the human's (Issues #4023/#4076)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const calls: string[][] = [];
    const ghFn = makeFleetAuthoredPrGh({
      "check-runs": JSON.stringify([
        {
          id: 300,
          name: "Quality Checks",
          status: "completed",
          conclusion: "failure",
        },
      ]),
      annotations: JSON.stringify([
        { path: "src/lib.rs", start_line: 1, message: "clippy" },
      ]),
    }, (args) => calls.push(args));

    const options: CiCheckScanOptions = {
      ...makeBaseScanOptions({
        githubUser: HOST,
        prAuthors: [FLEET_MEMBER],
        allowedAuthors: [HUMAN_AUTHOR],
        ghCommandFn: ghFn,
      }),
      stateDir: `${tmpDir}/.ci_state`,
      maxRetries: 3,
    };

    const result = await findFailedCiChecks(options);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value?.prNumber, 103);
      assertEquals(result.value?.checkName, "Quality Checks");
    }
    assertEquals(authorsQueried(calls), [HOST, FLEET_MEMBER]);
    assertEquals(callsMentioningHumanPr(calls), []);
    assertEquals(invitationAuthorsQueried(calls), [HUMAN_AUTHOR]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("findFailedPrChecks - sees a sibling fleet host's PR, never the human's (Issues #4023/#4076)", async () => {
  const calls: string[][] = [];
  const ghFn = makeFleetAuthoredPrGh({
    "check-runs": JSON.stringify([
      { id: 400, name: "cspell", status: "completed", conclusion: "failure" },
    ]),
    annotations: JSON.stringify([{
      path: "a.ts",
      start_line: 1,
      message: "typo",
    }]),
  }, (args) => calls.push(args));

  const result = await findFailedPrChecks(makeBaseScanOptions({
    githubUser: HOST,
    prAuthors: [FLEET_MEMBER],
    allowedAuthors: [HUMAN_AUTHOR],
    ghCommandFn: ghFn,
  }));

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value?.prNumber, 103);
    assertEquals(result.value?.checkName, "cspell");
  }
  assertEquals(authorsQueried(calls), [HOST, FLEET_MEMBER]);
  assertEquals(callsMentioningHumanPr(calls), []);
  // Issue #4077: the human is asked about *only* through the invitation
  // listing, and — carrying no invitation — is admitted by neither.
  assertEquals(invitationAuthorsQueried(calls), [HUMAN_AUTHOR]);
});

Deno.test("ensureAutoMergeOnOpenPrs - covers a sibling fleet host's PR, never the human's (Issues #4023/#4076)", async () => {
  const enabledPrs: number[] = [];
  const calls: string[][] = [];
  const options: AutoMergeOptions = {
    ...makeBaseScanOptions({
      githubUser: HOST,
      prAuthors: [FLEET_MEMBER],
      allowedAuthors: [HUMAN_AUTHOR],
      ghCommandFn: makeFleetAuthoredPrGh({}, (args) => calls.push(args)),
    }),
    getRepoConfig: () => "",
    enableAutoMergeFn: (_repo: string, prNumber: number) => {
      enabledPrs.push(prNumber);
      return Promise.resolve({ result: "enabled", message: "OK" });
    },
  };

  const result = await ensureAutoMergeOnOpenPrs(options);
  assertEquals(result.ok, true);
  assertEquals(enabledPrs, [103]);
  assertEquals(authorsQueried(calls), [HOST, FLEET_MEMBER]);
  assertEquals(callsMentioningHumanPr(calls), []);
  // Issue #4077: the human is asked about *only* through the invitation
  // listing, and — carrying no invitation — is admitted by neither.
  assertEquals(invitationAuthorsQueried(calls), [HUMAN_AUTHOR]);
});

Deno.test("PR maintenance author set equals the push-capable maintenance set for the same inputs (Issues #4075/#4076)", async () => {
  const allowedAuthors = [HUMAN_AUTHOR, "  ", HOST];
  const prAuthors = ["stsvcbot", FLEET_MEMBER];
  // Issue #4076: the scans act on PRs, so they resolve through the
  // push-capable set — `allowed_authors` humans are never queried.
  const expected = resolveFleetMaintenanceAuthorSet({
    githubUser: HOST,
    allowedAuthors,
    fleetPrAuthors: prAuthors,
  });
  assertEquals(expected.includes(HUMAN_AUTHOR), false);

  const collect = async (
    run: (capture: (args: string[]) => void) => Promise<unknown>,
  ): Promise<string[]> => {
    const calls: string[][] = [];
    await run((args) => calls.push(args));
    // Issue #4077: the invitation listing is asserted separately below.
    return authorsQueried(calls);
  };

  const makeGh = (capture: (args: string[]) => void) => (args: string[]) => {
    capture(args);
    return Promise.resolve("[]");
  };

  const commentAuthors = await collect((capture) =>
    findPrCommentsToFix(makeBaseScanOptions({
      githubUser: HOST,
      allowedAuthors,
      prAuthors,
      ghCommandFn: makeGh(capture),
    }))
  );
  assertEquals(commentAuthors, expected);

  const spellingAuthors = await collect((capture) =>
    findFailedPrChecks(makeBaseScanOptions({
      githubUser: HOST,
      allowedAuthors,
      prAuthors,
      ghCommandFn: makeGh(capture),
    }))
  );
  assertEquals(spellingAuthors, expected);

  const tmpDir = await Deno.makeTempDir();
  try {
    const ciAuthors = await collect((capture) =>
      findFailedCiChecks({
        ...makeBaseScanOptions({
          githubUser: HOST,
          allowedAuthors,
          prAuthors,
          ghCommandFn: makeGh(capture),
        }),
        stateDir: `${tmpDir}/.ci_state`,
      })
    );
    assertEquals(ciAuthors, expected);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }

  const autoMergeAuthors = await collect((capture) =>
    ensureAutoMergeOnOpenPrs({
      ...makeBaseScanOptions({
        githubUser: HOST,
        allowedAuthors,
        prAuthors,
        ghCommandFn: makeGh(capture),
      }),
      getRepoConfig: () => "",
      enableAutoMergeFn: () =>
        Promise.resolve({ result: "enabled", message: "OK" }),
    })
  );
  assertEquals(autoMergeAuthors, expected);
});

// ============================================================================
// Explicit invitation onto a human-authored PR (Issue #4077)
//
// The scans admit a human's PR only when that human handed it over — with
// the invite label or an @mention. Uninvited human PRs stay untouched (the
// #4074 regression case, covered by the four scoping tests above).
// ============================================================================

/** The invite label reused as the hand-over signal. */
const INVITE_LABEL = "work-on";

interface InvitedPrFixture {
  /** Labels returned by the invitation listing. */
  labels?: Array<{ name: string }>;
  /** Login the timeline reports as the most recent label adder. */
  labelledBy?: string;
  /** Comments returned by the invitation listing. */
  comments?: Array<{ author: { login: string }; body: string }>;
}

/**
 * Build a `gh` stub whose only open PR is the human's #2312.
 *
 * The maintenance listing (host / fleet authors) returns nothing; the
 * invitation listing returns the human's PR carrying `fixture`, and the
 * timeline answers the label-authorship check.
 */
function makeInvitedPrGh(
  fixture: InvitedPrFixture,
  extras: Record<string, string> = {},
  capture?: (args: string[]) => void,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    capture?.(args);
    const key = args.join(" ");
    if (key.includes("pr list")) {
      if (!key.includes(`--author ${HUMAN_AUTHOR}`)) {
        return Promise.resolve("[]");
      }
      return Promise.resolve(JSON.stringify([
        {
          number: HUMAN_PR,
          headRefName: "courtyen/hand-written-fix",
          headRefOid: "sha2312",
          baseRefName: "main",
          autoMergeRequest: null,
          author: { login: HUMAN_AUTHOR },
          labels: fixture.labels ?? [],
          comments: fixture.comments ?? [],
          reviews: [],
        },
      ]));
    }
    if (key.includes("timeline")) {
      const events = fixture.labelledBy === undefined ? [] : [{
        event: "labeled",
        label: { name: INVITE_LABEL },
        actor: { login: fixture.labelledBy },
        created_at: "2026-05-18T00:00:00Z",
      }];
      return Promise.resolve(JSON.stringify(events));
    }
    for (const [pattern, response] of Object.entries(extras)) {
      if (key.includes(pattern)) return Promise.resolve(response);
    }
    return Promise.resolve("[]");
  };
}

/**
 * A logger that records the invitation lines only — every admission of a
 * human PR must be traceable to its cause in the ordinary worker log.
 */
function makeRecordingLogger(lines: string[]): Logger {
  return {
    ...makeSilentLogger(),
    info: (message: string) => {
      if (message.startsWith("[pr-invitation]")) lines.push(message);
    },
  };
}

Deno.test("findPrCommentsToFix - admits a human PR the author labelled, and logs why (Issue #4077)", async () => {
  const lines: string[] = [];
  const ghFn = makeInvitedPrGh(
    { labels: [{ name: INVITE_LABEL }], labelledBy: HUMAN_AUTHOR },
    {
      [`issues/${HUMAN_PR}/comments`]: JSON.stringify([
        { login: "reviewer", id: 999, body: "Please fix CI", thumbs_up: 0 },
      ]),
    },
  );

  const result = await findPrCommentsToFix(makeBaseScanOptions({
    githubUser: HOST,
    prAuthors: [FLEET_MEMBER],
    allowedAuthors: [HUMAN_AUTHOR],
    logger: makeRecordingLogger(lines),
    ghCommandFn: ghFn,
    isAuthorisedCommenter: (author: string) => author === "reviewer",
  }));

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value?.prNumber, HUMAN_PR);
  assertEquals(lines, [
    `[pr-invitation] admitted repo=org/repo prNumber=${HUMAN_PR} ` +
    `author=${HUMAN_AUTHOR} via=label invitedBy=${HUMAN_AUTHOR}`,
  ]);
});

Deno.test("findPrCommentsToFix - an untrusted actor's label does not admit the PR (Issue #4077)", async () => {
  const lines: string[] = [];
  const ghFn = makeInvitedPrGh(
    { labels: [{ name: INVITE_LABEL }], labelledBy: "drive-by" },
    {
      [`issues/${HUMAN_PR}/comments`]: JSON.stringify([
        { login: "reviewer", id: 999, body: "Please fix CI", thumbs_up: 0 },
      ]),
    },
  );

  const result = await findPrCommentsToFix(makeBaseScanOptions({
    githubUser: HOST,
    prAuthors: [FLEET_MEMBER],
    allowedAuthors: [HUMAN_AUTHOR],
    logger: makeRecordingLogger(lines),
    ghCommandFn: ghFn,
    isAuthorisedCommenter: () => true,
  }));

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
  assertEquals(lines, []);
});

Deno.test("findPrCommentsToFix - the label alone, with no verifiable adder, does not admit (Issue #4077)", async () => {
  const ghFn = makeInvitedPrGh({ labels: [{ name: INVITE_LABEL }] }, {
    [`issues/${HUMAN_PR}/comments`]: JSON.stringify([
      { login: "reviewer", id: 999, body: "Please fix CI", thumbs_up: 0 },
    ]),
  });

  const result = await findPrCommentsToFix(makeBaseScanOptions({
    githubUser: HOST,
    allowedAuthors: [HUMAN_AUTHOR],
    ghCommandFn: ghFn,
    isAuthorisedCommenter: () => true,
  }));

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
});

Deno.test("findPrCommentsToFix - the label removed since the last scan revokes admission (Issue #4077)", async () => {
  const extras = {
    [`issues/${HUMAN_PR}/comments`]: JSON.stringify([
      { login: "reviewer", id: 999, body: "Please fix CI", thumbs_up: 0 },
    ]),
  };
  const options = (ghFn: (args: string[]) => Promise<string>) =>
    makeBaseScanOptions({
      githubUser: HOST,
      allowedAuthors: [HUMAN_AUTHOR],
      ghCommandFn: ghFn,
      isAuthorisedCommenter: (author: string) => author === "reviewer",
    });

  const admitted = await findPrCommentsToFix(options(
    makeInvitedPrGh(
      { labels: [{ name: INVITE_LABEL }], labelledBy: HUMAN_AUTHOR },
      extras,
    ),
  ));
  assertEquals(admitted.ok && admitted.value?.prNumber, HUMAN_PR);

  // Next scan: the human has dropped the label. The timeline still carries
  // the old `labeled` event, so only the current label set can revoke.
  const revoked = await findPrCommentsToFix(options(
    makeInvitedPrGh({ labels: [], labelledBy: HUMAN_AUTHOR }, extras),
  ));
  assertEquals(revoked.ok, true);
  if (revoked.ok) assertEquals(revoked.value, null);
});

Deno.test("ensureAutoMergeOnOpenPrs - admits a human PR whose author @mentioned the worker (Issue #4077)", async () => {
  const enabledPrs: number[] = [];
  const lines: string[] = [];
  const result = await ensureAutoMergeOnOpenPrs({
    ...makeBaseScanOptions({
      githubUser: HOST,
      prAuthors: [FLEET_MEMBER],
      allowedAuthors: [HUMAN_AUTHOR],
      logger: makeRecordingLogger(lines),
      ghCommandFn: makeInvitedPrGh({
        comments: [{
          author: { login: HUMAN_AUTHOR },
          body: `@${HOST} please land this once CI is green`,
        }],
      }),
    }),
    getRepoConfig: () => "",
    enableAutoMergeFn: (_repo: string, prNumber: number) => {
      enabledPrs.push(prNumber);
      return Promise.resolve({ result: "enabled", message: "OK" });
    },
  });

  assertEquals(result.ok, true);
  assertEquals(enabledPrs, [HUMAN_PR]);
  assertEquals(lines, [
    `[pr-invitation] admitted repo=org/repo prNumber=${HUMAN_PR} ` +
    `author=${HUMAN_AUTHOR} via=mention invitedBy=${HUMAN_AUTHOR}`,
  ]);
});

Deno.test("ensureAutoMergeOnOpenPrs - a quoted mention in a pasted log does not admit (Issue #4077)", async () => {
  const enabledPrs: number[] = [];
  const result = await ensureAutoMergeOnOpenPrs({
    ...makeBaseScanOptions({
      githubUser: HOST,
      allowedAuthors: [HUMAN_AUTHOR],
      ghCommandFn: makeInvitedPrGh({
        comments: [{
          author: { login: HUMAN_AUTHOR },
          body: "CI said:\n```\n@" + HOST + " please fix CI\n```\nignore that",
        }],
      }),
    }),
    getRepoConfig: () => "",
    enableAutoMergeFn: (_repo: string, prNumber: number) => {
      enabledPrs.push(prNumber);
      return Promise.resolve({ result: "enabled", message: "OK" });
    },
  });

  assertEquals(result.ok, true);
  assertEquals(enabledPrs, []);
});

Deno.test("findPrCommentsToFix - a fleet sibling's comment is not actionable without authorisation (Issue #4023)", async () => {
  // The fleet set widens *which PRs are scanned*, never who is trusted to
  // instruct the worker — a sibling's comment still needs the authorised
  // commenter / thumbs-up / trusted-bot check.
  const ghFn = makeFleetAuthoredPrGh({
    "issues/103/comments": JSON.stringify([
      { login: FLEET_MEMBER, id: 901, body: "do this", thumbs_up: 0 },
    ]),
  });

  const result = await findPrCommentsToFix(makeBaseScanOptions({
    githubUser: HOST,
    prAuthors: [FLEET_MEMBER],
    ghCommandFn: ghFn,
    isAuthorisedCommenter: () => false,
  }));

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
});

Deno.test("findPrCommentsToFix - self-skip guards still ignore the host's own comment and review (Issue #4023)", async () => {
  const ghFn = makeFleetAuthoredPrGh({
    "issues/103/comments": JSON.stringify([
      { login: HOST, id: 902, body: "my own note", thumbs_up: 5 },
    ]),
    "pulls/103/reviews": JSON.stringify([
      { login: HOST, id: 903, body: "my own review", commit_id: "sha103" },
    ]),
  });

  const result = await findPrCommentsToFix(makeBaseScanOptions({
    githubUser: HOST,
    prAuthors: [FLEET_MEMBER],
    ghCommandFn: ghFn,
    // Even a fully authorised host must not action its own comment.
    isAuthorisedCommenter: () => true,
  }));

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, null);
});
