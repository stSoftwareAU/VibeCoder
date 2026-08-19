/**
 * Tests for issue_query.ts (Issue #910).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type ClosedPR,
  createMilestoneBranchName,
  fetchAllClosedIssues,
  fetchAllIssues,
  fetchAllOpenPRs,
  fetchMergedPRsByUser,
  fetchOpenPRsForFleet,
  fetchRecentlyClosedPRsForFleet,
  getBlockingPRForIssue,
  isBlockedByRecentlyClosedPR,
  parseIssueListJson,
  parsePRListJson,
  wasLabelAddedByAllowedAuthor,
} from "../lib/issue_query.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { TimelineCache } from "../lib/timeline_cache.ts";

// =============================================================================
// parseIssueListJson tests
// =============================================================================

Deno.test("issue_query - parseIssueListJson parses valid JSON", () => {
  const json = JSON.stringify([
    {
      number: 1,
      title: "Fix bug",
      url: "https://github.com/owner/repo/issues/1",
      assignees: [{ login: "user1" }],
      labels: [{ name: "bug" }],
      createdAt: "2024-01-01T00:00:00Z",
      author: { login: "alice" },
      milestone: { title: "v1.0" },
    },
  ]);
  const result = parseIssueListJson(json);
  assertEquals(result.length, 1);
  assertEquals(result[0]?.number, 1);
  assertEquals(result[0]?.title, "Fix bug");
  assertEquals(result[0]?.assignees, ["user1"]);
  assertEquals(result[0]?.labels, ["bug"]);
  assertEquals(result[0]?.author, "alice");
  assertEquals(result[0]?.milestone, "v1.0");
});

Deno.test("issue_query - parseIssueListJson handles null milestone", () => {
  const json = JSON.stringify([
    {
      number: 1,
      title: "No milestone",
      url: "",
      assignees: [],
      labels: [],
      createdAt: "2024-01-01T00:00:00Z",
      author: { login: "bob" },
      milestone: null,
    },
  ]);
  const result = parseIssueListJson(json);
  assertEquals(result[0]?.milestone, "");
});

Deno.test("issue_query - parseIssueListJson returns empty for invalid JSON", () => {
  assertEquals(parseIssueListJson("not json"), []);
  assertEquals(parseIssueListJson(""), []);
});

// =============================================================================
// parsePRListJson tests
// =============================================================================

Deno.test("issue_query - parsePRListJson parses valid JSON", () => {
  const json = JSON.stringify([
    {
      number: 10,
      title: "Fix PR",
      baseRefName: "main",
      headRefName: "fix-branch",
    },
  ]);
  const result = parsePRListJson(json);
  assertEquals(result.length, 1);
  assertEquals(result[0]?.number, 10);
  assertEquals(result[0]?.baseRefName, "main");
  assertEquals(result[0]?.headRefName, "fix-branch");
});

// =============================================================================
// createMilestoneBranchName tests
// =============================================================================

Deno.test("issue_query - createMilestoneBranchName normalises title", () => {
  assertEquals(createMilestoneBranchName("v1.0"), "milestone/v1-0");
  assertEquals(
    createMilestoneBranchName("Release 2.0"),
    "milestone/release-2-0",
  );
  assertEquals(
    createMilestoneBranchName("My Feature!"),
    "milestone/my-feature",
  );
});

// Issue #2900: the milestone branch name used for PR-blocking must match the
// branch actually created for the feature PR. The branch creator
// (git_branch.ts) caps the slug at 50 characters and strips any trailing
// hyphen; issue_query must apply the identical rule, otherwise a milestone
// whose normalised title exceeds 50 characters computes a different (longer)
// branch name here than the PR actually targets — so the milestone PR is never
// recognised as blocking and the work stream is no longer serialised.
Deno.test("issue_query - createMilestoneBranchName caps long title slug at 50 chars (Issue #2900)", () => {
  const longTitle =
    "Cross-Platform Migration v2 — Phase 3 Rollout and Stabilisation";
  const branch = createMilestoneBranchName(longTitle);
  // milestone/ prefix (10) + 50-char slug.
  const slug = branch.replace(/^milestone\//, "");
  assertEquals(
    slug.length <= 50,
    true,
    `slug too long: ${slug} (${slug.length})`,
  );
  assertEquals(
    branch.endsWith("-"),
    false,
    "branch must not end with a hyphen",
  );
  assertEquals(
    branch,
    "milestone/cross-platform-migration-v2-phase-3-rollout-and-st",
  );
});

Deno.test("issue_query - createMilestoneBranchName matches git_branch implementation (Issue #2900)", async () => {
  const { createMilestoneBranchName: fromGitBranch } = await import(
    "../lib/git_branch.ts"
  );
  for (
    const title of [
      "v1.0",
      "Release 2.0",
      "My Feature!",
      "OIDC Authentication and Single Sign-On Integration Programme",
      "Cross-Platform Migration v2 — Phase 3 Rollout and Stabilisation",
    ]
  ) {
    assertEquals(createMilestoneBranchName(title), fromGitBranch(title), title);
  }
});

// =============================================================================
// getBlockingPRForIssue tests
// =============================================================================

/**
 * No push-capable set supplied: nothing can be classified, so every PR
 * keeps blocking (the documented fail-safe). The branch-matching tests
 * below use it so they exercise branch logic only.
 */
const UNCLASSIFIABLE: readonly string[] = [];

/** A push-capable fleet set: the host login plus one sibling. */
const FLEET = ["bot", "stsvcbot"];

Deno.test("issue_query - getBlockingPRForIssue returns null for empty PRs", () => {
  assertEquals(getBlockingPRForIssue([], "", UNCLASSIFIABLE), null);
  assertEquals(getBlockingPRForIssue([], "v1.0", UNCLASSIFIABLE), null);
});

Deno.test("issue_query - getBlockingPRForIssue blocks milestone issue by same milestone PR", () => {
  const prs = [
    {
      number: 1,
      title: "Fix",
      baseRefName: "milestone/v1-0",
      headRefName: "fix-v1",
    },
    {
      number: 2,
      title: "Main fix",
      baseRefName: "main",
      headRefName: "fix-main",
    },
  ];
  const result = getBlockingPRForIssue(prs, "v1.0", UNCLASSIFIABLE);
  assertEquals(result?.number, 1);
});

Deno.test("issue_query - getBlockingPRForIssue does not block milestone issue by default branch PR", () => {
  const prs = [
    {
      number: 2,
      title: "Main fix",
      baseRefName: "main",
      headRefName: "fix-main",
    },
  ];
  assertEquals(getBlockingPRForIssue(prs, "v1.0", UNCLASSIFIABLE), null);
});

// Issue #2900: a long-titled milestone's open PR targets the 50-char-capped
// milestone branch. Blocking detection must use the same capped name so the
// PR is recognised and the milestone work stream stays serialised (one PR at
// a time) rather than the worker opening a second PR against the default branch.
Deno.test("issue_query - getBlockingPRForIssue blocks long-titled milestone issue by its capped milestone PR (Issue #2900)", () => {
  const milestoneTitle =
    "Cross-Platform Migration v2 — Phase 3 Rollout and Stabilisation";
  const cappedBranch =
    "milestone/cross-platform-migration-v2-phase-3-rollout-and-st";
  const prs = [
    {
      number: 7,
      title: "Feature",
      baseRefName: cappedBranch,
      headRefName: "issue-7-feature",
    },
  ];
  const result = getBlockingPRForIssue(prs, milestoneTitle, UNCLASSIFIABLE);
  assertEquals(result?.number, 7);
});

Deno.test("issue_query - getBlockingPRForIssue blocks non-milestone issue by non-milestone PR", () => {
  const prs = [
    { number: 1, title: "Fix", baseRefName: "main", headRefName: "fix-branch" },
  ];
  const result = getBlockingPRForIssue(prs, "", UNCLASSIFIABLE);
  assertEquals(result?.number, 1);
});

Deno.test("issue_query - getBlockingPRForIssue excludes milestone-merge PRs for non-milestone issues", () => {
  const prs = [
    {
      number: 1,
      title: "Merge milestone",
      baseRefName: "main",
      headRefName: "milestone/v1-0",
    },
  ];
  assertEquals(getBlockingPRForIssue(prs, "", UNCLASSIFIABLE), null);
});

Deno.test("issue_query - getBlockingPRForIssue excludes merge-milestone PRs for non-milestone issues", () => {
  const prs = [
    {
      number: 1,
      title: "Merge",
      baseRefName: "main",
      headRefName: "issue-42-merge-milestone-v1-to-main",
    },
  ];
  assertEquals(getBlockingPRForIssue(prs, "", UNCLASSIFIABLE), null);
});

// ---------------------------------------------------------------------------
// Issue #4133: a human's open PR never blocks issue pickup
// ---------------------------------------------------------------------------

/** An ordinary open PR against the default branch, by `author`. */
function prBy(number: number, author: string) {
  return {
    number,
    title: `Work by ${author}`,
    baseRefName: "main",
    headRefName: `branch-${number}`,
    author,
  };
}

Deno.test("issue_query - getBlockingPRForIssue ignores a human-authored PR (Issue #4133)", () => {
  // `maintainer` is a trusted human: fetched by the fleet-owned guard set, but
  // never push-capable. Their PR is theirs to manage, so it must not park
  // the repo's queue.
  assertEquals(getBlockingPRForIssue([prBy(4036, "maintainer")], "", FLEET), null);
});

Deno.test("issue_query - getBlockingPRForIssue still blocks on a fleet PR (Issue #4133)", () => {
  assertEquals(
    getBlockingPRForIssue([prBy(500, "stsvcbot")], "", FLEET)?.number,
    500,
  );
  // GitHub logins are case-insensitive.
  assertEquals(
    getBlockingPRForIssue([prBy(501, "BOT")], "", FLEET)?.number,
    501,
  );
});

Deno.test("issue_query - getBlockingPRForIssue skips past a human PR to a fleet PR (Issue #4133)", () => {
  const prs = [prBy(4036, "maintainer"), prBy(4037, "bot")];
  assertEquals(getBlockingPRForIssue(prs, "", FLEET)?.number, 4037);
});

Deno.test("issue_query - getBlockingPRForIssue ignores a human PR on the milestone lane too (Issue #4133)", () => {
  const humanMilestonePr = {
    number: 900,
    title: "Human milestone work",
    baseRefName: "milestone/v1-0",
    headRefName: "human-v1",
    author: "maintainer",
  };
  const fleetMilestonePr = { ...humanMilestonePr, number: 901, author: "bot" };
  assertEquals(getBlockingPRForIssue([humanMilestonePr], "v1.0", FLEET), null);
  assertEquals(
    getBlockingPRForIssue([fleetMilestonePr], "v1.0", FLEET)?.number,
    901,
  );
});

Deno.test("issue_query - getBlockingPRForIssue blocks on an unstamped author (Issue #4133)", () => {
  // A pre-#4024 cache entry carries no author. Authorship cannot be
  // confirmed, so the fail-safe keeps the one-PR-at-a-time rule rather
  // than guessing the PR away.
  const unstamped = {
    number: 600,
    title: "Unstamped",
    baseRefName: "main",
    headRefName: "unstamped",
  };
  assertEquals(getBlockingPRForIssue([unstamped], "", FLEET)?.number, 600);
  assertEquals(
    getBlockingPRForIssue([{ ...unstamped, author: "  " }], "", FLEET)?.number,
    600,
  );
});

Deno.test("issue_query - getBlockingPRForIssue blocks when the fleet set is unresolved (Issue #4133)", () => {
  // An empty push-capable set classifies nothing — fail safe, not open.
  assertEquals(
    getBlockingPRForIssue([prBy(700, "maintainer")], "", UNCLASSIFIABLE)?.number,
    700,
  );
});

// =============================================================================
// wasLabelAddedByAllowedAuthor tests
// =============================================================================

Deno.test("issue_query - wasLabelAddedByAllowedAuthor returns true when allowed", async () => {
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api") {
      return JSON.stringify([
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
        },
      ]);
    }
    return "[]";
  };
  const result = await wasLabelAddedByAllowedAuthor(
    "owner/repo",
    1,
    "work-on",
    ["alice"],
    mockGh,
  );
  assertEquals(result, true);
});

Deno.test("issue_query - wasLabelAddedByAllowedAuthor returns false for non-allowed", async () => {
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api") {
      return JSON.stringify([
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "mallory" },
        },
      ]);
    }
    return "[]";
  };
  const result = await wasLabelAddedByAllowedAuthor(
    "owner/repo",
    1,
    "work-on",
    ["alice"],
    mockGh,
  );
  assertEquals(result, false);
});

// Fleet worker-login discovery-label trust exclusion (Issue #3416)
// ---------------------------------------------------------------------------

Deno.test("issue_query - work-on added by a fleet worker login is untrusted (Issue #3416)", async () => {
  // In a multi-account fleet, the worker's own login (and siblings) must
  // appear in allowedAuthors for PR-dedup (#3138). A reserved discovery label
  // a worker applied directly (bypassing the addLabelToIssue allowlist) must
  // still be stripped — the gate must exclude fleet worker logins.
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api") {
      return JSON.stringify([
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "VibeCoderBot" }, // fleet worker, in allowedAuthors
        },
      ]);
    }
    return "[]";
  };
  const result = await wasLabelAddedByAllowedAuthor(
    "owner/repo",
    1,
    "work-on",
    ["alice", "VibeCoderBot"], // human + fleet worker (fleet requirement)
    mockGh,
    undefined,
    ["VibeCoderBot", "stsvcbot"], // fleet worker logins
  );
  assertEquals(result, false);
});

Deno.test("issue_query - top-priority added by a genuine human stays trusted with fleet exclusion (Issue #3416)", async () => {
  // The fleet-worker exclusion must not distrust genuine humans in
  // allowedAuthors — only fleet worker logins are excluded.
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api") {
      return JSON.stringify([
        {
          event: "labeled",
          label: { name: "top-priority" },
          actor: { login: "alice" }, // human, not a fleet worker
        },
      ]);
    }
    return "[]";
  };
  const result = await wasLabelAddedByAllowedAuthor(
    "owner/repo",
    2,
    "top-priority",
    ["alice", "VibeCoderBot"],
    mockGh,
    undefined,
    ["VibeCoderBot", "stsvcbot"],
  );
  assertEquals(result, true);
});

Deno.test("issue_query - fleet exclusion also applies on the cached timeline path (Issue #3416)", async () => {
  // The cache-hit short-circuit must apply the same fleet-worker exclusion as
  // the API path, otherwise a cached complete timeline would honour a
  // worker-applied discovery label.
  const cache = new TimelineCache(300, await Deno.makeTempDir());
  await cache.write(
    "owner/repo",
    3,
    [
      {
        event: "labeled",
        label: { name: "work-on" },
        actor: { login: "stsvcbot" }, // this host's own worker login
      },
    ],
    true, // complete — eligible for the cache-hit short-circuit
  );
  let apiCalled = false;
  const mockGh = async (_args: string[]): Promise<string> => {
    apiCalled = true;
    return "[]";
  };
  const result = await wasLabelAddedByAllowedAuthor(
    "owner/repo",
    3,
    "work-on",
    ["alice", "stsvcbot"],
    mockGh,
    cache,
    ["stsvcbot", "VibeCoderBot"],
  );
  assertEquals(result, false);
  assertEquals(apiCalled, false); // resolved from the cache, not the API
});

Deno.test("issue_query - wasLabelAddedByAllowedAuthor requests an untruncated timeline window (Issue #3089)", async () => {
  // Simulate a heavily-labelled issue: the genuine most-recent `work-on` add
  // is by an untrusted actor (mallory) and only appears once the full window
  // is fetched. The truncated default page would show only the stale trusted
  // add (alice). The gate must request per_page=100 so it sees mallory's add
  // and rejects the reserved label.
  let requestedPath = "";
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api") {
      requestedPath = args[1] ?? "";
      const truncatedWindow = [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
        },
      ];
      const fullWindow = [
        ...truncatedWindow,
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "mallory" },
        },
      ];
      const events = requestedPath.includes("per_page=100")
        ? fullWindow
        : truncatedWindow;
      return JSON.stringify(events);
    }
    return "[]";
  };
  const result = await wasLabelAddedByAllowedAuthor(
    "owner/repo",
    1,
    "work-on",
    ["alice"],
    mockGh,
  );
  assertStringIncludes(requestedPath, "per_page=100");
  // mallory's re-add is the true most-recent labelled event → reject.
  assertEquals(result, false);
});

Deno.test("issue_query - wasLabelAddedByAllowedAuthor paginates past 100 events to find the true most-recent add (Issue #3200)", async () => {
  // A >100-event issue: page 1 (oldest-first, full 100 events) carries a stale
  // trusted `work-on` add by alice; page 2 carries the genuine most-recent add
  // by an untrusted actor (mallory). A single-page fallback would stop at page 1
  // and honour the stale trusted add. Paginating to exhaustion must surface
  // mallory's re-add and reject the reserved label.
  const requestedPages: string[] = [];
  const page1: unknown[] = Array.from({ length: 99 }, () => ({
    event: "commented",
  }));
  page1.push({
    event: "labeled",
    label: { name: "work-on" },
    actor: { login: "alice" },
  });
  const page2 = [
    {
      event: "labeled",
      label: { name: "work-on" },
      actor: { login: "mallory" },
    },
  ];
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api") {
      const path = args[1] ?? "";
      requestedPages.push(path);
      if (path.includes("page=2")) return JSON.stringify(page2);
      return JSON.stringify(page1);
    }
    return "[]";
  };
  const result = await wasLabelAddedByAllowedAuthor(
    "owner/repo",
    1,
    "work-on",
    ["alice"],
    mockGh,
  );
  // A full first page must trigger a second fetch.
  assertEquals(requestedPages.some((p) => p.includes("page=2")), true);
  // mallory's re-add on page 2 is the true most-recent labelled event → reject.
  assertEquals(result, false);
});

Deno.test("issue_query - wasLabelAddedByAllowedAuthor stops paginating on a short page (Issue #3200)", async () => {
  // A short (<100) first page is the last page — no second fetch should occur.
  const requestedPages: string[] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api") {
      requestedPages.push(args[1] ?? "");
      return JSON.stringify([
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
        },
      ]);
    }
    return "[]";
  };
  const result = await wasLabelAddedByAllowedAuthor(
    "owner/repo",
    1,
    "work-on",
    ["alice"],
    mockGh,
  );
  assertEquals(result, true);
  assertEquals(requestedPages.length, 1);
});

Deno.test("issue_query - wasLabelAddedByAllowedAuthor propagates API failure", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API failure");
  };
  await assertRejects(
    () =>
      wasLabelAddedByAllowedAuthor(
        "owner/repo",
        1,
        "work-on",
        ["alice"],
        mockGh,
      ),
    Error,
    "API failure",
  );
});

// =============================================================================
// fetchAllOpenPRs (Issue #1787)
// =============================================================================

async function makeTempCache(): Promise<
  { cache: IssueCache; cleanup: () => Promise<void> }
> {
  const dir = await Deno.makeTempDir({ prefix: "issue-cache-test-" });
  const cache = new IssueCache(dir);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

Deno.test("issue_query - fetchAllOpenPRs - cache miss fetches and parses JSON", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      return JSON.stringify([
        {
          number: 5,
          title: "PR five",
          baseRefName: "main",
          headRefName: "issue-5",
          body: "vibe-worker-issue-5 body",
          url: "https://github.com/o/r/pull/5",
        },
      ]);
    };
    const prs = await fetchAllOpenPRs("o/r", cache, 50, mockGh);
    assertEquals(prs.length, 1);
    assertEquals(prs[0]?.number, 5);
    assertEquals(prs[0]?.headRefName, "issue-5");
    assertEquals(prs[0]?.body, "vibe-worker-issue-5 body");
    assertEquals(calls.length, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchAllOpenPRs - cache hit avoids gh call", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = async (_args: string[]): Promise<string> => {
      callCount++;
      return JSON.stringify([
        {
          number: 7,
          title: "T",
          baseRefName: "main",
          headRefName: "h",
          body: "",
          url: "",
        },
      ]);
    };
    await fetchAllOpenPRs("o/r", cache, 50, mockGh);
    await fetchAllOpenPRs("o/r", cache, 50, mockGh);
    assertEquals(callCount, 1, "second call should be served from cache");
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchAllOpenPRs - cache invalidation forces refetch", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = async (_args: string[]): Promise<string> => {
      callCount++;
      return "[]";
    };
    await fetchAllOpenPRs("o/r", cache, 50, mockGh);
    await cache.invalidate("o/r", "prs_open_all");
    await fetchAllOpenPRs("o/r", cache, 50, mockGh);
    assertEquals(callCount, 2, "post-invalidate read must hit network");
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchAllOpenPRs - rejects invalid JSON (Issue #4257)", async () => {
  // Contract changed by Issue #4257: unparseable output used to read as
  // "no open PRs" — the answer that marks a branch deletion safe. It is
  // now a thrown failure and nothing is cached.
  const { cache, cleanup } = await makeTempCache();
  try {
    const mockGh = (_args: string[]): Promise<string> =>
      Promise.resolve("not json");
    await assertRejects(
      () => fetchAllOpenPRs("o/r", cache, 50, mockGh),
      Error,
      "4257",
    );
    assertEquals(await cache.read("o/r", "prs_open_all"), null);
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchAllOpenPRs - works without cache", async () => {
  const mockGh = async (_args: string[]): Promise<string> =>
    JSON.stringify([
      {
        number: 1,
        title: "T",
        baseRefName: "main",
        headRefName: "h",
        body: "",
        url: "",
      },
    ]);
  const prs = await fetchAllOpenPRs("o/r", undefined, 50, mockGh);
  assertEquals(prs.length, 1);
});

// =============================================================================
// fetchOpenPRsForFleet (Issue #3100)
// =============================================================================

/** Build a mock gh returning per-author PR lists keyed by --author value. */
function mockGhByAuthor(
  byAuthor: Record<string, Array<{ number: number; baseRefName: string }>>,
): { fn: (args: string[]) => Promise<string>; authors: string[] } {
  const authors: string[] = [];
  const fn = (args: string[]): Promise<string> => {
    const idx = args.indexOf("--author");
    const author = idx >= 0 ? args[idx + 1] ?? "" : "";
    authors.push(author);
    const prs = (byAuthor[author] ?? []).map((p) => ({
      number: p.number,
      title: `PR ${p.number}`,
      baseRefName: p.baseRefName,
      headRefName: `issue-${p.number}`,
    }));
    return Promise.resolve(JSON.stringify(prs));
  };
  return { fn, authors };
}

Deno.test("issue_query - fetchOpenPRsForFleet - unions PRs across fleet accounts", async () => {
  const { fn } = mockGhByAuthor({
    VibeCoderBot: [{ number: 10, baseRefName: "main" }],
    stsvcbot: [{ number: 20, baseRefName: "milestone/x" }],
  });
  const prs = await fetchOpenPRsForFleet(
    "o/r",
    ["VibeCoderBot", "stsvcbot"],
    undefined,
    fn,
  );
  assertEquals(prs.map((p) => p.number).sort((a, b) => a - b), [10, 20]);
});

Deno.test("issue_query - fetchOpenPRsForFleet - de-duplicates by PR number", async () => {
  // The same PR could be reported for two authors if config lists duplicates
  // or gh attributes oddly; the union must collapse it.
  const { fn } = mockGhByAuthor({
    alice: [{ number: 7, baseRefName: "main" }],
    bob: [{ number: 7, baseRefName: "main" }, {
      number: 8,
      baseRefName: "main",
    }],
  });
  const prs = await fetchOpenPRsForFleet(
    "o/r",
    ["alice", "bob"],
    undefined,
    fn,
  );
  assertEquals(prs.map((p) => p.number).sort((a, b) => a - b), [7, 8]);
});

Deno.test("issue_query - fetchOpenPRsForFleet - skips blank authors and dedups author list", async () => {
  const { fn, authors } = mockGhByAuthor({
    alice: [{ number: 1, baseRefName: "main" }],
  });
  await fetchOpenPRsForFleet(
    "o/r",
    ["alice", "alice", "", "  "],
    undefined,
    fn,
  );
  // Only one distinct, non-blank author → exactly one gh call for "alice".
  assertEquals(authors, ["alice"]);
});

Deno.test("issue_query - fetchOpenPRsForFleet - empty author list yields no PRs and no calls", async () => {
  let calls = 0;
  const fn = (_args: string[]): Promise<string> => {
    calls++;
    return Promise.resolve("[]");
  };
  const prs = await fetchOpenPRsForFleet("o/r", [], undefined, fn);
  assertEquals(prs, []);
  assertEquals(calls, 0);
});

Deno.test("issue_query - fetchOpenPRsForFleet - forceRefresh bypasses a stale cache entry (Issue #3150)", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    // Seed the per-user cache with an empty (stale) result, as the
    // discovery-time guard would.
    await cache.write("o/r", "prs_alice", []);

    let callCount = 0;
    const fn = (_args: string[]): Promise<string> => {
      callCount++;
      // Live: a PR has since been opened.
      return Promise.resolve(
        JSON.stringify([
          {
            number: 99,
            title: "PR 99",
            baseRefName: "main",
            headRefName: "issue-99",
          },
        ]),
      );
    };

    // Without forceRefresh the stale empty cache hides the live PR.
    const stale = await fetchOpenPRsForFleet("o/r", ["alice"], cache, fn);
    assertEquals(stale, []);
    assertEquals(callCount, 0, "cached read must not hit the network");

    // With forceRefresh the live PR is seen despite the stale cache.
    const fresh = await fetchOpenPRsForFleet(
      "o/r",
      ["alice"],
      cache,
      fn,
      undefined,
      true,
    );
    assertEquals(fresh.map((p) => p.number), [99]);
    assertEquals(callCount, 1, "forceRefresh must hit the network");

    // The refreshed result overwrites the cache for later reads.
    const afterRefresh = await fetchOpenPRsForFleet(
      "o/r",
      ["alice"],
      cache,
      fn,
    );
    assertEquals(afterRefresh.map((p) => p.number), [99]);
    assertEquals(callCount, 1, "post-refresh read must be served from cache");
  } finally {
    await cleanup();
  }
});

// =============================================================================
// fetchRecentlyClosedPRsForFleet (Issue #3151)
// =============================================================================

/**
 * Build a mock gh returning per-author closed-PR lists (with merge state)
 * keyed by the `--author` value, mirroring `gh pr list --state closed`.
 */
function mockClosedGhByAuthor(
  byAuthor: Record<
    string,
    Array<{
      number: number;
      title: string;
      mergedAt: string | null;
      closedAt: string | null;
    }>
  >,
): { fn: (args: string[]) => Promise<string>; authors: string[] } {
  const authors: string[] = [];
  const fn = (args: string[]): Promise<string> => {
    const idx = args.indexOf("--author");
    const author = idx >= 0 ? args[idx + 1] ?? "" : "";
    authors.push(author);
    return Promise.resolve(JSON.stringify(byAuthor[author] ?? []));
  };
  return { fn, authors };
}

/** ISO timestamp `secondsAgo` before now. */
function isoAgo(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

Deno.test("issue_query - fetchRecentlyClosedPRsForFleet - merged PR by sibling is a permanent block (past cooldown)", async () => {
  // Sibling account merged a PR long before the cooldown window. It must
  // still block re-pickup permanently (Failure Mode B, Issue #3136).
  const { fn } = mockClosedGhByAuthor({
    self: [],
    sibling: [{
      number: 680,
      title: "Fix thing (#678)",
      mergedAt: isoAgo(7200), // 2h ago, well past the 1h cooldown
      closedAt: isoAgo(7200),
    }],
  });
  const prs = await fetchRecentlyClosedPRsForFleet(
    "o/r",
    ["self", "sibling"],
    3600,
    undefined,
    fn,
  );
  assertEquals(prs.length, 1);
  assertEquals(prs[0]?.number, 680);
  assertEquals(prs[0]?.merged, true);
  // Reusing isBlockedByRecentlyClosedPR semantics, the source issue is blocked.
  assertEquals(isBlockedByRecentlyClosedPR(prs, 678)?.number, 680);
});

Deno.test("issue_query - a merged fleet PR still blocks an issue whose earlier attempt was closed-unmerged and expired (Issue #3151 fleet-wide)", async () => {
  // Realistic fleet shape for one issue #678: account A's first attempt (PR
  // #679) was closed-unmerged long ago (past the cooldown → would be a retry
  // path on its own), then account B's PR #680 merged. The merged PR must win
  // and block re-pickup permanently even though the expired attempt alone
  // would not.
  const { fn } = mockClosedGhByAuthor({
    "account-a": [{
      number: 679,
      title: "Fix validation (#678)",
      mergedAt: null,
      closedAt: isoAgo(7200), // expired closed-unmerged
    }],
    "account-b": [{
      number: 680,
      title: "Fix validation (#678)",
      mergedAt: isoAgo(9000), // merged, past cooldown
      closedAt: isoAgo(9000),
    }],
  });
  const prs = await fetchRecentlyClosedPRsForFleet(
    "o/r",
    ["account-a", "account-b"],
    3600,
    undefined,
    fn,
  );
  // The expired closed-unmerged #679 is dropped; the merged #680 remains and
  // blocks issue #678 permanently.
  assertEquals(prs.some((p) => p.number === 679), false);
  const block = isBlockedByRecentlyClosedPR(prs, 678);
  assertEquals(block?.number, 680);
  assertEquals(block?.merged, true);
});

Deno.test("issue_query - fetchRecentlyClosedPRsForFleet - closed-unmerged past cooldown is NOT blocked (retry path)", async () => {
  const { fn } = mockClosedGhByAuthor({
    self: [{
      number: 90,
      title: "Attempt (#88)",
      mergedAt: null,
      closedAt: isoAgo(7200), // past the 1h cooldown → retry allowed
    }],
  });
  const prs = await fetchRecentlyClosedPRsForFleet(
    "o/r",
    ["self"],
    3600,
    undefined,
    fn,
  );
  assertEquals(prs, []);
});

Deno.test("issue_query - fetchRecentlyClosedPRsForFleet - closed-unmerged within cooldown is blocked but marked not merged", async () => {
  const { fn } = mockClosedGhByAuthor({
    self: [{
      number: 91,
      title: "Attempt (#89)",
      mergedAt: null,
      closedAt: isoAgo(60), // within the 1h cooldown
    }],
  });
  const prs = await fetchRecentlyClosedPRsForFleet(
    "o/r",
    ["self"],
    3600,
    undefined,
    fn,
  );
  assertEquals(prs.length, 1);
  assertEquals(prs[0]?.number, 91);
  assertEquals(prs[0]?.merged, false);
});

Deno.test("issue_query - fetchRecentlyClosedPRsForFleet - merged classification wins over closed-unmerged for same PR number", async () => {
  // The same PR number reported for two accounts, once merged once not; the
  // union must classify it merged (permanent skip).
  const { fn } = mockClosedGhByAuthor({
    alice: [{
      number: 5,
      title: "Fix (#4)",
      mergedAt: null,
      closedAt: isoAgo(30),
    }],
    bob: [{
      number: 5,
      title: "Fix (#4)",
      mergedAt: isoAgo(9000),
      closedAt: isoAgo(9000),
    }],
  });
  const prs = await fetchRecentlyClosedPRsForFleet(
    "o/r",
    ["alice", "bob"],
    3600,
    undefined,
    fn,
  );
  assertEquals(prs.length, 1);
  assertEquals(prs[0]?.merged, true);
});

Deno.test("issue_query - fetchRecentlyClosedPRsForFleet - skips blank/duplicate authors and empty list makes no calls", async () => {
  const { fn, authors } = mockClosedGhByAuthor({
    alice: [],
  });
  await fetchRecentlyClosedPRsForFleet(
    "o/r",
    ["alice", "alice", "", "  "],
    3600,
    undefined,
    fn,
  );
  assertEquals(authors, ["alice"]);

  let calls = 0;
  const countFn = (_args: string[]): Promise<string> => {
    calls++;
    return Promise.resolve("[]");
  };
  const prs = await fetchRecentlyClosedPRsForFleet(
    "o/r",
    [],
    3600,
    undefined,
    countFn,
  );
  assertEquals(prs, []);
  assertEquals(calls, 0);
});

Deno.test("issue_query - isBlockedByRecentlyClosedPR - matches (#N), Issue #N and trailing #N without partial matches", () => {
  const prs: ClosedPR[] = [
    { number: 1, title: "Fix bug (#42)", closedAt: "", merged: true },
    { number: 2, title: "Resolve Issue #43", closedAt: "", merged: false },
    { number: 3, title: "Cleanup #44", closedAt: "", merged: true },
  ];
  assertEquals(isBlockedByRecentlyClosedPR(prs, 42)?.number, 1);
  assertEquals(isBlockedByRecentlyClosedPR(prs, 43)?.number, 2);
  assertEquals(isBlockedByRecentlyClosedPR(prs, 44)?.number, 3);
  // #44 must not spuriously match issue #4 (word-boundary guard).
  assertEquals(isBlockedByRecentlyClosedPR(prs, 4), null);
});

// =============================================================================
// fetchMergedPRsByUser (Issue #1787)
// =============================================================================

Deno.test("issue_query - fetchMergedPRsByUser - cache miss fetches and parses JSON", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      return JSON.stringify([
        { number: 11, title: "Fix (#42)", headRefName: "issue-42" },
      ]);
    };
    const prs = await fetchMergedPRsByUser("o/r", "bot", cache, 30, mockGh);
    assertEquals(prs.length, 1);
    assertEquals(prs[0]?.number, 11);
    assertEquals(prs[0]?.headRefName, "issue-42");
    assertEquals(calls.length, 1);
    // Verify --author flag was included.
    const sent = calls[0]!.join(" ");
    assertEquals(sent.includes("--author bot"), true);
    assertEquals(sent.includes("--state merged"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchMergedPRsByUser - cache hit avoids gh call", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = async (_args: string[]): Promise<string> => {
      callCount++;
      return JSON.stringify([
        { number: 1, title: "T", headRefName: "h" },
      ]);
    };
    await fetchMergedPRsByUser("o/r", "bot", cache, 30, mockGh);
    await fetchMergedPRsByUser("o/r", "bot", cache, 30, mockGh);
    assertEquals(callCount, 1, "second call must use cache");
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchMergedPRsByUser - cache invalidation forces refetch", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    let callCount = 0;
    const mockGh = async (_args: string[]): Promise<string> => {
      callCount++;
      return "[]";
    };
    await fetchMergedPRsByUser("o/r", "bot", cache, 30, mockGh);
    await cache.invalidate("o/r", "prs_merged_bot");
    await fetchMergedPRsByUser("o/r", "bot", cache, 30, mockGh);
    assertEquals(callCount, 2);
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchMergedPRsByUser - rejects invalid JSON (Issue #4257)", async () => {
  // Contract changed by Issue #4257: a failed call must surface as a
  // failure, never as "this user has no merged PRs here".
  const { cache, cleanup } = await makeTempCache();
  try {
    const mockGh = (_args: string[]): Promise<string> =>
      Promise.resolve("broken");
    await assertRejects(
      () => fetchMergedPRsByUser("o/r", "bot", cache, 30, mockGh),
      Error,
      "4257",
    );
    assertEquals(await cache.read("o/r", "prs_merged_bot"), null);
  } finally {
    await cleanup();
  }
});

// =============================================================================
// Never cache a failure as an empty list (Issue #4257)
// =============================================================================

Deno.test("issue_query - fetchAllIssues rejects empty gh output and leaves the cache untouched (Issue #4257)", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    // runGh-style failure: gh failed, the wrapper returned "".
    await assertRejects(
      () => fetchAllIssues("org/repo", cache, 100, () => Promise.resolve("")),
      Error,
      "4257",
    );
    assertEquals(
      await cache.read("org/repo", "issues_all"),
      null,
      "a failed list call must not poison issues_all",
    );

    // A subsequent good call populates the cache normally.
    const issues = await fetchAllIssues(
      "org/repo",
      cache,
      100,
      () =>
        Promise.resolve(JSON.stringify([{ number: 9, title: "Real issue" }])),
    );
    assertEquals(issues.length, 1);
    const cached = await cache.read<unknown[]>("org/repo", "issues_all");
    assertEquals(cached?.length, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchAllIssues rejects unparseable gh output without caching (Issue #4257)", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    await assertRejects(
      () =>
        fetchAllIssues("org/repo", cache, 100, () => Promise.resolve("{oops")),
      Error,
      "4257",
    );
    assertEquals(await cache.read("org/repo", "issues_all"), null);
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchAllIssues caches a genuine empty list (Issue #4257)", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    const issues = await fetchAllIssues(
      "org/repo",
      cache,
      100,
      () => Promise.resolve("[]"),
    );
    assertEquals(issues, []);
    assertEquals(
      await cache.read("org/repo", "issues_all"),
      [],
      "an empty successful list is a real answer and belongs in the cache",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchMergedPRsByUser rejects empty gh output instead of caching [] (Issue #4257)", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    // The old code turned "" into JSON.parse("[]") and cached an empty
    // list — branch cleanup and close-issues then saw a repo with no
    // merged PRs for the 10-minute TTL.
    await assertRejects(
      () =>
        fetchMergedPRsByUser(
          "org/repo",
          "testuser",
          cache,
          30,
          () => Promise.resolve(""),
        ),
      Error,
      "4257",
    );
    assertEquals(await cache.read("org/repo", "prs_merged_testuser"), null);
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchAllOpenPRs rejects empty gh output instead of caching [] (Issue #4257)", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    // "No open PRs" is what marks a branch deletion safe — a failed call
    // must never masquerade as that answer.
    await assertRejects(
      () => fetchAllOpenPRs("org/repo", cache, 50, () => Promise.resolve("")),
      Error,
      "4257",
    );
    assertEquals(await cache.read("org/repo", "prs_open_all"), null);
  } finally {
    await cleanup();
  }
});

Deno.test("issue_query - fetchAllClosedIssues returns [] uncached on empty gh output (Issue #4257)", async () => {
  const { cache, cleanup } = await makeTempCache();
  try {
    // This fetcher's contract swallows gh failures (returns []); the
    // #4257 requirement is only that the failure is never *cached*.
    const issues = await fetchAllClosedIssues(
      "org/repo",
      cache,
      500,
      () => Promise.resolve(""),
    );
    assertEquals(issues, []);
    assertEquals(
      await cache.read("org/repo", "issues_closed_all"),
      null,
      "a failed closed-issues call must not poison issues_closed_all",
    );
  } finally {
    await cleanup();
  }
});
