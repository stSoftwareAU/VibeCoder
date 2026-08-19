/**
 * Regression tests for the cache-backed trust and mutation decisions
 * (Issue #3709).
 *
 * Covers:
 *  - SEC-e70b8134af26: a cache hit may deny trust but must never grant it,
 *    and a cache directory another account could have written to is not used
 *    at all.
 *  - SEC-c41e97b60238: the untrusted-`work-on` strip reads the timeline
 *    exhaustively, exactly like the sibling trust gate.
 */

import { assertEquals } from "@std/assert";
import { TimelineCache } from "../lib/timeline_cache.ts";
import { wasLabelAddedByAllowedAuthor } from "../lib/issue_query.ts";
import { stripUntrustedWorkOnLabel } from "../lib/strip_untrusted_work_on.ts";
import type { Logger } from "../types.ts";

function silentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** Extract the requested page number from a `gh api .../timeline?...` path. */
function requestedPage(path: string): number {
  const match = /[?&]page=(\d+)/.exec(path);
  return match ? Number(match[1]) : 1;
}

/** A trusted-looking `labeled` event an attacker could forge into a cache. */
function labeledEvent(login: string, createdAt = "2024-05-01T10:00:00Z") {
  return {
    event: "labeled",
    label: { name: "work-on" },
    actor: { login },
    created_at: createdAt,
  };
}

Deno.test(
  "issue_query - a forged trusted cache entry does not grant trust without an API confirmation (Issue #3709)",
  async () => {
    // An attacker who can write the cache file plants a `work-on` add
    // attributed to a trusted author. The live timeline shows the truth:
    // `mallory` applied it. The gate must confirm against the API and deny.
    const dir = await Deno.makeTempDir({ prefix: "timeline-trust-test-" });
    try {
      const cache = new TimelineCache(300, dir);
      await cache.write("owner/repo", 42, [labeledEvent("alice")], true);

      let apiCalls = 0;
      const gh = (_args: string[]): Promise<string> => {
        apiCalls++;
        return Promise.resolve(JSON.stringify([labeledEvent("mallory")]));
      };

      const result = await wasLabelAddedByAllowedAuthor(
        "owner/repo",
        42,
        "work-on",
        ["alice"],
        gh,
        cache,
      );
      assertEquals(result, false, "trust must come from the API, not a cache");
      assertEquals(apiCalls, 1, "a trust-granting cache hit must be confirmed");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "issue_query - a genuine trusted add is still granted after the API confirms it (Issue #3709)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "timeline-trust-test-" });
    try {
      const cache = new TimelineCache(300, dir);
      await cache.write("owner/repo", 42, [labeledEvent("alice")], true);
      const gh = (_args: string[]): Promise<string> =>
        Promise.resolve(JSON.stringify([labeledEvent("alice")]));

      assertEquals(
        await wasLabelAddedByAllowedAuthor(
          "owner/repo",
          42,
          "work-on",
          ["alice"],
          gh,
          cache,
        ),
        true,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "issue_query - a cached denial still short-circuits the API (Issue #3709)",
  async () => {
    // The N+1 collapse from Issue #1673 must survive: denial is the dominant
    // outcome during a scan and carries no escalation risk.
    const dir = await Deno.makeTempDir({ prefix: "timeline-trust-test-" });
    try {
      const cache = new TimelineCache(300, dir);
      await cache.write("owner/repo", 42, [labeledEvent("mallory")], true);
      let apiCalls = 0;
      const gh = (_args: string[]): Promise<string> => {
        apiCalls++;
        return Promise.resolve("[]");
      };

      assertEquals(
        await wasLabelAddedByAllowedAuthor(
          "owner/repo",
          42,
          "work-on",
          ["alice"],
          gh,
          cache,
        ),
        false,
      );
      assertEquals(apiCalls, 0, "a cached denial needs no API call");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "timeline_cache - a group/other-accessible cache directory is not read (Issue #3709)",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "timeline-trust-test-" });
    try {
      // Seed a valid entry, then open the directory up as an attacker could.
      const seeder = new TimelineCache(300, dir);
      await seeder.write("owner/repo", 42, [labeledEvent("mallory")], true);
      await Deno.chmod(dir, 0o777);
      if ((await Deno.stat(dir)).mode === null) return; // no modes on platform

      const cache = new TimelineCache(300, dir);
      assertEquals(
        await cache.read("owner/repo", 42),
        null,
        "an unsafe cache directory must behave as a permanent miss",
      );
      assertEquals(await cache.readComplete("owner/repo", 42), null);
    } finally {
      await Deno.chmod(dir, 0o700);
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "strip_untrusted_work_on - the strip decision reads the timeline exhaustively (Issue #3709)",
  async () => {
    // Page 1 shows only a stale untrusted add; page 2 shows the trusted
    // re-add that is the genuine most-recent event. A page-1-only read would
    // strip a label a trusted author has re-applied.
    const page1 = Array.from(
      { length: 100 },
      (_, i) =>
        labeledEvent(
          "mallory",
          `2024-05-01T10:00:${String(i % 60).padStart(2, "0")}Z`,
        ),
    );
    const page2 = [labeledEvent("alice", "2024-06-01T10:00:00Z")];

    const mutations: string[][] = [];
    const gh = (args: string[]): Promise<string> => {
      const path = args[1] ?? "";
      if (args[0] === "api" && path.includes("/timeline")) {
        return Promise.resolve(
          JSON.stringify(requestedPage(path) === 1 ? page1 : page2),
        );
      }
      mutations.push([...args]);
      return Promise.resolve("[]");
    };

    const stripped = await stripUntrustedWorkOnLabel({
      repo: "owner/repo",
      issueNumber: 42,
      workOnLabel: "work-on",
      allowedAuthors: ["alice"],
      ghFn: gh,
      logger: silentLogger(),
    });

    assertEquals(stripped, false, "the most-recent adder is trusted");
    assertEquals(mutations.length, 0, "no comment and no label removal");
  },
);

Deno.test(
  "strip_untrusted_work_on - still strips when the exhaustive read confirms an untrusted adder (Issue #3709)",
  async () => {
    const page1 = Array.from(
      { length: 100 },
      () => labeledEvent("alice", "2024-05-01T10:00:00Z"),
    );
    const page2 = [labeledEvent("mallory", "2024-06-01T10:00:00Z")];

    const mutations: string[][] = [];
    const gh = (args: string[]): Promise<string> => {
      const path = args[1] ?? "";
      if (args[0] === "api" && path.includes("/timeline")) {
        return Promise.resolve(
          JSON.stringify(requestedPage(path) === 1 ? page1 : page2),
        );
      }
      if (args[0] === "api" && path.includes("/comments")) {
        return Promise.resolve("[]");
      }
      mutations.push([...args]);
      return Promise.resolve("[]");
    };

    const stripped = await stripUntrustedWorkOnLabel({
      repo: "owner/repo",
      issueNumber: 42,
      workOnLabel: "work-on",
      allowedAuthors: ["alice"],
      ghFn: gh,
      logger: silentLogger(),
    });

    assertEquals(stripped, true);
    assertEquals(
      mutations.some((m) => m.includes("--remove-label")),
      true,
      "the untrusted label must be removed",
    );
  },
);
