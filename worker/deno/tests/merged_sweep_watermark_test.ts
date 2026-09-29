/**
 * Tests for the merge-order-independent processed-set store (Issue #2828).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  emptyProcessedSweepState,
  isProcessed,
  loadProcessedSweepState,
  markProcessed,
  type ProcessedSweepState,
  pruneToWindow,
  saveProcessedSweepState,
} from "../lib/merged_sweep_watermark.ts";

const REPO = "owner/repo";

function recordingLogger(): { warn: (m: string) => void; warnings: string[] } {
  const warnings: string[] = [];
  return { warn: (m: string) => warnings.push(m), warnings };
}

async function withTempFile(
  content: string | undefined,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/watermarks.json`;
  try {
    if (content !== undefined) await Deno.writeTextFile(path, content);
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loadProcessedSweepState - missing file loads as empty without a warning", async () => {
  await withTempFile(undefined, async (path) => {
    const log = recordingLogger();
    assertEquals(
      await loadProcessedSweepState(path, log),
      emptyProcessedSweepState(),
    );
    assertEquals(log.warnings, []);
  });
});

Deno.test("loadProcessedSweepState - legacy v1 number map loads as empty (catch-up)", async () => {
  await withTempFile(
    JSON.stringify({ "owner/repo": 200, "owner/other": 12 }),
    async (path) => {
      const log = recordingLogger();
      const state = await loadProcessedSweepState(path, log);
      assertEquals(state, emptyProcessedSweepState());
      assertFalse(isProcessed(state, REPO, 150));
      assertEquals(log.warnings, []);
    },
  );
});

for (
  const [label, content] of [
    ["invalid JSON", "{not json"],
    ["a JSON array", "[1, 2, 3]"],
    ["an unknown version", JSON.stringify({ version: 3, repos: {} })],
    ["v2 with non-object repos", JSON.stringify({ version: 2, repos: [] })],
    [
      "v2 with a non-array processed list",
      JSON.stringify({ version: 2, repos: { [REPO]: { processed: 5 } } }),
    ],
  ] as const
) {
  Deno.test(`loadProcessedSweepState - corrupt file (${label}) loads as empty and warns`, async () => {
    await withTempFile(content, async (path) => {
      const log = recordingLogger();
      assertEquals(
        await loadProcessedSweepState(path, log),
        emptyProcessedSweepState(),
      );
      assertEquals(log.warnings.length, 1);
      assertStringIncludes(log.warnings[0] ?? "", path);
    });
  });
}

Deno.test("loadProcessedSweepState - drops invalid PR numbers from a v2 list and warns", async () => {
  await withTempFile(
    JSON.stringify({
      version: 2,
      repos: { [REPO]: { processed: [150, -1, 0, 1.5, "7", 200, 150] } },
    }),
    async (path) => {
      const log = recordingLogger();
      const state = await loadProcessedSweepState(path, log);
      assertEquals(state.repos[REPO]?.processed, [150, 200]);
      assertEquals(log.warnings.length, 1);
    },
  );
});

Deno.test("markProcessed/isProcessed - order of marking does not matter", () => {
  let state = emptyProcessedSweepState();
  state = markProcessed(state, REPO, 200);
  state = markProcessed(state, REPO, 150);
  assert(isProcessed(state, REPO, 200));
  assert(isProcessed(state, REPO, 150));
  // A number-comparison watermark would call 175 processed; the set does not.
  assertFalse(isProcessed(state, REPO, 175));
  assertFalse(isProcessed(state, "owner/other", 150));
});

Deno.test("markProcessed - is pure and idempotent", () => {
  const before = emptyProcessedSweepState();
  const once = markProcessed(before, REPO, 42);
  const twice = markProcessed(once, REPO, 42);
  assertEquals(before, emptyProcessedSweepState());
  assertEquals(twice.repos[REPO]?.processed, [42]);
});

Deno.test("pruneToWindow - keeps numbers in the window and drops the rest", () => {
  let state: ProcessedSweepState = emptyProcessedSweepState();
  for (const n of [100, 150, 200]) state = markProcessed(state, REPO, n);
  state = markProcessed(state, "owner/other", 100);
  const pruned = pruneToWindow(state, REPO, [150, 200, 250]);
  assertEquals(pruned.repos[REPO]?.processed, [150, 200]);
  // Other repos are untouched, and the input state is not mutated.
  assertEquals(pruned.repos["owner/other"]?.processed, [100]);
  assertEquals(state.repos[REPO]?.processed, [100, 150, 200]);
});

Deno.test("pruneToWindow - an unknown repo is a no-op", () => {
  const state = markProcessed(emptyProcessedSweepState(), REPO, 1);
  assertEquals(pruneToWindow(state, "owner/other", [1, 2]), state);
});

Deno.test("saveProcessedSweepState - round-trips through load in the v2 format", async () => {
  await withTempFile(undefined, async (path) => {
    let state = emptyProcessedSweepState();
    state = markProcessed(state, REPO, 200);
    state = markProcessed(state, REPO, 150);
    await saveProcessedSweepState(path, state);
    const raw = JSON.parse(await Deno.readTextFile(path));
    assertEquals(raw, {
      version: 2,
      repos: { [REPO]: { processed: [150, 200] } },
    });
    assertEquals(
      await loadProcessedSweepState(path, recordingLogger()),
      state,
    );
  });
});

Deno.test("markProcessed - rejects an invalid PR number loudly", () => {
  assertThrows(
    () => markProcessed(emptyProcessedSweepState(), REPO, 0),
    RangeError,
  );
});
