/**
 * The deferred-PR drain is dispatched, and dispatched first (Issue #1951).
 *
 * The parked PR only reaches GitHub if the cycle actually calls the drain —
 * and it has to run before the PR upkeep that assumes the PR exists, since a
 * PR that has not been raised cannot have its branch updated, its CI nudged or
 * its auto-merge armed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildPriorityDispatchTable,
  createDefaultRunCoreConfig,
  type RunCoreDeps,
} from "../lib/run_core.ts";

function mockDeps(overrides: Partial<RunCoreDeps>): RunCoreDeps {
  // Only the fields the dispatch table reads are supplied; the table is built,
  // never run, for every priority but the one under test.
  return {
    loadAndValidateConfig: () =>
      Promise.resolve({ ok: true, value: createDefaultRunCoreConfig() }),
    ...overrides,
  } as unknown as RunCoreDeps;
}

Deno.test("dispatch - the deferred-PR drain runs before every other pass", () => {
  const table = buildPriorityDispatchTable(
    mockDeps({
      drainDeferredPrs: () => Promise.resolve({ ok: true, value: undefined }),
    }),
  );
  const drain = table.find((h) => h.name === "Deferred PR Raise");
  assert(drain, `no drain tier: ${table.map((h) => h.name).join(", ")}`);
  assertEquals(drain.priority, 0.9);

  for (const pass of table) {
    if (pass === drain) continue;
    assert(
      drain.priority < pass.priority,
      `${pass.name} (${pass.priority}) must run after the drain`,
    );
  }
});

Deno.test("dispatch - the drain tier calls the dep and never claims an issue", async () => {
  let calls = 0;
  const table = buildPriorityDispatchTable(
    mockDeps({
      drainDeferredPrs: () => {
        calls++;
        return Promise.resolve({ ok: true, value: undefined });
      },
    }),
  );
  const drain = table.find((h) => h.name === "Deferred PR Raise")!;
  const result = await drain.execute();
  assertEquals(calls, 1);
  assert(result.ok);
  assertEquals(result.value?.processed, false);
});

Deno.test("dispatch - a drain failure is surfaced, not swallowed", async () => {
  const table = buildPriorityDispatchTable(
    mockDeps({
      drainDeferredPrs: () =>
        Promise.resolve({ ok: false, error: new Error("work dir unreadable") }),
    }),
  );
  const drain = table.find((h) => h.name === "Deferred PR Raise")!;
  const result = await drain.execute();
  assertEquals(result.ok, false);
  assertEquals(
    result.ok === false ? result.error.message : "",
    "work dir unreadable",
  );
});

Deno.test("dispatch - a host wired without the drain still builds its table", async () => {
  const table = buildPriorityDispatchTable(mockDeps({}));
  const drain = table.find((h) => h.name === "Deferred PR Raise")!;
  const result = await drain.execute();
  assert(result.ok, "the optional dep absent is a no-op, never a failure");
});
