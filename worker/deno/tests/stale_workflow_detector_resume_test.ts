/**
 * Tests for the rate-limit pause-and-resume behaviour added to
 * scanForStaleWorkflowIssues (Issue #1781).
 *
 * Covers:
 *   - Rate-limit hit on repo 2 of 3 → wait → resumes on repo 2 → completes repo 3.
 *   - Rate-limit hit → shutdown during wait → scan aborts; totalScanned reflects
 *     how far the scan got before the rate-limit hit.
 *   - Non-rate-limit error continues to throw (unchanged behaviour).
 *   - Each `process*` call for a retried repo is idempotent — a stale issue
 *     hit before the rate-limit and again on resume is processed at most once.
 *
 * Issue #2031: the `needs-clarification` reminder/close branch was retired.
 * These tests now exercise the surviving `failed` diagnostic branch to
 * trigger the rate-limit pause-and-resume path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  scanForStaleWorkflowIssues,
  STALE_WORKFLOW_DEFAULTS,
  type StaleWorkflowConfig,
  type StaleWorkflowDeps,
} from "../lib/stale_workflow_detector.ts";
import type { GitHubComment, GitHubIssue } from "../types.ts";

/** Fixed "now" at 2026-02-01T00:00:00Z. */
const FIXED_NOW_MS = new Date("2026-02-01T00:00:00Z").getTime();
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW_MS / 1000);

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: "Test issue",
    body: "Test body",
    labels: [],
    author: "testuser",
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function defaultConfig(
  overrides: Partial<StaleWorkflowConfig> = {},
): StaleWorkflowConfig {
  return {
    repos: ["org/repo1", "org/repo2", "org/repo3"],
    // Issue #2031: needs-clarification branch retired.
    labels: {
      failed: "failed",
      failedOnce: "failed-once",
      planning: "planning",
    },
    thresholds: {
      failedDiagnosticDays: STALE_WORKFLOW_DEFAULTS.failedDiagnosticDays,
      planningWarningDays: STALE_WORKFLOW_DEFAULTS.planningWarningDays,
    },
    ...overrides,
  };
}

interface ResumeTestDeps extends StaleWorkflowDeps {
  logs: string[];
  postedComments: Array<{ repo: string; issueNumber: number; body: string }>;
  closedIssues: Array<{ repo: string; issueNumber: number }>;
  /** Per-repo,per-label call counter for listIssuesByLabel. */
  listCalls: Map<string, number>;
}

interface ResumeTestOptions {
  /**
   * Map of repo → list of issues returned for the `failed` label.
   * Replaces the retired `needsClarification` map (Issue #2031).
   */
  failedIssues?: Map<string, GitHubIssue[]>;
  /** Repos that should throw a rate-limit error on the first list call. */
  rateLimitOnRepos?: Set<string>;
  /** Repos that should throw a non-rate-limit error on the first list call. */
  fatalErrorOnRepos?: Set<string>;
  /** Existing comments to return for any issue (defaults to none). */
  comments?: GitHubComment[];
  /** Reset epoch returned by getRateLimitReset (defaults to FIXED_NOW_SECONDS + 60). */
  rateLimitResetEpoch?: number;
  /** Shutdown signal accessor (defaults to never). */
  shouldShutdown?: () => boolean;
}

function createResumeDeps(opts: ResumeTestOptions = {}): ResumeTestDeps {
  const logs: string[] = [];
  const postedComments: Array<
    { repo: string; issueNumber: number; body: string }
  > = [];
  const closedIssues: Array<{ repo: string; issueNumber: number }> = [];
  const listCalls = new Map<string, number>();
  // Rate-limit / fatal-error fires once per repo across all labels.
  const rateLimitFired = new Set<string>();
  const fatalFired = new Set<string>();
  let nowSeconds = FIXED_NOW_SECONDS;

  return {
    logs,
    postedComments,
    closedIssues,
    listCalls,
    listIssuesByLabel: (repo, label) => {
      const key = `${repo}::${label}`;
      listCalls.set(key, (listCalls.get(key) ?? 0) + 1);

      if (opts.rateLimitOnRepos?.has(repo) && !rateLimitFired.has(repo)) {
        rateLimitFired.add(repo);
        return Promise.reject(new Error("HTTP 403: API rate limit exceeded"));
      }
      if (opts.fatalErrorOnRepos?.has(repo) && !fatalFired.has(repo)) {
        fatalFired.add(repo);
        return Promise.reject(new Error("HTTP 500: internal server error"));
      }

      if (label === "failed") {
        const issues = opts.failedIssues?.get(repo) ?? [];
        return Promise.resolve(issues);
      }
      return Promise.resolve([]);
    },
    getIssueComments: () => Promise.resolve(opts.comments ?? []),
    postComment: (repo, issueNumber, body) => {
      postedComments.push({ repo, issueNumber, body });
      return Promise.resolve();
    },
    closeIssue: (repo, issueNumber) => {
      closedIssues.push({ repo, issueNumber });
      return Promise.resolve();
    },
    log: (msg) => logs.push(msg),
    now: () => FIXED_NOW_MS,
    nowSeconds: () => nowSeconds,
    shouldShutdown: opts.shouldShutdown ?? (() => false),
    sleep: (ms) => {
      // Advance the virtual clock; never sleep in real time.
      nowSeconds += Math.ceil(ms / 1000);
      return Promise.resolve();
    },
    getRateLimitReset: () =>
      Promise.resolve(opts.rateLimitResetEpoch ?? FIXED_NOW_SECONDS + 60),
  };
}

// ---------------------------------------------------------------------------
// 1. Rate-limit hit on repo 2 of 3 → wait → resumes on repo 2 → completes repo 3.
// ---------------------------------------------------------------------------

Deno.test(
  "stale workflow resume - rate-limit on repo 2 waits then resumes and finishes",
  async () => {
    const fiveDaysAgo = new Date(FIXED_NOW_MS - 5 * 24 * 60 * 60 * 1000)
      .toISOString();
    // Each repo has one stale failed issue (Issue #2031: needs-clarification retired).
    const failedIssues = new Map<string, GitHubIssue[]>([
      ["org/repo1", [makeIssue({ number: 11, updatedAt: fiveDaysAgo })]],
      ["org/repo2", [makeIssue({ number: 22, updatedAt: fiveDaysAgo })]],
      ["org/repo3", [makeIssue({ number: 33, updatedAt: fiveDaysAgo })]],
    ]);

    const deps = createResumeDeps({
      failedIssues,
      rateLimitOnRepos: new Set(["org/repo2"]),
    });

    const result = await scanForStaleWorkflowIssues(defaultConfig(), deps);

    assert(result.ok, `expected ok result, got ${JSON.stringify(result)}`);
    if (!result.ok) return;

    // All three repos must end up scanned despite the mid-scan pause.
    assertEquals(result.value.scanned, 3);
    assertEquals(
      result.value.actioned,
      3,
      "one diagnostic per repo",
    );

    // Repo 2 was retried — listIssuesByLabel for `failed` must have been
    // called twice for repo 2 (initial + resume), once for the others.
    assertEquals(deps.listCalls.get("org/repo1::failed") ?? 0, 1);
    assertEquals(deps.listCalls.get("org/repo2::failed") ?? 0, 2);
    assertEquals(deps.listCalls.get("org/repo3::failed") ?? 0, 1);

    // The pause and resume each leave a log line.
    assert(
      deps.logs.some((l) => l.includes("rate limit hit on org/repo2")),
      `expected pause log, got: ${deps.logs.join(" | ")}`,
    );
    assert(
      deps.logs.some((l) => l.includes("Resumed") && l.includes("org/repo2")),
      `expected resume log, got: ${deps.logs.join(" | ")}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 2. Rate-limit hit → shutdown during wait → scan aborts cleanly.
// ---------------------------------------------------------------------------

Deno.test(
  "stale workflow resume - shutdown during wait aborts and totalScanned reflects progress",
  async () => {
    const fiveDaysAgo = new Date(FIXED_NOW_MS - 5 * 24 * 60 * 60 * 1000)
      .toISOString();
    const failedIssues = new Map<string, GitHubIssue[]>([
      ["org/repo1", [makeIssue({ number: 11, updatedAt: fiveDaysAgo })]],
      ["org/repo2", [makeIssue({ number: 22, updatedAt: fiveDaysAgo })]],
      ["org/repo3", [makeIssue({ number: 33, updatedAt: fiveDaysAgo })]],
    ]);

    let pollsAfterPause = 0;
    const deps = createResumeDeps({
      failedIssues,
      rateLimitOnRepos: new Set(["org/repo2"]),
      // Shutdown signalled on the second poll inside waitUntilRateLimitReset.
      shouldShutdown: () => {
        pollsAfterPause++;
        return pollsAfterPause >= 2;
      },
      // Reset is far enough in the future that the wait won't complete
      // before the shutdown poll fires.
      rateLimitResetEpoch: FIXED_NOW_SECONDS + 600,
    });

    const result = await scanForStaleWorkflowIssues(defaultConfig(), deps);

    assert(result.ok, `expected ok result, got ${JSON.stringify(result)}`);
    if (!result.ok) return;

    // Repo 1 was scanned cleanly; repo 2 hit the rate limit and the
    // wait was aborted by shutdown — repos 2 and 3 are unscanned.
    assertEquals(result.value.scanned, 1);
    assertEquals(result.value.actioned, 1);

    assert(
      deps.logs.some((l) => l.includes("Shutdown during rate-limit wait")),
      `expected shutdown-abort log, got: ${deps.logs.join(" | ")}`,
    );

    // Repo 2 must not have been retried after the shutdown abort.
    assertEquals(deps.listCalls.get("org/repo2::failed") ?? 0, 1);
    assertEquals(deps.listCalls.get("org/repo3::failed") ?? 0, 0);
  },
);

// ---------------------------------------------------------------------------
// 3. Non-rate-limit error continues to throw (unchanged behaviour).
// ---------------------------------------------------------------------------

Deno.test(
  "stale workflow resume - non-rate-limit error propagates from outer try",
  async () => {
    // The only path to the outer try is a synchronous throw from code
    // that is *not* wrapped in the per-helper try/catch. `deps.now()`
    // is called at the top of each process* helper without a guard, so
    // making it throw exercises the outer-throw branch directly.
    const deps = createResumeDeps();
    deps.now = () => {
      throw new Error("clock failure");
    };

    await assertRejects(
      () => scanForStaleWorkflowIssues(defaultConfig(), deps),
      Error,
      "clock failure",
    );
  },
);

// ---------------------------------------------------------------------------
// 4. Idempotency on retry — a stale issue actioned before the rate-limit
//    must not be double-actioned when the repo is retried.
// ---------------------------------------------------------------------------

Deno.test(
  "stale workflow resume - retried repo does not double-post the same diagnostic",
  async () => {
    const fiveDaysAgo = new Date(FIXED_NOW_MS - 5 * 24 * 60 * 60 * 1000)
      .toISOString();
    const stale = makeIssue({ number: 11, updatedAt: fiveDaysAgo });

    // The scan order inside a repo is: failed → failed-once → planning
    // (Issue #2031 retired the needs-clarification branch). We let the
    // `failed` scan succeed (posting one diagnostic), then trip a
    // rate-limit on the next list call (`failed-once`). After the wait,
    // the retry re-runs the failed scan — but it must skip thanks to the
    // marker now present in the comments.
    let failedOnceListCalls = 0;
    let failedListCalls = 0;
    const deps = createResumeDeps();
    deps.listIssuesByLabel = (_repo, label) => {
      if (label === "failed") {
        failedListCalls++;
        return Promise.resolve([stale]);
      }
      if (label === "failed-once") {
        failedOnceListCalls++;
        if (failedOnceListCalls === 1) {
          return Promise.reject(
            new Error("HTTP 403: API rate limit exceeded"),
          );
        }
      }
      return Promise.resolve([]);
    };
    // Pre-diagnostic (call 1): no marker. Post-diagnostic (call 2): marker
    // present so the retry skips.
    let commentsCalls = 0;
    deps.getIssueComments = () => {
      commentsCalls++;
      if (commentsCalls === 1) {
        return Promise.resolve([]);
      }
      return Promise.resolve([
        {
          id: 1,
          body: "<!-- vibe-coder-stale-diagnostic -->\nDiagnostic",
          author: "bot",
          createdAt: "2026-01-25T00:00:00Z",
          reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
        },
      ]);
    };

    const config = defaultConfig({ repos: ["org/repo1"] });
    const result = await scanForStaleWorkflowIssues(config, deps);

    assert(result.ok, `expected ok result, got ${JSON.stringify(result)}`);
    if (!result.ok) return;

    // Sanity: `failed` was listed twice (initial + retry).
    assertEquals(failedListCalls, 2);

    // The diagnostic is posted exactly once even though the issue was
    // matched on both passes — idempotency holds.
    assertEquals(
      deps.postedComments.length,
      1,
      `expected exactly one diagnostic comment, got ${deps.postedComments.length}`,
    );
  },
);
