/**
 * Regression tests for `cleanStaleLabels` TimelineCache wiring (Issue #1785).
 *
 * Covers:
 *   - cold call hits `gh` and populates the cache
 *   - warm call within TTL serves from the cache and skips `gh`
 *   - worker-initiated label removal invalidates the cached timeline
 *     entry so the next read sees fresh data
 */

import { assertEquals } from "@std/assert";
import { cleanStaleLabels } from "../lib/issue_filter.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import { TimelineCache } from "../lib/timeline_cache.ts";

const FAILED = "failed";
const FAILED_ONCE = "failed-once";
// Issue #2031: needs-clarification retired — cleanStaleLabels only touches failure labels.

function makeCache(ttlSeconds = 300): { cache: TimelineCache; dir: string } {
  const dir = Deno.makeTempDirSync({ prefix: "clean-stale-labels-test-" });
  return { cache: new TimelineCache(ttlSeconds, dir), dir };
}

function makeIssue(
  number: number,
  labels: string[] = [FAILED],
): FilterableIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/owner/repo/issues/${number}`,
    author: "user",
    assignees: [],
    labels,
    createdAt: "2024-01-01T00:00:00Z",
    milestone: "",
  };
}

/**
 * Build a recording gh stub. Timeline calls return the supplied JSON;
 * `issue edit` calls succeed silently. Every invocation is recorded
 * so the test can count timeline reads and label removals.
 */
function recordingGh(timelineJson: string) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "api" && /\/timeline(\?|$)/.test(args[1] ?? "")) {
      return Promise.resolve(timelineJson);
    }
    return Promise.resolve("");
  };
  const timelineCalls = (): number =>
    calls.filter((a) => a[0] === "api" && /\/timeline(\?|$)/.test(a[1] ?? ""))
      .length;
  const editCalls = (): number =>
    calls.filter((a) => a[0] === "issue" && a[1] === "edit").length;
  return { fn, calls, timelineCalls, editCalls };
}

/** Reopened-after-label timeline: the label was applied at 10:00 then
 * the issue was reopened at 11:00 — the label is stale. */
const REOPENED_TIMELINE = JSON.stringify([
  {
    event: "labeled",
    label: { name: FAILED },
    actor: { login: "bot" },
    created_at: "2024-05-01T10:00:00Z",
  },
  {
    event: "reopened",
    actor: { login: "alice" },
    created_at: "2024-05-01T11:00:00Z",
  },
]);

Deno.test("cleanStaleLabels — cold call populates the cache", async () => {
  const { cache, dir } = makeCache();
  try {
    const gh = recordingGh(REOPENED_TIMELINE);
    const issues = [makeIssue(42)];

    const result = await cleanStaleLabels(
      issues,
      "owner/repo",
      FAILED,
      FAILED_ONCE,
      gh.fn,
      cache,
    );

    // Stale label was detected and removed locally.
    assertEquals(result[0]?.labels, []);
    // One timeline read on the cold path.
    assertEquals(gh.timelineCalls(), 1);
    // One `issue edit --remove-label` for the stale label.
    assertEquals(gh.editCalls(), 1);
    // Cache was NOT populated — mutation invalidates the entry.
    assertEquals(await cache.read("owner/repo", 42), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cleanStaleLabels — warm call within TTL skips the API", async () => {
  const { cache, dir } = makeCache();
  try {
    // Pre-populate the cache with a non-stale timeline (label applied
    // after the only reopen) so cleanStaleLabels does not mutate.
    await cache.write("owner/repo", 7, [
      {
        event: "reopened",
        actor: { login: "alice" },
        created_at: "2024-05-01T09:00:00Z",
      },
      {
        event: "labeled",
        label: { name: FAILED },
        actor: { login: "bot" },
        created_at: "2024-05-01T10:00:00Z",
      },
    ]);

    const gh = recordingGh(REOPENED_TIMELINE);
    const issues = [makeIssue(7)];

    const result = await cleanStaleLabels(
      issues,
      "owner/repo",
      FAILED,
      FAILED_ONCE,
      gh.fn,
      cache,
    );

    // No mutation — label was not stale.
    assertEquals(result[0]?.labels, [FAILED]);
    // Cache hit — no `gh api .../timeline` issued.
    assertEquals(gh.timelineCalls(), 0);
    assertEquals(gh.editCalls(), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cleanStaleLabels — label removal invalidates the cached timeline", async () => {
  const { cache, dir } = makeCache();
  try {
    // Pre-populate the cache so the read hits.
    await cache.write("owner/repo", 99, [
      {
        event: "labeled",
        label: { name: FAILED },
        actor: { login: "bot" },
        created_at: "2024-05-01T10:00:00Z",
      },
      {
        event: "reopened",
        actor: { login: "alice" },
        created_at: "2024-05-01T11:00:00Z",
      },
    ]);

    const gh = recordingGh(REOPENED_TIMELINE);
    const issues = [makeIssue(99)];

    await cleanStaleLabels(
      issues,
      "owner/repo",
      FAILED,
      FAILED_ONCE,
      gh.fn,
      cache,
    );

    // After mutation, the cache entry must be gone so the next reader
    // sees fresh state instead of the now-stale snapshot.
    assertEquals(await cache.read("owner/repo", 99), null);
    // Removal happened.
    assertEquals(gh.editCalls(), 1);
    // Initial read was cache-served — no timeline API call.
    assertEquals(gh.timelineCalls(), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cleanStaleLabels — no cache works exactly as before", async () => {
  // Backwards-compatibility: when the cache argument is omitted the
  // function must still hit the API and behave correctly.
  const gh = recordingGh(REOPENED_TIMELINE);
  const issues = [makeIssue(1)];

  const result = await cleanStaleLabels(
    issues,
    "owner/repo",
    FAILED,
    FAILED_ONCE,
    gh.fn,
  );

  assertEquals(result[0]?.labels, []);
  assertEquals(gh.timelineCalls(), 1);
  assertEquals(gh.editCalls(), 1);
});
