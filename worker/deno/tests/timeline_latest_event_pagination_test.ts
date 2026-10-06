/**
 * Regression tests for Issue #3327: every "most recent label event" lookup
 * must read the **whole** REST timeline, not page 1.
 *
 * `fetchTimelineWithCache` used to request `timeline?per_page=100` alone —
 * page 1, the *oldest* 100 events. On GRQ-AutoTrader#2089 (131 events) the
 * developer's two `needs-human` removals after Grill-Me Round 4 sat on page 2,
 * so `getLabelLastRemoveInfo` returned a removal from four days earlier,
 * `isNonWorkerRemovalAfterRound` said "no", and the grill-me processor re-added
 * `needs-human` on every scan. The fixtures below reproduce that shape.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  fetchTimelineWithCache,
  getLabelLastAddInfo,
  getLabelLastRemoveInfo,
} from "../lib/issue_query.ts";
import { isNonWorkerRemovalAfterRound } from "../lib/grill_me_processor.ts";
import { cleanStaleLabels } from "../lib/issue_filter.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import { TimelineCache } from "../lib/timeline_cache.ts";
import type { TimelineLabelEventJson } from "../lib/validation.ts";

const PER_PAGE = 100;
const ROUND_4_AT = "2026-10-06T18:33:34Z";

/** Neutral filler event that no label lookup matches. */
function filler(i: number): TimelineLabelEventJson {
  return {
    event: "commented",
    actor: { login: "VibeCoderST" },
    created_at: new Date(Date.parse("2026-10-03T00:00:00Z") + i * 60_000)
      .toISOString(),
  };
}

function labelEvent(
  event: "labeled" | "unlabeled",
  label: string,
  login: string,
  at: string,
): TimelineLabelEventJson {
  return { event, label: { name: label }, actor: { login }, created_at: at };
}

/**
 * The GRQ-AutoTrader#2089 shape: 131 events. Page 1 holds the four early
 * `needs-human` removals from 2 October (all before Round 4); page 2 holds the
 * developer's two removals after Round 4.
 */
function grq2089Timeline(): TimelineLabelEventJson[] {
  const early = [
    "2026-10-02T05:15:08Z",
    "2026-10-02T05:57:45Z",
    "2026-10-02T06:15:21Z",
    "2026-10-02T06:47:55Z",
  ].map((at) => labelEvent("unlabeled", "needs-human", "nleck", at));
  const page1 = [...early];
  for (let i = 0; page1.length < PER_PAGE; i++) page1.push(filler(i));
  const page2: TimelineLabelEventJson[] = [];
  for (let i = 0; page2.length < 27; i++) page2.push(filler(200 + i));
  page2.push(
    labelEvent("labeled", "needs-human", "VibeCoderST", "2026-10-06T18:33:42Z"),
    labelEvent("unlabeled", "needs-human", "nleck", "2026-10-06T18:45:52Z"),
    labelEvent("labeled", "needs-human", "VibeCoderST", "2026-10-06T18:54:58Z"),
    labelEvent("unlabeled", "needs-human", "nleck", "2026-10-06T19:14:48Z"),
  );
  return [...page1, ...page2];
}

/**
 * A `gh` stub that serves the REST timeline the way GitHub does: `page=N`
 * returns events `[(N-1)*per_page, N*per_page)`, and a request with no `page`
 * parameter returns page 1 (exactly what the pre-#3327 call received).
 */
function pagingGh(
  events: TimelineLabelEventJson[],
  opts: { failOnPage?: number } = {},
) {
  const timelineCalls: string[] = [];
  const fn = (args: string[]): Promise<string> => {
    const path = args[1] ?? "";
    if (args[0] === "api" && /\/timeline(\?|$)/.test(path)) {
      timelineCalls.push(path);
      const query = new URLSearchParams(path.split("?")[1] ?? "");
      const perPage = Number(query.get("per_page") ?? "30");
      const page = Number(query.get("page") ?? "1");
      if (page === opts.failOnPage) {
        return Promise.reject(new Error("HTTP 502: Bad Gateway"));
      }
      const start = (page - 1) * perPage;
      return Promise.resolve(
        JSON.stringify(events.slice(start, start + perPage)),
      );
    }
    return Promise.resolve("");
  };
  return { fn, timelineCalls };
}

function makeCache(): { cache: TimelineCache; dir: string } {
  const dir = Deno.makeTempDirSync({ prefix: "timeline-pagination-test-" });
  return { cache: new TimelineCache(300, dir), dir };
}

// ---------------------------------------------------------------------------
// getLabelLastRemoveInfo / isNonWorkerRemovalAfterRound
// ---------------------------------------------------------------------------

Deno.test(
  "getLabelLastRemoveInfo - finds the developer's needs-human removal on page 2 (Issue #3327)",
  async () => {
    const gh = pagingGh(grq2089Timeline());

    const info = await getLabelLastRemoveInfo(
      "stSoftwareAU/GRQ-AutoTrader",
      2089,
      "needs-human",
      gh.fn,
    );

    assertEquals(info, {
      removedBy: "nleck",
      removedAt: Math.floor(Date.parse("2026-10-06T19:14:48Z") / 1000),
    });
    assertEquals(gh.timelineCalls.length, 2, "both pages are read");
  },
);

Deno.test(
  "isNonWorkerRemovalAfterRound - a page-2 removal after Round 4 is the developer's go signal (Issue #3327)",
  async () => {
    const gh = pagingGh(grq2089Timeline());

    const info = await getLabelLastRemoveInfo(
      "stSoftwareAU/GRQ-AutoTrader",
      2089,
      "needs-human",
      gh.fn,
    );

    assertEquals(
      isNonWorkerRemovalAfterRound(info, ROUND_4_AT, "VibeCoderST"),
      true,
      "the 2 October removal on page 1 must not shadow the 6 October removal",
    );
  },
);

Deno.test(
  "getLabelLastRemoveInfo - a page that fails mid-pagination returns null, never a page-1 answer (Issue #3327)",
  async () => {
    const gh = pagingGh(grq2089Timeline(), { failOnPage: 2 });

    const info = await getLabelLastRemoveInfo(
      "stSoftwareAU/GRQ-AutoTrader",
      2089,
      "needs-human",
      gh.fn,
    );

    // null keeps the grill-me awaiting-reply guard in charge (fail-safe);
    // page 1's stale 2 October removal must never be returned instead.
    assertEquals(info, null);
  },
);

// ---------------------------------------------------------------------------
// getLabelLastAddInfo
// ---------------------------------------------------------------------------

Deno.test(
  "getLabelLastAddInfo - finds the newest add on page 2 (Issue #3327)",
  async () => {
    const events: TimelineLabelEventJson[] = [
      labelEvent("labeled", "grill-me", "alice", "2026-10-01T00:00:00Z"),
    ];
    for (let i = 0; events.length < PER_PAGE + 10; i++) events.push(filler(i));
    events.push(
      labelEvent("labeled", "grill-me", "nleck", "2026-10-06T18:20:43Z"),
    );
    const gh = pagingGh(events);

    const info = await getLabelLastAddInfo("owner/repo", 7, "grill-me", gh.fn);

    assertEquals(info, {
      addedBy: "nleck",
      addedAt: Math.floor(Date.parse("2026-10-06T18:20:43Z") / 1000),
    });
  },
);

// ---------------------------------------------------------------------------
// fetchTimelineWithCache — cache semantics
// ---------------------------------------------------------------------------

Deno.test(
  "fetchTimelineWithCache - writes a complete entry that later readers reuse without a call (Issue #3327)",
  async () => {
    const { cache, dir } = makeCache();
    try {
      const timeline = grq2089Timeline();
      const cold = pagingGh(timeline);
      const first = await fetchTimelineWithCache(
        "owner/repo",
        1,
        cold.fn,
        cache,
      );
      assertEquals(first?.length, timeline.length);
      assertEquals(
        (await cache.readComplete("owner/repo", 1))?.length,
        timeline.length,
        "a fully paginated read is cached as complete",
      );

      const warm = pagingGh([]);
      const second = await fetchTimelineWithCache(
        "owner/repo",
        1,
        warm.fn,
        cache,
      );
      assertEquals(second?.length, timeline.length);
      assertEquals(warm.timelineCalls.length, 0, "served from the cache");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "fetchTimelineWithCache - refuses a partial cache entry and re-paginates (Issue #3327)",
  async () => {
    const { cache, dir } = makeCache();
    try {
      const timeline = grq2089Timeline();
      // A page-1-only entry, as written before #3327 or by an older worker.
      await cache.write("owner/repo", 1, timeline.slice(0, PER_PAGE), false);

      const gh = pagingGh(timeline);
      const info = await getLabelLastRemoveInfo(
        "owner/repo",
        1,
        "needs-human",
        gh.fn,
        cache,
      );

      assertEquals(info?.removedAt, Date.parse("2026-10-06T19:14:48Z") / 1000);
      assertEquals(gh.timelineCalls.length, 2);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// cleanStaleLabels
// ---------------------------------------------------------------------------

Deno.test(
  "cleanStaleLabels - a reopen on page 2 clears a stale failed label (Issue #3327)",
  async () => {
    const events: TimelineLabelEventJson[] = [
      labelEvent("labeled", "failed", "VibeCoderST", "2026-10-01T00:00:00Z"),
    ];
    for (let i = 0; events.length < PER_PAGE + 5; i++) events.push(filler(i));
    events.push({
      event: "reopened",
      actor: { login: "nleck" },
      created_at: "2026-10-06T00:00:00Z",
    });
    const gh = pagingGh(events);
    const edits: string[][] = [];
    const fn = (args: string[]) => {
      if (args[0] === "issue" && args[1] === "edit") edits.push(args);
      return gh.fn(args);
    };
    const issue: FilterableIssue = {
      number: 5,
      title: "Issue 5",
      url: "https://github.com/owner/repo/issues/5",
      author: "nleck",
      assignees: [],
      labels: ["failed"],
      createdAt: "2026-10-01T00:00:00Z",
      milestone: "",
    };

    const result = await cleanStaleLabels(
      [issue],
      "owner/repo",
      "failed",
      "failed-once",
      fn,
    );

    assertEquals(result[0]?.labels, [], "the reopen post-dates the label");
    assertEquals(edits.length, 1);
  },
);
