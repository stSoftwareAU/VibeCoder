/**
 * The milestone-close sweep is dispatched, and dispatched in the right place
 * (Issue #2338).
 *
 * A closed milestone's worktrees only go if the cycle actually calls the
 * sweep, and it must run after the completion pass that closes milestones —
 * otherwise a milestone closed this cycle waits a whole cycle to be swept.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildPriorityDispatchTable,
  createDefaultRunCoreConfig,
  type RunCoreDeps,
} from "../lib/run_core.ts";

const TIER = "Closed Milestone Housekeeping";

function mockDeps(overrides: Partial<RunCoreDeps>): RunCoreDeps {
  // Only the fields the dispatch table reads are supplied; the table is built,
  // never run, for every priority but the one under test.
  return {
    loadAndValidateConfig: () =>
      Promise.resolve({ ok: true, value: createDefaultRunCoreConfig() }),
    ...overrides,
  } as unknown as RunCoreDeps;
}

Deno.test("dispatch - the sweep sits between milestone completion and branch sync", () => {
  const table = buildPriorityDispatchTable(
    mockDeps({
      sweepClosedMilestones: () =>
        Promise.resolve({ ok: true, value: undefined }),
    }),
  );
  const sweep = table.find((h) => h.name === TIER);
  assert(sweep, `no sweep tier: ${table.map((h) => h.name).join(", ")}`);
  assertEquals(sweep.priority, 1.71);

  const completion = table.find((h) => h.name === "Milestone Completions")!;
  const sync = table.find((h) => h.name === "Milestone Branch Sync")!;
  assert(
    completion.priority < sweep.priority,
    "a milestone is closed before its footprint is swept",
  );
  assert(
    sweep.priority < sync.priority,
    "the sweep runs before the branch sync it makes cheaper",
  );
});

Deno.test("dispatch - the sweep tier calls the dep and never claims an issue", async () => {
  let calls = 0;
  const table = buildPriorityDispatchTable(
    mockDeps({
      sweepClosedMilestones: () => {
        calls++;
        return Promise.resolve({ ok: true, value: undefined });
      },
    }),
  );
  const sweep = table.find((h) => h.name === TIER)!;
  const result = await sweep.execute();
  assertEquals(calls, 1);
  assert(result.ok);
  assertEquals(result.value?.processed, false);
});

Deno.test("dispatch - a sweep failure is surfaced, not swallowed", async () => {
  const table = buildPriorityDispatchTable(
    mockDeps({
      sweepClosedMilestones: () =>
        Promise.resolve({ ok: false, error: new Error("work dir unreadable") }),
    }),
  );
  const sweep = table.find((h) => h.name === TIER)!;
  const result = await sweep.execute();
  assertEquals(result.ok, false);
  assertEquals(
    result.ok === false ? result.error.message : "",
    "work dir unreadable",
  );
});

Deno.test("dispatch - an unwired sweep dep leaves the tier inert rather than failing", async () => {
  const table = buildPriorityDispatchTable(mockDeps({}));
  const sweep = table.find((h) => h.name === TIER)!;
  const result = await sweep.execute();
  assert(result.ok, "a deps set without the sweep must still dispatch cleanly");
  assertEquals(result.value?.processed, false);
});
