/**
 * Tests for bounded comment-thread pagination (Issue #3709,
 * SEC-2ab604fe9137).
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  COMMENTS_PER_PAGE,
  fetchIssueCommentPages,
  issueCommentsContainMarker,
  MAX_COMMENT_PAGES,
} from "../lib/issue_comment_pages.ts";

/** The fleet login every verified-marker test writes its comments as. */
const FLEET_LOGIN = "vibe-coder-bot";

/** Fleet identity the marker check is given instead of reading a config. */
const FLEET = { fleetAuthors: [FLEET_LOGIN] };

/** Swallow the author-verification diagnostics so test output stays readable. */
const quiet = () => {};

/**
 * Build a page of `n` comment objects, each carrying `body` and authored by
 * `login` — the `user.login` shape the REST comments endpoint returns.
 */
function page(n: number, body = "hello", login = FLEET_LOGIN): string {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ id: i, body, user: { login } })),
  );
}

/** A gh stub that serves the given pages in order and records the args. */
function pagingGh(pages: string[]) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const match = /[?&]page=(\d+)/.exec(args[1] ?? "");
    const index = match ? Number(match[1]) - 1 : 0;
    return Promise.resolve(pages[index] ?? "[]");
  };
  return { fn, calls };
}

Deno.test("issue_comment_pages - single short page stops after one call", async () => {
  const { fn, calls } = pagingGh([page(3)]);
  const comments = await fetchIssueCommentPages("owner/repo", 7, fn);
  assertEquals(comments.length, 3);
  assertEquals(calls.length, 1, "a short page is the last page");
});

Deno.test("issue_comment_pages - follows pages until a short page", async () => {
  const { fn, calls } = pagingGh([
    page(COMMENTS_PER_PAGE),
    page(COMMENTS_PER_PAGE),
    page(5),
  ]);
  const comments = await fetchIssueCommentPages("owner/repo", 7, fn);
  assertEquals(comments.length, COMMENTS_PER_PAGE * 2 + 5);
  assertEquals(calls.length, 3);
});

Deno.test("issue_comment_pages - empty body is treated as an empty page", async () => {
  const { fn } = pagingGh([""]);
  assertEquals((await fetchIssueCommentPages("owner/repo", 7, fn)).length, 0);
});

Deno.test("issue_comment_pages - fails loud when the page cap is exceeded", async () => {
  // Every page is full, so the thread is longer than we can read: throwing
  // beats silently returning a truncated thread.
  const { fn, calls } = pagingGh(
    Array.from(
      { length: MAX_COMMENT_PAGES + 2 },
      () => page(COMMENTS_PER_PAGE),
    ),
  );
  await assertRejects(
    () => fetchIssueCommentPages("owner/repo", 7, fn),
    Error,
    "exceeded",
  );
  assertEquals(
    calls.length,
    MAX_COMMENT_PAGES,
    "must never request more than the page cap",
  );
});

Deno.test("issue_comment_pages - non-array response throws", async () => {
  const { fn } = pagingGh(['{"message":"Not Found"}']);
  await assertRejects(
    () => fetchIssueCommentPages("owner/repo", 7, fn),
    Error,
    "Expected a comments array",
  );
});

Deno.test("issue_comment_pages - marker check short-circuits on the first matching page", async () => {
  const marker = "<!-- vibe-coder:ci-nudge -->";
  const { fn, calls } = pagingGh([
    page(COMMENTS_PER_PAGE, `already nudged ${marker}`),
    page(COMMENTS_PER_PAGE),
    page(1),
  ]);
  assertEquals(
    await issueCommentsContainMarker("owner/repo", 7, marker, fn, FLEET, quiet),
    true,
  );
  assertEquals(calls.length, 1, "must stop at the first page that matches");
});

Deno.test("issue_comment_pages - marker check returns false after reading every page", async () => {
  const { fn, calls } = pagingGh([page(COMMENTS_PER_PAGE), page(2)]);
  assertEquals(
    await issueCommentsContainMarker(
      "owner/repo",
      7,
      "<!-- absent -->",
      fn,
      FLEET,
      quiet,
    ),
    false,
  );
  assertEquals(calls.length, 2);
});

Deno.test("issue_comment_pages - marker check honours the page cap", async () => {
  const { fn, calls } = pagingGh(
    Array.from(
      { length: MAX_COMMENT_PAGES + 5 },
      () => page(COMMENTS_PER_PAGE),
    ),
  );
  assertEquals(
    await issueCommentsContainMarker(
      "owner/repo",
      7,
      "<!-- absent -->",
      fn,
      FLEET,
      quiet,
    ),
    false,
  );
  assertEquals(calls.length, MAX_COMMENT_PAGES);
});

// ---------------------------------------------------------------------------
// Author verification (Issue #1216)
//
// A comment body is text any GitHub account may write, and every caller of
// `issueCommentsContainMarker` uses a match to SUPPRESS an action. Matching on
// the body alone therefore let one planted comment silence the blocking-PR
// stall escalation, a stall-reason comment, a self-schedule announcement or a
// CI nudge on that thread for good.
// ---------------------------------------------------------------------------

Deno.test("issue_comment_pages - a planted marker from outside the fleet does not count", async () => {
  const marker = "<!-- vibe-coder:ci-nudge -->";
  const { fn, calls } = pagingGh([
    page(3, `nothing to see here ${marker}`, "drive-by-attacker"),
  ]);
  assertEquals(
    await issueCommentsContainMarker("owner/repo", 7, marker, fn, FLEET, quiet),
    false,
    "an outsider's marker comment must not suppress the worker's action",
  );
  assertEquals(calls.length, 1);
});

Deno.test("issue_comment_pages - a fleet marker still counts on a thread an outsider also marked", async () => {
  const marker = "<!-- vibe-coder:ci-nudge -->";
  const thread = JSON.stringify([
    { id: 1, body: `planted ${marker}`, user: { login: "drive-by-attacker" } },
    { id: 2, body: `nudged ${marker}`, user: { login: FLEET_LOGIN } },
  ]);
  const { fn } = pagingGh([thread]);
  assertEquals(
    await issueCommentsContainMarker("owner/repo", 7, marker, fn, FLEET, quiet),
    true,
    "the fleet's own marker is still evidence beside a planted one",
  );
});

Deno.test("issue_comment_pages - the search continues past a page of planted markers", async () => {
  const marker = "<!-- vibe-coder:ci-nudge -->";
  const { fn, calls } = pagingGh([
    page(COMMENTS_PER_PAGE, `planted ${marker}`, "drive-by-attacker"),
    page(1, `nudged ${marker}`),
  ]);
  assertEquals(
    await issueCommentsContainMarker("owner/repo", 7, marker, fn, FLEET, quiet),
    true,
    "a page an outsider flooded must not hide the fleet's marker behind it",
  );
  assertEquals(calls.length, 2);
});

Deno.test("issue_comment_pages - an authorless comment carrying the marker does not count", async () => {
  const marker = "<!-- vibe-coder:ci-nudge -->";
  const thread = JSON.stringify([{ id: 1, body: `ghost ${marker}` }]);
  const { fn } = pagingGh([thread]);
  assertEquals(
    await issueCommentsContainMarker("owner/repo", 7, marker, fn, FLEET, quiet),
    false,
    "a comment whose author cannot be read is unattributable, so it fails towards acting",
  );
});

Deno.test("issue_comment_pages - an unresolvable fleet identity fails towards acting", async () => {
  const marker = "<!-- vibe-coder:ci-nudge -->";
  const { fn } = pagingGh([page(2, `nudged ${marker}`)]);
  const logged: string[] = [];
  assertEquals(
    await issueCommentsContainMarker(
      "owner/repo",
      7,
      marker,
      fn,
      { fleetAuthors: [] },
      (message) => logged.push(message),
    ),
    false,
    "no fleet identity means no marker can be attributed",
  );
  assertEquals(
    logged.some((m) => m.includes("fleet author set unresolved")),
    true,
    "the unverifiable condition must be logged loudly, never inferred",
  );
});

Deno.test("issue_comment_pages - the marker must be in a comment body, not anywhere in the payload", async () => {
  // The old check substring-matched the raw page JSON, so a marker appearing
  // in any field at all — a login, a URL — read as a marker comment.
  const marker = "<!-- vibe-coder:ci-nudge -->";
  const thread = JSON.stringify([
    { id: 1, body: "unrelated", user: { login: FLEET_LOGIN }, note: marker },
  ]);
  const { fn } = pagingGh([thread]);
  assertEquals(
    await issueCommentsContainMarker("owner/repo", 7, marker, fn, FLEET, quiet),
    false,
  );
});
