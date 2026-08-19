/**
 * Probe → access-store wiring tests (Issue #4037).
 *
 * #4036 built the per-repo access store but nothing wrote to it. This
 * suite pins the two *existing* per-tick issue-list paths that now feed
 * it, and — just as importantly — pins the guard rails: no new gh call
 * is made, a cache-served read is never counted as fresh access, and
 * recording is best-effort so it can never alter a caller's control
 * flow.
 *
 * Paths covered:
 *   1. `fetchAllIssues` — the fetch the Priority 2 scan already performs
 *      per repo per tick (via `findOldestIssue`).
 *   2. `auditClaimableState` — the idle-detect audit, which only runs on
 *      idle ticks and so cannot be the sole source of the signal.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { fetchAllIssues } from "../lib/issue_query.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { findOldestIssue } from "../lib/issue_finder.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { auditClaimableState } from "../lib/idle_detect_diagnostics.ts";
import {
  ACCESS_FAILURE_THRESHOLD,
  getInaccessibleRepos,
  getRepoAccessState,
  recordRepoProbe,
  resetRepoAccessState,
} from "../lib/monitored_repo_access.ts";
import type { WorkerConfig } from "../types.ts";

const REPO_A = "owner/repo-a";
const REPO_B = "owner/repo-b";

/** Isolated on-disk cache so cache hit/miss is genuinely exercised. */
function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "probe-record-test-" });
  return new IssueCache(dir, 600);
}

/** One open issue in the shape `fetchAllIssues` parses. */
function issuePayload(number: number): string {
  return JSON.stringify([
    {
      number,
      title: `Issue ${number}`,
      url: `https://github.com/${REPO_A}/issues/${number}`,
      assignees: [],
      labels: [{ name: "work-on" }],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      author: { login: "alice" },
      milestone: null,
    },
  ]);
}

/** Error text gh produces when the identity cannot see the repo. */
function notFoundError(repo: string): Error {
  return new Error(
    `HTTP 404: Could not resolve to a Repository with the name '${repo}'.`,
  );
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    workDir: Deno.makeTempDirSync({ prefix: "probe-record-workdir-" }),
    repos: [REPO_A],
    issueLabels: ["help-wanted"],
    allowedAuthors: ["alice"],
    shuffleRepos: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Path 1 — the per-repo fetch the Priority 2 scan already makes
// ---------------------------------------------------------------------------

Deno.test("fetch path - successful issue-list fetch records ok", async () => {
  resetRepoAccessState();
  await fetchAllIssues(
    REPO_A,
    undefined,
    100,
    () => Promise.resolve(issuePayload(1)),
  );

  const state = getRepoAccessState(REPO_A);
  assertEquals(state.lastOutcome, "ok");
  assertEquals(state.consecutiveAccessDenied, 0);
  assertEquals(typeof state.lastOkAt, "number");
});

Deno.test("fetch path - success clears a prior access-denied count", async () => {
  resetRepoAccessState();
  for (let i = 0; i < ACCESS_FAILURE_THRESHOLD; i++) {
    recordRepoProbe(REPO_A, "access_denied");
  }
  assertEquals(getInaccessibleRepos(), [REPO_A]);

  await fetchAllIssues(
    REPO_A,
    undefined,
    100,
    () => Promise.resolve(issuePayload(2)),
  );

  const state = getRepoAccessState(REPO_A);
  assertEquals(state.lastOutcome, "ok");
  assertEquals(state.consecutiveAccessDenied, 0);
  assertEquals(getInaccessibleRepos(), []);
});

Deno.test("fetch path - 404 records access_denied and still throws", async () => {
  resetRepoAccessState();
  await assertRejects(
    () =>
      fetchAllIssues(
        REPO_A,
        undefined,
        100,
        () => Promise.reject(notFoundError(REPO_A)),
      ),
    Error,
    "404",
  );

  const state = getRepoAccessState(REPO_A);
  assertEquals(state.lastOutcome, "access_denied");
  assertEquals(state.consecutiveAccessDenied, 1);
});

Deno.test("fetch path - rate limit records transient, never access_denied", async () => {
  resetRepoAccessState();
  await assertRejects(() =>
    fetchAllIssues(
      REPO_A,
      undefined,
      100,
      () => Promise.reject(new Error("API rate limit exceeded for user")),
    )
  );

  const state = getRepoAccessState(REPO_A);
  assertEquals(state.lastOutcome, "transient");
  assertEquals(state.consecutiveAccessDenied, 0);
  assertEquals(getInaccessibleRepos(), []);
});

Deno.test("fetch path - cache hit records nothing (a cached read is not fresh access)", async () => {
  resetRepoAccessState();
  const cache = createTestCache();
  let ghCalls = 0;
  const gh = () => {
    ghCalls++;
    return Promise.resolve(issuePayload(3));
  };

  // First call populates the cache and records the real probe.
  await fetchAllIssues(REPO_A, cache, 100, gh);
  assertEquals(ghCalls, 1);

  // Second call is served from the cache — nothing may be recorded.
  resetRepoAccessState();
  const issues = await fetchAllIssues(REPO_A, cache, 100, gh);
  assertEquals(ghCalls, 1, "cache hit must not issue a gh call");
  assertEquals(issues.length, 1);
  assertEquals(getRepoAccessState(REPO_A).lastOutcome, "unknown");
});

Deno.test("fetch path - recording failure never changes control flow", async () => {
  resetRepoAccessState();
  // A blank repo makes the store's own validation throw. The fetch must
  // behave exactly as it would without recording: same value on success,
  // same error on failure.
  const issues = await fetchAllIssues(
    "   ",
    undefined,
    100,
    () => Promise.resolve(issuePayload(4)),
  );
  assertEquals(issues.length, 1);

  await assertRejects(
    () =>
      fetchAllIssues(
        "   ",
        undefined,
        100,
        () => Promise.reject(notFoundError("   ")),
      ),
    Error,
    "404",
  );
});

// ---------------------------------------------------------------------------
// Priority 2 scan — the busy-tick path the idle audit never covers
// ---------------------------------------------------------------------------

Deno.test("scan path - 404 on one repo records access_denied without the idle audit running", async () => {
  resetRepoAccessState();
  const config = makeConfig({ repos: [REPO_A, REPO_B] });
  const gh = (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes(REPO_B) && command.includes("issue list")) {
      return Promise.reject(notFoundError(REPO_B));
    }
    if (command.includes("issue list")) return Promise.resolve(issuePayload(5));
    return Promise.resolve("[]");
  };

  // `auditClaimableState` is deliberately never called here — this is the
  // busy-tick path.
  let thrown: unknown = null;
  try {
    await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
    });
  } catch (err) {
    thrown = err;
  }

  assertEquals(getRepoAccessState(REPO_B).lastOutcome, "access_denied");
  assertEquals(getRepoAccessState(REPO_A).lastOutcome, "ok");
  // Control-flow invariance: the scan surfaces the fetch error exactly as
  // it did before recording existed — the original 404, unwrapped.
  assertEquals(thrown instanceof Error && thrown.message.includes("404"), true);
});

Deno.test("scan path - repeated 404 ticks trip the inaccessible threshold", async () => {
  resetRepoAccessState();
  const config = makeConfig({ repos: [REPO_B] });
  const gh = (args: string[]): Promise<string> => {
    if (args.join(" ").includes("issue list")) {
      return Promise.reject(notFoundError(REPO_B));
    }
    return Promise.resolve("[]");
  };

  for (let tick = 0; tick < ACCESS_FAILURE_THRESHOLD; tick++) {
    // A fresh cache per tick mirrors the iteration-scoped cache in run_core.
    // The scan's own error handling is unchanged; only the store is new.
    await findOldestIssue(config, {
      githubUser: "bot",
      ghCommandFn: gh,
      cache: createTestCache(),
    }).catch(() => null);
  }

  assertEquals(getInaccessibleRepos(), [REPO_B]);
});

Deno.test("scan path - adds no gh call beyond the issue-list fetch it already made", async () => {
  resetRepoAccessState();
  const config = makeConfig({ repos: [REPO_A] });
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.join(" ").includes("issue list")) {
      return Promise.resolve(issuePayload(6));
    }
    return Promise.resolve("[]");
  };

  await findOldestIssue(config, {
    githubUser: "bot",
    ghCommandFn: gh,
    cache: createTestCache(),
  });

  // No repo-metadata sweep: recording rides the scan's own fetch, so no
  // `gh repo view` and no bare `GET /repos/{owner}/{repo}` appears.
  const repoExistenceProbes = calls.filter((a) =>
    a[0] === "repo" ||
    (a[0] === "api" && /^repos\/[^/]+\/[^/]+$/.test(a[1] ?? ""))
  );
  assertEquals(repoExistenceProbes.length, 0);
  const openIssueLists = calls.filter((a) =>
    a[0] === "issue" && a[1] === "list" && a.includes("--state") &&
    a.includes("open")
  );
  assertEquals(openIssueLists.length, 1, "one issue-list fetch for one repo");
});

// ---------------------------------------------------------------------------
// Path 2 — the idle-detect audit
// ---------------------------------------------------------------------------

Deno.test("audit path - successful probe records ok", async () => {
  resetRepoAccessState();
  await auditClaimableState({
    repos: [REPO_A],
    workerUser: "bot",
    tick: 1,
    scanFoundClaimable: false,
    ghCommandFn: () => Promise.resolve(JSON.stringify([])),
    log: () => {},
    hostnameFn: () => "host",
    pidFn: () => 1,
  });

  assertEquals(getRepoAccessState(REPO_A).lastOutcome, "ok");
});

Deno.test("audit path - 404 probe records access_denied, parse failure records parse_failed", async () => {
  resetRepoAccessState();
  await auditClaimableState({
    repos: [REPO_A, REPO_B],
    workerUser: "bot",
    tick: 2,
    scanFoundClaimable: false,
    ghCommandFn: (args: string[]) =>
      args.join(" ").includes(REPO_A)
        ? Promise.reject(notFoundError(REPO_A))
        : Promise.resolve("not json"),
    log: () => {},
    hostnameFn: () => "host",
    pidFn: () => 1,
  });

  assertEquals(getRepoAccessState(REPO_A).lastOutcome, "access_denied");
  assertEquals(getRepoAccessState(REPO_B).lastOutcome, "parse_failed");
  // `parse_failed` is neutral — it must not count towards inaccessibility.
  assertEquals(getRepoAccessState(REPO_B).consecutiveAccessDenied, 0);
});

Deno.test("audit path - probes exactly once per repo and adds no gh call", async () => {
  resetRepoAccessState();
  const calls: string[][] = [];
  const result = await auditClaimableState({
    repos: [REPO_A, REPO_B],
    workerUser: "bot",
    tick: 3,
    scanFoundClaimable: false,
    ghCommandFn: (args: string[]) => {
      calls.push(args);
      return Promise.resolve(JSON.stringify([]));
    },
    log: () => {},
    hostnameFn: () => "host",
    pidFn: () => 1,
  });

  assertEquals(calls.length, 2, "one issue-list probe per repo, nothing more");
  assertEquals(calls.every((a) => a[0] === "issue" && a[1] === "list"), true);
  assertEquals(result.perRepo.length, 2);
});

Deno.test("audit path - recording failure never changes the audit result", async () => {
  resetRepoAccessState();
  // Blank repo → the store's validation throws; the audit must still
  // return its normal snapshot rather than propagating the throw.
  const result = await auditClaimableState({
    repos: ["   "],
    workerUser: "bot",
    tick: 4,
    scanFoundClaimable: false,
    ghCommandFn: () => Promise.resolve(JSON.stringify([])),
    log: () => {},
    hostnameFn: () => "host",
    pidFn: () => 1,
  });

  assertEquals(result.perRepo.length, 1);
  assertEquals(result.perRepo[0]?.reason, "no_open");
  assertEquals(result.claimableTotal, 0);
});
