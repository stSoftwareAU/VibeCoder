/**
 * Tests for label_manager.ts — GitHub label management, failure handling,
 * clarification workflows, and planning escalation (Issue #911).
 *
 * Uses injectable gh command function for testability.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  addLabelToIssue,
  buildQuestionFailureComment,
  checkAndHealPlanningEscalation,
  checkIssueHasFailedOnce,
  countClarificationRounds,
  DEFAULT_LABEL_CONFIG,
  detectPlanningEscalationInComments,
  ensureLabelExists,
  escalateToPlanning,
  getQuestionFailureReason,
  handleIssueFailure,
  handleQuestionFailure,
  labelCacheFilePath,
  labelCacheInvalidate,
  labelCacheIsValid,
  markIssueAsFailed,
  markIssueAsFailedOnce,
  PLANNING_ESCALATION_HEADINGS,
  postClarifyingQuestions,
  validateClarifyingQuestions,
} from "../lib/label_manager.ts";
import { ghClientFromCommandFn } from "../lib/label_clarification.ts";
import { buildDedupMarker } from "../lib/needs_human_escalation.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";
import type { GitHubClient } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "lm-test-" });
}

/** Check if a specific pattern was called. */
function wasCalledWith(calls: string[][], pattern: string): boolean {
  return calls.some((call) => call.join(" ").includes(pattern));
}

/** Create mock gh that records calls. */
function createMockGh(responses: Record<string, string | Error> = {}) {
  const calls: string[][] = [];

  const ghCommandFn = async (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    for (const [pattern, response] of Object.entries(responses)) {
      if (joined.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    return "";
  };

  return { ghCommandFn, calls };
}

// ---------------------------------------------------------------------------
// Label Cache
// ---------------------------------------------------------------------------

Deno.test("label manager - labelCacheFilePath generates correct path", () => {
  const path = labelCacheFilePath("/tmp/cache", "org/repo");
  assertEquals(path, "/tmp/cache/org_repo.cache");
});

Deno.test("label manager - labelCacheIsValid returns false for missing file", async () => {
  const dir = await makeTempDir();
  try {
    const valid = await labelCacheIsValid(dir, "org/repo", 3600);
    assertEquals(valid, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - labelCacheIsValid returns true for fresh cache", async () => {
  const dir = await makeTempDir();
  try {
    const cachePath = labelCacheFilePath(dir, "org/repo");
    const now = Math.floor(Date.now() / 1000);
    await Deno.writeTextFile(cachePath, `${now}\nbug\nfeature\n`);
    const valid = await labelCacheIsValid(dir, "org/repo", 3600);
    assertEquals(valid, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - labelCacheIsValid returns false for stale cache", async () => {
  const dir = await makeTempDir();
  try {
    const cachePath = labelCacheFilePath(dir, "org/repo");
    const staleTime = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
    await Deno.writeTextFile(cachePath, `${staleTime}\nbug\nfeature\n`);
    const valid = await labelCacheIsValid(dir, "org/repo", 3600);
    assertEquals(valid, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - labelCacheInvalidate removes cache file", async () => {
  const dir = await makeTempDir();
  try {
    const cachePath = labelCacheFilePath(dir, "org/repo");
    await Deno.writeTextFile(cachePath, "12345\nbug\n");
    await labelCacheInvalidate(dir, "org/repo");
    try {
      await Deno.stat(cachePath);
      assertEquals(true, false, "Cache file should be removed");
    } catch (e) {
      assertEquals((e as Deno.errors.NotFound).name, "NotFound");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - labelCacheInvalidate succeeds for missing file", async () => {
  const dir = await makeTempDir();
  try {
    // Should not throw
    await labelCacheInvalidate(dir, "org/nonexistent");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// ensureLabelExists
// ---------------------------------------------------------------------------

Deno.test("label manager - ensureLabelExists creates label when not cached", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "bug\nfeature\n",
    });

    const result = await ensureLabelExists(
      "org/repo",
      "new-label",
      "ff0000",
      "A new label",
      { ghCommandFn, cacheDir: dir },
    );

    assertEquals(result.ok, true);
    // Issue #976: Should try REST API first for label creation
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/labels"),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - ensureLabelExists skips creation when label exists in cache", async () => {
  const dir = await makeTempDir();
  try {
    // Pre-populate cache with the label
    const cachePath = labelCacheFilePath(dir, "org/repo");
    const now = Math.floor(Date.now() / 1000);
    await Deno.writeTextFile(cachePath, `${now}\nbug\nmy-label\nfeature\n`);

    const { ghCommandFn, calls } = createMockGh({});

    const result = await ensureLabelExists(
      "org/repo",
      "my-label",
      "ff0000",
      "",
      { ghCommandFn, cacheDir: dir },
    );

    assertEquals(result.ok, true);
    // Should NOT have called label create
    assertEquals(wasCalledWith(calls, "label create"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// checkIssueHasFailedOnce
// ---------------------------------------------------------------------------

Deno.test("label manager - checkIssueHasFailedOnce returns true when label present", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return "bug,failed-once,enhancement";
  };

  const result = await checkIssueHasFailedOnce(
    "org/repo",
    42,
    "failed-once",
    mockGh,
  );
  assertEquals(result, true);
});

Deno.test("label manager - checkIssueHasFailedOnce returns false when label absent", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return "bug,enhancement";
  };

  const result = await checkIssueHasFailedOnce(
    "org/repo",
    42,
    "failed-once",
    mockGh,
  );
  assertEquals(result, false);
});

Deno.test("label manager - checkIssueHasFailedOnce returns false on API error", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API error");
  };

  const result = await checkIssueHasFailedOnce(
    "org/repo",
    42,
    "failed-once",
    mockGh,
  );
  assertEquals(result, false);
});

// ---------------------------------------------------------------------------
// markIssueAsFailedOnce
// ---------------------------------------------------------------------------

Deno.test("label manager - markIssueAsFailedOnce adds label and posts comment", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "bug\nfailed-once\n",
    });

    const result = await markIssueAsFailedOnce({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Something went wrong",
    }, { ghCommandFn, cacheDir: dir });

    assertEquals(result.ok, true);
    assertEquals(wasCalledWith(calls, "issue comment"), true);
    // Issue #976: label is now added via REST API
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/issues/42/labels"),
      true,
    );
    assertEquals(wasCalledWith(calls, "--remove-assignee worker-user"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - markIssueAsFailedOnce includes failure category in comment", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args.join(" ").includes("label list")) return "failed-once\n";
      return "";
    };

    await markIssueAsFailedOnce({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Claude timed out after 3600 seconds",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    // Find the comment call and check body contains category
    const commentCall = calls.find((c) =>
      c[0] === "issue" && c[1] === "comment"
    );
    assertEquals(commentCall !== undefined, true);
    const bodyIdx = commentCall!.indexOf("--body");
    const body = bodyIdx >= 0 ? commentCall![bodyIdx + 1] ?? "" : "";
    assertEquals(body.includes("timeout"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Issue #3425: the raw Claude stdout tail (captured on OOM/timeout) is embedded
// verbatim in a public failure comment. Assert secrets in that tail are masked
// before the comment is posted.
function extractCommentBody(calls: string[][]): string {
  const commentCall = calls.find((c) => c[0] === "issue" && c[1] === "comment");
  if (!commentCall) return "";
  const bodyIdx = commentCall.indexOf("--body");
  return bodyIdx >= 0 ? commentCall[bodyIdx + 1] ?? "" : "";
}

Deno.test("label manager - markIssueAsFailedOnce redacts secrets in the failure tail (Issue #3425)", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "failed-once\n",
    });

    const token = "ghs_" + "A".repeat(36);
    const anthropicKey = "sk-ant-" + "b".repeat(30);
    const tokenisedUrl =
      `https://x-access-token:${token}@github.com/org/repo.git`;
    const failureMessage =
      `fatal: unable to clone ${tokenisedUrl}\nGH_TOKEN=${token}\nANTHROPIC_API_KEY=${anthropicKey}`;

    await markIssueAsFailedOnce({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage,
    }, { ghCommandFn, cacheDir: dir });

    const body = extractCommentBody(calls);
    // The comment must have been posted and must not leak any secret bytes.
    assertEquals(body.length > 0, true);
    assertEquals(body.includes(token), false);
    assertEquals(body.includes(anthropicKey), false);
    assertEquals(body.includes(REDACTION_PLACEHOLDER), true);
    // The non-secret host/path stays visible for diagnosis.
    assertEquals(body.includes("github.com/org/repo.git"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - markIssueAsFailed redacts secrets in the failure tail (Issue #3425)", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "failed\nfailed-once\n",
    });

    const token = "ghp_" + "C".repeat(36);
    const failureMessage = `remote error using GH_TOKEN=${token}`;

    await markIssueAsFailed({
      repo: "org/repo",
      issueNumber: 7,
      githubUser: "worker-user",
      failureMessage,
    }, { ghCommandFn, cacheDir: dir });

    const body = extractCommentBody(calls);
    assertEquals(body.length > 0, true);
    assertEquals(body.includes(token), false);
    assertEquals(body.includes(REDACTION_PLACEHOLDER), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// markIssueAsFailed
// ---------------------------------------------------------------------------

Deno.test("label manager - markIssueAsFailed adds failed label and removes failed-once", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "bug\nfailed\nfailed-once\n",
    });

    const result = await markIssueAsFailed({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Failed again",
    }, { ghCommandFn, cacheDir: dir });

    assertEquals(result.ok, true);
    // Issue #976: label is now added via REST API
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/issues/42/labels"),
      true,
    );
    assertEquals(wasCalledWith(calls, "--remove-label failed-once"), true);
    assertEquals(wasCalledWith(calls, "--remove-assignee worker-user"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// handleIssueFailure
// ---------------------------------------------------------------------------

Deno.test("label manager - handleIssueFailure marks as failed-once on first failure", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      // checkIssueHasFailedOnce returns no labels
      "issue view": "bug,enhancement",
      "label list": "failed-once\n",
    });

    const result = await handleIssueFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Error occurred",
    }, { ghCommandFn, cacheDir: dir });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.markedAsFailedOnce, true);
      assertEquals(result.value.markedAsFailed, false);
    }
    // Issue #976: label is now added via REST API
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/issues/42/labels"),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - handleIssueFailure marks as permanently failed on second failure", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      // checkIssueHasFailedOnce — return failed-once label
      if (joined.includes("issue view") && joined.includes("labels")) {
        return "bug,failed-once";
      }
      if (joined.includes("label list")) return "failed\nfailed-once\n";
      // countInfraRetries — no failure comments
      if (joined.includes("Automated Processing Failed")) return "0";
      return "";
    };

    const result = await handleIssueFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Quality checks failed",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.markedAsFailed, true);
      assertEquals(result.value.markedAsFailedOnce, false);
      assertEquals(result.value.failureCategory, "quality_check");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - handleIssueFailure self-heals infrastructure failures", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      // has failed-once label
      if (joined.includes("issue view") && joined.includes("labels")) {
        return "failed-once";
      }
      if (joined.includes("label list")) return "failed-once\n";
      // Only 1 infra retry
      if (joined.includes("Automated Processing Failed")) return "1";
      return "";
    };

    const result = await handleIssueFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Claude rate limit exceeded",
      maxInfraRetries: 5,
    }, { ghCommandFn: mockGh, cacheDir: dir });

    assertEquals(result.ok, true);
    if (result.ok) {
      // Should NOT be marked as permanently failed
      assertEquals(result.value.markedAsFailed, false);
      assertEquals(result.value.markedAsFailedOnce, true);
      assertEquals(result.value.isInfrastructure, true);
      assertEquals(result.value.failureCategory, "rate_limit");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - handleIssueFailure never labels a scheduled release (Issue #424)", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      return "";
    };

    const result = await handleIssueFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage:
        "Released on schedule: the supervisor's run hard cap was reached — " +
        "WIP preserved, resumes next cycle",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.markedAsFailed, false);
      assertEquals(result.value.markedAsFailedOnce, false);
      assertEquals(result.value.failureCategory, "scheduled_release");
      assertEquals(result.value.isInfrastructure, false);
    }
    // A handover writes no comment, adds no label and unassigns nobody: the
    // ladder is not entered at all, so `gh` is never touched.
    assertEquals(calls.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Question Failure
// ---------------------------------------------------------------------------

Deno.test("label manager - getQuestionFailureReason returns appropriate reasons", () => {
  assertEquals(
    getQuestionFailureReason("timeout").includes("time limit"),
    true,
  );
  assertEquals(
    getQuestionFailureReason("zero_output").includes("no output"),
    true,
  );
  assertEquals(
    getQuestionFailureReason("rate_limit").includes("rate-limited"),
    true,
  );
  assertEquals(
    getQuestionFailureReason("unknown").includes("unexpected error"),
    true,
  );
});

Deno.test("label manager - buildQuestionFailureComment includes category and reason", () => {
  const comment = buildQuestionFailureComment(
    "Claude timed out",
    false,
    "question",
  );
  assertEquals(comment.includes("timeout"), true);
  assertEquals(comment.includes("Question Answering Failed"), true);
  assertEquals(comment.includes("question"), true);
});

Deno.test("label manager - buildQuestionFailureComment adds second failure notice", () => {
  const comment = buildQuestionFailureComment(
    "Failed again",
    true,
    "question",
  );
  assertEquals(comment.includes("Second Attempt"), true);
  assertEquals(comment.includes("failed twice"), true);
});

Deno.test("label manager - handleQuestionFailure adds failed-once on first failure", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      // No failed-once label
      if (joined.includes("issue view") && joined.includes("labels")) {
        return "question,bug";
      }
      if (joined.includes("label list")) return "question\nfailed-once\n";
      return "";
    };

    const result = await handleQuestionFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Timeout",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    assertEquals(result.ok, true);
    // Issue #976: label is now added via REST API
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/issues/42/labels"),
      true,
    );
    assertEquals(wasCalledWith(calls, "--remove-assignee worker-user"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - handleQuestionFailure adds failed on second failure", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      // Has failed-once label
      if (joined.includes("issue view") && joined.includes("labels")) {
        return "question,failed-once";
      }
      if (joined.includes("label list")) {
        return "question\nfailed\nfailed-once\n";
      }
      return "";
    };

    const result = await handleQuestionFailure({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Timeout again",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    assertEquals(result.ok, true);
    // Issue #976: label is now added via REST API
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/issues/42/labels"),
      true,
    );
    assertEquals(wasCalledWith(calls, "--remove-label failed-once"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Clarification
// ---------------------------------------------------------------------------

Deno.test("label manager - countClarificationRounds counts headers correctly", () => {
  assertEquals(countClarificationRounds(""), 0);
  assertEquals(
    countClarificationRounds("## Clarification Needed\nsome text"),
    1,
  );
  assertEquals(
    countClarificationRounds(
      "## Clarification Needed\nfirst\n## Clarification Needed\nsecond",
    ),
    2,
  );
  assertEquals(countClarificationRounds("No clarification here"), 0);
});

Deno.test("label manager - validateClarifyingQuestions rejects empty input", () => {
  const result = validateClarifyingQuestions("");
  assertEquals(result.ok, false);
});

Deno.test("label manager - validateClarifyingQuestions rejects whitespace-only input", () => {
  const result = validateClarifyingQuestions("   \n\t  ");
  assertEquals(result.ok, false);
});

Deno.test("label manager - validateClarifyingQuestions rejects input without question marks", () => {
  const result = validateClarifyingQuestions(
    "This is a statement about the code.",
  );
  assertEquals(result.ok, false);
});

Deno.test("label manager - validateClarifyingQuestions accepts valid questions", () => {
  const result = validateClarifyingQuestions("What is the expected behaviour?");
  assertEquals(result.ok, true);
});

Deno.test("label manager - validateClarifyingQuestions accepts multiple questions", () => {
  const result = validateClarifyingQuestions(
    "1. What colour should the button be?\n2. Should it be centred?",
  );
  assertEquals(result.ok, true);
});

Deno.test("label manager - postClarifyingQuestions rejects invalid questions", async () => {
  const { ghCommandFn } = createMockGh({});

  const result = await postClarifyingQuestions({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-user",
    clarifyingQuestions: "No questions here",
  }, { ghCommandFn });

  assertEquals(result.ok, false);
});

Deno.test("label manager - postClarifyingQuestions posts comment and adds label", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args.join(" ").includes("label list")) return "needs-clarification\n";
      return "";
    };

    const result = await postClarifyingQuestions({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      clarifyingQuestions: "What colour should it be?",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    assertEquals(result.ok, true);
    assertEquals(wasCalledWith(calls, "issue comment"), true);
    // Issue #976: label is now added via REST API
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/issues/42/labels"),
      true,
    );
    assertEquals(wasCalledWith(calls, "--remove-assignee worker-user"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("postClarifyingQuestions - masks secrets in the posted comment (Issue #3226)", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      return "";
    };

    const secret = "sk-ant-api03-" + "A".repeat(80);
    const ghpToken = "ghp_" + "B".repeat(36);

    const result = await postClarifyingQuestions({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      clarifyingQuestions:
        `Should the key be ${secret}? Or the token ${ghpToken}?`,
    }, { ghCommandFn: mockGh, cacheDir: dir });

    assertEquals(result.ok, true);

    // Find the posted comment body (the `--body` argument of `issue comment`).
    const commentCall = calls.find((call) =>
      call.includes("comment") && call.includes("--body")
    );
    assertEquals(commentCall !== undefined, true);
    const body = commentCall![commentCall!.indexOf("--body") + 1] ?? "";

    // The raw secrets must not appear in the world-readable comment.
    assertEquals(body.includes(secret), false);
    assertEquals(body.includes(ghpToken), false);
    // The surrounding question text is preserved.
    assertEquals(body.includes("Should the key be"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ghClientFromCommandFn - addLabel uses REST POST (Issue #2210)", async () => {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]) => {
    calls.push(args);
    return Promise.resolve("");
  };
  const client = ghClientFromCommandFn(ghCommandFn);
  await client.addLabel("org/repo", 7, "needs-human");
  assertEquals(
    wasCalledWith(calls, "api -X POST repos/org/repo/issues/7/labels"),
    true,
  );
});

Deno.test("postClarifyingQuestions - routes label via escalateToHuman and dedups (Issue #2210)", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const postedBodies: string[] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args.join(" ").includes("issue comment")) {
        const idx = args.indexOf("--body");
        if (idx >= 0) postedBodies.push(args[idx + 1] ?? "");
      }
      if (args.join(" ").includes("label list")) return "needs-clarification\n";
      return "";
    };

    const addedLabels: string[] = [];
    let helperPostCount = 0;
    // Injected client: dedup lookup returns the just-posted comment (carrying
    // the marker) so escalateToHuman recognises it and skips a duplicate.
    const ghClient: GitHubClient = {
      getIssue: () => Promise.reject(new Error("not used")),
      getIssueComments: () =>
        Promise.resolve([
          {
            id: 1,
            body: `## Clarification Needed\n${
              buildDedupMarker("clarification-42")
            }`,
            author: "worker-user",
            createdAt: new Date().toISOString(),
            reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
          },
        ]),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
      removeLabel: () => Promise.resolve(),
      postComment: () => {
        helperPostCount++;
        return Promise.resolve(undefined);
      },
      editIssue: () => Promise.resolve(),
      assignIssue: () => Promise.resolve(),
      unassignIssue: () => Promise.resolve(),
      closeIssue: () => Promise.resolve(),
    };

    const result = await postClarifyingQuestions({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      clarifyingQuestions: "What colour should it be?",
    }, { ghCommandFn: mockGh, cacheDir: dir, ghClient });

    assertEquals(result.ok, true);
    // Label applied via the injected client (escalateToHuman path).
    assertEquals(addedLabels.includes("needs-human"), true);
    // Dedup suppressed the helper's own comment.
    assertEquals(
      helperPostCount,
      0,
      "helper must not post a duplicate comment",
    );
    // The clarification comment carries the dedup marker.
    assertEquals(postedBodies.length, 1);
    assertEquals(
      postedBodies[0]!.includes(buildDedupMarker("clarification-42")),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Planning Escalation
// ---------------------------------------------------------------------------

// Issue #1476: escalateToPlanning posts the comment and unassigns but does
// NOT add the planning label. A trusted human adds the label to confirm.
Deno.test("label manager - escalateToPlanning posts comment and unassigns without adding planning label (Issue #1476)", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args.join(" ").includes("label list")) return "planning\n";
      return "";
    };

    const result = await escalateToPlanning({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    assertEquals(result.ok, true);
    assertEquals(wasCalledWith(calls, "issue comment"), true);
    assertEquals(wasCalledWith(calls, "--remove-assignee worker-user"), true);
    // Issue #1476: must NOT add the planning label programmatically
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/issues/42/labels"),
      false,
      "planning label must not be added via REST API",
    );
    assertEquals(
      wasCalledWith(calls, "--add-label planning"),
      false,
      "planning label must not be added via CLI",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - escalateToPlanning comment asks a human to add the planning label (Issue #1476)", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args.join(" ").includes("label list")) return "planning\n";
      return "";
    };

    await escalateToPlanning({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    // Find the issue comment body and assert it asks a trusted human to add the label
    const commentCall = calls.find((c) => {
      const joined = c.join(" ");
      return joined.startsWith("issue comment") ||
        joined.includes("issue comment 42");
    });
    assertEquals(
      commentCall !== undefined,
      true,
      "Expected an issue comment call",
    );
    const bodyIdx = commentCall!.indexOf("--body");
    assertEquals(bodyIdx >= 0, true, "Expected --body flag");
    const body = commentCall![bodyIdx + 1] ?? "";
    assertEquals(
      body.includes("trusted human") && body.includes("planning"),
      true,
      "Comment body must ask a trusted human to add the planning label",
    );
    // Must NOT claim the label has been added
    assertEquals(
      body.includes("has been added"),
      false,
      "Comment body must not claim the planning label has been added",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// addLabelToIssue (Issue #976)
// ---------------------------------------------------------------------------

Deno.test("label manager - addLabelToIssue succeeds via REST API", async () => {
  const { ghCommandFn, calls } = createMockGh({});

  // Issue #2382: `failed` is on the worker label allowlist. The guard
  // would reject an arbitrary `my-label` before the gh call is made.
  const result = await addLabelToIssue("org/repo", 42, "failed", {
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  // Should have called the REST API endpoint
  assertEquals(
    wasCalledWith(calls, "api -X POST repos/org/repo/issues/42/labels"),
    true,
  );
  // Should NOT have fallen back to CLI
  assertEquals(wasCalledWith(calls, "issue edit"), false);
});

Deno.test("label manager - addLabelToIssue falls back to CLI when REST API fails", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    // REST API call fails
    if (joined.includes("api -X POST")) throw new Error("403 Forbidden");
    return "";
  };

  const result = await addLabelToIssue("org/repo", 42, "failed", {
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  // Should have tried REST API first
  assertEquals(wasCalledWith(calls, "api -X POST"), true);
  // Should have fallen back to CLI
  assertEquals(wasCalledWith(calls, "--add-label failed"), true);
});

Deno.test("label manager - addLabelToIssue returns error when both methods fail", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("Permission denied");
  };

  const result = await addLabelToIssue("org/repo", 42, "failed", {
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message.includes("both REST API and CLI failed"),
      true,
    );
  }
});

Deno.test(
  "label manager - addLabelToIssue refuses labels outside the worker allowlist (Issue #2382)",
  async () => {
    const { ghCommandFn, calls } = createMockGh({});

    // `top-priority` is on the forbidden list — the Rule-of-Two guard
    // must short-circuit before any gh call is attempted.
    const result = await addLabelToIssue(
      "org/repo",
      42,
      "top-priority",
      { ghCommandFn },
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(
        result.error.message.includes("not authorised"),
        true,
        `error must explain the refusal: ${result.error.message}`,
      );
    }
    // No gh call should have been made.
    assertEquals(calls.length, 0);
  },
);

Deno.test("label manager - ensureLabelExists tries REST API before CLI for creation", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      // Cache miss — return empty label list
      if (joined.includes("label list")) return "bug\nfeature\n";
      return "";
    };

    const result = await ensureLabelExists(
      "org/repo",
      "new-label",
      "ff0000",
      "A new label",
      { ghCommandFn: mockGh, cacheDir: dir },
    );

    assertEquals(result.ok, true);
    // Should have tried REST API for label creation
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/labels"),
      true,
    );
    // Should NOT have needed CLI fallback since REST API succeeded
    assertEquals(wasCalledWith(calls, "label create new-label"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - ensureLabelExists falls back to CLI when REST API creation fails", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      if (joined.includes("label list")) return "bug\nfeature\n";
      // REST API creation fails
      if (joined.includes("api -X POST repos/org/repo/labels")) {
        throw new Error("403 Forbidden");
      }
      return "";
    };

    const result = await ensureLabelExists(
      "org/repo",
      "new-label",
      "ff0000",
      "A new label",
      { ghCommandFn: mockGh, cacheDir: dir },
    );

    assertEquals(result.ok, true);
    // Should have tried REST API first
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/labels"),
      true,
    );
    // Should have fallen back to CLI
    assertEquals(wasCalledWith(calls, "label create new-label"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - markIssueAsFailedOnce uses REST API for label addition", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args.join(" ").includes("label list")) return "failed-once\n";
      return "";
    };

    await markIssueAsFailedOnce({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Something went wrong",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    // Should use REST API for adding the label
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/issues/42/labels"),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Issue #1476: escalateToPlanning no longer adds the planning label.
// This test was previously "uses REST API for label addition" — it has
// been rewritten to assert the new behaviour: no label-add API call is
// made at all.
Deno.test("label manager - escalateToPlanning does not call any label-add API (Issue #1476)", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args.join(" ").includes("label list")) return "planning\n";
      return "";
    };

    await escalateToPlanning({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    // No issue-level label-add via REST API
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/issues/42/labels"),
      false,
    );
    // No label-create for planning either (since we don't need it)
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/labels"),
      false,
    );
    // No CLI label-add fallback
    assertEquals(wasCalledWith(calls, "--add-label"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// DEFAULT_LABEL_CONFIG
// ---------------------------------------------------------------------------

Deno.test("label manager - DEFAULT_LABEL_CONFIG has expected values", () => {
  assertEquals(DEFAULT_LABEL_CONFIG.failedLabel, "failed");
  assertEquals(DEFAULT_LABEL_CONFIG.failedOnceLabel, "failed-once");
  // Issue #2031: needs-clarification retired — needs-human is the handoff label.
  assertEquals(DEFAULT_LABEL_CONFIG.needsHumanLabel, "needs-human");
  assertEquals(DEFAULT_LABEL_CONFIG.planningLabel, "planning");
  assertEquals(DEFAULT_LABEL_CONFIG.questionLabel, "question");
});

// ---------------------------------------------------------------------------
// Comment-Based Planning Detection (Issue #977)
// ---------------------------------------------------------------------------

Deno.test("label manager - PLANNING_ESCALATION_HEADINGS contains expected patterns", () => {
  assertEquals(PLANNING_ESCALATION_HEADINGS.length, 2);
  assertEquals(
    PLANNING_ESCALATION_HEADINGS[0],
    "## Automatic Escalation to Planning Mode",
  );
  assertEquals(PLANNING_ESCALATION_HEADINGS[1], "## Claim Churn Detected");
});

Deno.test("label manager - detectPlanningEscalationInComments returns false for empty input", () => {
  assertEquals(detectPlanningEscalationInComments(""), false);
});

Deno.test("label manager - detectPlanningEscalationInComments detects escalation heading", () => {
  const comments =
    `Some earlier comment\n## Automatic Escalation to Planning Mode\n\nThis issue has been detected as too complex.`;
  assertEquals(detectPlanningEscalationInComments(comments), true);
});

Deno.test("label manager - detectPlanningEscalationInComments detects claim churn heading", () => {
  const comments =
    `## Claim Churn Detected\n\nThis issue has been claimed and released multiple times.`;
  assertEquals(detectPlanningEscalationInComments(comments), true);
});

Deno.test("label manager - detectPlanningEscalationInComments returns false for unrelated comments", () => {
  const comments =
    `## Some Other Heading\n\nThis is a regular comment about planning.\nNo escalation here.`;
  assertEquals(detectPlanningEscalationInComments(comments), false);
});

Deno.test("label manager - detectPlanningEscalationInComments returns false for partial heading match", () => {
  // Should not match substrings of the heading
  const comments =
    `Automatic Escalation to Planning Mode was mentioned but not as a heading.`;
  assertEquals(detectPlanningEscalationInComments(comments), false);
});

// Issue #1476: checkAndHealPlanningEscalation detects escalation but no
// longer re-adds the planning label. It always returns labelAdded:false.
Deno.test("label manager - checkAndHealPlanningEscalation detects escalation without re-adding label (Issue #1476)", async () => {
  const calls: string[][] = [];

  // Mock that returns comment text via --jq
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("comments") && joined.includes("--jq")) {
      return "## Automatic Escalation to Planning Mode\n\nToo complex.";
    }
    return "";
  };

  const tmpDir = await makeTempDir();
  try {
    const result = await checkAndHealPlanningEscalation(
      "owner/repo",
      42,
      "planning",
      { ghCommandFn: mockGh, cacheDir: tmpDir },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.detected, true);
      assertEquals(
        result.value.labelAdded,
        false,
        "Issue #1476: worker must never report labelAdded:true",
      );
    }

    // Verify NO label add was attempted
    const labelAddCall = calls.find((c) => {
      const joined = c.join(" ");
      return (
        joined.includes("issues/42/labels") ||
        joined.includes("--add-label")
      );
    });
    assertEquals(
      labelAddCall,
      undefined,
      "Issue #1476: no label-add API/CLI call should be made",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("label manager - checkAndHealPlanningEscalation returns not detected when no escalation comment", async () => {
  const mockGh = async (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("comments") && joined.includes("--jq")) {
      return "Just a regular comment about the issue.";
    }
    return "";
  };

  const tmpDir = await makeTempDir();
  try {
    const result = await checkAndHealPlanningEscalation(
      "owner/repo",
      42,
      "planning",
      { ghCommandFn: mockGh, cacheDir: tmpDir },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.detected, false);
      assertEquals(result.value.labelAdded, false);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("label manager - checkAndHealPlanningEscalation handles comment fetch failure", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API rate limited");
  };

  const result = await checkAndHealPlanningEscalation(
    "owner/repo",
    42,
    "planning",
    { ghCommandFn: mockGh },
  );

  assertEquals(result.ok, false);
});

// ---------------------------------------------------------------------------
// Issue #978 — Label-add failure resilience
// All label-add operations should be non-fatal: the workflow continues even
// when the label cannot be added.
// ---------------------------------------------------------------------------

Deno.test("label manager - escalateToPlanning succeeds even when label-add fails", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      if (joined.includes("label list")) return "planning\n";
      // Both REST API and CLI label-add fail
      if (joined.includes("api -X POST") && joined.includes("labels")) {
        throw new Error("REST API 403");
      }
      if (joined.includes("--add-label")) {
        throw new Error("CLI permission denied");
      }
      return "";
    };

    const result = await escalateToPlanning({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    // Must still succeed — label failure is non-fatal
    assertEquals(result.ok, true);
    // Comment should still have been posted
    assertEquals(wasCalledWith(calls, "issue comment"), true);
    // Unassign should still have happened
    assertEquals(wasCalledWith(calls, "--remove-assignee worker-user"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - postClarifyingQuestions succeeds even when label-add fails", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      if (joined.includes("label list")) return "needs-clarification\n";
      // Both REST API and CLI label-add fail
      if (joined.includes("api -X POST") && joined.includes("labels")) {
        throw new Error("REST API 403");
      }
      if (joined.includes("--add-label")) {
        throw new Error("CLI permission denied");
      }
      return "";
    };

    const result = await postClarifyingQuestions({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      clarifyingQuestions: "What colour should it be?",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    // Must still succeed — label failure is non-fatal
    assertEquals(result.ok, true);
    // Comment should still have been posted
    assertEquals(wasCalledWith(calls, "issue comment"), true);
    // Unassign should still have happened
    assertEquals(wasCalledWith(calls, "--remove-assignee worker-user"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - markIssueAsFailedOnce succeeds even when label-add fails", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      if (joined.includes("label list")) return "failed-once\n";
      // Both REST API and CLI label-add fail
      if (joined.includes("api -X POST") && joined.includes("labels")) {
        throw new Error("REST API 403");
      }
      if (joined.includes("--add-label")) {
        throw new Error("CLI permission denied");
      }
      return "";
    };

    const result = await markIssueAsFailedOnce({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Something went wrong",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    // Must still succeed — label failure is non-fatal
    assertEquals(result.ok, true);
    // Comment should still have been posted
    assertEquals(wasCalledWith(calls, "issue comment"), true);
    // Unassign should still have happened
    assertEquals(wasCalledWith(calls, "--remove-assignee worker-user"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - markIssueAsFailed succeeds even when label-add fails", async () => {
  const dir = await makeTempDir();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      const joined = args.join(" ");
      if (joined.includes("label list")) return "failed\nfailed-once\n";
      // Both REST API and CLI label-add fail
      if (joined.includes("api -X POST") && joined.includes("labels")) {
        throw new Error("REST API 403");
      }
      if (joined.includes("--add-label")) {
        throw new Error("CLI permission denied");
      }
      return "";
    };

    const result = await markIssueAsFailed({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-user",
      failureMessage: "Failed again",
    }, { ghCommandFn: mockGh, cacheDir: dir });

    // Must still succeed — label failure is non-fatal
    assertEquals(result.ok, true);
    // Comment should still have been posted
    assertEquals(wasCalledWith(calls, "issue comment"), true);
    // Unassign should still have happened
    assertEquals(wasCalledWith(calls, "--remove-assignee worker-user"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #1476: checkAndHealPlanningEscalation never adds or creates the
// planning label. The Issue #1215 regression test has been removed because
// the code path it covered (self-healing label re-add) no longer exists.
// ---------------------------------------------------------------------------

Deno.test("label manager - checkAndHealPlanningEscalation never calls label-add or ensureLabelExists (Issue #1476)", async () => {
  const calls: string[][] = [];

  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("comments") && joined.includes("--jq")) {
      return "## Claim Churn Detected\n\nMultiple claim/release cycles.";
    }
    return "";
  };

  const tmpDir = await makeTempDir();
  try {
    const result = await checkAndHealPlanningEscalation(
      "owner/repo",
      42,
      "planning",
      { ghCommandFn: mockGh, cacheDir: tmpDir },
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.detected, true);
      assertEquals(result.value.labelAdded, false);
    }

    // No label-create for the planning label
    const ensureCall = calls.find((c) =>
      c.join(" ").includes("api -X POST repos/owner/repo/labels")
    );
    assertEquals(
      ensureCall,
      undefined,
      "ensureLabelExists must not be called for the planning label",
    );
    // No label-add on the issue
    const addCall = calls.find((c) => {
      const joined = c.join(" ");
      return (
        joined.includes("issues/42/labels") ||
        joined.includes("--add-label")
      );
    });
    assertEquals(
      addCall,
      undefined,
      "addLabelToIssue must not be called for the planning label",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// ensureLabelExists — quota-safe error handling (Issue #42)
// ---------------------------------------------------------------------------

Deno.test("label manager - ensureLabelExists treats a 422 already_exists as success", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh({
      "label list": "bug\nfeature\n", // cache miss for the target label
      "POST repos/org/repo/labels": new Error(
        "gh: HTTP 422: Validation Failed (name already_exists)",
      ),
    });

    const result = await ensureLabelExists(
      "org/repo",
      "needs-human",
      "d73a4a",
      "",
      { ghCommandFn, cacheDir: dir },
    );

    // The label is already there — that is success, not a failed create.
    assertEquals(result.ok, true);
    // And we must NOT fall through to a second, redundant CLI create.
    assertEquals(wasCalledWith(calls, "label create"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("label manager - ensureLabelExists surfaces the rate-limit cause, not a generic label bug", async () => {
  const dir = await makeTempDir();
  try {
    const rateLimit = new Error(
      "gh command failed (exit 1): GraphQL: API rate limit already exceeded",
    );
    // Every path — the initial list, the REST create, the CLI create, and the
    // self-heal re-list — hits the exhausted quota.
    const { ghCommandFn } = createMockGh({
      "label list": rateLimit,
      "POST repos/org/repo/labels": rateLimit,
      "label create": rateLimit,
    });

    const result = await ensureLabelExists(
      "org/repo",
      "needs-human",
      "d73a4a",
      "",
      { ghCommandFn, cacheDir: dir },
    );

    assertEquals(result.ok, false);
    if (!result.ok) {
      // The underlying cause must be carried so a quota outage does not
      // masquerade as a permissions/label defect.
      assertEquals(
        /rate limit already exceeded/i.test(result.error.message),
        true,
        `error should name the rate-limit cause: ${result.error.message}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
