/**
 * Per-iteration GH call budget regression test (Issue #1788).
 *
 * Pins the per-iteration `gh` call volume produced by the
 * issue-finding portion of one main-loop iteration. This is the
 * heaviest gh consumer in a normal cycle, so a budget here catches
 * the bulk of regressions that would silently bloat call volume.
 *
 * The test wires `findOldestIssue` (the body of Priority 2 in
 * `runCoreLoop`) against a fixture-driven `runGhCommand` mock that
 * also feeds `recordGhCall` so `getGhCallMetrics()` reflects the
 * iteration's call volume exactly as production telemetry would.
 *
 * Two variants are exercised:
 * - **Cold iteration:** fresh `IssueCache` and `TimelineBatchRegistry`,
 *   asserts numeric ceilings on `total`, `issue list`, `pr list`, and
 *   `api` buckets. The ceilings are deliberately set generously above
 *   the post-#1783-#1787 baseline so noise (added repos, an extra
 *   configured label) does not break the test, but tight enough that
 *   re-introducing a per-issue uncached `gh` call (the regression
 *   pattern that prompted the audit) trips the assertion.
 * - **Warm iteration:** runs a second iteration immediately after the
 *   first with the same `IssueCache` instance and a fresh
 *   `TimelineBatchRegistry` (mirroring the production iteration
 *   boundary in `run_core` where the registry is reset every cycle
 *   but the file-backed `IssueCache` persists for its TTL). The
 *   cached `issue list` and `pr list` responses must serve the warm
 *   iteration without re-issuing `gh`, proving the per-iteration
 *   cache is effective.
 *
 * Budget rationale (post #1783–#1787, three repos × twenty issues,
 * one configured-label tier, no in-cache failed/needs-clarification
 * timeline lookups):
 *
 * | Bucket          | Cold ceiling | Why                                  |
 * |-----------------|--------------|--------------------------------------|
 * | total           | 30           | Whole iteration ≤ 10 calls per repo  |
 * | issue list      | 6            | One per repo, plus headroom for misses |
 * | pr list         | 13           | fleet open + fleet closed PR list per repo (Issue #3151) |
 * | api             | 10           | Timeline graphql batch per collector |
 *
 * Issue #3151: the closed/merged duplicate guard is now fleet-wide
 * (`fetchRecentlyClosedPRsForFleet`), mirroring the fleet-aware open-PR
 * guard (#3100). With F fleet authors the per-repo `pr list` volume is
 * `F` open + `F` closed calls; the two-author fixture here therefore makes
 * 4 per repo × 3 repos = 12 calls, so the ceiling rose from 9 to 13 (one
 * call of headroom).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";

import { findOldestIssue } from "../lib/find_oldest_issue.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { TimelineBatchRegistry } from "../lib/timeline_batch_registry.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  getGhCallMetrics,
  recordGhCall,
  resetGhCallMetrics,
} from "../lib/gh_call_metrics.ts";
import type { WorkerConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const REPOS = ["owner/repo-a", "owner/repo-b", "owner/repo-c"];

const ALICE = { login: "alice" };

/** Synthetic 20-issue list per repo. Repo-a holds the winning candidate. */
function makeIssuesForRepo(repo: string): Record<string, unknown>[] {
  const issues: Record<string, unknown>[] = [];
  // The first issue in repo-a wears a top-priority label so a candidate
  // is selected and findOldestIssue exits the dependency-blocking path
  // without making per-child REST calls.
  if (repo === "owner/repo-a") {
    issues.push({
      number: 1,
      title: "Top-priority bug",
      url: `https://github.com/${repo}/issues/1`,
      assignees: [],
      labels: [{ name: "top-priority" }],
      body: "",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
      author: ALICE,
      milestone: null,
    });
  }

  // Mix of typical labels — work-on, low-priority, and a handful of
  // regular open issues without operational labels. Keep failed and
  // needs-clarification absent so cleanStaleLabels short-circuits and
  // does not issue per-issue timeline calls (those are exercised in
  // dedicated tests for cleanStaleLabels).
  const labelRotation = [
    [{ name: "work-on" }],
    [{ name: "low-priority" }],
    [], // plain open issue
    [], // plain open issue
  ];
  for (let i = 2; i <= 20; i++) {
    const labelGroup = labelRotation[(i - 2) % labelRotation.length]!;
    issues.push({
      number: i,
      title: `Issue ${i} in ${repo}`,
      url: `https://github.com/${repo}/issues/${i}`,
      assignees: [],
      labels: labelGroup,
      body: "",
      createdAt: `2024-02-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      updatedAt: `2024-02-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      author: ALICE,
      milestone: null,
    });
  }
  return issues;
}

const FIXTURE: Record<string, Record<string, unknown>[]> = {
  "owner/repo-a": makeIssuesForRepo("owner/repo-a"),
  "owner/repo-b": makeIssuesForRepo("owner/repo-b"),
  "owner/repo-c": makeIssuesForRepo("owner/repo-c"),
};

// ---------------------------------------------------------------------------
// Mock gh — wraps recordGhCall so getGhCallMetrics() reflects the iteration
// ---------------------------------------------------------------------------

/**
 * Resolve the repo touched by a `gh` invocation. Most commands use
 * `--repo owner/repo`; `gh api` calls embed the repo in URL paths or
 * GraphQL queries.
 */
function resolveRepo(args: string[]): string {
  const repoIdx = args.indexOf("--repo");
  if (repoIdx >= 0) return args[repoIdx + 1] ?? "";
  for (const arg of args) {
    const restMatch = arg.match(/^repos\/([^/]+\/[^/]+)\//);
    if (restMatch) return restMatch[1] ?? "";
    const graphqlMatch = arg.match(
      /owner:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"/,
    );
    if (graphqlMatch) return `${graphqlMatch[1]}/${graphqlMatch[2]}`;
  }
  return "";
}

/** Build the recording mock used by both cold and warm iterations. */
function createRecordingMockGh(): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    // Mirror runGhCommandRaw — every invocation must be counted exactly
    // once, regardless of whether the response is fixture data or empty.
    recordGhCall(args);

    const command = args.join(" ");
    const repo = resolveRepo(args);

    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify(FIXTURE[repo] ?? []));
    }
    if (command.includes("issue view") && command.includes("title,body")) {
      // Issue #2967: the configured-label collector's content-integrity
      // re-check reads title/body for the selected candidate. Return
      // valid JSON so the first-encounter snapshot is captured and the
      // candidate proceeds.
      return Promise.resolve(
        JSON.stringify({ title: "Top-priority bug", body: "" }),
      );
    }
    if (command.includes("pr list")) {
      return Promise.resolve("[]");
    }
    if (command.includes("api graphql")) {
      // Issue #2967: the configured-label collector now verifies the
      // top-priority label author, so the batched timeline must report an
      // authorised "labeled" event for the winning candidate (repo-a #1).
      // Parse the `nI: issue(number: M)` alias map out of the query and
      // emit a single top-priority LabeledEvent by alice for issue #1;
      // every other issue stays event-free, preserving the prior call
      // volume for the work-on and low-priority collectors (whose issues
      // are still skipped before any content-integrity read).
      const repository: Record<string, unknown> = {};
      const aliasRe = /n(\d+): issue\(number: (\d+)\)/g;
      let aliasMatch: RegExpExecArray | null;
      while ((aliasMatch = aliasRe.exec(command)) !== null) {
        const alias = `n${aliasMatch[1]}`;
        const number = Number(aliasMatch[2]);
        const nodes = number === 1
          ? [{
            __typename: "LabeledEvent",
            createdAt: "2024-01-01T00:00:00Z",
            label: { name: "top-priority" },
            actor: { login: "alice" },
          }]
          : [];
        repository[alias] = { timelineItems: { nodes } };
      }
      const body = JSON.stringify({ data: { repository } });
      return Promise.resolve(body);
    }
    if (command.includes("api")) {
      // Per-issue REST timeline fallbacks — empty array is harmless.
      return Promise.resolve("[]");
    }
    return Promise.resolve("[]");
  };
}

// ---------------------------------------------------------------------------
// Worker config
// ---------------------------------------------------------------------------

function makeConfig(): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    // Issue #3874: the content-approval store must resolve from workDir, or
    // the integrity gate fails closed and blocks every candidate.
    workDir: Deno.makeTempDirSync({ prefix: "call-budget-workdir-" }),
    repos: [...REPOS],
    issueLabels: ["top-priority"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    lowPriorityLabel: "low-priority",
    failedLabel: "failed",
    failedOnceLabel: "failed-once",
    refineIssueLabel: "refine-issue",
    planningLabel: "planning",
    questionLabel: "question",
    needsRevisionLabel: "needs-revision",
    needsHumanLabel: "needs-human",
    shuffleRepos: false,
  };
}

async function makeFreshCache(): Promise<{
  cache: IssueCache;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "iter-budget-" });
  const cache = new IssueCache(dir, 600);
  return {
    cache,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => undefined),
  };
}

// ---------------------------------------------------------------------------
// Cold iteration — pins explicit per-bucket budgets
// ---------------------------------------------------------------------------

Deno.test(
  "iteration call budget - cold iteration stays within per-bucket ceilings (Issue #1788)",
  async () => {
    const { cache, cleanup } = await makeFreshCache();
    try {
      resetGhCallMetrics();

      const config = makeConfig();
      const mockGh = createRecordingMockGh();
      const registry = new TimelineBatchRegistry();

      const result = await findOldestIssue(config, {
        githubUser: "bot",
        ghCommandFn: mockGh,
        cache,
        timelineBatchRegistry: registry,
        // Deterministic selection so the test is stable.
        selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
      });

      assertEquals(
        result.found,
        true,
        "fixture must produce a selectable candidate (top-priority in repo-a)",
      );

      const metrics = getGhCallMetrics();
      const issueListCount = metrics.bySubCommand["issue list"] ?? 0;
      const prListCount = metrics.bySubCommand["pr list"] ?? 0;
      const apiCount = metrics.bySubCommand["api"] ?? 0;

      // Budget ceilings — see file header for rationale.
      const TOTAL_BUDGET = 30;
      const ISSUE_LIST_BUDGET = 6;
      const PR_LIST_BUDGET = 13;
      const API_BUDGET = 10;

      assert(
        metrics.total <= TOTAL_BUDGET,
        `total gh calls ${metrics.total} exceeded budget ${TOTAL_BUDGET}. ` +
          `Buckets: ${JSON.stringify(metrics.bySubCommand)}`,
      );
      assert(
        issueListCount <= ISSUE_LIST_BUDGET,
        `'issue list' calls ${issueListCount} exceeded budget ` +
          `${ISSUE_LIST_BUDGET}. Buckets: ${
            JSON.stringify(metrics.bySubCommand)
          }`,
      );
      assert(
        prListCount <= PR_LIST_BUDGET,
        `'pr list' calls ${prListCount} exceeded budget ${PR_LIST_BUDGET}. ` +
          `Buckets: ${JSON.stringify(metrics.bySubCommand)}`,
      );
      assert(
        apiCount <= API_BUDGET,
        `'api' calls ${apiCount} exceeded budget ${API_BUDGET}. ` +
          `Buckets: ${JSON.stringify(metrics.bySubCommand)}`,
      );

      // Sanity: the iteration must have actually made some gh calls —
      // an empty bucket map likely means the mock or wiring broke.
      assert(metrics.total > 0, "expected at least one recorded gh call");
    } finally {
      await cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Warm iteration — pins the cache-effectiveness ratio
// ---------------------------------------------------------------------------

Deno.test(
  "iteration call budget - warm iteration eliminates cached buckets (Issue #1788)",
  async () => {
    const { cache, cleanup } = await makeFreshCache();
    try {
      const config = makeConfig();
      const mockGh = createRecordingMockGh();

      // --- Cold iteration ---
      resetGhCallMetrics();
      const coldRegistry = new TimelineBatchRegistry();
      const cold = await findOldestIssue(config, {
        githubUser: "bot",
        ghCommandFn: mockGh,
        cache,
        timelineBatchRegistry: coldRegistry,
        selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
      });
      assertEquals(cold.found, true);
      const coldMetrics = getGhCallMetrics();
      const coldTotal = coldMetrics.total;
      const coldIssueList = coldMetrics.bySubCommand["issue list"] ?? 0;
      const coldPrList = coldMetrics.bySubCommand["pr list"] ?? 0;
      assert(coldTotal > 0, "cold iteration must have made gh calls");
      assert(coldIssueList > 0, "cold iteration must hit 'issue list'");
      assert(coldPrList > 0, "cold iteration must hit 'pr list'");

      // --- Warm iteration: same IssueCache, fresh registry (mirrors the
      // production iteration boundary in run_core where the registry is
      // reset every cycle but the file-backed IssueCache persists for
      // its TTL window). ---
      resetGhCallMetrics();
      const warmRegistry = new TimelineBatchRegistry();
      const warm = await findOldestIssue(config, {
        githubUser: "bot",
        ghCommandFn: mockGh,
        cache,
        timelineBatchRegistry: warmRegistry,
        selectionOptions: { randomFn: () => 0, randomPoolSize: 1 },
      });
      assertEquals(warm.found, true);
      const warmMetrics = getGhCallMetrics();
      const warmTotal = warmMetrics.total;
      const warmIssueList = warmMetrics.bySubCommand["issue list"] ?? 0;
      const warmPrList = warmMetrics.bySubCommand["pr list"] ?? 0;

      // The warm iteration must NOT re-issue any cached `issue list` or
      // `pr list` calls — those are served from `IssueCache` for the
      // 10-minute TTL window. Re-issuing them is the regression pattern
      // the test exists to catch.
      assertEquals(
        warmIssueList,
        0,
        `warm iteration made ${warmIssueList} 'issue list' calls; ` +
          "IssueCache must serve the warm path without re-fetching " +
          "(buckets: " + JSON.stringify(warmMetrics.bySubCommand) + ")",
      );
      assertEquals(
        warmPrList,
        0,
        `warm iteration made ${warmPrList} 'pr list' calls; ` +
          "IssueCache must serve the warm path without re-fetching " +
          "(buckets: " + JSON.stringify(warmMetrics.bySubCommand) + ")",
      );

      // The aggregate warm total must be substantially smaller than cold.
      // The residual warm calls are timeline-batch GraphQL plus per-
      // candidate dependency lookups; both are reset per iteration by
      // design. The ≤ 60% ceiling captures real-world cache effectiveness
      // for the post-#1783–#1787 baseline (measured: ~52%) with a small
      // margin for fixture noise.
      const ratio = warmTotal / coldTotal;
      assert(
        warmTotal * 100 <= coldTotal * 60,
        `warm iteration made ${warmTotal} gh calls (${
          (ratio * 100).toFixed(1)
        }% ` +
          `of cold ${coldTotal}); cache must reduce warm to ≤ 60%`,
      );
    } finally {
      await cleanup();
    }
  },
);
