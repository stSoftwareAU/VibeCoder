/**
 * The eyes reaction must not outlive a claim nobody won (Issue #2269).
 *
 * `claimPrComment` adds the processed marker (👀) in step 3, before the claim
 * is verified, so the marker is on the feedback comment even when the claim is
 * then dropped with **no winner** — a failed verification read, or a re-read
 * that cannot see this host's own claim. That marker is what stops
 * `findActionableComment` rediscovering the comment, so the feedback was
 * answered by nobody. These tests drive both no-winner paths and assert the
 * comment is left rediscoverable, while a claim genuinely lost to another host
 * keeps its marker — the winner answers it.
 *
 * The reactions endpoints are exercised through a **fake of the API**, not by
 * asserting the request text: the fake keys its rows on the endpoint path, so
 * a mapping that reversed `pulls/comments` and `issues/comments` would read an
 * empty collection and the test would go red rather than pin the mistake
 * (CODING-STANDARDS.md, "Fake the external service").
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { claimPrComment } from "../lib/claim_pr_comment.ts";
import { removeProcessedMark } from "../lib/pr_comments.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op sleep for fast tests. */
const noSleep = () => Promise.resolve();

/** The fleet service account this host authenticates as. */
const FLEET_AUTHOR = "vibe-coder-bot";

/** Author-verification inputs the fixtures pass instead of a config file. */
const FLEET_OPTIONS = { fleetAuthors: [FLEET_AUTHOR] } as const;

/** The wall-clock instant every fixture is anchored to. */
const NOW = Date.parse("2026-04-01T00:10:00Z");

/** A claim comment row as the `--jq` filter shapes it. */
const claimRow = (
  id: number,
  workerId: string,
  targetCommentId: string,
  createdAt: string,
) => ({
  id,
  body: `<!-- PR_COMMENT_CLAIM:${workerId}:${targetCommentId} -->\n` +
    `Claiming PR feedback comment ${targetCommentId} for worker ` +
    `\`${workerId}\`.`,
  created_at: createdAt,
  author: FLEET_AUTHOR,
});

/** One reaction as the fake API holds it. */
interface FakeReaction {
  id: number;
  content: string;
  login: string;
}

/**
 * A fake of GitHub's comment-reactions API.
 *
 * It models the endpoint's own rules rather than the argv the worker builds:
 * rows live under the exact path they were posted to, `content=` filters,
 * `per_page` caps a page (GitHub may return fewer, which `pageSize` models),
 * `--paginate` walks every page and its absence returns page one only, and a
 * `DELETE …/reactions/<id>` removes that row from that path alone.
 */
function createReactionsApi(
  seed: Record<string, FakeReaction[]> = {},
  pageSize = 100,
) {
  const store = new Map<string, FakeReaction[]>(
    Object.entries(seed).map(([path, rows]) => [path, [...rows]]),
  );
  let nextId = 9000;

  /** Rows currently on a path, in insertion order. */
  const rowsAt = (path: string): FakeReaction[] => store.get(path) ?? [];

  /**
   * Answer one `gh` call, or null when it is not a reactions call.
   */
  const handle = (args: string[]): string | null => {
    const endpoint = args.find((a) => a.includes("/reactions"));
    if (endpoint === undefined || args[0] !== "api") return null;

    const [pathWithId, query = ""] = endpoint.split("?");
    const deleteMatch = pathWithId!.match(/^(.*\/reactions)\/(\d+)$/);
    const path = deleteMatch ? deleteMatch[1]! : pathWithId!;

    if (args.includes("DELETE")) {
      if (!deleteMatch) throw new Error(`delete without a reaction id`);
      const id = Number(deleteMatch[2]);
      store.set(path, rowsAt(path).filter((r) => r.id !== id));
      return "";
    }

    if (args.includes("POST")) {
      const content = (args.find((a) => a.startsWith("content=")) ?? "")
        .slice("content=".length);
      store.set(path, [...rowsAt(path), {
        id: nextId++,
        content,
        login: FLEET_AUTHOR,
      }]);
      return "";
    }

    // A read. Filter as the endpoint does, then page as gh does.
    const wanted = new URLSearchParams(query).get("content");
    const perPage = Number(new URLSearchParams(query).get("per_page") ?? "30");
    const matching = rowsAt(path).filter((r) =>
      wanted === null || r.content === wanted
    );
    const size = Math.max(1, Math.min(perPage, pageSize));
    const pages: string[] = [];
    for (let i = 0; i < matching.length; i += size) {
      pages.push(
        JSON.stringify(
          matching.slice(i, i + size).map((r) => ({
            id: r.id,
            login: r.login,
          })),
        ),
      );
    }
    if (pages.length === 0) pages.push("[]");
    return args.includes("--paginate") ? pages.join("\n") : pages[0]!;
  };

  return { handle, rowsAt };
}

/** Does this `gh` call read the PR's comment thread? */
const isCommentRead = (args: string[]) =>
  args[0] === "api" && !args.includes("DELETE") &&
  args.some((a) => a.includes("/comments") && !a.includes("/reactions"));

/**
 * A `gh` stub for the claim's full call sequence, backed by the fake API.
 *
 * @param options.commentReads - Payload per comment-thread read, in order;
 *   the last entry is reused once the list is exhausted
 * @param options.commentReadError - Thrown by the verification read when set
 */
function createMockGh(options: {
  commentReads: string[];
  commentReadError?: string;
}) {
  const api = createReactionsApi();
  let reads = 0;

  const ghCommandFn = (args: string[]): Promise<string> => {
    if (isCommentRead(args)) {
      reads++;
      // The stale sweep reads first; the verification read is the second.
      if (reads === 2 && options.commentReadError) {
        return Promise.reject(new Error(options.commentReadError));
      }
      return Promise.resolve(
        options.commentReads[reads - 1] ??
          options.commentReads[options.commentReads.length - 1] ?? "[]",
      );
    }

    const reaction = api.handle(args);
    if (reaction !== null) return Promise.resolve(reaction);

    if (args[0] === "api" && args[1] === "user") {
      return Promise.resolve(`${FLEET_AUTHOR}\n`);
    }

    if (args[0] === "pr" && args[1] === "comment") {
      return Promise.resolve(
        "https://github.com/org/repo/pull/42#issuecomment-402",
      );
    }

    return Promise.resolve("");
  };

  return { api, ghCommandFn };
}

/** The reactions the fake holds on the feedback comment under test. */
const feedbackReactions = (api: ReturnType<typeof createReactionsApi>) =>
  api.rowsAt("repos/org/repo/issues/comments/555/reactions");

// ---------------------------------------------------------------------------
// claimPrComment — the no-winner paths
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - a failed verification read takes the eyes reaction back", async () => {
  const mock = createMockGh({
    commentReads: ["[]"],
    commentReadError: "API rate limit exceeded",
  });

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mock.ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    nowMsFn: () => NOW,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.winnerId, undefined);
  }
  assertEquals(
    feedbackReactions(mock.api),
    [],
    "nobody won the claim, so the feedback comment must stay rediscoverable",
  );
});

Deno.test("claim pr comment - an unseen own claim takes the eyes reaction back", async () => {
  const mock = createMockGh({ commentReads: ["[]", "[]"] });

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mock.ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    nowMsFn: () => NOW,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, false);
  assertEquals(feedbackReactions(mock.api), []);
});

Deno.test("claim pr comment - a claim lost to a real winner keeps the eyes reaction", async () => {
  const thread = JSON.stringify([
    claimRow(300, "worker-alpha", "555", "2026-04-01T00:09:58Z"),
    claimRow(402, "worker-beta", "555", "2026-04-01T00:09:59Z"),
  ]);
  const mock = createMockGh({ commentReads: ["[]", thread] });

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mock.ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    nowMsFn: () => NOW,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.winnerId, "worker-alpha");
  }
  assertEquals(
    feedbackReactions(mock.api).map((r) => r.content),
    ["eyes"],
    "the winner answers the comment, so its marker must stand",
  );
});

Deno.test("claim pr comment - a won claim keeps the eyes reaction", async () => {
  const thread = JSON.stringify([
    claimRow(402, "worker-beta", "555", "2026-04-01T00:09:59Z"),
  ]);
  const mock = createMockGh({ commentReads: ["[]", thread] });

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mock.ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    nowMsFn: () => NOW,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(feedbackReactions(mock.api).map((r) => r.content), ["eyes"]);
});

Deno.test("claim pr comment - a reaction that cannot be taken back is said out loud", async () => {
  const messages: string[] = [];
  const mock = createMockGh({
    commentReads: ["[]"],
    commentReadError: "API rate limit exceeded",
  });
  const ghCommandFn = (args: string[]): Promise<string> =>
    args[0] === "api" && !args.includes("POST") &&
      args.some((a) => a.includes("/reactions"))
      ? Promise.reject(new Error("reactions unavailable"))
      : mock.ghCommandFn(args);

  await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: (m) => messages.push(m),
    nowMsFn: () => NOW,
  });

  const said = messages.join("\n");
  assertStringIncludes(said, "555");
  assertStringIncludes(said, "rediscover");
  assertStringIncludes(said, "reactions unavailable");
});

// ---------------------------------------------------------------------------
// removeProcessedMark
// ---------------------------------------------------------------------------

/** A `gh` stub over the fake API, answering the acting-login read too. */
const ghOver =
  (api: ReturnType<typeof createReactionsApi>) =>
  (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1] === "user") {
      return Promise.resolve(`${FLEET_AUTHOR}\n`);
    }
    const answer = api.handle(args);
    if (answer === null) throw new Error(`unexpected call: ${args.join(" ")}`);
    return Promise.resolve(answer);
  };

Deno.test("remove processed mark - removes this account's reaction and leaves the rest", async () => {
  const path = "repos/org/repo/issues/comments/555/reactions";
  const api = createReactionsApi({
    [path]: [
      { id: 11, content: "eyes", login: "outsider" },
      { id: 12, content: "eyes", login: FLEET_AUTHOR.toUpperCase() },
      { id: 13, content: "+1", login: FLEET_AUTHOR },
    ],
  });

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghOver(api),
    () => {},
  );

  assertEquals(error, null);
  assertEquals(api.rowsAt(path).map((r) => r.id), [11, 13]);
});

Deno.test("remove processed mark - a review comment clears the pulls collection only", async () => {
  const pulls = "repos/org/repo/pulls/comments/555/reactions";
  const issues = "repos/org/repo/issues/comments/555/reactions";
  const api = createReactionsApi({
    [pulls]: [{ id: 21, content: "eyes", login: FLEET_AUTHOR }],
    [issues]: [{ id: 22, content: "eyes", login: FLEET_AUTHOR }],
  });

  const error = await removeProcessedMark(
    "org/repo",
    "review",
    "555",
    ghOver(api),
    () => {},
  );

  assertEquals(error, null);
  assertEquals(api.rowsAt(pulls), []);
  assertEquals(api.rowsAt(issues).map((r) => r.id), [22]);
});

Deno.test("remove processed mark - clears its reactions across every page", async () => {
  const path = "repos/org/repo/issues/comments/555/reactions";
  // One row per page: `--paginate` prints one JSON array per line, and a
  // parser that read only the first line would leave the marker behind.
  const api = createReactionsApi({
    [path]: [
      { id: 31, content: "eyes", login: FLEET_AUTHOR },
      { id: 32, content: "eyes", login: "outsider" },
      { id: 33, content: "eyes", login: FLEET_AUTHOR },
    ],
  }, 1);

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghOver(api),
    () => {},
  );

  assertEquals(error, null);
  assertEquals(api.rowsAt(path).map((r) => r.id), [32]);
});

Deno.test("remove processed mark - no reaction from this account deletes nothing", async () => {
  const path = "repos/org/repo/issues/comments/555/reactions";
  const api = createReactionsApi({
    [path]: [{ id: 41, content: "eyes", login: "outsider" }],
  });

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghOver(api),
    () => {},
  );

  assertEquals(error, null);
  assertEquals(api.rowsAt(path).map((r) => r.id), [41]);
});

Deno.test("remove processed mark - an unreadable reactions list reports the failure", async () => {
  const ghCommandFn = (args: string[]): Promise<string> =>
    args[0] === "api" && args[1] === "user"
      ? Promise.resolve(FLEET_AUTHOR)
      : Promise.reject(new Error("reactions unavailable"));

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghCommandFn,
    () => {},
  );

  assertStringIncludes(error?.message ?? "", "reactions unavailable");
});

Deno.test("remove processed mark - a payload that is not a list reports the failure", async () => {
  // An error object where the array was expected must never read as "this
  // account left no marker".
  const ghCommandFn = (args: string[]): Promise<string> =>
    Promise.resolve(
      args[1] === "user" ? FLEET_AUTHOR : '{"message":"Not Found"}',
    );

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghCommandFn,
    () => {},
  );

  assertStringIncludes(error?.message ?? "", "Not Found");
});

Deno.test("remove processed mark - an unusable reaction id reports the failure", async () => {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve(
      args[1] === "user"
        ? FLEET_AUTHOR
        : JSON.stringify([{ id: null, login: FLEET_AUTHOR }]),
    );
  };

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghCommandFn,
    () => {},
  );

  assertStringIncludes(error?.message ?? "", "unusable reaction id");
  assertEquals(calls.some((c) => c.includes("DELETE")), false);
});

Deno.test("remove processed mark - an unresolvable acting login reports the failure", async () => {
  const ghCommandFn = (args: string[]): Promise<string> =>
    args[0] === "api" && args[1] === "user"
      ? Promise.reject(new Error("bad credentials"))
      : Promise.resolve("[]");

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghCommandFn,
    () => {},
  );

  assertStringIncludes(error?.message ?? "", "bad credentials");
});

Deno.test("remove processed mark - a dismissed review cannot be undismissed", async () => {
  const calls: string[][] = [];
  const error = await removeProcessedMark(
    "org/repo",
    "pr_review",
    "555",
    (args: string[]) => {
      calls.push(args);
      return Promise.resolve("");
    },
    () => {},
  );

  assertStringIncludes(error?.message ?? "", "dismiss");
  assertEquals(calls.length, 0);
});

Deno.test("remove processed mark - a failed delete reports the failure", async () => {
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1] === "user") {
      return Promise.resolve(FLEET_AUTHOR);
    }
    if (args.includes("DELETE")) {
      return Promise.reject(new Error("delete refused"));
    }
    return Promise.resolve(JSON.stringify([{ id: 51, login: FLEET_AUTHOR }]));
  };

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghCommandFn,
    () => {},
  );

  assertStringIncludes(error?.message ?? "", "delete refused");
});
