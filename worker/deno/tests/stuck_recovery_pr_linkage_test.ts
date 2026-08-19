/**
 * Integration tests for the hardened PR-linkage skip in
 * `detectAssignedWithoutHeartbeat` (Issue #1887).
 *
 * Each test reproduces a single linkage signal — the title-based
 * fallback, GraphQL `closedByPullRequestsReferences`, GraphQL
 * `CrossReferencedEvent`, or a worker-authored comment — and verifies
 * that recovery is skipped with `decision: "skipped:open_pr"`.
 *
 * The issue #1881 fixture (worker comment present, target PR open) is
 * exercised directly in the worker-comment test; that scenario was the
 * false-positive that motivated this hardening.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  __getRecoveryDecisions,
  __resetRecoveryDecisions,
} from "../lib/stuck_issue_detector.ts";
import { detectAssignedWithoutHeartbeat } from "../lib/stuck_recovery.ts";
import {
  STUCK_ISSUE_DEFAULTS,
  type StuckIssueConfig,
} from "../lib/stuck_issue_detector.ts";

async function makeTempDir(prefix = "pr-linkage-it-"): Promise<string> {
  return await Deno.makeTempDir({ prefix });
}

function testConfig(workDir: string, machineId = "m1"): StuckIssueConfig {
  return {
    workDir,
    stuckIssueTimeout: STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
    assignedNoHeartbeatTimeout: STUCK_ISSUE_DEFAULTS.assignedNoHeartbeatTimeout,
    staleAssignmentTimeout: STUCK_ISSUE_DEFAULTS.staleAssignmentTimeout,
    repos: ["org/repo"],
    machineId,
  };
}

function buildIssue(num: number, updatedAt: string): Record<string, unknown> {
  return {
    number: num,
    title: `Issue ${num}`,
    assignees: [{ login: "worker-bot" }],
    labels: [],
    author: { login: "alice" },
    createdAt: updatedAt,
    updatedAt,
    url: `https://example/${num}`,
    milestone: null,
  };
}

const NOW = 1_700_000_000;
const OLD_UPDATED_AT = new Date(
  (NOW - STUCK_ISSUE_DEFAULTS.assignedNoHeartbeatTimeout - 100) * 1000,
).toISOString();

function emptyTitleSearch(): string {
  return "[]";
}

function noMarkers(): string {
  return "[]";
}

// ----------------------------------------------------------------------
// closing_ref signal — explicit `Closes #N` keyword in the PR body.
// ----------------------------------------------------------------------

Deno.test("stuck_recovery PR linkage - skips recovery when GraphQL closedByPullRequestsReferences contains an open PR", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir();
  const workDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(
          JSON.stringify([buildIssue(401, OLD_UPDATED_AT)]),
        );
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return Promise.resolve(emptyTitleSearch());
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return Promise.resolve(noMarkers());
      }
      if (args[0] === "api" && args[1] === "graphql") {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [{ number: 1900, state: "OPEN" }],
                },
                timelineItems: { nodes: [] },
                comments: { nodes: [] },
              },
            },
          },
        }));
      }
      return Promise.resolve("");
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      testConfig(workDir),
      "worker-bot",
      () => NOW,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "skipped:open_pr");
    assertEquals(e.linkedOpenPR, "org/repo#1900");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ----------------------------------------------------------------------
// cross_ref signal — open PR mentions the issue.
// ----------------------------------------------------------------------

Deno.test("stuck_recovery PR linkage - skips recovery when timeline cross-references an open PR", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir();
  const workDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(
          JSON.stringify([buildIssue(402, OLD_UPDATED_AT)]),
        );
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return Promise.resolve(emptyTitleSearch());
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return Promise.resolve(noMarkers());
      }
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
                        number: 1901,
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
      return Promise.resolve("");
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      testConfig(workDir),
      "worker-bot",
      () => NOW,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "skipped:open_pr");
    assertEquals(e.linkedOpenPR, "org/repo#1901");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ----------------------------------------------------------------------
// worker_comment signal — issue #1881 / PR #1882 fixture.
// ----------------------------------------------------------------------

Deno.test("stuck_recovery PR linkage - reproduces issue #1881: worker comment + open PR ⇒ recovery skipped", async () => {
  // Without the hardening this test fails: title search returns nothing
  // (the PR may have merged before the scan, or its title may not match
  // the worker title convention), the marker is absent, `updatedAt` is
  // old, and the original code path proceeds to recover. With the new
  // worker-comment signal, the linked open PR is detected and recovery
  // is skipped with `decision: "skipped:open_pr"`.
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir();
  const workDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    let prViewCalls = 0;
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(
          JSON.stringify([buildIssue(1881, OLD_UPDATED_AT)]),
        );
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return Promise.resolve(emptyTitleSearch());
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return Promise.resolve(noMarkers());
      }
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
                        "Pull request https://github.com/org/repo/pull/1882 has been created to address this issue.",
                    },
                  ],
                },
              },
            },
          },
        }));
      }
      if (args[0] === "pr" && args[1] === "view" && args[2] === "1882") {
        prViewCalls++;
        return Promise.resolve(JSON.stringify({ state: "OPEN" }));
      }
      return Promise.resolve("");
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      testConfig(workDir),
      "worker-bot",
      () => NOW,
      ghFn,
      cache,
    );
    assertEquals(recovered, 0, "the issue must not be recovered");

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "skipped:open_pr");
    assertEquals(e.linkedOpenPR, "org/repo#1882");
    assertEquals(prViewCalls, 1, "PR open-state must be verified once");
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});

// ----------------------------------------------------------------------
// Negative case — no signal present, recovery proceeds.
// ----------------------------------------------------------------------

Deno.test("stuck_recovery PR linkage - recovers when no linkage signal is present", async () => {
  __resetRecoveryDecisions();
  const cacheDir = await makeTempDir();
  const workDir = await makeTempDir();
  try {
    const cache = new IssueCache(cacheDir);
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve(
          JSON.stringify([buildIssue(403, OLD_UPDATED_AT)]),
        );
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--search")) {
        return Promise.resolve(emptyTitleSearch());
      }
      if (args[0] === "api" && args[1]?.endsWith("/comments")) {
        return Promise.resolve(noMarkers());
      }
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
      return Promise.resolve("");
    };

    const recovered = await detectAssignedWithoutHeartbeat(
      testConfig(workDir),
      "worker-bot",
      () => NOW,
      ghFn,
      cache,
    );
    assertEquals(recovered, 1);

    const events = __getRecoveryDecisions();
    assertEquals(events.length, 1);
    const e = events[0]!;
    assertEquals(e.decision, "recovered");
    assertEquals(e.linkedOpenPR, null);
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
});
