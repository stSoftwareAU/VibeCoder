/**
 * Tests for `fetchIssueLabels` per-issue label cache (Issue #1787).
 *
 * Covers cache hit, cache miss, and parse-failure fail-safe.
 */

import { assertEquals } from "@std/assert";
import { IssueCache } from "../lib/issue_cache.ts";
import { fetchIssueLabels, hasIgnoreOpenPRsLabel } from "../lib/issue_query.ts";

function makeCache(ttlSeconds = 600): { cache: IssueCache; dir: string } {
  const dir = Deno.makeTempDirSync({ prefix: "issue-labels-cache-test-" });
  return { cache: new IssueCache(dir, ttlSeconds), dir };
}

const LABELS_JSON = JSON.stringify({
  labels: [{ name: "ignore-open-prs" }, { name: "low-priority" }],
});

function recordingGh(opts?: { issueViewJson?: string; timelineJson?: string }) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(opts?.issueViewJson ?? LABELS_JSON);
    }
    if (args[0] === "api" && /\/timeline(\?|$)/.test(args[1] ?? "")) {
      return Promise.resolve(opts?.timelineJson ?? "[]");
    }
    return Promise.resolve("");
  };
  const issueViewCalls = (): number =>
    calls.filter((a) => a[0] === "issue" && a[1] === "view").length;
  return { fn, calls, issueViewCalls };
}

Deno.test("fetchIssueLabels — cold call hits gh and warm call hits cache", async () => {
  const { cache, dir } = makeCache();
  try {
    const gh = recordingGh();

    const r1 = await fetchIssueLabels("owner/repo", 42, cache, gh.fn);
    assertEquals(r1, ["ignore-open-prs", "low-priority"]);
    assertEquals(gh.issueViewCalls(), 1);

    // Warm — no extra gh call.
    const r2 = await fetchIssueLabels("owner/repo", 42, cache, gh.fn);
    assertEquals(r2, ["ignore-open-prs", "low-priority"]);
    assertEquals(gh.issueViewCalls(), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchIssueLabels — returns null on parse failure", async () => {
  const { cache, dir } = makeCache();
  try {
    const gh = recordingGh({ issueViewJson: "not valid json" });
    const r = await fetchIssueLabels("owner/repo", 42, cache, gh.fn);
    assertEquals(r, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "hasIgnoreOpenPRsLabel — second call within TTL skips the issue-view call",
  async () => {
    const { cache, dir } = makeCache();
    try {
      const gh = recordingGh({
        issueViewJson: LABELS_JSON,
        timelineJson: JSON.stringify([
          {
            event: "labeled",
            label: { name: "ignore-open-prs" },
            actor: { login: "alice" },
            created_at: "2024-01-01T00:00:00Z",
          },
        ]),
      });

      const r1 = await hasIgnoreOpenPRsLabel(
        "owner/repo",
        42,
        "ignore-open-prs",
        ["alice"],
        gh.fn,
        undefined,
        cache,
      );
      assertEquals(r1, true);
      assertEquals(gh.issueViewCalls(), 1);

      const r2 = await hasIgnoreOpenPRsLabel(
        "owner/repo",
        42,
        "ignore-open-prs",
        ["alice"],
        gh.fn,
        undefined,
        cache,
      );
      assertEquals(r2, true);
      // Cache hit — no extra issue-view call.
      assertEquals(gh.issueViewCalls(), 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
