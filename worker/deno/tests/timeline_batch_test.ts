/**
 * Tests for timeline_batch.ts (Issue #1674).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchTimelineBatch,
  TIMELINE_BATCH_SIZE,
  wrapGhWithBatchedTimeline,
} from "../lib/timeline_batch.ts";
import { wasLabelAddedByAllowedAuthor } from "../lib/issue_query.ts";
import { verifyOperationalLabels } from "../lib/label_security.ts";
import {
  fakeGithubGraphQL,
  type FakeLabelEvent,
} from "./support/github_graphql_fake.ts";

// =============================================================================
// Behaviour against a fake that models GitHub's own connection rules
// =============================================================================

Deno.test("timeline_batch - each issue receives its own timeline (Issue #471)", async () => {
  const { gh } = fakeGithubGraphQL({
    owner: "acme",
    name: "tools",
    issues: {
      10: {
        labelEvents: [{
          label: "work-on",
          actor: "alice",
          createdAt: "2024-01-01T00:00:00Z",
        }],
      },
      20: {
        labelEvents: [{
          label: "top-priority",
          actor: "bob",
          createdAt: "2024-02-01T00:00:00Z",
        }],
      },
    },
  });

  const result = await fetchTimelineBatch("acme/tools", [10, 20], gh);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.events.get(10)?.[0]?.label?.name, "work-on");
  assertEquals(result.events.get(10)?.[0]?.actor?.login, "alice");
  assertEquals(result.events.get(20)?.[0]?.label?.name, "top-priority");
  assertEquals(result.events.get(20)?.[0]?.actor?.login, "bob");
});

Deno.test("timeline_batch - the most-recent untrusted add survives batching and is rejected (Issue #3089)", async () => {
  // 101 labelled events: the oldest 100 are trusted adds by alice, the newest
  // is an untrusted add by mallory. GitHub's `last: n` returns the tail, so a
  // fetcher that reads the tail sees mallory's add and the trust gate refuses.
  // A fetcher that read the head (`first: n`) would see only alice's adds and
  // wrongly accept — the fake answers each spelling truthfully, so the
  // assertion below is what detects the difference.
  const labelEvents: FakeLabelEvent[] = [];
  for (let i = 0; i < 149; i++) {
    labelEvents.push({
      label: "work-on",
      actor: "alice",
      createdAt: `2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    });
  }
  labelEvents.push({
    label: "work-on",
    actor: "mallory",
    createdAt: "2024-06-01T00:00:00Z",
  });

  const { gh } = fakeGithubGraphQL({
    owner: "acme",
    name: "tools",
    issues: { 55: { labelEvents } },
  });

  const batch = await fetchTimelineBatch("acme/tools", [55], gh);
  assert(batch.ok);
  if (!batch.ok) return;
  const fetched = batch.events.get(55) ?? [];
  assertEquals(fetched.at(-1)?.actor?.login, "mallory");
});

Deno.test("timeline_batch - the trust gate refuses a batched timeline whose last add is untrusted (Issue #3089)", async () => {
  const { gh } = fakeGithubGraphQL({
    owner: "acme",
    name: "tools",
    issues: {
      55: {
        labelEvents: [
          {
            label: "work-on",
            actor: "alice",
            createdAt: "2024-01-01T00:00:00Z",
          },
          {
            label: "work-on",
            actor: "mallory",
            createdAt: "2024-06-01T00:00:00Z",
          },
        ],
      },
    },
  });

  const batch = await fetchTimelineBatch("acme/tools", [55], gh);
  assert(batch.ok);
  if (!batch.ok) return;
  const wrapped = wrapGhWithBatchedTimeline(gh, batch.events);
  assertEquals(
    await wasLabelAddedByAllowedAuthor(
      "acme/tools",
      55,
      "work-on",
      ["alice"],
      wrapped,
    ),
    false,
  );
});

Deno.test("timeline_batch - a repository the API cannot resolve is an error, not an empty timeline", async () => {
  const { gh } = fakeGithubGraphQL({
    owner: "acme",
    name: "tools",
    issues: { 1: { labelEvents: [] } },
  });
  const result = await fetchTimelineBatch("acme/other", [1], gh);
  assertEquals(result.ok, false);
});

// =============================================================================
// fetchTimelineBatch — happy path / empty / batching / failure
// =============================================================================

function fakeGraphQLResponse(numbers: number[]): string {
  const repo: Record<string, unknown> = {};
  for (let i = 0; i < numbers.length; i++) {
    repo[`n${i}`] = {
      timelineItems: {
        nodes: [
          {
            __typename: "LabeledEvent",
            createdAt: "2024-05-01T00:00:00Z",
            label: { name: "work-on" },
            actor: { login: `user-${numbers[i]}` },
          },
        ],
      },
    };
  }
  return JSON.stringify({ data: { repository: repo } });
}

Deno.test("timeline_batch - fetchTimelineBatch happy path returns events per issue", async () => {
  let calls = 0;
  const gh = async (args: string[]): Promise<string> => {
    calls++;
    assertEquals(args[0], "api");
    assertEquals(args[1], "graphql");
    assertEquals(args[2], "-f");
    assert(args[3]?.startsWith("query="));
    return fakeGraphQLResponse([1, 2, 3]);
  };
  const result = await fetchTimelineBatch("acme/tools", [1, 2, 3], gh);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(calls, 1);
  assertEquals(result.callCount, 1);
  assertEquals(result.events.size, 3);
  const events = result.events.get(2);
  assert(events && events.length === 1);
  assertEquals(events[0]?.event, "labeled");
  assertEquals(events[0]?.label?.name, "work-on");
  assertEquals(events[0]?.actor?.login, "user-2");
  assertEquals(events[0]?.created_at, "2024-05-01T00:00:00Z");
});

Deno.test("timeline_batch - fetchTimelineBatch empty input issues no calls", async () => {
  let calls = 0;
  const gh = (_args: string[]): Promise<string> => {
    calls++;
    return Promise.resolve("{}");
  };
  const result = await fetchTimelineBatch("acme/tools", [], gh);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(calls, 0);
  assertEquals(result.callCount, 0);
  assertEquals(result.events.size, 0);
});

Deno.test("timeline_batch - fetchTimelineBatch splits batches at 25", async () => {
  const numbers = Array.from({ length: 30 }, (_, i) => i + 1);
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    // Pull the issue numbers back out of the query string to count
    const query = (args[3] ?? "").substring("query=".length);
    const matches = query.match(/issue\(number: (\d+)\)/g) ?? [];
    return Promise.resolve(
      fakeGraphQLResponse(matches.map((m) => Number(m.match(/\d+/)![0]))),
    );
  };
  const result = await fetchTimelineBatch("acme/tools", numbers, gh);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(TIMELINE_BATCH_SIZE, 25);
  assertEquals(calls, 2);
  assertEquals(result.callCount, 2);
  assertEquals(result.events.size, 30);
});

Deno.test("timeline_batch - fetchTimelineBatch boundary: exactly 25 issues = 1 call", async () => {
  const numbers = Array.from({ length: 25 }, (_, i) => i + 1);
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    const query = (args[3] ?? "").substring("query=".length);
    const matches = query.match(/issue\(number: (\d+)\)/g) ?? [];
    return Promise.resolve(
      fakeGraphQLResponse(matches.map((m) => Number(m.match(/\d+/)![0]))),
    );
  };
  const result = await fetchTimelineBatch("acme/tools", numbers, gh);
  assert(result.ok);
  assertEquals(calls, 1);
});

Deno.test("timeline_batch - fetchTimelineBatch returns error on gh failure", async () => {
  const gh = (_args: string[]): Promise<string> => {
    return Promise.reject(new Error("boom"));
  };
  const result = await fetchTimelineBatch("acme/tools", [1], gh);
  assert(!result.ok);
  if (result.ok) return;
  assertEquals(result.error.message, "boom");
});

Deno.test("timeline_batch - fetchTimelineBatch returns error on GraphQL errors payload", async () => {
  const gh = (_args: string[]): Promise<string> => {
    return Promise.resolve(JSON.stringify({
      errors: [{ message: "Field 'issue' not found" }],
    }));
  };
  const result = await fetchTimelineBatch("acme/tools", [1], gh);
  assert(!result.ok);
});

Deno.test("timeline_batch - fetchTimelineBatch handles top-level error with data:null", async () => {
  // A top-level GraphQL error returns `data: null`. The caller's guard
  // must catch this and return an error result rather than letting
  // convertBatch dereference a null repository (Issue #2984).
  const gh = (_args: string[]): Promise<string> =>
    Promise.resolve(JSON.stringify({ data: null }));
  const result = await fetchTimelineBatch("acme/tools", [1, 2], gh);
  assert(!result.ok);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "missing data.repository");
});

Deno.test("timeline_batch - fetchTimelineBatch rejects malformed repo identifier", async () => {
  const gh = (_args: string[]): Promise<string> => Promise.resolve("{}");
  const r1 = await fetchTimelineBatch("not-a-repo", [1], gh);
  assert(!r1.ok);
  const r2 = await fetchTimelineBatch("ow ner/repo", [1], gh);
  assert(!r2.ok);
});

Deno.test("timeline_batch - fetchTimelineBatch deduplicates issue numbers", async () => {
  let calls = 0;
  const gh = (args: string[]): Promise<string> => {
    calls++;
    const query = (args[3] ?? "").substring("query=".length);
    const matches = query.match(/issue\(number: (\d+)\)/g) ?? [];
    assertEquals(matches.length, 2); // dedup to [1, 2]
    return Promise.resolve(fakeGraphQLResponse([1, 2]));
  };
  const result = await fetchTimelineBatch("acme/tools", [1, 2, 1, 2, 1], gh);
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(calls, 1);
  assertEquals(result.events.size, 2);
});

// =============================================================================
// wrapGhWithBatchedTimeline integration with existing consumers
// =============================================================================

Deno.test("timeline_batch - wrapped gh feeds wasLabelAddedByAllowedAuthor without REST call", async () => {
  const events = new Map([
    [42, [
      {
        event: "labeled",
        label: { name: "work-on" },
        actor: { login: "alice" },
        created_at: "2024-04-01T00:00:00Z",
      },
    ]],
  ]);
  let baseCalls = 0;
  const baseGh = (_args: string[]): Promise<string> => {
    baseCalls++;
    return Promise.resolve("[]");
  };
  const wrapped = wrapGhWithBatchedTimeline(baseGh, events);
  const result = await wasLabelAddedByAllowedAuthor(
    "acme/tools",
    42,
    "work-on",
    ["alice"],
    wrapped,
  );
  assertEquals(result, true);
  assertEquals(baseCalls, 0);
});

Deno.test("timeline_batch - wrapped gh falls through for non-timeline calls", async () => {
  const events = new Map();
  let baseCalls = 0;
  const baseGh = (_args: string[]): Promise<string> => {
    baseCalls++;
    return Promise.resolve("ok");
  };
  const wrapped = wrapGhWithBatchedTimeline(baseGh, events);
  const out = await wrapped(["issue", "view", "5"]);
  assertEquals(out, "ok");
  assertEquals(baseCalls, 1);
});

Deno.test("timeline_batch - wrapped gh falls through for issue not in batch", async () => {
  const events = new Map([[42, []]]);
  let baseCalls = 0;
  const baseGh = (args: string[]): Promise<string> => {
    baseCalls++;
    assertStringIncludes(args[1] ?? "", "/issues/99/timeline");
    return Promise.resolve("[]");
  };
  const wrapped = wrapGhWithBatchedTimeline(baseGh, events);
  await wrapped(["api", "repos/acme/tools/issues/99/timeline"]);
  assertEquals(baseCalls, 1);
});

Deno.test("timeline_batch - wrapped gh feeds verifyOperationalLabels too", async () => {
  const events = new Map([
    [42, [
      {
        event: "labeled",
        label: { name: "planning" },
        actor: { login: "alice" },
        created_at: "2024-04-01T00:00:00Z",
      },
    ]],
  ]);
  let baseCalls = 0;
  const baseGh = (_args: string[]): Promise<string> => {
    baseCalls++;
    return Promise.resolve("[]");
  };
  const wrapped = wrapGhWithBatchedTimeline(baseGh, events);
  const verification = await verifyOperationalLabels(
    "acme/tools",
    42,
    ["planning"],
    ["alice"],
    wrapped,
  );
  assertEquals(verification.trustedLabels, ["planning"]);
  assertEquals(verification.untrustedLabels.length, 0);
  assertEquals(baseCalls, 0);
});
