/**
 * Regression tests for Issue #1784 — the stale-workflow scan now
 * routes its `listIssuesByLabel` calls through {@link fetchIssuesByLabel}
 * (and the shared `issues_all` cache) instead of firing per-label
 * `gh issue list` calls each iteration.
 *
 * Cover:
 *   1. Cache miss/cold cache fires exactly one `gh issue list` per repo
 *      (not one per label) and populates the `issues_all` key.
 *   2. Cache hit on a warm cache fires zero `gh issue list` calls.
 *   3. Label filtering is correct — only matching issues are returned.
 *   4. The cached projection includes `updatedAt` so the stale-workflow
 *      can compute `daysSince` without an extra fetch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { fetchIssuesByLabel } from "../lib/issue_query.ts";
import { IssueCache } from "../lib/issue_cache.ts";

function createTestCache(): IssueCache {
  const dir = Deno.makeTempDirSync({ prefix: "stale-cache-test-" });
  return new IssueCache(dir, 600);
}

interface FakeIssue {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
  author: { login: string };
  assignees: Array<{ login: string }>;
  createdAt: string;
  updatedAt: string;
  milestone?: null;
}

function makeFakeIssue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    number: 1,
    title: "Test issue",
    url: "https://example/issues/1",
    labels: [],
    author: { login: "alice" },
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-15T00:00:00Z",
    milestone: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Cache miss → one gh call per repo (no per-label fan-out).
// ---------------------------------------------------------------------------

Deno.test(
  "stale-workflow cache - cold cache fires one gh issue list per repo for any label",
  async () => {
    const cache = createTestCache();
    const ghCalls: string[][] = [];
    const fakeRepoIssues = [
      makeFakeIssue({ number: 11, labels: [{ name: "needs-clarification" }] }),
      makeFakeIssue({ number: 12, labels: [{ name: "failed" }] }),
      makeFakeIssue({ number: 13, labels: [{ name: "planning" }] }),
    ];
    const ghCommandFn = (args: string[]): Promise<string> => {
      ghCalls.push(args);
      return Promise.resolve(JSON.stringify(fakeRepoIssues));
    };

    // Three label queries against the same repo, back-to-back.
    await fetchIssuesByLabel(
      "org/repo",
      "needs-clarification",
      cache,
      50,
      ghCommandFn,
    );
    await fetchIssuesByLabel("org/repo", "failed", cache, 50, ghCommandFn);
    await fetchIssuesByLabel("org/repo", "planning", cache, 50, ghCommandFn);

    // Exactly one underlying `gh issue list` for the whole repo (the
    // first call populates the `issues_all` cache; the next two read it).
    assertEquals(
      ghCalls.length,
      1,
      `expected one gh call across three labels, got ${ghCalls.length}: ${
        ghCalls.map((a) => a.join(" ")).join(" | ")
      }`,
    );

    // The lone gh call must be a `gh issue list` for this repo (not a
    // per-label query).
    const args = ghCalls[0]!;
    assertEquals(args[0], "issue");
    assertEquals(args[1], "list");
    assert(
      args.includes("org/repo"),
      `expected repo arg, got: ${args.join(" ")}`,
    );
    // No `--label` flag — the cache populator does a batch query.
    assertEquals(
      args.includes("--label"),
      false,
      `expected no --label flag, got: ${args.join(" ")}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 2. Warm cache → zero gh calls.
// ---------------------------------------------------------------------------

Deno.test(
  "stale-workflow cache - warm cache fires zero gh calls",
  async () => {
    const cache = createTestCache();
    let ghCalls = 0;
    const ghCommandFn = (_args: string[]): Promise<string> => {
      ghCalls++;
      return Promise.resolve(JSON.stringify([
        makeFakeIssue({ number: 11, labels: [{ name: "failed" }] }),
      ]));
    };

    // Prime the cache.
    await fetchIssuesByLabel("org/repo", "failed", cache, 50, ghCommandFn);
    assertEquals(ghCalls, 1);

    // Subsequent reads (any label) hit the cache.
    await fetchIssuesByLabel("org/repo", "failed", cache, 50, ghCommandFn);
    await fetchIssuesByLabel(
      "org/repo",
      "needs-clarification",
      cache,
      50,
      ghCommandFn,
    );
    await fetchIssuesByLabel("org/repo", "planning", cache, 50, ghCommandFn);
    assertEquals(ghCalls, 1, "no further gh calls expected");
  },
);

// ---------------------------------------------------------------------------
// 3. Label filtering correctness.
// ---------------------------------------------------------------------------

Deno.test(
  "stale-workflow cache - label filtering returns only matching issues",
  async () => {
    const cache = createTestCache();
    const fakeRepoIssues = [
      makeFakeIssue({ number: 11, labels: [{ name: "needs-clarification" }] }),
      makeFakeIssue({ number: 12, labels: [{ name: "failed" }] }),
      makeFakeIssue({
        number: 13,
        labels: [{ name: "planning" }, { name: "failed" }],
      }),
      makeFakeIssue({ number: 14, labels: [{ name: "wontfix" }] }),
    ];
    const ghCommandFn = (_args: string[]): Promise<string> =>
      Promise.resolve(JSON.stringify(fakeRepoIssues));

    const failed = await fetchIssuesByLabel(
      "org/repo",
      "failed",
      cache,
      50,
      ghCommandFn,
    );
    const planning = await fetchIssuesByLabel(
      "org/repo",
      "planning",
      cache,
      50,
      ghCommandFn,
    );
    const wontfix = await fetchIssuesByLabel(
      "org/repo",
      "wontfix",
      cache,
      50,
      ghCommandFn,
    );

    assertEquals(failed.map((i) => i.number).sort(), [12, 13]);
    assertEquals(planning.map((i) => i.number), [13]);
    assertEquals(wontfix.map((i) => i.number), [14]);
  },
);

// ---------------------------------------------------------------------------
// 4. Cached projection includes `updatedAt` (the only new field needed
//    by the stale-workflow detector).
// ---------------------------------------------------------------------------

Deno.test(
  "stale-workflow cache - projection includes updatedAt",
  async () => {
    const cache = createTestCache();
    const fakeRepoIssues = [
      makeFakeIssue({
        number: 99,
        labels: [{ name: "needs-clarification" }],
        updatedAt: "2026-02-15T12:34:56Z",
      }),
    ];
    const ghCommandFn = (_args: string[]): Promise<string> =>
      Promise.resolve(JSON.stringify(fakeRepoIssues));

    const issues = await fetchIssuesByLabel(
      "org/repo",
      "needs-clarification",
      cache,
      50,
      ghCommandFn,
    );

    assertEquals(issues.length, 1);
    assertEquals(issues[0]!.updatedAt, "2026-02-15T12:34:56Z");
  },
);

// ---------------------------------------------------------------------------
// 5. Expired cache forces a fresh gh call.
// ---------------------------------------------------------------------------

Deno.test(
  "stale-workflow cache - expired cache refetches",
  async () => {
    // 1-second TTL so we can age the cache without sleeping.
    const dir = Deno.makeTempDirSync({ prefix: "stale-cache-expire-" });
    const cache = new IssueCache(dir, 0); // TTL 0 — every read is expired
    let ghCalls = 0;
    const ghCommandFn = (_args: string[]): Promise<string> => {
      ghCalls++;
      return Promise.resolve(JSON.stringify([
        makeFakeIssue({ number: 11, labels: [{ name: "failed" }] }),
      ]));
    };

    await fetchIssuesByLabel("org/repo", "failed", cache, 50, ghCommandFn);
    await fetchIssuesByLabel("org/repo", "failed", cache, 50, ghCommandFn);

    // Both calls must have hit gh because the TTL is zero.
    assertEquals(ghCalls, 2);
  },
);

// ---------------------------------------------------------------------------
// 6. Empty batch → no per-label fallback gh call (Issue #1909).
//    Pre-#1909 a repo with zero open issues paid one extra `gh issue list
//    --label X` per label per iteration via the fallback path. The batch
//    is the source of truth — empty means no labelled issues exist.
// ---------------------------------------------------------------------------

Deno.test(
  "stale-workflow cache - empty batch does not trigger per-label fallback (Issue #1909)",
  async () => {
    const cache = createTestCache();
    const ghCalls: string[][] = [];
    const ghCommandFn = (args: string[]): Promise<string> => {
      ghCalls.push(args);
      return Promise.resolve("[]");
    };

    // Two different labels — the batch fires once, the second label
    // serves from the cached empty result, and neither path issues a
    // per-label fallback gh call.
    const failed = await fetchIssuesByLabel(
      "org/repo",
      "failed",
      cache,
      50,
      ghCommandFn,
    );
    const planning = await fetchIssuesByLabel(
      "org/repo",
      "planning",
      cache,
      50,
      ghCommandFn,
    );

    assertEquals(failed, []);
    assertEquals(planning, []);
    // Exactly one underlying gh call — the cold batch. No `--label`
    // fallback fires for either label.
    assertEquals(
      ghCalls.length,
      1,
      `expected one gh call, got ${ghCalls.length}: ${
        ghCalls.map((a) => a.join(" ")).join(" | ")
      }`,
    );
    assertEquals(
      ghCalls[0]!.includes("--label"),
      false,
      `the single gh call must be the batch, not a per-label fallback: ${
        ghCalls[0]!.join(" ")
      }`,
    );
  },
);
