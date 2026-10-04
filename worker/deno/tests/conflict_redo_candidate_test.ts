import { assertEquals } from "@std/assert";
import { conflictRestartMarker } from "../lib/conflict_abandon_restart.ts";
import {
  classifyConflictRedo,
  isPendingConflictRedo,
  latestTrustedRestartClaim,
} from "../lib/conflict_redo_candidate.ts";
import { buildIssueCommentsPageArgs } from "../lib/issue_comment_pages.ts";
import { IssueCache } from "../lib/issue_cache.ts";

const REPO = "acme/widgets";
const ISSUE = 42;
const FLEET = ["vibe-bot"];

function comment(
  login: string | undefined,
  body: string,
  createdAt: string,
): unknown {
  return {
    user: login === undefined ? undefined : { login },
    body,
    created_at: createdAt,
  };
}

function markerBody(prNumber: number): string {
  return conflictRestartMarker(REPO, prNumber, "issue-42-foo");
}

/** A fake `gh` returning a single page of comments for the issue's thread. */
function ghFor(comments: unknown[]): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const page1 = buildIssueCommentsPageArgs(REPO, ISSUE, 1);
    if (JSON.stringify(args) === JSON.stringify(page1)) {
      return Promise.resolve(JSON.stringify(comments));
    }
    // Any further page is short/empty, ending pagination.
    return Promise.resolve("[]");
  };
}

Deno.test("latestTrustedRestartClaim: trusted marker is classified", async () => {
  const comments = [
    comment("vibe-bot", markerBody(10), "2026-01-01T00:00:00Z"),
  ];
  const result = await classifyConflictRedo({
    repo: REPO,
    issue: { number: ISSUE },
    openPRs: [],
    closedPRs: [],
    trustedAuthors: FLEET,
    ghFn: ghFor(comments),
  });
  assertEquals(result, { restartedAt: "2026-01-01T00:00:00Z" });
});

Deno.test("outsider's restart marker is not treated as a redo", async () => {
  const comments = [
    comment("outsider", markerBody(10), "2026-01-01T00:00:00Z"),
  ];
  const result = await classifyConflictRedo({
    repo: REPO,
    issue: { number: ISSUE },
    openPRs: [],
    closedPRs: [],
    trustedAuthors: FLEET,
    ghFn: ghFor(comments),
  });
  assertEquals(result, undefined);
});

Deno.test("comment with no user.login is not trusted", async () => {
  const comments = [
    comment(undefined, markerBody(10), "2026-01-01T00:00:00Z"),
  ];
  const claim = latestTrustedRestartClaim(comments, FLEET);
  assertEquals(claim, null);

  const result = await classifyConflictRedo({
    repo: REPO,
    issue: { number: ISSUE },
    openPRs: [],
    closedPRs: [],
    trustedAuthors: FLEET,
    ghFn: ghFor(comments),
  });
  assertEquals(result, undefined);
});

Deno.test("open fleet PR referencing the issue disqualifies the redo", async () => {
  const comments = [
    comment("vibe-bot", markerBody(10), "2026-01-01T00:00:00Z"),
  ];
  const result = await classifyConflictRedo({
    repo: REPO,
    issue: { number: ISSUE },
    openPRs: [{ number: 99, title: `Fix thing (#${ISSUE})` }],
    closedPRs: [],
    trustedAuthors: FLEET,
    ghFn: ghFor(comments),
  });
  assertEquals(result, undefined);
});

Deno.test("closed PR numbered above the abandoned PR means the redo already happened", () => {
  const claim = { restartedAt: "2026-01-01T00:00:00Z", prNumber: 10 };
  // Greater number: redo already raised and closed.
  assertEquals(
    isPendingConflictRedo(claim, ISSUE, [], [
      { number: 11, title: `Fix thing (#${ISSUE})` },
    ]),
    false,
  );
  // Equal number: that's the abandoned PR itself — still pending.
  assertEquals(
    isPendingConflictRedo(claim, ISSUE, [], [
      { number: 10, title: `Fix thing (#${ISSUE})` },
    ]),
    true,
  );
});

Deno.test("latestTrustedRestartClaim: several markers, latest created_at wins", () => {
  const comments = [
    comment("vibe-bot", markerBody(10), "2026-01-01T00:00:00Z"),
    comment("vibe-bot", markerBody(11), "2026-02-01T00:00:00Z"),
    comment("vibe-bot", markerBody(9), "2025-12-01T00:00:00Z"),
  ];
  const claim = latestTrustedRestartClaim(comments, FLEET);
  assertEquals(claim, { restartedAt: "2026-02-01T00:00:00Z", prNumber: 11 });
});

Deno.test("ghFn throws: undefined returned and log called once naming repo#issue", async () => {
  const logs: string[] = [];
  const result = await classifyConflictRedo({
    repo: REPO,
    issue: { number: ISSUE },
    openPRs: [],
    closedPRs: [],
    trustedAuthors: FLEET,
    ghFn: () => Promise.reject(new Error("boom")),
    log: (message) => logs.push(message),
  });
  assertEquals(result, undefined);
  assertEquals(logs.length, 1);
  const message = logs[0] ?? "";
  assertEquals(message.includes(`${REPO}#${ISSUE}`), true);
  assertEquals(message.includes("boom"), true);
});

Deno.test("cache: reused while updatedAt is unchanged, refetched when it changes", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const cache = new IssueCache(tmpDir);
    let calls = 0;
    const comments = [
      comment("vibe-bot", markerBody(10), "2026-01-01T00:00:00Z"),
    ];
    const ghFn = (args: string[]) => {
      calls++;
      return ghFor(comments)(args);
    };

    const first = await classifyConflictRedo({
      repo: REPO,
      issue: { number: ISSUE, updatedAt: "2026-01-01T00:00:00Z" },
      openPRs: [],
      closedPRs: [],
      trustedAuthors: FLEET,
      ghFn,
      cache,
    });
    assertEquals(first, { restartedAt: "2026-01-01T00:00:00Z" });
    assertEquals(calls > 0, true);
    const callsAfterFirst = calls;

    const second = await classifyConflictRedo({
      repo: REPO,
      issue: { number: ISSUE, updatedAt: "2026-01-01T00:00:00Z" },
      openPRs: [],
      closedPRs: [],
      trustedAuthors: FLEET,
      ghFn,
      cache,
    });
    assertEquals(second, { restartedAt: "2026-01-01T00:00:00Z" });
    assertEquals(calls, callsAfterFirst);

    const third = await classifyConflictRedo({
      repo: REPO,
      issue: { number: ISSUE, updatedAt: "2026-02-01T00:00:00Z" },
      openPRs: [],
      closedPRs: [],
      trustedAuthors: FLEET,
      ghFn,
      cache,
    });
    assertEquals(third, { restartedAt: "2026-01-01T00:00:00Z" });
    assertEquals(calls > callsAfterFirst, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
