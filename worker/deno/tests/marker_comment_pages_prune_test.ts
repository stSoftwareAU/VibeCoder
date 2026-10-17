/**
 * Direct tests for `pruneDuplicateFleetMarkerComments` in
 * `marker_comment_pages.ts` (Issue #3597).
 *
 * Every test calls the real function with a stubbed `gh`. The stub serves the
 * paginated read as one JSON array, records every DELETE, and fails the
 * deletes a test names, so the assertions are on the argv the module sends and
 * on what it returns or throws.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchMarkerCommentsBounded,
  pruneDuplicateFleetMarkerComments,
} from "../lib/marker_comment_pages.ts";
import { MAX_COMMENT_PAGES } from "../lib/issue_comment_pages.ts";

const MARKER = "vibe-test-marker";
const FLEET = "vibe-coder-bot";

/** A comment row as `markerJq` projects it: id, body, dates and author. */
interface Row {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  author: string | null;
}

function row(id: number, author: string | null): Row {
  const day = String(id).padStart(2, "0");
  return {
    id,
    body: `held <!-- ${MARKER} key="k${id}" -->`,
    created_at: `2026-01-${day}T00:00:00Z`,
    updated_at: `2026-01-${day}T00:00:00Z`,
    author,
  };
}

/**
 * A fake thread: serves `rows` on the paginated read, and fails each DELETE
 * for which `deleteError` returns an error.
 */
function fakeThread(
  rows: Row[],
  deleteError: (id: number) => Error | null = () => null,
) {
  const calls: string[][] = [];
  const attempted: number[] = [];
  const deleted: number[] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args.includes("--paginate")) {
      return Promise.resolve(JSON.stringify(rows));
    }
    if (args[1] === "-X" && args[2] === "DELETE") {
      const id = Number((args[3] ?? "").split("/").at(-1));
      attempted.push(id);
      const err = deleteError(id);
      if (err) return Promise.reject(err);
      deleted.push(id);
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
  return { ghFn, calls, attempted, deleted };
}

Deno.test("prune - keeps the oldest fleet comment and deletes later fleet duplicates", async () => {
  const thread = fakeThread([
    row(1, FLEET),
    row(2, FLEET),
    row(3, FLEET),
  ]);

  const kept = await pruneDuplicateFleetMarkerComments(
    "owner/repo",
    7,
    MARKER,
    thread.ghFn,
    [FLEET],
  );

  assertEquals(kept?.id, 1);
  assertEquals(thread.attempted, [2, 3]);
  assertEquals(thread.deleted, [2, 3]);
});

Deno.test("prune - never deletes a comment a non-fleet account wrote", async () => {
  const thread = fakeThread([
    row(1, FLEET),
    row(2, "stranger"),
    row(3, FLEET),
    row(4, null),
  ]);

  const kept = await pruneDuplicateFleetMarkerComments(
    "owner/repo",
    7,
    MARKER,
    thread.ghFn,
    [FLEET],
  );

  assertEquals(kept?.id, 1);
  assertEquals(thread.attempted, [3]);
  assertEquals(thread.deleted, [3]);
});

Deno.test("prune - returns null and deletes nothing when no fleet comment carries the marker", async () => {
  const thread = fakeThread([row(1, "stranger"), row(2, null)]);

  const kept = await pruneDuplicateFleetMarkerComments(
    "owner/repo",
    7,
    MARKER,
    thread.ghFn,
    [FLEET],
  );

  assertEquals(kept, null);
  assertEquals(thread.attempted, []);
});

Deno.test("prune - an empty fleet list deletes nothing and keeps nothing", async () => {
  const thread = fakeThread([row(1, FLEET), row(2, FLEET)]);

  const kept = await pruneDuplicateFleetMarkerComments(
    "owner/repo",
    7,
    MARKER,
    thread.ghFn,
    [],
  );

  assertEquals(kept, null);
  assertEquals(thread.attempted, []);
  assertEquals(thread.calls, [], "an empty fleet reads nothing");
  assertEquals(
    thread.calls.some((args) => args.includes("DELETE")),
    false,
  );
});

Deno.test("prune - a DELETE answered with HTTP 404 counts as already deleted", async () => {
  const thread = fakeThread(
    [row(1, FLEET), row(2, FLEET), row(3, FLEET)],
    (id) => id === 2 ? new Error("gh: Not Found (HTTP 404)") : null,
  );

  const kept = await pruneDuplicateFleetMarkerComments(
    "owner/repo",
    7,
    MARKER,
    thread.ghFn,
    [FLEET],
  );

  assertEquals(kept?.id, 1);
  assertEquals(thread.attempted, [2, 3]);
  assertEquals(thread.deleted, [3]);
});

Deno.test("prune - a DELETE refused with HTTP 403 throws, naming every failed comment", async () => {
  const thread = fakeThread(
    [row(1, FLEET), row(2, FLEET), row(3, FLEET)],
    () => new Error("gh: Must have admin rights (HTTP 403)"),
  );

  let thrown: Error | undefined;
  try {
    await pruneDuplicateFleetMarkerComments(
      "owner/repo",
      7,
      MARKER,
      thread.ghFn,
      [FLEET],
    );
  } catch (err) {
    thrown = err instanceof Error ? err : new Error(String(err));
  }

  assert(thrown !== undefined, "expected the prune to throw");
  assertStringIncludes(thrown.message, "comment 2");
  assertStringIncludes(thrown.message, "comment 3");
  assertStringIncludes(thrown.message, "HTTP 403");
  // Every duplicate is attempted before the error is thrown.
  assertEquals(thread.attempted, [2, 3]);
});

Deno.test("prune - a partial delete failure throws naming only the failed comment", async () => {
  const thread = fakeThread(
    [row(1, FLEET), row(2, FLEET), row(3, FLEET)],
    (id) =>
      id === 2 ? new Error("gh: Must have admin rights (HTTP 403)") : null,
  );

  let thrown: Error | undefined;
  try {
    await pruneDuplicateFleetMarkerComments(
      "owner/repo",
      7,
      MARKER,
      thread.ghFn,
      [FLEET],
    );
  } catch (err) {
    thrown = err instanceof Error ? err : new Error(String(err));
  }

  assert(thrown !== undefined, "expected the prune to throw");
  assertStringIncludes(thrown.message, "comment 2");
  assertEquals(thrown.message.includes("comment 3"), false);
  assertEquals(thread.deleted, [3]);
});

/** A raw REST comment, as an explicit `?page=` read returns it. */
function restComment(id: number, login: string | null, body?: string) {
  return {
    id,
    body: body ?? row(id, login).body,
    created_at: row(id, login).created_at,
    updated_at: row(id, login).updated_at,
    user: login === null ? null : { login },
  };
}

Deno.test("bounded read - reads explicit pages and keeps the marker rows with their authors", async () => {
  const calls: string[][] = [];
  const page1 = [
    restComment(1, FLEET),
    ...Array.from(
      { length: 99 },
      (_, i) => restComment(100 + i, "stranger", "chatter"),
    ),
  ];
  const page2 = [restComment(2, "stranger"), restComment(3, null)];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const page = Number(/[?&]page=(\d+)/.exec(args[1] ?? "")?.[1]);
    return Promise.resolve(JSON.stringify(page === 1 ? page1 : page2));
  };

  const rows = await fetchMarkerCommentsBounded("owner/repo", 7, MARKER, ghFn);

  assertEquals(rows.map((r) => [r.id, r.author]), [
    [1, FLEET],
    [2, "stranger"],
    [3, null],
  ]);
  assertEquals(rows[0]!.createdAt, "2026-01-01T00:00:00Z");
  assertEquals(rows[0]!.updatedAt, "2026-01-01T00:00:00Z");
  assertEquals(calls.length, 2);
  assertEquals(calls.some((c) => c.includes("--paginate")), false);
});

Deno.test("bounded read - a thread past the page cap throws, and the prune deletes nothing", async () => {
  const calls: string[][] = [];
  const fullPage = JSON.stringify(
    Array.from({ length: 100 }, (_, i) => restComment(i + 1, FLEET)),
  );
  const ghFn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    return Promise.resolve(fullPage);
  };

  let thrown: Error | undefined;
  try {
    await pruneDuplicateFleetMarkerComments(
      "owner/repo",
      7,
      MARKER,
      ghFn,
      [FLEET],
      fetchMarkerCommentsBounded,
    );
  } catch (err) {
    thrown = err instanceof Error ? err : new Error(String(err));
  }

  assert(thrown !== undefined, "expected the capped read to throw");
  assertStringIncludes(thrown.message, `exceeded ${MAX_COMMENT_PAGES} pages`);
  assertEquals(calls.length, MAX_COMMENT_PAGES);
  assertEquals(calls.some((c) => c.includes("DELETE")), false);
});
