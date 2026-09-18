/**
 * Tests for the fleet-wide milestone stream lock (Issue #2334).
 *
 * One run per milestone stream at a time: a sibling open issue of the same
 * milestone whose heartbeat is beating — or whose claim was posted seconds
 * ago — holds the stream, and anything older is stale and holds nothing.
 *
 * Every test drives the real `checkMilestoneStreamBusy` through an injected
 * `gh` runner and asserts on its result and on the calls it made.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkMilestoneStreamBusy,
  formatStreamBusy,
  STREAM_LOCK_ISSUE_LIMIT,
} from "../lib/stream_lock.ts";
import { LIVE_HEARTBEAT_WINDOW_SECONDS } from "../lib/claim_issue.ts";
import { formatHeartbeatMarker } from "../lib/heartbeat_storage.ts";

const REPO = "stSoftwareAU/VibeCoder";
const MILESTONE = "#2319 session resume on by default";
const NOW = 1_700_000_000;
const FLEET = ["VibeCoderST", "stservice"];

/** A comment as `gh issue list --json comments` returns it. */
function comment(
  body: string,
  options: { author?: string; createdAt?: string } = {},
): { body: string; author: { login: string }; createdAt: string } {
  return {
    body,
    author: { login: options.author ?? "stservice" },
    createdAt: options.createdAt ?? new Date(0).toISOString(),
  };
}

/** A claim comment of the shape `claimIssue` posts. */
function claimComment(workerId: string, host: string): string {
  return `<!-- CLAIM_LOCK:${workerId} -->\nClaimed by \`${workerId}\` on ` +
    `host \`${host}\``;
}

/** A `gh` runner answering the stream lock's one listing call. */
function listGh(issues: unknown[]): {
  ghCommandFn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve(JSON.stringify(issues));
  };
  return { ghCommandFn, calls };
}

Deno.test("checkMilestoneStreamBusy - a sibling beating 30 s ago holds the stream", async () => {
  const { ghCommandFn, calls } = listGh([
    {
      number: 2333,
      comments: [comment(formatHeartbeatMarker("GRQ-23-box", NOW - 30))],
    },
  ]);

  const status = await checkMilestoneStreamBusy({
    repo: REPO,
    milestoneTitle: MILESTONE,
    issueNumber: 2334,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assert(status.busy);
  assertEquals(status.holderIssue, 2333);
  assertEquals(status.holderHost, "GRQ-23-box");
  assertEquals(status.evidence, "heartbeat");
  // Exactly one listing call — the check costs one extra `gh issue list`.
  assertEquals(calls.length, 1);
  const listing = (calls[0] ?? []).join(" ");
  assertStringIncludes(listing, "issue list");
  assertStringIncludes(listing, "--state open");
  assertStringIncludes(listing, `--milestone ${MILESTONE}`);
  assertStringIncludes(listing, `--limit ${STREAM_LOCK_ISSUE_LIMIT}`);
});

Deno.test("checkMilestoneStreamBusy - a heartbeat older than the live window is stale", async () => {
  const { ghCommandFn } = listGh([
    {
      number: 2333,
      comments: [
        comment(
          formatHeartbeatMarker(
            "GRQ-23-box",
            NOW - LIVE_HEARTBEAT_WINDOW_SECONDS - 1,
          ),
        ),
      ],
    },
  ]);

  const status = await checkMilestoneStreamBusy({
    repo: REPO,
    milestoneTitle: MILESTONE,
    issueNumber: 2334,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assertEquals(status.busy, false);
});

Deno.test("checkMilestoneStreamBusy - a released marker holds nothing", async () => {
  const released = `${formatHeartbeatMarker("GRQ-23-box", 0)} ` +
    `<!-- cleared: claim released by machine GRQ-23-box -->`;
  const { ghCommandFn } = listGh([
    { number: 2333, comments: [comment(released)] },
  ]);

  const status = await checkMilestoneStreamBusy({
    repo: REPO,
    milestoneTitle: MILESTONE,
    issueNumber: 2334,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assertEquals(status.busy, false);
});

Deno.test("checkMilestoneStreamBusy - a fresh fleet CLAIM_LOCK holds the stream", async () => {
  const { ghCommandFn } = listGh([
    {
      number: 2333,
      comments: [
        comment(claimComment("VibeCoderST-1", "Mac-Ultra-M2"), {
          createdAt: new Date((NOW - 10) * 1000).toISOString(),
        }),
      ],
    },
  ]);

  const status = await checkMilestoneStreamBusy({
    repo: REPO,
    milestoneTitle: MILESTONE,
    issueNumber: 2334,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assert(status.busy);
  assertEquals(status.holderIssue, 2333);
  assertEquals(status.holderHost, "Mac-Ultra-M2");
  assertEquals(status.evidence, "claim_lock");
});

Deno.test("checkMilestoneStreamBusy - a CLAIM_LOCK past the recent window is stale", async () => {
  const { ghCommandFn } = listGh([
    {
      number: 2333,
      comments: [
        comment(claimComment("VibeCoderST-1", "Mac-Ultra-M2"), {
          createdAt: new Date((NOW - 3600) * 1000).toISOString(),
        }),
      ],
    },
  ]);

  const status = await checkMilestoneStreamBusy({
    repo: REPO,
    milestoneTitle: MILESTONE,
    issueNumber: 2334,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assertEquals(status.busy, false);
});

Deno.test("checkMilestoneStreamBusy - the issue being claimed never blocks itself", async () => {
  const { ghCommandFn } = listGh([
    {
      number: 2334,
      comments: [comment(formatHeartbeatMarker("this-host", NOW - 5))],
    },
  ]);

  const status = await checkMilestoneStreamBusy({
    repo: REPO,
    milestoneTitle: MILESTONE,
    issueNumber: 2334,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assertEquals(status.busy, false);
});

/** An issue on the fake GitHub the query filters against. */
interface FakeIssue {
  repo: string;
  milestone: string;
  state: "open" | "closed";
  number: number;
  comments: ReturnType<typeof comment>[];
}

/**
 * A `gh` runner that honours `--repo`, `--state` and `--milestone` the way
 * GitHub does, so the check is held to the query it actually issues.
 */
function fakeGitHub(issues: FakeIssue[]): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const value = (flag: string): string => args[args.indexOf(flag) + 1] ?? "";
    const repo = value("--repo");
    const state = value("--state");
    const milestone = value("--milestone");
    const matched = issues.filter((issue) =>
      issue.repo === repo &&
      issue.state === state &&
      issue.milestone === milestone
    );
    return Promise.resolve(
      JSON.stringify(
        matched.map((issue) => ({
          number: issue.number,
          comments: issue.comments,
        })),
      ),
    );
  };
}

Deno.test("checkMilestoneStreamBusy - a closed, differently-milestoned or foreign sibling never blocks", async () => {
  const beating = [comment(formatHeartbeatMarker("GRQ-23-box", NOW - 30))];
  const ghCommandFn = fakeGitHub([
    // Same milestone, but closed — its run is over.
    {
      repo: REPO,
      milestone: MILESTONE,
      state: "closed",
      number: 2331,
      comments: beating,
    },
    // Open and live, but a different milestone — a different conversation.
    {
      repo: REPO,
      milestone: "#2298 merge conflicts",
      state: "open",
      number: 2299,
      comments: beating,
    },
    // Open, live, same milestone title — but another repository.
    {
      repo: "stSoftwareAU/Other",
      milestone: MILESTONE,
      state: "open",
      number: 7,
      comments: beating,
    },
  ]);

  const status = await checkMilestoneStreamBusy({
    repo: REPO,
    milestoneTitle: MILESTONE,
    issueNumber: 2334,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assertEquals(status.busy, false);
});

Deno.test("checkMilestoneStreamBusy - an open live sibling of the same milestone does block", async () => {
  const ghCommandFn = fakeGitHub([
    {
      repo: REPO,
      milestone: MILESTONE,
      state: "open",
      number: 2333,
      comments: [comment(formatHeartbeatMarker("GRQ-23-box", NOW - 30))],
    },
  ]);

  const status = await checkMilestoneStreamBusy({
    repo: REPO,
    milestoneTitle: MILESTONE,
    issueNumber: 2334,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assert(status.busy);
  assertEquals(status.holderIssue, 2333);
});

Deno.test("checkMilestoneStreamBusy - a marker forged by a non-fleet author holds nothing", async () => {
  const { ghCommandFn } = listGh([
    {
      number: 2333,
      comments: [
        comment(formatHeartbeatMarker("attacker-box", NOW - 5), {
          author: "random-user",
        }),
        comment(claimComment("attacker-1", "attacker-box"), {
          author: "random-user",
          createdAt: new Date((NOW - 5) * 1000).toISOString(),
        }),
      ],
    },
  ]);

  const status = await checkMilestoneStreamBusy({
    repo: REPO,
    milestoneTitle: MILESTONE,
    issueNumber: 2334,
    ghCommandFn,
    trustedAuthors: FLEET,
    nowSeconds: NOW,
  });

  assertEquals(status.busy, false);
});

Deno.test("checkMilestoneStreamBusy - a blank-stream issue is never checked", async () => {
  const { ghCommandFn, calls } = listGh([
    {
      number: 2333,
      comments: [comment(formatHeartbeatMarker("GRQ-23-box", NOW - 5))],
    },
  ]);

  for (const milestoneTitle of [undefined, "", "   "]) {
    const status = await checkMilestoneStreamBusy({
      repo: REPO,
      ...(milestoneTitle === undefined ? {} : { milestoneTitle }),
      issueNumber: 2334,
      ghCommandFn,
      trustedAuthors: FLEET,
      nowSeconds: NOW,
    });
    assertEquals(status.busy, false);
  }
  assertEquals(calls.length, 0, "the blank stream costs no API call");
});

Deno.test("checkMilestoneStreamBusy - a gh failure fails open and says so", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const status = await checkMilestoneStreamBusy({
      repo: REPO,
      milestoneTitle: MILESTONE,
      issueNumber: 2334,
      ghCommandFn: () => Promise.reject(new Error("HTTP 503: gh is down")),
      trustedAuthors: FLEET,
      nowSeconds: NOW,
    });
    assertEquals(status.busy, false);
  } finally {
    console.warn = originalWarn;
  }
  assert(
    warnings.some((line) => line.includes("stream_check_failed")),
    "a failed stream check must be reported, not swallowed",
  );
});

Deno.test("checkMilestoneStreamBusy - unparseable JSON fails open", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const status = await checkMilestoneStreamBusy({
      repo: REPO,
      milestoneTitle: MILESTONE,
      issueNumber: 2334,
      ghCommandFn: () => Promise.resolve("not json"),
      trustedAuthors: FLEET,
      nowSeconds: NOW,
    });
    assertEquals(status.busy, false);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("formatStreamBusy - names the stream, the holder issue and the host", () => {
  const line = formatStreamBusy({
    busy: true,
    holderIssue: 2333,
    holderHost: "GRQ-23",
    streamLabel: `${REPO}${MILESTONE}`,
    evidence: "heartbeat",
  });
  assertEquals(
    line,
    `stream busy: ${REPO}${MILESTONE} held by #2333 on GRQ-23`,
  );
});
