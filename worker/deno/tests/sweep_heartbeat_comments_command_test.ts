/**
 * Tests for the one-shot `sweep-heartbeat-comments` entry point
 * (Issue #3755).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { sweepHeartbeatCommentsAcrossRepos } from "../commands/sweep_heartbeat_comments.ts";
import { renderHeartbeatBody } from "../lib/heartbeat_storage.ts";

const FLEET = ["vibe-bot"];
const NOW = Math.floor(Date.now() / 1000);

function clearedBody(machineId: string): string {
  return renderHeartbeatBody(
    { machineId, epoch: 0, released: true },
    () => NOW,
  );
}

function liveBody(machineId: string, epoch: number): string {
  return renderHeartbeatBody({ machineId, epoch }, () => NOW);
}

function isoAt(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

/**
 * Stub `gh` that serves a search result for one repo and a comment list per
 * issue, recording every call.
 */
function makeGhFn(
  search: Record<string, { total: number; numbers: number[] }>,
  comments: Record<string, unknown[]>,
): { ghFn: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("search/issues")) {
      const q = args.find((a) => a.startsWith("q=")) ?? "";
      const repo = q.split("repo:")[1] ?? "";
      return Promise.resolve(
        JSON.stringify(search[repo] ?? { total: 0, numbers: [] }),
      );
    }
    if (args.includes("DELETE")) {
      return Promise.resolve("HTTP/2.0 204 No Content\n");
    }
    const path = args[1] ?? "";
    const match = path.match(/repos\/(.+)\/issues\/(\d+)\/comments/);
    const key = match ? `${match[1]}#${match[2]}` : "";
    return Promise.resolve(JSON.stringify(comments[key] ?? []));
  };
  return { ghFn, calls };
}

Deno.test("one-shot sweep clears the backlog on discovered threads", async () => {
  const { ghFn, calls } = makeGhFn(
    { "org/repo": { total: 1, numbers: [3644] } },
    {
      "org/repo#3644": [
        {
          id: 1,
          body: clearedBody("host-A"),
          author: "vibe-bot",
          updatedAt: isoAt(NOW - 10 * 86400),
        },
        {
          id: 2,
          body: clearedBody("host-B"),
          author: "vibe-bot",
          updatedAt: isoAt(NOW - 9 * 86400),
        },
        {
          id: 3,
          body: liveBody("host-A", NOW - 60),
          author: "vibe-bot",
          updatedAt: isoAt(NOW - 60),
        },
        { id: 4, body: "human prose", author: "someone" },
      ],
    },
  );

  const data = await sweepHeartbeatCommentsAcrossRepos({
    repos: ["org/repo"],
    allowedAuthors: FLEET,
    machineId: "host-A",
    ghFn,
  });

  assertEquals(data.totals.threads, 1);
  assertEquals(data.totals.deleted, 2);
  assertEquals(data.threads[0]?.deleted, [1, 2]);
  assertEquals(calls.filter((c) => c.includes("DELETE")).length, 2);
});

Deno.test("one-shot sweep honours --dry-run and reports truncation", async () => {
  const { ghFn, calls } = makeGhFn(
    { "org/repo": { total: 130, numbers: [10] } },
    {
      "org/repo#10": [
        {
          id: 1,
          body: clearedBody("host-A"),
          author: "vibe-bot",
          updatedAt: isoAt(NOW - 10 * 86400),
        },
        {
          id: 2,
          body: clearedBody("host-B"),
          author: "vibe-bot",
          updatedAt: isoAt(NOW - 9 * 86400),
        },
      ],
    },
  );

  const data = await sweepHeartbeatCommentsAcrossRepos({
    repos: ["org/repo"],
    allowedAuthors: FLEET,
    dryRun: true,
    ghFn,
  });

  assertEquals(data.dryRun, true);
  assertEquals(data.totals.deleted, 2);
  assertEquals(calls.filter((c) => c.includes("DELETE")).length, 0);
  assertEquals(data.truncated, [{ repo: "org/repo", dropped: 129 }]);
});

Deno.test("one-shot sweep targets a single named thread without searching", async () => {
  const { ghFn, calls } = makeGhFn({}, {
    "org/repo#3750": [
      {
        id: 7,
        body: clearedBody("host-A"),
        author: "vibe-bot",
        updatedAt: isoAt(NOW - 10 * 86400),
      },
      {
        id: 8,
        body: clearedBody("host-A"),
        author: "vibe-bot",
        updatedAt: isoAt(NOW - 10 * 86400),
      },
    ],
  });

  const data = await sweepHeartbeatCommentsAcrossRepos({
    repos: ["org/repo"],
    allowedAuthors: FLEET,
    issueNumber: 3750,
    ghFn,
  });

  assertEquals(calls.some((c) => c.includes("search/issues")), false);
  assertEquals(data.threads[0]?.issue, 3750);
  // Every marker was released, so the thread legitimately ends with none.
  assertEquals(data.totals.deleted, 2);
});
