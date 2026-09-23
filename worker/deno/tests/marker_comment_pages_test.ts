/**
 * Tests for `marker_comment_pages.ts` (Issue #2531).
 *
 * The module is the single place the fleet reads and rewrites its own marker
 * comments, so the `gh` argv it builds is the whole contract. Every test calls
 * the real function with a stubbed `gh` and asserts on the recorded argv or
 * the returned rows — never on source text.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  deleteIssueComment,
  fetchMarkerComments,
  parseMarkerCommentPages,
  updateIssueComment,
} from "../lib/marker_comment_pages.ts";

Deno.test("updateIssueComment - PATCHes the comment body by id", async () => {
  const calls: string[][] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    return Promise.resolve("{}");
  };

  await updateIssueComment("owner/repo", 4242, "new body\nsecond line", ghFn);

  assertEquals(calls, [[
    "api",
    "-X",
    "PATCH",
    "repos/owner/repo/issues/comments/4242",
    "-f",
    "body=new body\nsecond line",
  ]]);
});

Deno.test("updateIssueComment - a refused edit fails loud", async () => {
  const ghFn = (): Promise<string> =>
    Promise.reject(new Error("gh: HTTP 403 forbidden"));

  let thrown: unknown;
  try {
    await updateIssueComment("owner/repo", 1, "body", ghFn);
  } catch (err) {
    thrown = err;
  }

  // A silently swallowed edit would leave a stale comment reading as current.
  assert(thrown instanceof Error, "expected the failure to surface");
  assertStringIncludes(thrown.message, "403");
});

Deno.test("deleteIssueComment - DELETEs the comment by id", async () => {
  const calls: string[][] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    return Promise.resolve("");
  };

  assertEquals(await deleteIssueComment("owner/repo", 7, ghFn), null);
  assertEquals(calls, [[
    "api",
    "-X",
    "DELETE",
    "repos/owner/repo/issues/comments/7",
  ]]);
});

Deno.test("fetchMarkerComments - reads every page and keeps the author", async () => {
  const calls: string[][] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    return Promise.resolve([
      JSON.stringify([{
        id: 1,
        body: '<!-- vibe-marker key="a" -->',
        created_at: "2026-09-22T12:00:00Z",
        author: "vibe-bot",
      }]),
      JSON.stringify([{
        id: 2,
        body: "unrelated",
        created_at: "2026-09-22T13:00:00Z",
        author: "mallory",
      }]),
    ].join("\n"));
  };

  const rows = await fetchMarkerComments("owner/repo", 9, "vibe-marker", ghFn);

  assertEquals(rows, [{
    id: 1,
    body: '<!-- vibe-marker key="a" -->',
    createdAt: "2026-09-22T12:00:00Z",
    author: "vibe-bot",
  }]);
  assert(calls[0].includes("--paginate"));
  assertStringIncludes(calls[0].join(" "), "author: .user.login");
});

Deno.test("parseMarkerCommentPages - keeps page order and defaults a missing author", () => {
  const rows = parseMarkerCommentPages(
    JSON.stringify([
      { id: 1, body: "m one", created_at: "2026-09-22T12:00:00Z" },
      { id: 2, body: "m two", created_at: "", author: 7 },
    ]),
    "m ",
  );

  assertEquals(rows.map((r) => r.id), [1, 2]);
  assertEquals(rows[0].author, null);
  assertEquals(rows[1].author, null);
});
