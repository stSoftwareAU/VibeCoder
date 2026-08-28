/**
 * Tests for comment_batch.ts (Issue #1842).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  COMMENT_BATCH_SIZE,
  COMMENTS_PER_ISSUE,
  fetchCommentBatch,
} from "../lib/comment_batch.ts";
import {
  type FakeComment,
  fakeGithubGraphQL,
} from "./support/github_graphql_fake.ts";

// =============================================================================
// Behaviour against a fake that models GitHub's own connection rules
// =============================================================================

Deno.test("comment_batch - each issue receives its own comments (Issue #471)", async () => {
  const { gh } = fakeGithubGraphQL({
    owner: "acme",
    name: "tools",
    issues: {
      10: {
        comments: [{
          databaseId: 1,
          author: "alice",
          body: "on ten",
          createdAt: "2024-01-01T00:00:00Z",
        }],
      },
      20: {
        comments: [{
          databaseId: 2,
          author: "bob",
          body: "on twenty",
          createdAt: "2024-02-01T00:00:00Z",
        }],
      },
    },
  });

  const result = await fetchCommentBatch("acme/tools", [10, 20], gh);
  assertEquals(result.failedNumbers, []);
  assertEquals(result.comments.get(10)?.[0]?.body, "on ten");
  assertEquals(result.comments.get(10)?.[0]?.author, "alice");
  assertEquals(result.comments.get(20)?.[0]?.body, "on twenty");
  assertEquals(result.comments.get(20)?.[0]?.author, "bob");
});

Deno.test("comment_batch - the newest comments are the ones fetched (Issue #471)", async () => {
  // Twice the per-issue budget exists on the issue. GitHub's `last: n` returns
  // the tail, so the fetcher must come back with the newest COMMENTS_PER_ISSUE
  // comments — a fetcher reading the head would return the oldest instead.
  const comments: FakeComment[] = [];
  for (let i = 0; i < COMMENTS_PER_ISSUE * 2; i++) {
    comments.push({
      databaseId: i,
      author: "alice",
      body: `comment-${i}`,
      createdAt: `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    });
  }

  const { gh } = fakeGithubGraphQL({
    owner: "acme",
    name: "tools",
    issues: { 7: { comments } },
  });

  const result = await fetchCommentBatch("acme/tools", [7], gh);
  const got = result.comments.get(7) ?? [];
  assertEquals(got.length, COMMENTS_PER_ISSUE);
  assertEquals(got.at(-1)?.body, `comment-${COMMENTS_PER_ISSUE * 2 - 1}`);
});

Deno.test("comment_batch - a repository the API cannot resolve fails the batch (Issue #471)", async () => {
  const { gh } = fakeGithubGraphQL({
    owner: "acme",
    name: "tools",
    issues: { 7: { comments: [] } },
  });
  const result = await fetchCommentBatch("acme/other", [7], gh);
  assertEquals(result.failedNumbers, [7]);
  assertEquals(result.comments.size, 0);
});

// =============================================================================
// fetchCommentBatch — happy path / empty / batching / failure
// =============================================================================

function fakeGraphQLResponse(numbers: number[]): string {
  const repo: Record<string, unknown> = {};
  for (let i = 0; i < numbers.length; i++) {
    repo[`n${i}`] = {
      comments: {
        nodes: [
          {
            databaseId: numbers[i]! * 1000,
            author: { login: `user-${numbers[i]}` },
            body: `comment-for-${numbers[i]}`,
            createdAt: "2024-05-01T00:00:00Z",
          },
        ],
      },
    };
  }
  return JSON.stringify({ data: { repository: repo } });
}

Deno.test("comment_batch - fetchCommentBatch happy path returns comments per issue", async () => {
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    assertEquals(args[0], "api");
    assertEquals(args[1], "graphql");
    assertEquals(args[2], "-f");
    assert(args[3]?.startsWith("query="));
    return Promise.resolve(fakeGraphQLResponse([1, 2, 3]));
  };
  const result = await fetchCommentBatch("acme/tools", [1, 2, 3], gh);
  assertEquals(calls, 1);
  assertEquals(result.callCount, 1);
  assertEquals(result.errors.length, 0);
  assertEquals(result.failedNumbers.length, 0);
  assertEquals(result.comments.size, 3);
  const c2 = result.comments.get(2);
  assert(c2 && c2.length === 1);
  assertEquals(c2[0]?.id, 2000);
  assertEquals(c2[0]?.author, "user-2");
  assertEquals(c2[0]?.body, "comment-for-2");
  assertEquals(c2[0]?.createdAt, "2024-05-01T00:00:00Z");
  // Reactions default to zero — the batch does not query them.
  assertEquals(c2[0]?.reactions, { thumbsUp: 0, eyes: 0, confused: 0 });
});

Deno.test("comment_batch - fetchCommentBatch empty input issues no calls", async () => {
  let calls = 0;
  const gh = (_args: string[]): Promise<string> => {
    calls++;
    return Promise.resolve("{}");
  };
  const result = await fetchCommentBatch("acme/tools", [], gh);
  assertEquals(calls, 0);
  assertEquals(result.callCount, 0);
  assertEquals(result.comments.size, 0);
  assertEquals(result.errors.length, 0);
});

Deno.test("comment_batch - fetchCommentBatch splits batches at 25", async () => {
  const numbers = Array.from({ length: 30 }, (_, i) => i + 1);
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    const query = (args[3] ?? "").substring("query=".length);
    const matches = query.match(/issue\(number: (\d+)\)/g) ?? [];
    return Promise.resolve(
      fakeGraphQLResponse(matches.map((m) => Number(m.match(/\d+/)![0]))),
    );
  };
  const result = await fetchCommentBatch("acme/tools", numbers, gh);
  assertEquals(COMMENT_BATCH_SIZE, 25);
  assertEquals(calls, 2);
  assertEquals(result.callCount, 2);
  assertEquals(result.comments.size, 30);
});

Deno.test("comment_batch - fetchCommentBatch boundary: exactly 25 issues = 1 call", async () => {
  const numbers = Array.from({ length: 25 }, (_, i) => i + 1);
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    const query = (args[3] ?? "").substring("query=".length);
    const matches = query.match(/issue\(number: (\d+)\)/g) ?? [];
    return Promise.resolve(
      fakeGraphQLResponse(matches.map((m) => Number(m.match(/\d+/)![0]))),
    );
  };
  const result = await fetchCommentBatch("acme/tools", numbers, gh);
  assertEquals(calls, 1);
  assertEquals(result.comments.size, 25);
});

Deno.test("comment_batch - fetchCommentBatch records failure for a sub-batch and continues", async () => {
  // 30 candidates → 2 sub-batches. The first sub-batch fails; the
  // second succeeds. The whole scan must continue: returned map has
  // the 5 second-batch issues, failedNumbers carries the first 25.
  const numbers = Array.from({ length: 30 }, (_, i) => i + 1);
  let call = 0;
  const gh = (args: string[]): Promise<string> => {
    call++;
    if (call === 1) return Promise.reject(new Error("transient boom"));
    const query = (args[3] ?? "").substring("query=".length);
    const matches = query.match(/issue\(number: (\d+)\)/g) ?? [];
    return Promise.resolve(
      fakeGraphQLResponse(matches.map((m) => Number(m.match(/\d+/)![0]))),
    );
  };
  const result = await fetchCommentBatch("acme/tools", numbers, gh);
  assertEquals(result.callCount, 1); // only the successful call counts
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0]?.message, "transient boom");
  assertEquals(result.failedNumbers.length, 25);
  assertEquals(result.comments.size, 5); // 26..30 succeeded
  assert(result.comments.has(26));
  assert(result.comments.has(30));
});

Deno.test("comment_batch - fetchCommentBatch records GraphQL errors payload as failure", async () => {
  const gh = (_args: string[]): Promise<string> => {
    return Promise.resolve(JSON.stringify({
      errors: [{ message: "Field 'issue' not found" }],
    }));
  };
  const result = await fetchCommentBatch("acme/tools", [1, 2, 3], gh);
  assertEquals(result.errors.length, 1);
  assertEquals(result.failedNumbers, [1, 2, 3]);
  assertEquals(result.comments.size, 0);
});

Deno.test("comment_batch - fetchCommentBatch handles top-level error with data:null", async () => {
  // GraphQL can return a top-level error alongside `data: null`. The
  // caller's guard must catch this and record a failure rather than
  // letting convertBatch dereference a null repository (Issue #2984).
  const gh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify({ data: null }));
  const result = await fetchCommentBatch("acme/tools", [1, 2, 3], gh);
  assertEquals(result.errors.length, 1);
  assertEquals(result.failedNumbers, [1, 2, 3]);
  assertEquals(result.comments.size, 0);
});

Deno.test("comment_batch - fetchCommentBatch rejects malformed repo identifier", async () => {
  const gh = (_args: string[]): Promise<string> => Promise.resolve("{}");
  const r1 = await fetchCommentBatch("not-a-repo", [1], gh);
  assertEquals(r1.errors.length, 1);
  assertEquals(r1.failedNumbers, [1]);

  const r2 = await fetchCommentBatch("ow ner/repo", [1, 2], gh);
  assertEquals(r2.errors.length, 1);
  assertEquals(r2.failedNumbers, [1, 2]);
});

Deno.test("comment_batch - fetchCommentBatch deduplicates issue numbers", async () => {
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    const query = (args[3] ?? "").substring("query=".length);
    const matches = query.match(/issue\(number: (\d+)\)/g) ?? [];
    assertEquals(matches.length, 2); // dedup to [1, 2]
    return Promise.resolve(fakeGraphQLResponse([1, 2]));
  };
  const result = await fetchCommentBatch("acme/tools", [1, 2, 1, 2, 1], gh);
  assertEquals(calls, 1);
  assertEquals(result.comments.size, 2);
});

Deno.test("comment_batch - fetchCommentBatch handles missing comment fields gracefully", async () => {
  // GraphQL returns a node with null/missing fields (deleted user, etc.)
  const gh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify({
      data: {
        repository: {
          n0: {
            comments: {
              nodes: [
                { databaseId: null, author: null, body: null, createdAt: null },
                {
                  databaseId: 1,
                  author: { login: "alice" },
                  body: "hi",
                  createdAt: "2024-01-01T00:00:00Z",
                },
              ],
            },
          },
        },
      },
    }));
  const result = await fetchCommentBatch("acme/tools", [42], gh);
  assertEquals(result.errors.length, 0);
  const comments = result.comments.get(42);
  assert(comments && comments.length === 2);
  assertEquals(comments[0]?.id, 0);
  assertEquals(comments[0]?.author, "");
  assertEquals(comments[0]?.body, "");
  assertEquals(comments[1]?.author, "alice");
});
