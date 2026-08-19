/**
 * Tests for the timeline cache (Issue #1673).
 *
 * Covers the four acceptance-criteria paths: cache hit (consecutive
 * calls within TTL skip the API), cache miss (first call populates
 * the cache), TTL expiry (stale entries are not used), and
 * invalidation (`addLabelToIssue` clears the entry).
 */

import { assertEquals } from "@std/assert";
import { TimelineCache } from "../lib/timeline_cache.ts";
import {
  fetchTimelineWithCache,
  getLabelLastAddInfo,
  hasIgnoreOpenPRsLabel,
  wasLabelAddedByAllowedAuthor,
} from "../lib/issue_query.ts";
import { addLabelToIssue } from "../lib/label_operations.ts";

/** Create an isolated cache backed by a fresh tmpdir. */
function makeCache(ttlSeconds = 300): { cache: TimelineCache; dir: string } {
  const dir = Deno.makeTempDirSync({ prefix: "timeline-cache-test-" });
  return { cache: new TimelineCache(ttlSeconds, dir), dir };
}

/** A gh stub that records every invocation it received. */
function recordingGh(timelineJson: string) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "api" && /\/timeline(\?|$)/.test(args[1] ?? "")) {
      return Promise.resolve(timelineJson);
    }
    return Promise.resolve("[]");
  };
  return { fn, calls };
}

const TIMELINE = JSON.stringify([
  {
    event: "labeled",
    label: { name: "work-on" },
    actor: { login: "alice" },
    created_at: "2024-05-01T10:00:00Z",
  },
]);

Deno.test("timeline_cache - read returns null on miss", async () => {
  const { cache, dir } = makeCache();
  try {
    assertEquals(await cache.read("owner/repo", 42), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("timeline_cache - write and read round-trips events", async () => {
  const { cache, dir } = makeCache();
  try {
    await cache.write("owner/repo", 42, [
      {
        event: "labeled",
        label: { name: "x" },
        actor: { login: "bob" },
        created_at: "2024-01-02T03:04:05Z",
      },
    ]);
    const got = await cache.read("owner/repo", 42);
    assertEquals(got?.length, 1);
    assertEquals(got?.[0]?.actor?.login, "bob");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("timeline_cache - expired entries return null", async () => {
  // ttl=0 means any entry is immediately expired (age >= 0 is not < 0).
  const { cache, dir } = makeCache(0);
  try {
    await cache.write("owner/repo", 1, [{ event: "labeled" }]);
    assertEquals(await cache.read("owner/repo", 1), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("timeline_cache - invalidate removes a single issue's entry", async () => {
  const { cache, dir } = makeCache();
  try {
    await cache.write("owner/repo", 1, [{ event: "labeled" }]);
    await cache.write("owner/repo", 2, [{ event: "labeled" }]);
    await cache.invalidate("owner/repo", 1);
    assertEquals(await cache.read("owner/repo", 1), null);
    assertEquals((await cache.read("owner/repo", 2))?.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "wasLabelAddedByAllowedAuthor - a trust-granting cache hit is re-confirmed against the API (Issue #3709)",
  async () => {
    // Behaviour change (Issue #3709, SEC-e70b8134af26): this test previously
    // asserted that the second call within TTL made no gh call at all. A cache
    // hit granting trust from a file under TMPDIR is exactly the escalation
    // path the finding describes, so a *granting* entry is now re-confirmed
    // live. The denial path — which dominates a scan — still short-circuits;
    // see the cached-denial test below and `timeline_cache_trust_test.ts`.
    const { cache, dir } = makeCache();
    try {
      const { fn, calls } = recordingGh(TIMELINE);

      const a = await wasLabelAddedByAllowedAuthor(
        "owner/repo",
        42,
        "work-on",
        ["alice"],
        fn,
        cache,
      );
      assertEquals(a, true);
      assertEquals(calls.length, 1);

      const b = await wasLabelAddedByAllowedAuthor(
        "owner/repo",
        42,
        "work-on",
        ["alice"],
        fn,
        cache,
      );
      assertEquals(b, true);
      assertEquals(
        calls.length,
        2,
        "a cache hit must never grant trust on its own",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "wasLabelAddedByAllowedAuthor - a cached denial is served from cache (no gh call)",
  async () => {
    // The Issue #1673 N+1 collapse survives Issue #3709: denial is the
    // dominant outcome during a scan and carries no escalation risk.
    const { cache, dir } = makeCache();
    try {
      const { fn, calls } = recordingGh(TIMELINE);

      // `alice` is not on this allowlist, so the first call denies and caches
      // the complete timeline.
      const a = await wasLabelAddedByAllowedAuthor(
        "owner/repo",
        42,
        "work-on",
        ["bob"],
        fn,
        cache,
      );
      assertEquals(a, false);
      assertEquals(calls.length, 1);

      const b = await wasLabelAddedByAllowedAuthor(
        "owner/repo",
        42,
        "work-on",
        ["bob"],
        fn,
        cache,
      );
      assertEquals(b, false);
      assertEquals(calls.length, 1, "a cached denial must not invoke gh");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "wasLabelAddedByAllowedAuthor - fleet-worker exclusion applies on the cache-hit path (Issue #3416)",
  async () => {
    // A completed cached timeline whose most-recent reserved-label add is a
    // fleet worker must not short-circuit to "trusted" — the cache-hit path
    // must apply the same fleet-worker exclusion as the API path.
    const { cache, dir } = makeCache();
    try {
      // Populate a completed cache entry: work-on added by a fleet worker.
      await cache.write(
        "owner/repo",
        42,
        [
          {
            event: "labeled",
            label: { name: "work-on" },
            actor: { login: "Vibecoderbot" },
            created_at: "2024-05-01T10:00:00Z",
          },
        ],
        true,
      );
      const { fn, calls } = recordingGh(TIMELINE);
      const result = await wasLabelAddedByAllowedAuthor(
        "owner/repo",
        42,
        "work-on",
        ["alice", "Vibecoderbot"], // fleet worker in allowed_authors
        fn,
        cache,
        ["Vibecoderbot"], // fleet worker logins
      );
      assertEquals(result, false, "fleet worker add must be untrusted");
      assertEquals(calls.length, 0, "completed cache entry must short-circuit");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "wasLabelAddedByAllowedAuthor - expired cache entry triggers a fresh gh call",
  async () => {
    const { cache, dir } = makeCache(0); // immediate expiry
    try {
      const { fn, calls } = recordingGh(TIMELINE);

      await wasLabelAddedByAllowedAuthor(
        "owner/repo",
        42,
        "work-on",
        ["alice"],
        fn,
        cache,
      );
      await wasLabelAddedByAllowedAuthor(
        "owner/repo",
        42,
        "work-on",
        ["alice"],
        fn,
        cache,
      );

      assertEquals(calls.length, 2, "expired cache must not be used");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "getLabelLastAddInfo - cache hit short-circuits the gh call",
  async () => {
    const { cache, dir } = makeCache();
    try {
      const { fn, calls } = recordingGh(TIMELINE);

      const a = await getLabelLastAddInfo(
        "owner/repo",
        42,
        "work-on",
        fn,
        cache,
      );
      assertEquals(a?.addedBy, "alice");
      assertEquals(calls.length, 1);

      const b = await getLabelLastAddInfo(
        "owner/repo",
        42,
        "work-on",
        fn,
        cache,
      );
      assertEquals(b?.addedBy, "alice");
      assertEquals(calls.length, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "addLabelToIssue - invalidates cached timeline so the next read is a miss",
  async () => {
    const { cache, dir } = makeCache();
    try {
      // Pre-populate the cache with a stale timeline.
      await cache.write("owner/repo", 42, [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2024-05-01T10:00:00Z",
        },
      ]);

      const ghCommandFn = (args: string[]): Promise<string> => {
        if (args[0] === "api" && args[1] === "-X") {
          // gh api -X POST /repos/.../labels — succeeds silently.
          return Promise.resolve("[]");
        }
        return Promise.resolve("[]");
      };

      // Issue #2382: pick a label on the worker allowlist; the new
      // Rule-of-Two guard rejects forbidden labels (e.g. `needs-revision`)
      // before they reach the cache-invalidation path.
      const result = await addLabelToIssue(
        "owner/repo",
        42,
        "needs-human",
        { ghCommandFn, timelineCache: cache },
      );
      assertEquals(result.ok, true);

      // After invalidation, the cache must miss.
      assertEquals(await cache.read("owner/repo", 42), null);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "timeline_cache - readComplete only returns fully-paginated entries (Issue #3296)",
  async () => {
    const { cache, dir } = makeCache();
    try {
      const one = [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2024-05-01T10:00:00Z",
        },
      ];

      // Partial write (page-1-only): read sees events, readComplete does not.
      await cache.write("owner/repo", 1, one, false);
      assertEquals((await cache.read("owner/repo", 1))?.length, 1);
      assertEquals(await cache.readComplete("owner/repo", 1), null);

      // Complete write: both read and readComplete return events.
      await cache.write("owner/repo", 2, one, true);
      assertEquals((await cache.read("owner/repo", 2))?.length, 1);
      assertEquals((await cache.readComplete("owner/repo", 2))?.length, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "wasLabelAddedByAllowedAuthor - partial cache entry is not trusted; re-paginates (Issue #3296)",
  async () => {
    const { cache, dir } = makeCache();
    try {
      // A truncated page-1-only slice showing ONLY the old trusted `work-on`
      // add — exactly what fetchTimelineWithCache writes after reading page 1.
      // Marked partial (complete=false).
      await cache.write(
        "owner/repo",
        42,
        [
          {
            event: "labeled",
            label: { name: "work-on" },
            actor: { login: "alice" },
            created_at: "2024-05-01T10:00:00Z",
          },
        ],
        false,
      );

      // The genuine full timeline: an untrusted actor removed then re-added
      // `work-on`, so the most-recent add is untrusted (beyond page 1 in the
      // real world; represented here as the last `labeled` event).
      const fullTimeline = JSON.stringify([
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2024-05-01T10:00:00Z",
        },
        {
          event: "unlabeled",
          label: { name: "work-on" },
          actor: { login: "mallory" },
          created_at: "2024-05-02T10:00:00Z",
        },
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "mallory" },
          created_at: "2024-05-02T10:05:00Z",
        },
      ]);
      const { fn, calls } = recordingGh(fullTimeline);

      const result = await wasLabelAddedByAllowedAuthor(
        "owner/repo",
        42,
        "work-on",
        ["alice"],
        fn,
        cache,
      );

      // The stale trusted add in the partial slice must NOT be honoured; the
      // gate re-paginates and sees the untrusted most-recent add.
      assertEquals(
        result,
        false,
        "partial cache entry must not honour the stale trusted add",
      );
      assertEquals(
        calls.length,
        1,
        "trust gate must re-paginate (call gh) on a partial cache entry",
      );

      // The paginated read rewrote the cache as complete, so a second call is
      // served from the cache without another gh call — and still fails closed.
      const second = await wasLabelAddedByAllowedAuthor(
        "owner/repo",
        42,
        "work-on",
        ["alice"],
        fn,
        cache,
      );
      assertEquals(second, false);
      assertEquals(
        calls.length,
        1,
        "a complete cache entry must short-circuit the second call",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "wasLabelAddedByAllowedAuthor - cache poisoned by fetchTimelineWithCache page-1 read re-paginates (Issue #3296)",
  async () => {
    const { cache, dir } = makeCache();
    try {
      // Simulate cleanStaleLabels' read: fetchTimelineWithCache reads only
      // page 1 (the oldest-100 slice) and writes a PARTIAL entry to the shared
      // cache. Here the page-1 slice shows only the old trusted work-on add.
      const partialPage1 = JSON.stringify([
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2024-05-01T10:00:00Z",
        },
      ]);
      await fetchTimelineWithCache(
        "owner/repo",
        42,
        recordingGh(partialPage1).fn,
        cache,
      );

      // The shared cache now holds a partial slice: read() sees it, but the
      // trust gate's readComplete() must treat it as a miss.
      assertEquals((await cache.read("owner/repo", 42))?.length, 1);
      assertEquals(await cache.readComplete("owner/repo", 42), null);

      // The genuine timeline has the untrusted actor holding the most-recent
      // work-on add.
      const fullTimeline = JSON.stringify([
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2024-05-01T10:00:00Z",
        },
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "mallory" },
          created_at: "2024-05-02T10:05:00Z",
        },
      ]);
      const result = await wasLabelAddedByAllowedAuthor(
        "owner/repo",
        42,
        "work-on",
        ["alice"],
        recordingGh(fullTimeline).fn,
        cache,
      );
      assertEquals(
        result,
        false,
        "the stale trusted add in the partial cache slice must not be honoured",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "hasIgnoreOpenPRsLabel - reuses cached timeline for the author check",
  async () => {
    const { cache, dir } = makeCache();
    try {
      const calls: string[][] = [];
      const fn = (args: string[]): Promise<string> => {
        calls.push([...args]);
        if (args[0] === "issue" && args[1] === "view") {
          return Promise.resolve(
            JSON.stringify({ labels: [{ name: "ignore-open-prs" }] }),
          );
        }
        if (args[0] === "api" && /\/timeline(\?|$)/.test(args[1] ?? "")) {
          return Promise.resolve(
            JSON.stringify([
              {
                event: "labeled",
                label: { name: "ignore-open-prs" },
                actor: { login: "alice" },
                created_at: "2024-05-01T10:00:00Z",
              },
            ]),
          );
        }
        return Promise.resolve("[]");
      };

      const a = await hasIgnoreOpenPRsLabel(
        "owner/repo",
        42,
        "ignore-open-prs",
        ["alice"],
        fn,
        cache,
      );
      assertEquals(a, true);
      const timelineCallsAfterFirst = calls.filter(
        (c) => c[0] === "api" && /\/timeline(\?|$)/.test(c[1] ?? ""),
      ).length;
      assertEquals(timelineCallsAfterFirst, 1);

      // Second call: issue view still happens (label list is not cached
      // here). Behaviour change (Issue #3709, SEC-e70b8134af26): the cached
      // timeline says the label was added by a *trusted* author, and a cache
      // hit may no longer grant trust on its own, so the timeline is
      // re-confirmed against the API rather than served from the cache.
      const b = await hasIgnoreOpenPRsLabel(
        "owner/repo",
        42,
        "ignore-open-prs",
        ["alice"],
        fn,
        cache,
      );
      assertEquals(b, true);

      const timelineCallsAfterSecond = calls.filter(
        (c) => c[0] === "api" && /\/timeline(\?|$)/.test(c[1] ?? ""),
      ).length;
      assertEquals(
        timelineCallsAfterSecond,
        2,
        "a trust-granting cached timeline must be re-confirmed live",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
