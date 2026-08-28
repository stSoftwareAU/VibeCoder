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
  type MergedPrIssueSweepOptions,
  sweepMergedPrIssues,
} from "../lib/merged_pr_issue_sweep.ts";
import type { Logger } from "../types.ts";

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
}

interface GhWorld {
  issues: GhWorldIssue[];
  prs: GhWorldPr[];
  /** Comparison status returned for `compare/<default>...<sha>`. */
  compareStatus?: string;
  /** Repos whose issue list fetch fails. */
  failingIssueRepos?: string[];
}

interface GhCalls {
  closes: Array<{ issue: string; comment: string }>;
}

/**
 * A `gh` mock backed by a small world model, so the sweep exercises the real
 * parsers, matchers and landing check rather than a stubbed decision.
 */
function makeGh(world: GhWorld, calls: GhCalls) {
  return (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    const repo = args[args.indexOf("--repo") + 1] ?? "";

    if (args[0] === "issue" && args[1] === "list") {
      if (world.failingIssueRepos?.includes(repo)) {
        return Promise.reject(new Error("gh: issue list failed (403)"));
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
