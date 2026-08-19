/**
 * Tests for `findOpenLinkedPR` (Issue #1887).
 *
 * Each test exercises one of the four linkage signals independently
 * (title search, closing reference, cross-referenced event, worker
 * comment) plus a negative case where no signal is present.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  findOpenLinkedPR,
  parseWorkerCommentPRNumber,
} from "../lib/pr_linkage.ts";

async function makeCache(): Promise<{ cache: IssueCache; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "pr-linkage-cache-" });
  return { cache: new IssueCache(dir), dir };
}

// ----------------------------------------------------------------------
// parseWorkerCommentPRNumber — pure helper
// ----------------------------------------------------------------------

Deno.test("pr_linkage - parseWorkerCommentPRNumber matches the worker comment shape", () => {
  const body =
    "Pull request https://github.com/stSoftwareAU/VibeCoder/pull/1882 has been created to address this issue.";
  assertEquals(parseWorkerCommentPRNumber(body), 1882);
});

Deno.test("pr_linkage - parseWorkerCommentPRNumber returns null for unrelated text", () => {
  assertEquals(parseWorkerCommentPRNumber("Some unrelated comment."), null);
});

Deno.test("pr_linkage - parseWorkerCommentPRNumber tolerates surrounding whitespace and trailing text", () => {
  const body =
    "  Pull request https://github.com/owner/repo/pull/42 has been created to address this issue.\n\nThanks!";
  assertEquals(parseWorkerCommentPRNumber(body), 42);
});

// ----------------------------------------------------------------------
// findOpenLinkedPR — title signal
// ----------------------------------------------------------------------

Deno.test("pr_linkage - findOpenLinkedPR returns title-signal match when title search hits", async () => {
  const { cache, dir } = await makeCache();
  try {
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return Promise.resolve(JSON.stringify([{
          number: 555,
          title: "Fix bug (#101)",
          baseRefName: "main",
          headRefName: "h",
          mergedAt: null,
        }]));
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await findOpenLinkedPR("org/repo", 101, ghFn, cache);
    assertEquals(result, { number: 555, signal: "title" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ----------------------------------------------------------------------
// findOpenLinkedPR — closing reference signal
// ----------------------------------------------------------------------

Deno.test("pr_linkage - findOpenLinkedPR returns closing_ref when GraphQL closedByPullRequestsReferences contains an open PR", async () => {
  const { cache, dir } = await makeCache();
  try {
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") {
        // No title match.
        return Promise.resolve("[]");
      }
      if (args[0] === "api" && args[1] === "graphql") {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [{ number: 777, state: "OPEN" }],
                },
                timelineItems: { nodes: [] },
                comments: { nodes: [] },
              },
            },
          },
        }));
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await findOpenLinkedPR("org/repo", 102, ghFn, cache);
    assertEquals(result, { number: 777, signal: "closing_ref" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ----------------------------------------------------------------------
// findOpenLinkedPR — cross_ref signal
// ----------------------------------------------------------------------

Deno.test("pr_linkage - findOpenLinkedPR returns cross_ref when timeline contains an open PR cross-reference", async () => {
  const { cache, dir } = await makeCache();
  try {
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      if (args[0] === "api" && args[1] === "graphql") {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: { nodes: [] },
                timelineItems: {
                  nodes: [
                    {
                      source: {
                        __typename: "PullRequest",
                        number: 888,
                        state: "OPEN",
                      },
                    },
                  ],
                },
                comments: { nodes: [] },
              },
            },
          },
        }));
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await findOpenLinkedPR("org/repo", 103, ghFn, cache);
    assertEquals(result, { number: 888, signal: "cross_ref" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ----------------------------------------------------------------------
// findOpenLinkedPR — worker_comment signal
// ----------------------------------------------------------------------

Deno.test("pr_linkage - findOpenLinkedPR returns worker_comment when worker comment + open PR verified", async () => {
  // Reproduces the issue #1881 / PR #1882 fixture: a worker-authored
  // "Pull request ... has been created" comment whose target PR is open.
  const { cache, dir } = await makeCache();
  try {
    let prViewCalled = false;
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      if (args[0] === "api" && args[1] === "graphql") {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: { nodes: [] },
                timelineItems: { nodes: [] },
                comments: {
                  nodes: [
                    {
                      author: { login: "worker-bot" },
                      body:
                        "Pull request https://github.com/stSoftwareAU/VibeCoder/pull/1882 has been created to address this issue.",
                    },
                  ],
                },
              },
            },
          },
        }));
      }
      if (args[0] === "pr" && args[1] === "view" && args[2] === "1882") {
        prViewCalled = true;
        return Promise.resolve(JSON.stringify({ state: "OPEN" }));
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await findOpenLinkedPR(
      "stSoftwareAU/VibeCoder",
      1881,
      ghFn,
      cache,
      "worker-bot",
    );
    assertEquals(result, { number: 1882, signal: "worker_comment" });
    assertEquals(prViewCalled, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr_linkage - findOpenLinkedPR ignores worker comments whose PR has since closed", async () => {
  const { cache, dir } = await makeCache();
  try {
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      if (args[0] === "api" && args[1] === "graphql") {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: { nodes: [] },
                timelineItems: { nodes: [] },
                comments: {
                  nodes: [
                    {
                      author: { login: "worker-bot" },
                      body:
                        "Pull request https://github.com/owner/repo/pull/9 has been created to address this issue.",
                    },
                  ],
                },
              },
            },
          },
        }));
      }
      if (args[0] === "pr" && args[1] === "view" && args[2] === "9") {
        return Promise.resolve(JSON.stringify({ state: "CLOSED" }));
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await findOpenLinkedPR(
      "owner/repo",
      4,
      ghFn,
      cache,
      "worker-bot",
    );
    assertEquals(result, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr_linkage - findOpenLinkedPR ignores worker comments authored by other users when workerLogin is supplied", async () => {
  const { cache, dir } = await makeCache();
  try {
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      if (args[0] === "api" && args[1] === "graphql") {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: { nodes: [] },
                timelineItems: { nodes: [] },
                comments: {
                  nodes: [
                    {
                      author: { login: "someone-else" },
                      body:
                        "Pull request https://github.com/owner/repo/pull/12 has been created to address this issue.",
                    },
                  ],
                },
              },
            },
          },
        }));
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await findOpenLinkedPR(
      "owner/repo",
      8,
      ghFn,
      cache,
      "worker-bot",
    );
    assertEquals(result, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ----------------------------------------------------------------------
// findOpenLinkedPR — negative case
// ----------------------------------------------------------------------

Deno.test("pr_linkage - findOpenLinkedPR returns null when no signal is present", async () => {
  const { cache, dir } = await makeCache();
  try {
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      if (args[0] === "api" && args[1] === "graphql") {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: { nodes: [] },
                timelineItems: { nodes: [] },
                comments: { nodes: [] },
              },
            },
          },
        }));
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await findOpenLinkedPR("org/repo", 999, ghFn, cache);
    assertEquals(result, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr_linkage - findOpenLinkedPR ignores closingIssuesReferences entries whose PR is not OPEN", async () => {
  const { cache, dir } = await makeCache();
  try {
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      if (args[0] === "api" && args[1] === "graphql") {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [{ number: 21, state: "MERGED" }],
                },
                timelineItems: { nodes: [] },
                comments: { nodes: [] },
              },
            },
          },
        }));
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await findOpenLinkedPR("org/repo", 7, ghFn, cache);
    assertEquals(result, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr_linkage - findOpenLinkedPR ignores closed PRs reachable only via cross_ref", async () => {
  const { cache, dir } = await makeCache();
  try {
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      if (args[0] === "api" && args[1] === "graphql") {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: { nodes: [] },
                timelineItems: {
                  nodes: [
                    {
                      source: {
                        __typename: "PullRequest",
                        number: 33,
                        state: "CLOSED",
                      },
                    },
                  ],
                },
                comments: { nodes: [] },
              },
            },
          },
        }));
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await findOpenLinkedPR("org/repo", 7, ghFn, cache);
    assertEquals(result, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ----------------------------------------------------------------------
// findOpenLinkedPR — cross-handler cache dedupe (Issue #1907)
// ----------------------------------------------------------------------

Deno.test("pr_linkage - findOpenLinkedPR caches negative GraphQL result across calls", async () => {
  // Two sequential calls for the same (repo, issue) with no linked PR
  // must issue the GraphQL query only once — the second call hits the
  // cached negative. Reproduces the per-iteration N+1 from #1907.
  const { cache, dir } = await makeCache();
  try {
    let graphqlCalls = 0;
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      if (args[0] === "api" && args[1] === "graphql") {
        graphqlCalls++;
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: { nodes: [] },
                timelineItems: { nodes: [] },
                comments: { nodes: [] },
              },
            },
          },
        }));
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const first = await findOpenLinkedPR("org/repo", 4242, ghFn, cache);
    const second = await findOpenLinkedPR("org/repo", 4242, ghFn, cache);
    assertEquals(first, null);
    assertEquals(second, null);
    assertEquals(
      graphqlCalls,
      1,
      "second call must hit the cache, not re-issue the GraphQL query",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pr_linkage - findOpenLinkedPR caches positive GraphQL result across calls", async () => {
  // Positive closing-ref hits also need to survive across calls so the
  // second handler doesn't repeat the GraphQL round-trip.
  const { cache, dir } = await makeCache();
  try {
    let graphqlCalls = 0;
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
      if (args[0] === "api" && args[1] === "graphql") {
        graphqlCalls++;
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [{ number: 99, state: "OPEN" }],
                },
                timelineItems: { nodes: [] },
                comments: { nodes: [] },
              },
            },
          },
        }));
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const first = await findOpenLinkedPR("org/repo", 4243, ghFn, cache);
    const second = await findOpenLinkedPR("org/repo", 4243, ghFn, cache);
    assertEquals(first, { number: 99, signal: "closing_ref" });
    assertEquals(second, { number: 99, signal: "closing_ref" });
    assertEquals(
      graphqlCalls,
      1,
      "second call must hit the cache, not re-issue the GraphQL query",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
