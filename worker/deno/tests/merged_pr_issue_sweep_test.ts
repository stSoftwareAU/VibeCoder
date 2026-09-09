/**
 * Tests for merged_pr_issue_sweep.ts — the repo-wide sweep that closes an
 * issue whose fix has already merged and landed (Issue #504).
 *
 * The worker only closed such an issue from inside the run that was working
 * it, so a fix merged by anyone else — or by a run that died between the
 * merge and its completion phase — left the issue open for ever, refused by
 * every claim scan as `merged-pr-permanent`.
 *
 * Every test drives the real gates through a mocked `gh` seam: the claim
 * scan's own merged-PR matcher, the Issue #482 ordering guard, the Issue
 * #4396 merge-landing check, and the trusted-re-label escape hatch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildSweepCloseComment,
  type MergedPrIssueSweepOptions,
  sweepMergedPrIssues,
} from "../lib/merged_pr_issue_sweep.ts";
import type { Logger } from "../types.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { buildRollbackMarker } from "../lib/milestone_rollback_marker.ts";
import {
  loadSweepWatermarks,
  mergedIssueSweepWatermarkPath,
} from "../lib/merged_sweep_watermark.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(lines: string[] = []): Logger {
  return {
    info: (m) => lines.push(`info:${m}`),
    warn: (m) => lines.push(`warn:${m}`),
    error: (m) => lines.push(`error:${m}`),
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

function baseOptions(
  overrides: Partial<MergedPrIssueSweepOptions> = {},
): MergedPrIssueSweepOptions {
  return {
    repos: ["org/repo"],
    githubUser: "vibe-bot",
    fleetAuthors: ["vibe-bot", "human-maintainer"],
    allowedAuthors: ["human-maintainer"],
    ...overrides,
  };
}

interface GhWorldIssue {
  number: number;
  title?: string;
  labels?: string[];
  createdAt?: string;
  state?: string;
}

interface GhWorldPr {
  number: number;
  title: string;
  /** Non-null marks the PR merged. */
  mergedAt: string | null;
  closedAt: string | null;
  /** `gh pr view` state — defaults from `mergedAt`. */
  state?: string;
  mergeCommit?: string | null;
  baseRefName?: string;
  /** The PR body, for its closing keywords (Issue #1528). */
  body?: string;
}

interface GhWorld {
  issues: GhWorldIssue[];
  prs: GhWorldPr[];
  /** Comparison status returned for `compare/<default>...<sha>`. */
  compareStatus?: string;
  /** Repos whose issue list fetch fails. */
  failingIssueRepos?: string[];
  /** Repos whose issue list fetch is refused for want of GraphQL quota. */
  rateLimitedRepos?: string[];
}

interface GhCalls {
  closes: Array<{ issue: string; comment: string }>;
  /** Every `gh` argv the sweep issued, in order (opt in). */
  all?: string[][];
}

/** What GitHub says when the hourly primary quota is spent. */
const RATE_LIMIT_MESSAGE =
  "gh command failed (exit 1): GraphQL: API rate limit already exceeded for user ID 283951956.";

/**
 * A `gh` mock backed by a small world model, so the sweep exercises the real
 * parsers, matchers and landing check rather than a stubbed decision.
 */
function makeGh(world: GhWorld, calls: GhCalls) {
  return (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    const repo = args[args.indexOf("--repo") + 1] ?? "";
    calls.all?.push([...args]);

    if (args[0] === "issue" && args[1] === "list") {
      if (world.failingIssueRepos?.includes(repo)) {
        return Promise.reject(new Error("gh: issue list failed (403)"));
      }
      if (world.rateLimitedRepos?.includes(repo)) {
        return Promise.reject(new Error(RATE_LIMIT_MESSAGE));
      }
      return Promise.resolve(JSON.stringify(
        world.issues.map((i) => ({
          number: i.number,
          title: i.title ?? `Issue ${i.number}`,
          assignees: [],
          url: `https://github.com/${repo}/issues/${i.number}`,
          labels: (i.labels ?? []).map((name) => ({ name })),
          createdAt: i.createdAt ?? "2026-08-01T00:00:00Z",
          updatedAt: i.createdAt ?? "2026-08-01T00:00:00Z",
          author: { login: "human-maintainer" },
          milestone: null,
          body: "",
        })),
      ));
    }

    if (args[0] === "pr" && args[1] === "list") {
      const author = args[args.indexOf("--author") + 1] ?? "";
      // Only the first fleet author owns the PRs in these fixtures; the
      // union across authors is de-duplicated by the production fetcher.
      const owned = author === "vibe-bot" ? world.prs : [];
      return Promise.resolve(JSON.stringify(
        owned.map((p) => ({
          number: p.number,
          title: p.title,
          mergedAt: p.mergedAt,
          closedAt: p.closedAt,
          body: p.body ?? "",
        })),
      ));
    }

    if (args[0] === "pr" && args[1] === "view") {
      const number = Number(args[2]);
      const pr = world.prs.find((p) => p.number === number);
      if (!pr) return Promise.reject(new Error(`no such PR #${number}`));
      const state = pr.state ?? (pr.mergedAt ? "MERGED" : "CLOSED");
      return Promise.resolve(JSON.stringify({
        state,
        headRefName: `issue-${number}-branch`,
        baseRefName: pr.baseRefName ?? "Develop",
        mergedAt: pr.mergedAt,
        mergeCommit: pr.mergeCommit === null
          ? null
          : { oid: pr.mergeCommit ?? "deadbee" },
      }));
    }

    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      const issue = world.issues.find((i) => i.number === number);
      return Promise.resolve(JSON.stringify({
        state: issue?.state ?? "OPEN",
        milestone: null,
        labels: (issue?.labels ?? []).map((name) => ({ name })),
        createdAt: issue?.createdAt ?? "2026-08-01T00:00:00Z",
      }));
    }

    if (args[0] === "issue" && args[1] === "close") {
      const commentIndex = args.indexOf("--comment");
      calls.closes.push({
        issue: args[2] ?? "",
        comment: commentIndex === -1 ? "" : (args[commentIndex + 1] ?? ""),
      });
      return Promise.resolve("");
    }

    if (joined.includes(".default_branch")) {
      return Promise.resolve("Develop\n");
    }
    if (joined.includes("/compare/")) {
      return Promise.resolve(
        JSON.stringify({ status: world.compareStatus ?? "behind" }),
      );
    }
    // Timeline (trusted re-label check) and anything else: empty.
    return Promise.resolve("[]");
  };
}

/** The canonical world: issue #48 fixed by merged, landed PR #49. */
function landedWorld(overrides: Partial<GhWorld> = {}): GhWorld {
  return {
    issues: [{
      number: 48,
      title: "Producer emits stale scores",
      labels: ["bug", "work-on"],
      createdAt: "2026-08-26T00:00:00Z",
    }],
    prs: [{
      number: 49,
      title: "Fix the producer (Issue #48)",
      mergedAt: "2026-08-28T04:55:00Z",
      closedAt: "2026-08-28T04:55:00Z",
      mergeCommit: "f00dcafe",
    }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Acceptance: a merged, landed PR closes the issue whoever authored it
// ---------------------------------------------------------------------------

Deno.test("sweepMergedPrIssues - closes an open issue named by a merged, landed PR", async () => {
  const calls: GhCalls = { closes: [] };
  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: makeGh(landedWorld(), calls),
    logger: makeLogger(),
  });

  assertEquals(result.closed, 1);
  assertEquals(result.candidates, 1);
  assertEquals(result.failures, []);
  assertEquals(calls.closes.length, 1);
  assertEquals(calls.closes[0]?.issue, "48");
});

Deno.test("sweepMergedPrIssues - the closure names the PR and the merge commit", async () => {
  const calls: GhCalls = { closes: [] };
  await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: makeGh(landedWorld(), calls),
    logger: makeLogger(),
  });

  const comment = calls.closes[0]?.comment ?? "";
  assertStringIncludes(comment, "#49");
  assertStringIncludes(comment, "f00dcafe");
  assertStringIncludes(comment, "504");
});

// ---------------------------------------------------------------------------
// Acceptance: the merge-landing check (Issue #4396) is not weakened
// ---------------------------------------------------------------------------

Deno.test("sweepMergedPrIssues - a merged PR whose change did not land leaves the issue open", async () => {
  const calls: GhCalls = { closes: [] };
  const world = landedWorld({ compareStatus: "diverged" });
  world.prs[0]!.baseRefName = "feature/orphan";

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: makeGh(world, calls),
    logger: makeLogger(),
  });

  assertEquals(result.closed, 0);
  assertEquals(calls.closes.length, 0);
  assert(
    result.records.some((r) =>
      r.outcome === "skipped" && r.reason.includes("did not land")
    ),
    `expected an unlanded skip, got ${JSON.stringify(result.records)}`,
  );
});

// ---------------------------------------------------------------------------
// Acceptance: an open or closed-unmerged PR touches nothing
// ---------------------------------------------------------------------------

Deno.test("sweepMergedPrIssues - an issue named only by a closed-unmerged PR is untouched", async () => {
  const calls: GhCalls = { closes: [] };
  const world = landedWorld();
  world.prs[0]!.mergedAt = null;
  world.prs[0]!.closedAt = new Date().toISOString();

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: makeGh(world, calls),
    logger: makeLogger(),
  });

  assertEquals(result.candidates, 0);
  assertEquals(result.closed, 0);
  assertEquals(calls.closes.length, 0);
});

Deno.test("sweepMergedPrIssues - an issue named only by an open PR is untouched", async () => {
  const calls: GhCalls = { closes: [] };
  // An open PR never appears in the closed/merged fleet set.
  const world = landedWorld({ prs: [] });

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: makeGh(world, calls),
    logger: makeLogger(),
  });

  assertEquals(result.candidates, 0);
  assertEquals(calls.closes.length, 0);
});

// ---------------------------------------------------------------------------
// Acceptance: needs-human is never closed by the sweep
// ---------------------------------------------------------------------------

Deno.test("sweepMergedPrIssues - never closes an issue carrying needs-human", async () => {
  const calls: GhCalls = { closes: [] };
  const world = landedWorld();
  world.issues[0]!.labels = ["bug", "needs-human"];

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: makeGh(world, calls),
    logger: makeLogger(),
  });

  assertEquals(result.closed, 0);
  assertEquals(calls.closes.length, 0);
  assert(
    result.records.some((r) => r.reason.includes("needs-human")),
    `expected a needs-human skip, got ${JSON.stringify(result.records)}`,
  );
});

// ---------------------------------------------------------------------------
// Acceptance: a fix cannot predate the thing it fixes (Issue #482)
// ---------------------------------------------------------------------------

Deno.test("sweepMergedPrIssues - an issue filed after the merge is never closed by it", async () => {
  const calls: GhCalls = { closes: [] };
  const world = landedWorld();
  world.issues[0]!.createdAt = "2026-08-29T00:00:00Z"; // after the merge

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: makeGh(world, calls),
    logger: makeLogger(),
  });

  assertEquals(result.closed, 0);
  assertEquals(calls.closes.length, 0);
});

// ---------------------------------------------------------------------------
// A trusted re-label after the merge re-opens the work — hands off
// ---------------------------------------------------------------------------

Deno.test("sweepMergedPrIssues - a trusted re-label after the merge stops the closure", async () => {
  const calls: GhCalls = { closes: [] };
  const inner = makeGh(landedWorld(), calls);
  const gh = (args: string[]): Promise<string> => {
    if (args.join(" ").includes("/timeline")) {
      return Promise.resolve(JSON.stringify([{
        event: "labeled",
        label: { name: "work-on" },
        actor: { login: "human-maintainer" },
        created_at: "2026-08-28T06:00:00Z",
      }]));
    }
    return inner(args);
  };

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: gh,
    logger: makeLogger(),
  });

  assertEquals(result.closed, 0);
  assertEquals(calls.closes.length, 0);
  assert(
    result.records.some((r) => r.reason.includes("re-label")),
    `expected a re-label skip, got ${JSON.stringify(result.records)}`,
  );
});

// ---------------------------------------------------------------------------
// A milestone roll-back after the merge keeps the reverted child open (#1770)
// ---------------------------------------------------------------------------

/** The roll-back marker a milestone roll-back posts on a reverted child. */
const ROLLBACK_COMMENT = buildRollbackMarker({
  prNumber: 49,
  revertSha: "beefca7",
  branch: "milestone/1730-resolve-merge-conflicts",
});

/** Wrap the world `gh` mock so the issue thread carries one comment. */
function withComments(
  inner: (args: string[]) => Promise<string>,
  comments: Array<Record<string, unknown>>,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    if (args[0] === "api" && (args[1] ?? "").includes("/comments")) {
      // Only the first page carries anything; a short page ends the read.
      return Promise.resolve(
        JSON.stringify((args[1] ?? "").includes("page=1") ? comments : []),
      );
    }
    return inner(args);
  };
}

Deno.test("sweepMergedPrIssues - a fleet roll-back after the merge skips the close as rolled-back (Issue #1770)", async () => {
  const calls: GhCalls = { closes: [] };
  const gh = withComments(makeGh(landedWorld(), calls), [{
    user: { login: "vibe-bot" },
    created_at: "2026-08-29T09:00:00Z",
    body: `Rolled back by the milestone.\n\n${ROLLBACK_COMMENT}`,
  }]);

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: gh,
    logger: makeLogger(),
  });

  assertEquals(result.closed, 0);
  assertEquals(calls.closes.length, 0);
  assert(
    result.records.some((r) =>
      r.outcome === "skipped" && r.reason.startsWith("rolled-back")
    ),
    `expected a rolled-back skip, got ${JSON.stringify(result.records)}`,
  );
});

Deno.test("sweepMergedPrIssues - the same roll-back marker from a non-fleet author still closes (Issue #1770)", async () => {
  const calls: GhCalls = { closes: [] };
  const gh = withComments(makeGh(landedWorld(), calls), [{
    user: { login: "drive-by" },
    created_at: "2026-08-29T09:00:00Z",
    body: ROLLBACK_COMMENT,
  }]);

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: gh,
    logger: makeLogger(),
  });

  assertEquals(result.closed, 1);
  assertEquals(calls.closes[0]?.issue, "48");
});

Deno.test("sweepMergedPrIssues - a roll-back marker predating the merge does not block the close (Issue #1770)", async () => {
  const calls: GhCalls = { closes: [] };
  const gh = withComments(makeGh(landedWorld(), calls), [{
    user: { login: "vibe-bot" },
    created_at: "2026-08-27T09:00:00Z",
    body: ROLLBACK_COMMENT,
  }]);

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: gh,
    logger: makeLogger(),
  });

  assertEquals(result.closed, 1);
  assertEquals(calls.closes[0]?.issue, "48");
});

Deno.test("sweepMergedPrIssues - an unreadable comment thread leaves the issue open, loudly (Issue #1770)", async () => {
  const calls: GhCalls = { closes: [] };
  const inner = makeGh(landedWorld(), calls);
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "api" && (args[1] ?? "").includes("/comments")) {
      return Promise.reject(new Error("gh: comments unavailable (500)"));
    }
    return inner(args);
  };

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: gh,
    logger: makeLogger(),
  });

  assertEquals(result.closed, 0);
  assertEquals(calls.closes.length, 0);
  assert(
    result.records.some((r) =>
      r.outcome === "skipped" && r.reason.includes("comments unavailable")
    ),
    `expected an unreadable-thread skip, got ${JSON.stringify(result.records)}`,
  );
});

// ---------------------------------------------------------------------------
// Fail loud: a repo that cannot be scanned is reported, not swallowed
// ---------------------------------------------------------------------------

Deno.test("sweepMergedPrIssues - a repo whose scan fails is reported and does not stop the sweep", async () => {
  const calls: GhCalls = { closes: [] };
  const lines: string[] = [];
  const world = landedWorld({ failingIssueRepos: ["org/broken"] });

  const result = await sweepMergedPrIssues(
    baseOptions({ repos: ["org/broken", "org/repo"] }),
    { ghCommandFn: makeGh(world, calls), logger: makeLogger(lines) },
  );

  assertEquals(result.failures.length, 1);
  assertStringIncludes(result.failures[0] ?? "", "org/broken");
  // The healthy repo is still swept.
  assertEquals(result.closed, 1);
  assert(
    lines.some((l) => l.startsWith("error:")),
    "the repo failure must be logged loud",
  );
  assertStringIncludes(result.message, "1 repo failure");
});

Deno.test("sweepMergedPrIssues - no repos is a clean no-op", async () => {
  const calls: GhCalls = { closes: [] };
  const result = await sweepMergedPrIssues(
    baseOptions({ repos: [] }),
    { ghCommandFn: makeGh(landedWorld(), calls), logger: makeLogger() },
  );

  assertEquals(result.scanned, 0);
  assertEquals(result.closed, 0);
  assertEquals(result.failures, []);
});

// ---------------------------------------------------------------------------
// Issue #1477: quota is a skip, reported once — not N repo failures
// ---------------------------------------------------------------------------

const NINETEEN_REPOS = Array.from({ length: 19 }, (_, i) => `org/repo-${i}`);

Deno.test("sweepMergedPrIssues - an exhausted quota costs one call, one line, and skips the rest (Issue #1477)", async () => {
  const calls: GhCalls = { closes: [], all: [] };
  const lines: string[] = [];
  const world = landedWorld({ rateLimitedRepos: NINETEEN_REPOS });

  const result = await sweepMergedPrIssues(
    baseOptions({ repos: NINETEEN_REPOS }),
    {
      ghCommandFn: makeGh(world, calls),
      logger: makeLogger(lines),
      isQuotaLatchedFn: () => false,
    },
  );

  assertEquals(calls.all?.length, 1, "the first refusal is the last call");
  assertEquals(result.failures, [], "one quota exhaustion is not 19 failures");
  assertEquals(result.closed, 0);
  assertEquals(result.reposSkipped, 19);
  assertStringIncludes(
    result.quotaExhausted ?? "",
    "rate limit already exceeded",
  );
  const warnings = lines.filter((l) => l.startsWith("warn:"));
  assertEquals(warnings.length, 1, "exactly one line names the condition");
  assertStringIncludes(warnings[0] ?? "", "quota exhausted");
  assertStringIncludes(warnings[0] ?? "", "19 of 19 repo(s)");
  assertEquals(lines.filter((l) => l.startsWith("error:")), []);
  assertStringIncludes(result.message, "quota exhausted, sweep skipped");
  assertStringIncludes(result.message, "resumes next cycle");
});

Deno.test("sweepMergedPrIssues - a quota refusal part-way keeps the repos already swept (Issue #1477)", async () => {
  const calls: GhCalls = { closes: [], all: [] };
  const lines: string[] = [];
  const world = landedWorld({ rateLimitedRepos: ["org/limited"] });

  const result = await sweepMergedPrIssues(
    baseOptions({ repos: ["org/repo", "org/limited", "org/after"] }),
    {
      ghCommandFn: makeGh(world, calls),
      logger: makeLogger(lines),
      isQuotaLatchedFn: () => false,
    },
  );

  assertEquals(result.closed, 1, "the first repo's close stands");
  assertEquals(result.reposSkipped, 2, "the refused repo and the one after it");
  assertEquals(result.failures, []);
  assert(
    !calls.all?.some((a) => a.includes("org/after")),
    "no call may be made for a repo after the refusal",
  );
});

Deno.test("sweepMergedPrIssues - a latch already set stops the sweep before any call (Issue #1477)", async () => {
  const calls: GhCalls = { closes: [], all: [] };
  const lines: string[] = [];

  const result = await sweepMergedPrIssues(
    baseOptions({ repos: NINETEEN_REPOS }),
    {
      ghCommandFn: makeGh(landedWorld(), calls),
      logger: makeLogger(lines),
      isQuotaLatchedFn: () => true,
    },
  );

  assertEquals(calls.all, [], "a latched process spends nothing");
  assertEquals(result.reposSkipped, 19);
  assertEquals(result.failures, []);
  assertEquals(lines.filter((l) => l.startsWith("warn:")).length, 1);
});

Deno.test("sweepMergedPrIssues - a rate-limited pre-flight skips the whole sweep without a call (Issue #1477)", async () => {
  const calls: GhCalls = { closes: [], all: [] };
  const lines: string[] = [];
  let preflights = 0;

  const result = await sweepMergedPrIssues(
    baseOptions({ repos: NINETEEN_REPOS }),
    {
      ghCommandFn: makeGh(landedWorld(), calls),
      logger: makeLogger(lines),
      isQuotaLatchedFn: () => false,
      preflightFn: () => {
        preflights++;
        return Promise.resolve({
          rateLimited: true,
          remainingSeconds: 1200,
          message: "Rate-limit signal still active (1200s remaining)",
        });
      },
    },
  );

  assertEquals(preflights, 1, "asked once per sweep, not once per repo");
  assertEquals(calls.all, []);
  assertEquals(result.reposSkipped, 19);
  assertStringIncludes(result.quotaExhausted ?? "", "signal still active");
  assertStringIncludes(result.message, "sweep skipped");
});

Deno.test("sweepMergedPrIssues - a healthy quota still sweeps every repository (Issue #1477)", async () => {
  const calls: GhCalls = { closes: [], all: [] };
  const lines: string[] = [];
  let preflights = 0;

  const result = await sweepMergedPrIssues(
    baseOptions({ repos: ["org/a", "org/b", "org/c"] }),
    {
      ghCommandFn: makeGh(landedWorld(), calls),
      logger: makeLogger(lines),
      isQuotaLatchedFn: () => false,
      preflightFn: () => {
        preflights++;
        return Promise.resolve({
          rateLimited: false,
          remainingSeconds: 0,
          message: "ok",
        });
      },
    },
  );

  assertEquals(preflights, 1);
  assertEquals(result.closed, 3, "one landed fix per repo, all closed");
  assertEquals(result.reposSkipped, 0);
  assertEquals(result.quotaExhausted, undefined);
  assertEquals(lines.filter((l) => l.startsWith("warn:")), []);
  assertEquals(calls.closes.length, 3);
});

// ---------------------------------------------------------------------------
// Issue #1477: the shared cache and the sweep watermark
// ---------------------------------------------------------------------------

Deno.test("sweepMergedPrIssues - reads the issue and PR lists through the shared cache (Issue #1477)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "merged-sweep-cache-" });
  try {
    const cache = new IssueCache(dir, 600);
    const listCalls = (calls: GhCalls): number =>
      (calls.all ?? []).filter((a) =>
        (a[0] === "issue" || a[0] === "pr") && a[1] === "list"
      ).length;

    // A world with nothing to close, so the second sweep is the same read.
    const world = landedWorld({ issues: [] });
    const first: GhCalls = { closes: [], all: [] };
    await sweepMergedPrIssues(baseOptions(), {
      ghCommandFn: makeGh(world, first),
      logger: makeLogger(),
      isQuotaLatchedFn: () => false,
      cache,
    });
    assert(listCalls(first) > 0, "a cold cache is filled by real calls");

    const second: GhCalls = { closes: [], all: [] };
    await sweepMergedPrIssues(baseOptions(), {
      ghCommandFn: makeGh(world, second),
      logger: makeLogger(),
      isQuotaLatchedFn: () => false,
      cache,
    });
    assertEquals(listCalls(second), 0, "a warm cache costs no list calls");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sweepMergedPrIssues - the watermark skips a PR already swept, without a call (Issue #1477)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "merged-sweep-mark-" });
  try {
    const watermarkPath = mergedIssueSweepWatermarkPath(dir);
    const world = landedWorld();

    const first: GhCalls = { closes: [], all: [] };
    const one = await sweepMergedPrIssues(baseOptions({ watermarkPath }), {
      ghCommandFn: makeGh(world, first),
      logger: makeLogger(),
      isQuotaLatchedFn: () => false,
    });
    assertEquals(one.closed, 1);
    assertEquals(await loadSweepWatermarks(watermarkPath), { "org/repo": 49 });

    // The stale list still shows #48 open; the sweep must not re-spend on it.
    const second: GhCalls = { closes: [], all: [] };
    const two = await sweepMergedPrIssues(baseOptions({ watermarkPath }), {
      ghCommandFn: makeGh(world, second),
      logger: makeLogger(),
      isQuotaLatchedFn: () => false,
    });
    assertEquals(two.candidates, 0);
    assertEquals(two.belowWatermark, 1);
    assertEquals(second.closes, []);
    assert(
      !second.all?.some((a) => a[0] === "pr" && a[1] === "view"),
      "a PR below the watermark is not looked at again",
    );
    assertStringIncludes(two.message, "1 below watermark");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sweepMergedPrIssues - the watermark holds back on what the sweep left open (Issue #1477)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "merged-sweep-hold-" });
  try {
    const watermarkPath = mergedIssueSweepWatermarkPath(dir);
    // #48 carries needs-human, so PR #49 is not settled; PR #60 merged and
    // names nothing open, so it is.
    const world = landedWorld({
      issues: [{
        number: 48,
        title: "Producer emits stale scores",
        labels: ["needs-human"],
        createdAt: "2026-08-26T00:00:00Z",
      }],
      prs: [
        {
          number: 49,
          title: "Fix the producer (Issue #48)",
          mergedAt: "2026-08-28T04:55:00Z",
          closedAt: "2026-08-28T04:55:00Z",
          mergeCommit: "f00dcafe",
        },
        {
          number: 60,
          title: "Unrelated tidy-up",
          mergedAt: "2026-08-29T04:55:00Z",
          closedAt: "2026-08-29T04:55:00Z",
          mergeCommit: "0ddba11",
        },
      ],
    });

    const calls: GhCalls = { closes: [], all: [] };
    const result = await sweepMergedPrIssues(baseOptions({ watermarkPath }), {
      ghCommandFn: makeGh(world, calls),
      logger: makeLogger(),
      isQuotaLatchedFn: () => false,
    });
    assertEquals(result.closed, 0);
    // Window reaches #60, but #49 was left open, so the mark stops at 48.
    assertEquals(await loadSweepWatermarks(watermarkPath), { "org/repo": 48 });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sweepMergedPrIssues - a quota stop never advances the interrupted repo's watermark (Issue #1477)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "merged-sweep-quota-mark-" });
  try {
    const watermarkPath = mergedIssueSweepWatermarkPath(dir);
    const world = landedWorld({ rateLimitedRepos: ["org/limited"] });
    const calls: GhCalls = { closes: [], all: [] };
    await sweepMergedPrIssues(
      baseOptions({ repos: ["org/repo", "org/limited"], watermarkPath }),
      {
        ghCommandFn: makeGh(world, calls),
        logger: makeLogger(),
        isQuotaLatchedFn: () => false,
      },
    );
    // The swept repo's progress is kept; the refused one has no mark.
    assertEquals(await loadSweepWatermarks(watermarkPath), { "org/repo": 49 });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #1528: a merged PR whose BODY closes the issue counts, whatever its
// title says, and the closure names the milestone branch it landed on
// ---------------------------------------------------------------------------

Deno.test("sweepMergedPrIssues - a merged PR that names the issue only in its body closes it (Issue #1528)", async () => {
  const calls: GhCalls = { closes: [] };
  const world = landedWorld({
    prs: [{
      number: 49,
      // No `#48` anywhere in the title — the shape of #1509 and #1524.
      title: "🟡 producer picks its victims by head-branch name alone",
      mergedAt: "2026-08-28T04:55:00Z",
      closedAt: "2026-08-28T04:55:00Z",
      mergeCommit: "f00dcafe",
      body: "## Summary\n\nCloses #48\n",
    }],
  });

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: makeGh(world, calls),
    logger: makeLogger(),
    isQuotaLatchedFn: () => false,
  });

  assertEquals(result.candidates, 1);
  assertEquals(result.closed, 1);
  assertEquals(calls.closes.map((c) => c.issue), ["48"]);
});

Deno.test("sweepMergedPrIssues - a body reference on a closed-unmerged PR closes nothing (Issue #1528)", async () => {
  const calls: GhCalls = { closes: [] };
  const world = landedWorld({
    prs: [{
      number: 49,
      title: "abandoned attempt",
      mergedAt: null,
      closedAt: "2026-08-28T04:55:00Z",
      body: "Closes #48",
    }],
  });

  const result = await sweepMergedPrIssues(baseOptions(), {
    ghCommandFn: makeGh(world, calls),
    logger: makeLogger(),
    isQuotaLatchedFn: () => false,
  });

  assertEquals(result.candidates, 0);
  assertEquals(calls.closes, []);
});

Deno.test("buildSweepCloseComment - names the milestone branch when the merge was not into the default branch (Issue #1528)", () => {
  const onMilestone = buildSweepCloseComment(1509, {
    landed: true,
    via: "milestone-route-open",
    mergeCommit: "f00dcafe",
    baseRefName: "milestone/fix-scan-issues-20260906",
  });
  assertStringIncludes(onMilestone, "PR #1509");
  assertStringIncludes(
    onMilestone,
    "into `milestone/fix-scan-issues-20260906`",
  );
  assertStringIncludes(onMilestone, "milestone's rollup");

  const onDefault = buildSweepCloseComment(49, {
    landed: true,
    via: "default-branch",
    mergeCommit: "f00dcafe",
    baseRefName: "Develop",
  });
  assert(!onDefault.includes("into `"), onDefault);
  assertStringIncludes(onDefault, "PR #49 merged and its change landed");
});
