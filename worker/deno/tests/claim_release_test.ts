/**
 * Tests for the shared claim-release helper (Issue #2728).
 *
 * Covers the success path, the swallowed-failure path, and the
 * `ghCommandFn` adapter used by processors that hold a raw command
 * runner rather than a full GitHubClient.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  releaseAllWorkerClaims,
  releaseClaim,
  unassignerFromGhCommand,
} from "../lib/claim_release.ts";
import type { GitHubComment, GitHubIssue } from "../types.ts";

/** Build a minimal GitHubIssue with the given assignees. */
function makeIssue(assignees: string[]): GitHubIssue {
  return {
    number: 1,
    title: "t",
    body: "b",
    labels: [],
    author: "dev",
    assignees,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

/** Build a minimal GitHubComment with the given author and body. */
function makeComment(author: string, body: string): GitHubComment {
  return {
    id: 1,
    body,
    author,
    createdAt: "2026-01-01T00:00:00Z",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

const CLAIM_BODY = "<!-- CLAIM_LOCK:machine-x:0 -->";
const HEARTBEAT_BODY = "<!-- VIBE_CODER_HEARTBEAT:machine-x:0 -->";

/** Options that make the bounded retry instant in tests. */
const FAST_RETRY = {
  retryDelayMs: 0,
  sleepFn: (_ms: number) => Promise.resolve(),
};

/** Logger stub that records warning calls. */
function createWarnLogger(): {
  warn: (message: string, context?: Record<string, unknown>) => void;
  calls: Array<{ message: string; context?: Record<string, unknown> }>;
} {
  const calls: Array<{ message: string; context?: Record<string, unknown> }> =
    [];
  return {
    warn: (message, context) => {
      calls.push({ message, context });
    },
    calls,
  };
}

Deno.test("releaseClaim - returns true and unassigns on success", async () => {
  const unassignCalls: Array<
    { repo: string; issueNumber: number; assignees: string[] }
  > = [];
  const logger = createWarnLogger();

  const ghClient = {
    unassignIssue: (
      repo: string,
      issueNumber: number,
      assignees: string[],
    ): Promise<void> => {
      unassignCalls.push({ repo, issueNumber, assignees });
      return Promise.resolve();
    },
  };

  const result = await releaseClaim(
    ghClient,
    "org/repo",
    42,
    "worker-bot",
    logger,
  );

  assert(result, "should return true on success");
  assertEquals(unassignCalls.length, 1);
  assertEquals(unassignCalls[0], {
    repo: "org/repo",
    issueNumber: 42,
    assignees: ["worker-bot"],
  });
  assertEquals(logger.calls.length, 0, "should not warn on success");
});

Deno.test("releaseClaim - returns false and logs (no throw) on failure", async () => {
  const logger = createWarnLogger();

  const ghClient = {
    unassignIssue: (): Promise<void> =>
      Promise.reject(new Error("user not assigned")),
  };

  // Must not throw — best-effort.
  const result = await releaseClaim(
    ghClient,
    "org/repo",
    7,
    "worker-bot",
    logger,
  );

  assertFalse(result, "should return false on failure");
  assertEquals(logger.calls.length, 1, "should log exactly one warning");
  assertEquals(logger.calls[0]?.context?.repo, "org/repo");
  assertEquals(logger.calls[0]?.context?.issueNumber, 7);
  assertEquals(logger.calls[0]?.context?.error, "user not assigned");
});

Deno.test("releaseClaim - stringifies non-Error rejections", async () => {
  const logger = createWarnLogger();

  const ghClient = {
    unassignIssue: (): Promise<void> => Promise.reject("plain string failure"),
  };

  const result = await releaseClaim(
    ghClient,
    "org/repo",
    9,
    "worker-bot",
    logger,
  );

  assertFalse(result);
  assertEquals(logger.calls[0]?.context?.error, "plain string failure");
});

Deno.test("unassignerFromGhCommand - emits the canonical gh args", async () => {
  const ghCalls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    ghCalls.push(args);
    return Promise.resolve("");
  };

  const unassigner = unassignerFromGhCommand(ghCommandFn);
  await unassigner.unassignIssue("org/repo", 123, ["worker-bot"]);

  assertEquals(ghCalls.length, 1);
  assertEquals(ghCalls[0], [
    "issue",
    "edit",
    "123",
    "--repo",
    "org/repo",
    "--remove-assignee",
    "worker-bot",
  ]);
});

Deno.test("unassignerFromGhCommand - works through releaseClaim", async () => {
  const ghCalls: string[][] = [];
  const logger = createWarnLogger();
  const ghCommandFn = (args: string[]): Promise<string> => {
    ghCalls.push(args);
    return Promise.resolve("");
  };

  const result = await releaseClaim(
    unassignerFromGhCommand(ghCommandFn),
    "org/repo",
    5,
    "worker-bot",
    logger,
  );

  assert(result);
  assertEquals(ghCalls[0]?.[6], "worker-bot");
  assertEquals(logger.calls.length, 0);
});

Deno.test("unassignerFromGhCommand - failure surfaces as false via releaseClaim", async () => {
  const logger = createWarnLogger();
  const ghCommandFn = (): Promise<string> =>
    Promise.reject(new Error("gh failed"));

  const result = await releaseClaim(
    unassignerFromGhCommand(ghCommandFn),
    "org/repo",
    5,
    "worker-bot",
    logger,
  );

  assertFalse(result);
  assertEquals(logger.calls.length, 1);
  assertEquals(logger.calls[0]?.context?.error, "gh failed");
});

/** Build an all-account stub recording the unassign calls (Issue #3109). */
function makeAllAccountClient(
  assignees: string[],
  comments: GitHubComment[],
  opts: {
    unassign?: (assignees: string[]) => Promise<void>;
    getIssueThrows?: boolean;
    getCommentsThrows?: boolean;
  } = {},
): {
  client: Parameters<typeof releaseAllWorkerClaims>[0];
  unassignCalls: string[][];
} {
  const unassignCalls: string[][] = [];
  const client = {
    getIssue: (): Promise<GitHubIssue> =>
      opts.getIssueThrows
        ? Promise.reject(new Error("getIssue failed"))
        : Promise.resolve(makeIssue(assignees)),
    getIssueComments: (): Promise<GitHubComment[]> =>
      opts.getCommentsThrows
        ? Promise.reject(new Error("getIssueComments failed"))
        : Promise.resolve(comments),
    unassignIssue: (
      _repo: string,
      _issueNumber: number,
      a: string[],
    ): Promise<void> => {
      unassignCalls.push(a);
      return opts.unassign ? opts.unassign(a) : Promise.resolve();
    },
  };
  return { client, unassignCalls };
}

Deno.test("releaseAllWorkerClaims - clears only the own account when alone", async () => {
  const logger = createWarnLogger();
  const { client, unassignCalls } = makeAllAccountClient(["worker-bot"], []);

  const result = await releaseAllWorkerClaims(
    client,
    "org/repo",
    42,
    "worker-bot",
    logger,
    FAST_RETRY,
  );

  assert(result);
  assertEquals(unassignCalls.length, 1);
  assertEquals(unassignCalls[0], ["worker-bot"]);
  assertEquals(logger.calls.length, 0);
});

Deno.test("releaseAllWorkerClaims - clears a cross-account worker (marker evidence)", async () => {
  const logger = createWarnLogger();
  // Current run is `stsvcbot`; an earlier round assigned `Vibecoderbot`
  // which posted a claim marker — evidence it is a worker.
  const { client, unassignCalls } = makeAllAccountClient(
    ["stsvcbot", "Vibecoderbot"],
    [makeComment("Vibecoderbot", CLAIM_BODY)],
  );

  const result = await releaseAllWorkerClaims(
    client,
    "org/repo",
    42,
    "stsvcbot",
    logger,
    FAST_RETRY,
  );

  assert(result);
  assertEquals(unassignCalls.length, 1);
  assertEquals(
    new Set(unassignCalls[0]),
    new Set(["stsvcbot", "Vibecoderbot"]),
  );
});

Deno.test("releaseAllWorkerClaims - clears via heartbeat marker evidence", async () => {
  const logger = createWarnLogger();
  const { client, unassignCalls } = makeAllAccountClient(
    ["stsvcbot", "Vibecoderbot"],
    [makeComment("Vibecoderbot", HEARTBEAT_BODY)],
  );

  const result = await releaseAllWorkerClaims(
    client,
    "org/repo",
    42,
    "stsvcbot",
    logger,
    FAST_RETRY,
  );

  assert(result);
  assertEquals(
    new Set(unassignCalls[0]),
    new Set(["stsvcbot", "Vibecoderbot"]),
  );
});

Deno.test("releaseAllWorkerClaims - never clears a human assignee with no marker", async () => {
  const logger = createWarnLogger();
  // `dev-human` is assigned but has posted no worker marker — must stay.
  const { client, unassignCalls } = makeAllAccountClient(
    ["worker-bot", "dev-human"],
    [makeComment("dev-human", "just a normal reply")],
  );

  const result = await releaseAllWorkerClaims(
    client,
    "org/repo",
    42,
    "worker-bot",
    logger,
    FAST_RETRY,
  );

  assert(result);
  assertEquals(unassignCalls.length, 1);
  assertEquals(unassignCalls[0], ["worker-bot"]);
});

Deno.test("releaseAllWorkerClaims - always clears own account, leaving a human", async () => {
  const logger = createWarnLogger();
  // A human is assigned and the current account is not in the list — the
  // own account is still cleared (preserving releaseClaim's guarantee) and
  // the human is left untouched (no marker evidence).
  const { client, unassignCalls } = makeAllAccountClient(["dev-human"], []);

  const result = await releaseAllWorkerClaims(
    client,
    "org/repo",
    42,
    "worker-bot",
    logger,
    FAST_RETRY,
  );

  assert(result);
  assertEquals(unassignCalls.length, 1);
  assertEquals(unassignCalls[0], ["worker-bot"], "clears own account only");
});

Deno.test("releaseAllWorkerClaims - retries a transient failure then succeeds", async () => {
  const logger = createWarnLogger();
  let attempts = 0;
  const { client, unassignCalls } = makeAllAccountClient(["worker-bot"], [], {
    unassign: () => {
      attempts++;
      return attempts < 2
        ? Promise.reject(new Error("transient 502"))
        : Promise.resolve();
    },
  });

  const result = await releaseAllWorkerClaims(
    client,
    "org/repo",
    42,
    "worker-bot",
    logger,
    FAST_RETRY,
  );

  assert(result, "should succeed after one retry");
  assertEquals(unassignCalls.length, 2, "should have retried once");
  assertEquals(logger.calls.length, 0, "no warning when retry succeeds");
});

Deno.test("releaseAllWorkerClaims - returns false after exhausting retries", async () => {
  const logger = createWarnLogger();
  const { client, unassignCalls } = makeAllAccountClient(["worker-bot"], [], {
    unassign: () => Promise.reject(new Error("persistent failure")),
  });

  const result = await releaseAllWorkerClaims(
    client,
    "org/repo",
    42,
    "worker-bot",
    logger,
    { retries: 2, ...FAST_RETRY },
  );

  assertFalse(result, "should return false when every attempt fails");
  assertEquals(unassignCalls.length, 3, "first attempt + 2 retries");
  assertEquals(logger.calls.length, 1, "logs exactly one warning");
  assertEquals(logger.calls[0]?.context?.attempts, 3);
});

Deno.test("releaseAllWorkerClaims - falls back to own account when getIssue throws", async () => {
  const logger = createWarnLogger();
  const { client, unassignCalls } = makeAllAccountClient([], [], {
    getIssueThrows: true,
  });

  const result = await releaseAllWorkerClaims(
    client,
    "org/repo",
    42,
    "worker-bot",
    logger,
    FAST_RETRY,
  );

  assert(result);
  assertEquals(unassignCalls.length, 1);
  assertEquals(unassignCalls[0], ["worker-bot"]);
  // One warning for the resolve failure, none for the (successful) unassign.
  assertEquals(logger.calls.length, 1);
});

Deno.test("releaseAllWorkerClaims - clears only own account when comments fetch fails", async () => {
  const logger = createWarnLogger();
  const { client, unassignCalls } = makeAllAccountClient(
    ["worker-bot", "Vibecoderbot"],
    [],
    { getCommentsThrows: true },
  );

  const result = await releaseAllWorkerClaims(
    client,
    "org/repo",
    42,
    "worker-bot",
    logger,
    FAST_RETRY,
  );

  assert(result);
  // Cannot prove Vibecoderbot is a worker without comments — clear self only.
  assertEquals(unassignCalls[0], ["worker-bot"]);
});
