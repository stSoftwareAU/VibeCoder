/**
 * Tests for the idle-task activity collector (Issue #2477).
 *
 * Exercises `latestIdleTaskActivity` with a stubbed `gh` runner and an
 * injected clock. Verifies the four required behaviours:
 *   - a freshly-created wrapper yields a recent `lastRaisedEpoch`;
 *   - a wrapper carrying a CLAIM_LOCK comment / a handled (closed) wrapper
 *     yields a `lastClaimedEpoch`;
 *   - a raised-but-never-claimed wrapper yields `lastRaisedEpoch` set and
 *     `lastClaimedEpoch` null (the exact "raised but not claimed within 8h"
 *     case the guard must catch);
 *   - no idle-task issues, and a `gh` failure, both yield `{ null, null }`.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals } from "@std/assert";
import {
  IDLE_TASK_ACTIVITY_WINDOW_SECONDS,
  latestIdleTaskActivity,
} from "../lib/idle_task_activity.ts";
import { CLAIM_MARKER_PREFIX } from "../lib/claim_issue.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";

// A fixed "now" (Unix seconds): 2026-06-02T00:00:00Z.
const NOW = Math.floor(Date.parse("2026-06-02T00:00:00Z") / 1000);
const now = () => NOW;

/** ISO string for `secondsAgo` before NOW. */
function isoAgo(secondsAgo: number): string {
  return new Date((NOW - secondsAgo) * 1000).toISOString();
}

interface IssueRow {
  number: number;
  state: string;
  createdAt: string;
  closedAt: string;
}

/**
 * Build a stubbed `gh` runner. `issues` is returned for `issue list`;
 * `comments` maps an issue number to the CLAIM_LOCK comment timestamps
 * returned by the `api .../comments` jq query.
 */
function makeGh(
  issues: IssueRow[],
  comments: Record<number, string[]> = {},
) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(issues));
    }
    if (args[0] === "api") {
      // args[1] is repos/<repo>/issues/<n>/comments
      const match = args[1]?.match(/issues\/(\d+)\/comments/);
      const num = match ? Number(match[1]) : NaN;
      return Promise.resolve(JSON.stringify(comments[num] ?? []));
    }
    return Promise.resolve("[]");
  };
  return { fn, calls };
}

Deno.test("latestIdleTaskActivity - freshly-raised open wrapper yields recent raised, null claimed", async () => {
  const raisedIso = isoAgo(600); // 10 minutes ago
  const { fn } = makeGh([
    { number: 10, state: "OPEN", createdAt: raisedIso, closedAt: "" },
  ]);

  const result = await latestIdleTaskActivity({
    repo: "o/r",
    ghCommandFn: fn,
    nowFn: now,
  });

  assertEquals(result.lastRaisedEpoch, NOW - 600);
  // Raised but never claimed — the exact case the 8h guard must catch.
  assertEquals(result.lastClaimedEpoch, null);
});

Deno.test("latestIdleTaskActivity - open wrapper with CLAIM_LOCK comment yields claimed epoch", async () => {
  const raisedIso = isoAgo(900);
  const claimIso = isoAgo(800);
  const { fn, calls } = makeGh(
    [{ number: 11, state: "OPEN", createdAt: raisedIso, closedAt: "" }],
    { 11: [claimIso] },
  );

  const result = await latestIdleTaskActivity({
    repo: "o/r",
    ghCommandFn: fn,
    nowFn: now,
  });

  assertEquals(result.lastRaisedEpoch, NOW - 900);
  assertEquals(result.lastClaimedEpoch, NOW - 800);
  // The comment lookup queried this issue's comments with the CLAIM marker.
  const apiCall = calls.find((c) => c[0] === "api");
  assertEquals(apiCall?.[1], "repos/o/r/issues/11/comments");
  assertEquals(apiCall?.[3]?.includes(CLAIM_MARKER_PREFIX), true);
});

Deno.test("latestIdleTaskActivity - handled (closed) wrapper uses closedAt as claim proxy", async () => {
  const raisedIso = isoAgo(1200);
  const closedIso = isoAgo(1000);
  // A closed wrapper resolves its claim epoch from closedAt with no comment call.
  const { fn, calls } = makeGh([
    { number: 12, state: "CLOSED", createdAt: raisedIso, closedAt: closedIso },
  ]);

  const result = await latestIdleTaskActivity({
    repo: "o/r",
    ghCommandFn: fn,
    nowFn: now,
  });

  assertEquals(result.lastRaisedEpoch, NOW - 1200);
  assertEquals(result.lastClaimedEpoch, NOW - 1000);
  // No comments API call needed for a closed wrapper (close is the proxy).
  assertEquals(calls.some((c) => c[0] === "api"), false);
});

Deno.test("latestIdleTaskActivity - no idle-task issues yields null/null", async () => {
  const { fn } = makeGh([]);
  const result = await latestIdleTaskActivity({
    repo: "o/r",
    ghCommandFn: fn,
    nowFn: now,
  });
  assertEquals(result, { lastRaisedEpoch: null, lastClaimedEpoch: null });
});

Deno.test("latestIdleTaskActivity - gh failure on listing yields null/null (no signal)", async () => {
  const fn = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("gh boom"));
  const result = await latestIdleTaskActivity({
    repo: "o/r",
    ghCommandFn: fn,
    nowFn: now,
  });
  assertEquals(result, { lastRaisedEpoch: null, lastClaimedEpoch: null });
});

Deno.test("latestIdleTaskActivity - reports the most-recent across several wrappers", async () => {
  const { fn } = makeGh(
    [
      {
        number: 20,
        state: "CLOSED",
        createdAt: isoAgo(5000),
        closedAt: isoAgo(4900),
      },
      {
        number: 21,
        state: "CLOSED",
        createdAt: isoAgo(3000),
        closedAt: isoAgo(2900),
      },
      { number: 22, state: "OPEN", createdAt: isoAgo(1000), closedAt: "" },
    ],
    { 22: [isoAgo(950)] },
  );

  const result = await latestIdleTaskActivity({
    repo: "o/r",
    ghCommandFn: fn,
    nowFn: now,
  });

  // Most-recent raise is the open wrapper (#22).
  assertEquals(result.lastRaisedEpoch, NOW - 1000);
  // Most-recent claim is #22's CLAIM_LOCK comment.
  assertEquals(result.lastClaimedEpoch, NOW - 950);
});

Deno.test("latestIdleTaskActivity - wrappers outside the window are ignored", async () => {
  const stale = IDLE_TASK_ACTIVITY_WINDOW_SECONDS + 3600; // older than the window
  const { fn } = makeGh([
    {
      number: 30,
      state: "CLOSED",
      createdAt: isoAgo(stale),
      closedAt: isoAgo(stale - 60),
    },
  ]);

  const result = await latestIdleTaskActivity({
    repo: "o/r",
    ghCommandFn: fn,
    nowFn: now,
  });

  assertEquals(result, { lastRaisedEpoch: null, lastClaimedEpoch: null });
});

Deno.test("latestIdleTaskActivity - claim-comment lookup failure leaves claimed null but keeps raised", async () => {
  const raisedIso = isoAgo(700);
  const fn = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(
        JSON.stringify([
          { number: 40, state: "OPEN", createdAt: raisedIso, closedAt: "" },
        ]),
      );
    }
    // Comments lookup fails — best-effort, must not discard the raised signal.
    return Promise.reject(new Error("comments boom"));
  };

  const result = await latestIdleTaskActivity({
    repo: "o/r",
    ghCommandFn: fn,
    nowFn: now,
  });

  assertEquals(result.lastRaisedEpoch, NOW - 700);
  assertEquals(result.lastClaimedEpoch, null);
});

Deno.test("latestIdleTaskActivity - issue list query uses the idle-task label and state all", async () => {
  const { fn, calls } = makeGh([]);
  await latestIdleTaskActivity({ repo: "o/r", ghCommandFn: fn, nowFn: now });
  const listCall = calls.find((c) => c[0] === "issue" && c[1] === "list");
  assertEquals(listCall?.includes(IDLE_TASK_LABEL), true);
  assertEquals(listCall?.includes("all"), true);
});
