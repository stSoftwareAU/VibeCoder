/**
 * Tests for check_runs_batch.ts (Issue #1806).
 *
 * Verifies the GraphQL `statusCheckRollup` batched fetcher and the
 * adapters that map it back to the legacy `CheckRunsResponse`,
 * `CombinedStatusResponse`, and `CheckRunEntry` shapes.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCheckRunsBatchQuery,
  CHECK_RUNS_BATCH_SIZE,
  fetchCheckRunsBatch,
  fetchFailedCheckRunsBatch,
  type PrRollup,
  rollupToCheckRunsResponse,
  rollupToCombinedStatusResponse,
  rollupToFailedCheckRuns,
} from "../lib/check_runs_batch.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface FakeContextSpec {
  type: "CheckRun" | "StatusContext";
  // CheckRun
  databaseId?: number;
  name?: string;
  status?: string; // GraphQL enum (uppercase)
  conclusion?: string | null; // GraphQL enum (uppercase) or null
  // StatusContext
  context?: string;
  state?: string; // GraphQL enum (uppercase)
}

function fakeRollupResponse(
  prSpecs: Array<{ rollupState: string | null; contexts: FakeContextSpec[] }>,
): string {
  const repo: Record<string, unknown> = {};
  for (let i = 0; i < prSpecs.length; i++) {
    const spec = prSpecs[i]!;
    repo[`n${i}`] = {
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: spec.rollupState === null ? null : {
                state: spec.rollupState,
                contexts: {
                  nodes: spec.contexts.map((c) => {
                    if (c.type === "CheckRun") {
                      return {
                        __typename: "CheckRun",
                        databaseId: c.databaseId ?? 0,
                        name: c.name ?? "",
                        status: c.status ?? "COMPLETED",
                        conclusion: c.conclusion ?? null,
                      };
                    }
                    return {
                      __typename: "StatusContext",
                      context: c.context ?? "",
                      state: c.state ?? "SUCCESS",
                    };
                  }),
                },
              },
            },
          },
        ],
      },
    };
  }
  return JSON.stringify({ data: { repository: repo } });
}

// ===========================================================================
// buildCheckRunsBatchQuery
// ===========================================================================

Deno.test("check_runs_batch - buildCheckRunsBatchQuery aliases each PR", () => {
  const q = buildCheckRunsBatchQuery("acme", "tools", [10, 20, 30]);
  assertStringIncludes(q, "n0: pullRequest(number: 10)");
  assertStringIncludes(q, "n1: pullRequest(number: 20)");
  assertStringIncludes(q, "n2: pullRequest(number: 30)");
  assertStringIncludes(q, 'repository(owner: "acme", name: "tools")');
  assertStringIncludes(q, "statusCheckRollup");
  assertStringIncludes(q, "... on CheckRun");
  assertStringIncludes(q, "... on StatusContext");
});

// ===========================================================================
// fetchCheckRunsBatch — happy path / empty / batching / failures
// ===========================================================================

Deno.test("check_runs_batch - fetchCheckRunsBatch happy path returns rollup per PR", async () => {
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    assertEquals(args[0], "api");
    assertEquals(args[1], "graphql");
    assertEquals(args[2], "-f");
    assert(args[3]?.startsWith("query="));
    return Promise.resolve(
      fakeRollupResponse([
        {
          rollupState: "SUCCESS",
          contexts: [
            {
              type: "CheckRun",
              databaseId: 11,
              name: "build",
              status: "COMPLETED",
              conclusion: "SUCCESS",
            },
            {
              type: "StatusContext",
              context: "deploy",
              state: "SUCCESS",
            },
          ],
        },
      ]),
    );
  };
  const result = await fetchCheckRunsBatch("acme/tools", [42], gh);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(calls, 1);
  assertEquals(result.callCount, 1);
  assertEquals(result.rollups.size, 1);
  const rollup = result.rollups.get(42);
  assert(rollup);
  assertEquals(rollup.rollupState, "SUCCESS");
  assertEquals(rollup.checkRuns.length, 1);
  assertEquals(rollup.checkRuns[0]?.name, "build");
  assertEquals(rollup.checkRuns[0]?.status, "completed");
  assertEquals(rollup.checkRuns[0]?.conclusion, "success");
  assertEquals(rollup.statusContexts.length, 1);
  assertEquals(rollup.statusContexts[0]?.context, "deploy");
  assertEquals(rollup.statusContexts[0]?.state, "success");
});

Deno.test("check_runs_batch - fetchCheckRunsBatch empty input issues no calls", async () => {
  let calls = 0;
  const gh = (_args: string[]): Promise<string> => {
    calls++;
    return Promise.resolve("{}");
  };
  const result = await fetchCheckRunsBatch("acme/tools", [], gh);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(calls, 0);
  assertEquals(result.callCount, 0);
  assertEquals(result.rollups.size, 0);
});

Deno.test("check_runs_batch - fetchCheckRunsBatch boundary: exactly 25 PRs = 1 call", async () => {
  const numbers = Array.from({ length: 25 }, (_, i) => i + 1);
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    const query = (args[3] ?? "").substring("query=".length);
    const matches = query.match(/pullRequest\(number: (\d+)\)/g) ?? [];
    return Promise.resolve(
      fakeRollupResponse(
        matches.map(() => ({ rollupState: "SUCCESS", contexts: [] })),
      ),
    );
  };
  const result = await fetchCheckRunsBatch("acme/tools", numbers, gh);
  assert(result.ok);
  assertEquals(CHECK_RUNS_BATCH_SIZE, 25);
  assertEquals(calls, 1);
});

Deno.test("check_runs_batch - fetchCheckRunsBatch splits batches at 25", async () => {
  const numbers = Array.from({ length: 30 }, (_, i) => i + 1);
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    const query = (args[3] ?? "").substring("query=".length);
    const matches = query.match(/pullRequest\(number: (\d+)\)/g) ?? [];
    return Promise.resolve(
      fakeRollupResponse(
        matches.map(() => ({ rollupState: "SUCCESS", contexts: [] })),
      ),
    );
  };
  const result = await fetchCheckRunsBatch("acme/tools", numbers, gh);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(calls, 2);
  assertEquals(result.callCount, 2);
  assertEquals(result.rollups.size, 30);
});

Deno.test("check_runs_batch - fetchCheckRunsBatch returns error on gh failure", async () => {
  const gh = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("boom"));
  const result = await fetchCheckRunsBatch("acme/tools", [1], gh);
  assert(!result.ok);
  if (result.ok) return;
  assertEquals(result.error.message, "boom");
});

Deno.test("check_runs_batch - fetchCheckRunsBatch returns error on GraphQL errors payload", async () => {
  const gh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify({
      errors: [{ message: "Field 'pullRequest' not found" }],
    }));
  const result = await fetchCheckRunsBatch("acme/tools", [1], gh);
  assert(!result.ok);
});

Deno.test("check_runs_batch - fetchCheckRunsBatch handles top-level error with data:null", async () => {
  // A top-level GraphQL error returns `data: null`. The caller's guard
  // must catch this and return an error result rather than letting
  // convertBatch dereference a null repository (Issue #2984).
  const gh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify({ data: null }));
  const result = await fetchCheckRunsBatch("acme/tools", [1, 2], gh);
  assert(!result.ok);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "missing data.repository");
});

Deno.test("check_runs_batch - fetchCheckRunsBatch rejects malformed repo identifier", async () => {
  const gh = (_args: string[]): Promise<string> => Promise.resolve("{}");
  const r1 = await fetchCheckRunsBatch("not-a-repo", [1], gh);
  assert(!r1.ok);
  const r2 = await fetchCheckRunsBatch("ow ner/repo", [1], gh);
  assert(!r2.ok);
});

Deno.test("check_runs_batch - fetchCheckRunsBatch deduplicates PR numbers", async () => {
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    const query = (args[3] ?? "").substring("query=".length);
    const matches = query.match(/pullRequest\(number: (\d+)\)/g) ?? [];
    assertEquals(matches.length, 2); // dedup to [1, 2]
    return Promise.resolve(
      fakeRollupResponse(
        matches.map(() => ({ rollupState: "SUCCESS", contexts: [] })),
      ),
    );
  };
  const result = await fetchCheckRunsBatch(
    "acme/tools",
    [1, 2, 1, 2, 1],
    gh,
  );
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(calls, 1);
  assertEquals(result.rollups.size, 2);
});

// ===========================================================================
// Adapters
// ===========================================================================

Deno.test("check_runs_batch - rollupToCheckRunsResponse converts shape", () => {
  const rollup: PrRollup = {
    rollupState: "FAILURE",
    headSha: null,
    checkRuns: [
      {
        databaseId: 7,
        name: "build",
        status: "completed",
        conclusion: "success",
      },
      {
        databaseId: 8,
        name: "test",
        status: "completed",
        conclusion: "failure",
      },
    ],
    statusContexts: [],
  };
  const out = rollupToCheckRunsResponse(rollup);
  assertEquals(out.total_count, 2);
  assertEquals(out.check_runs[0]?.id, 7);
  assertEquals(out.check_runs[1]?.conclusion, "failure");
});

Deno.test("check_runs_batch - rollupToCombinedStatusResponse: all success → success", () => {
  const rollup: PrRollup = {
    rollupState: "SUCCESS",
    headSha: null,
    checkRuns: [],
    statusContexts: [
      { context: "deploy", state: "success" },
      { context: "lint", state: "success" },
    ],
  };
  const out = rollupToCombinedStatusResponse(rollup);
  assertEquals(out.state, "success");
  assertEquals(out.statuses.length, 2);
});

Deno.test("check_runs_batch - rollupToCombinedStatusResponse: failure context → failure", () => {
  const rollup: PrRollup = {
    rollupState: "FAILURE",
    headSha: null,
    checkRuns: [],
    statusContexts: [
      { context: "deploy", state: "failure" },
    ],
  };
  const out = rollupToCombinedStatusResponse(rollup);
  assertEquals(out.state, "failure");
});

Deno.test("check_runs_batch - rollupToCombinedStatusResponse: pending context → pending", () => {
  const rollup: PrRollup = {
    rollupState: "PENDING",
    headSha: null,
    checkRuns: [],
    statusContexts: [
      { context: "deploy", state: "pending" },
    ],
  };
  const out = rollupToCombinedStatusResponse(rollup);
  assertEquals(out.state, "pending");
});

Deno.test("check_runs_batch - rollupToCombinedStatusResponse: no statuses → pending state with empty array", () => {
  const rollup: PrRollup = {
    rollupState: "SUCCESS",
    headSha: null,
    checkRuns: [],
    statusContexts: [],
  };
  const out = rollupToCombinedStatusResponse(rollup);
  // Mirrors REST default: when no statuses exist, state is "pending"
  assertEquals(out.statuses.length, 0);
  assertEquals(out.state, "pending");
});

Deno.test("check_runs_batch - rollupToFailedCheckRuns filters failures only", () => {
  const rollup: PrRollup = {
    rollupState: "FAILURE",
    headSha: null,
    checkRuns: [
      {
        databaseId: 1,
        name: "build",
        status: "completed",
        conclusion: "success",
      },
      {
        databaseId: 2,
        name: "test",
        status: "completed",
        conclusion: "failure",
      },
      { databaseId: 3, name: "lint", status: "in_progress", conclusion: null },
      {
        databaseId: 4,
        name: "spell",
        status: "completed",
        conclusion: "cancelled",
      },
    ],
    statusContexts: [],
  };
  const out = rollupToFailedCheckRuns(rollup);
  assertEquals(out.length, 1);
  assertEquals(out[0]?.id, 2);
  assertEquals(out[0]?.name, "test");
  assertEquals(out[0]?.conclusion, "failure");
});

// ===========================================================================
// fetchFailedCheckRunsBatch — convenience helper
// ===========================================================================

Deno.test("check_runs_batch - fetchFailedCheckRunsBatch returns Map with failed check runs", async () => {
  const gh = (_args: string[]): Promise<string> =>
    Promise.resolve(
      fakeRollupResponse([
        {
          rollupState: "FAILURE",
          contexts: [
            {
              type: "CheckRun",
              databaseId: 100,
              name: "test",
              status: "COMPLETED",
              conclusion: "FAILURE",
            },
            {
              type: "CheckRun",
              databaseId: 101,
              name: "build",
              status: "COMPLETED",
              conclusion: "SUCCESS",
            },
          ],
        },
        {
          rollupState: "SUCCESS",
          contexts: [
            {
              type: "CheckRun",
              databaseId: 200,
              name: "build",
              status: "COMPLETED",
              conclusion: "SUCCESS",
            },
          ],
        },
      ]),
    );
  const result = await fetchFailedCheckRunsBatch("acme/tools", [42, 43], gh);
  assert(result !== null);
  assertEquals(result.size, 2);
  const failed42 = result.get(42);
  assert(failed42);
  assertEquals(failed42.length, 1);
  assertEquals(failed42[0]?.name, "test");
  const failed43 = result.get(43);
  assert(failed43);
  assertEquals(failed43.length, 0);
});

Deno.test("check_runs_batch - fetchFailedCheckRunsBatch returns null on GraphQL error", async () => {
  const gh = (_args: string[]): Promise<string> =>
    Promise.reject(new Error("network down"));
  const result = await fetchFailedCheckRunsBatch("acme/tools", [42], gh);
  assertEquals(result, null);
});

Deno.test("check_runs_batch - fetchFailedCheckRunsBatch returns empty Map on empty input", async () => {
  let calls = 0;
  const gh = (_args: string[]): Promise<string> => {
    calls++;
    return Promise.resolve("{}");
  };
  const result = await fetchFailedCheckRunsBatch("acme/tools", [], gh);
  assert(result !== null);
  assertEquals(result.size, 0);
  assertEquals(calls, 0);
});
