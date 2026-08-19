/**
 * Tests for `TimelineBatchRegistry` (Issue #1783).
 *
 * Covers the four acceptance-criteria paths:
 *   - dedupe within an iteration: a second `getBatchedGh` call for an
 *     overlapping issue number does not issue a fresh GraphQL batch
 *   - isolation between iterations: after `reset()` the next call
 *     re-fetches everything
 *   - fallthrough on miss: numbers absent from the map pass through
 *     to the underlying `gh` function
 *   - error propagation: a GraphQL failure does not poison the
 *     registry — subsequent calls retry rather than serving empty
 */

import { assertEquals } from "@std/assert";
import { TimelineBatchRegistry } from "../lib/timeline_batch_registry.ts";

/**
 * Build a recording stub. Tracks every gh invocation so the test can
 * count GraphQL batches and assert which issues each batch covered.
 */
function recordingGh(opts?: { fail?: boolean }) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "api" && args[1] === "graphql") {
      if (opts?.fail) {
        return Promise.reject(new Error("simulated GraphQL failure"));
      }
      // Echo a minimal response. Pull issue numbers from the query so
      // the registry sees a labeled event for each.
      const query = (args[3] ?? "").replace(/^query=/, "");
      const numbers = Array.from(query.matchAll(/issue\(number:\s*(\d+)\)/g))
        .map((m) => Number(m[1]));
      const repository: Record<string, unknown> = {};
      numbers.forEach((num, i) => {
        repository[`n${i}`] = {
          timelineItems: {
            nodes: [
              {
                __typename: "LabeledEvent",
                createdAt: "2024-05-01T10:00:00Z",
                label: { name: `label-${num}` },
                actor: { login: `user-${num}` },
              },
            ],
          },
        };
      });
      return Promise.resolve(JSON.stringify({ data: { repository } }));
    }
    return Promise.resolve("[]");
  };
  const graphqlCalls = (): string[][] =>
    calls.filter((a) => a[0] === "api" && a[1] === "graphql");
  return { fn, calls, graphqlCalls };
}

Deno.test("TimelineBatchRegistry — overlapping requests dedupe within an iteration", async () => {
  const registry = new TimelineBatchRegistry();
  const gh = recordingGh();

  // First collector requests issues 1-3.
  await registry.getBatchedGh("owner/repo", [1, 2, 3], gh.fn);
  // Second collector requests an overlapping set [2,3,4]: only 4 is new.
  await registry.getBatchedGh("owner/repo", [2, 3, 4], gh.fn);

  // Two GraphQL batches expected: one covering [1,2,3], one covering
  // just the missing [4].
  assertEquals(gh.graphqlCalls().length, 2);
  // Registry now holds all four issues.
  assertEquals(registry.size("owner/repo"), 4);
});

Deno.test("TimelineBatchRegistry — wrapped gh serves cached entries without an extra call", async () => {
  const registry = new TimelineBatchRegistry();
  const gh = recordingGh();

  const wrapped = await registry.getBatchedGh("owner/repo", [42], gh.fn);
  // The first batch fetched issue 42 — the wrapper should serve a
  // subsequent timeline call from the in-memory map without issuing
  // any extra GraphQL or REST call.
  const before = gh.calls.length;
  const out = await wrapped(["api", "repos/owner/repo/issues/42/timeline"]);
  const events = JSON.parse(out);
  assertEquals(Array.isArray(events), true);
  assertEquals(events.length, 1);
  assertEquals(gh.calls.length, before);
});

Deno.test("TimelineBatchRegistry — reset isolates iterations", async () => {
  const registry = new TimelineBatchRegistry();
  const gh = recordingGh();

  await registry.getBatchedGh("owner/repo", [1, 2, 3], gh.fn);
  assertEquals(gh.graphqlCalls().length, 1);

  // Iteration boundary.
  registry.reset();
  assertEquals(registry.size("owner/repo"), 0);
  assertEquals(registry.getGraphqlCallCount(), 0);

  // Same numbers must trigger a fresh GraphQL batch in the new iteration.
  await registry.getBatchedGh("owner/repo", [1, 2, 3], gh.fn);
  assertEquals(gh.graphqlCalls().length, 2);
});

Deno.test("TimelineBatchRegistry — fallthrough on issue numbers not in the map", async () => {
  const registry = new TimelineBatchRegistry();
  const gh = recordingGh();

  const wrapped = await registry.getBatchedGh("owner/repo", [1], gh.fn);

  // Issue 999 was never requested — the wrapper must fall through to
  // the base gh function, which returns "[]" for non-graphql calls.
  const before = gh.calls.length;
  const out = await wrapped(["api", "repos/owner/repo/issues/999/timeline"]);
  assertEquals(out, "[]");
  // One additional call to base gh.
  assertEquals(gh.calls.length, before + 1);
});

Deno.test("TimelineBatchRegistry — GraphQL failure does not poison the registry", async () => {
  const registry = new TimelineBatchRegistry();
  const failing = recordingGh({ fail: true });

  await registry.getBatchedGh("owner/repo", [1, 2], failing.fn);
  // Failed batch — nothing added to the map.
  assertEquals(registry.size("owner/repo"), 0);

  // Subsequent retry with a working gh stub must succeed.
  const ok = recordingGh();
  await registry.getBatchedGh("owner/repo", [1, 2], ok.fn);
  assertEquals(registry.size("owner/repo"), 2);
});

Deno.test("TimelineBatchRegistry — empty input is a no-op", async () => {
  const registry = new TimelineBatchRegistry();
  const gh = recordingGh();
  await registry.getBatchedGh("owner/repo", [], gh.fn);
  assertEquals(gh.graphqlCalls().length, 0);
  assertEquals(registry.size("owner/repo"), 0);
});

Deno.test("TimelineBatchRegistry — separate repos do not collide", async () => {
  const registry = new TimelineBatchRegistry();
  const gh = recordingGh();
  await registry.getBatchedGh("owner/foo", [1], gh.fn);
  await registry.getBatchedGh("owner/bar", [1], gh.fn);
  // Two batches — same issue number but different repos.
  assertEquals(gh.graphqlCalls().length, 2);
  assertEquals(registry.size("owner/foo"), 1);
  assertEquals(registry.size("owner/bar"), 1);
});
