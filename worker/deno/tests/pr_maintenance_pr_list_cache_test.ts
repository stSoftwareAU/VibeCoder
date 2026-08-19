/**
 * Tests for the shared Priority-1.x PR-list cache (Issue #4303).
 *
 * Each scan used to issue its own `gh pr list` per repo×author, differing
 * only in `--json` fields — four to six identical listings per repo per
 * cycle, and everything re-fetched again next cycle because the cache dir
 * died with the container. One superset listing now serves them all, from
 * a cache directory that can live on the durable work volume.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  listOpenPrs,
  PR_MAINTENANCE_LIST_FIELDS,
} from "../lib/pr_maintenance.ts";
import { IssueCache } from "../lib/issue_cache.ts";

const PRS = [
  { number: 7, headRefName: "issue-7-x", headRefOid: "abc", title: "seven" },
  { number: 9, headRefName: "issue-9-y", headRefOid: "def", title: "nine" },
];

function mockGh(calls: string[][]): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push(args);
    return Promise.resolve(JSON.stringify(PRS));
  };
}

Deno.test("pr list cache - repeated scans with different fields share ONE superset listing (Issue #4303)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pr_list_cache_" });
  const cache = new IssueCache(dir);
  const calls: string[][] = [];
  try {
    const first = await listOpenPrs(
      "o/r",
      "Vibecoderbot",
      "number,headRefName,headRefOid",
      mockGh(calls),
      cache,
    );
    const second = await listOpenPrs(
      "o/r",
      "Vibecoderbot",
      "number,headRefName,baseRefName",
      mockGh(calls),
      cache,
    );
    const third = await listOpenPrs(
      "o/r",
      "Vibecoderbot",
      "number,headRefName,autoMergeRequest",
      mockGh(calls),
      cache,
    );

    assertEquals(calls.length, 1, "three scans must cost one gh call");
    // The one real call requested the field superset, not the first
    // caller's narrow view.
    const jsonIndex = calls[0]!.indexOf("--json");
    assertEquals(calls[0]![jsonIndex + 1], PR_MAINTENANCE_LIST_FIELDS);
    for (const result of [first, second, third]) {
      assertEquals(result.map((p) => p.number), [7, 9]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("pr list cache - a second cache instance over the same directory reads the first's entry (cross-launch warm start, Issue #4303)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pr_list_cache_" });
  const calls: string[][] = [];
  try {
    await listOpenPrs(
      "o/r",
      "Vibecoderbot",
      "number",
      mockGh(calls),
      new IssueCache(dir),
    );
    // A fresh instance — the next launch — over the same durable dir.
    const warm = await listOpenPrs(
      "o/r",
      "Vibecoderbot",
      "number,headRefName",
      mockGh(calls),
      new IssueCache(dir),
    );
    assertEquals(calls.length, 1, "the relaunch must start warm");
    assertEquals(warm.map((p) => p.number), [7, 9]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("pr list cache - without a cache the legacy call shape is unchanged", async () => {
  const calls: string[][] = [];
  const result = await listOpenPrs(
    "o/r",
    "Vibecoderbot",
    "number,headRefName",
    mockGh(calls),
  );
  assertEquals(calls.length, 1);
  const jsonIndex = calls[0]!.indexOf("--json");
  assertEquals(calls[0]![jsonIndex + 1], "number,headRefName");
  assert(!calls[0]!.includes("--limit"), "legacy path must not add --limit");
  assertEquals(result.map((p) => p.number), [7, 9]);
});

Deno.test("pr list cache - per-author entries are separate keys", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pr_list_cache_" });
  const cache = new IssueCache(dir);
  const calls: string[][] = [];
  try {
    await listOpenPrs("o/r", ["a1", "a2"], "number", mockGh(calls), cache);
    assertEquals(calls.length, 2, "one listing per author");
    await listOpenPrs("o/r", ["a1", "a2"], "number", mockGh(calls), cache);
    assertEquals(calls.length, 2, "second pass fully served by cache");
    const flat = calls.map((c) => c.join(" ")).join("\n");
    assertStringIncludes(flat, "--author a1");
    assertStringIncludes(flat, "--author a2");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});
