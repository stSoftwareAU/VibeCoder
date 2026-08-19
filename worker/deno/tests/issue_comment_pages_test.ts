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

/** Build a page of `n` comment objects, each carrying `body`. */
function page(n: number, body = "hello"): string {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ id: i, body })),
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
    await issueCommentsContainMarker("owner/repo", 7, marker, fn),
    true,
  );
  assertEquals(calls.length, 1, "must stop at the first page that matches");
});

Deno.test("issue_comment_pages - marker check returns false after reading every page", async () => {
  const { fn, calls } = pagingGh([page(COMMENTS_PER_PAGE), page(2)]);
  assertEquals(
    await issueCommentsContainMarker("owner/repo", 7, "<!-- absent -->", fn),
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
    await issueCommentsContainMarker("owner/repo", 7, "<!-- absent -->", fn),
    false,
  );
  assertEquals(calls.length, MAX_COMMENT_PAGES);
});
