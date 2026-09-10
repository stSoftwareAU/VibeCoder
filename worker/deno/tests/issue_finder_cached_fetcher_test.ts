/**
 * The dependency fetcher reads a referenced issue once per iteration
 * (Issue #1818).
 *
 * `find_oldest_issue.ts` built a fresh fetcher per `findNextIssue`, so an
 * idle slot re-scanning every minute re-viewed every referenced issue each
 * time — ~700 `gh issue view` GraphQL calls a cycle on GRQ-25, which
 * exhausted the fleet's shared quota mid-window. Backed by the iteration
 * `IssueCache`, a second scan serves the same issue from the cache.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  createIssueFetcher,
  ISSUE_BODY_CACHE_PREFIX,
  ISSUE_STATE_CACHE_PREFIX,
} from "../lib/issue_finder_common.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { closeInvalidatedCacheKeys } from "../lib/issue_close_notifier.ts";

function ghStub(calls: string[][]) {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    const command = args.join(" ");
    if (command.includes("number,state,title")) {
      return Promise.resolve(
        JSON.stringify({ number: 7, state: "OPEN", title: "Parent" }),
      );
    }
    if (command.includes("--json body")) {
      return Promise.resolve(JSON.stringify({ body: "Depends on #3" }));
    }
    if (command.includes("/sub_issues")) {
      return Promise.resolve(JSON.stringify([{ number: 8 }, { number: 9 }]));
    }
    return Promise.resolve("");
  };
}

Deno.test("cached fetcher #1818 - a second scan in the same iteration serves state, body and sub-issues from the cache", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const cache = new IssueCache(dir, 600);
    const calls: string[][] = [];
    const gh = ghStub(calls);

    // Scan 1: a fresh fetcher, as each findNextIssue builds one.
    const first = createIssueFetcher(gh, cache);
    assertEquals((await first.getIssueState("o/r", 7)).state, "OPEN");
    assertEquals(await first.getIssueBody("o/r", 7), "Depends on #3");
    assertEquals(await first.getSubIssues("o/r", 7), [8, 9]);
    assertEquals(calls.length, 3);

    // Scan 2: another fresh fetcher — the idle re-scan — reads nothing.
    const second = createIssueFetcher(gh, cache);
    assertEquals((await second.getIssueState("o/r", 7)).state, "OPEN");
    assertEquals(await second.getIssueBody("o/r", 7), "Depends on #3");
    assertEquals(await second.getSubIssues("o/r", 7), [8, 9]);
    assertEquals(calls.length, 3, "the re-scan issued no gh call");

    // The keys are per repo: another repo's #7 is its own read.
    await second.getIssueBody("o/other", 7);
    assertEquals(calls.length, 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cached fetcher #1818 - without a cache every scan reads live, as before", async () => {
  const calls: string[][] = [];
  const gh = ghStub(calls);
  await createIssueFetcher(gh).getIssueBody("o/r", 7);
  await createIssueFetcher(gh).getIssueBody("o/r", 7);
  assertEquals(calls.length, 2);
});

Deno.test("cached fetcher #1818 - a close invalidates the cached state, not the body", () => {
  const keys = closeInvalidatedCacheKeys(7);
  assertEquals(keys.includes(`${ISSUE_STATE_CACHE_PREFIX}7`), true);
  assertEquals(keys.includes(`${ISSUE_BODY_CACHE_PREFIX}7`), false);
});
