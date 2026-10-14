/**
 * Tests for `buildIssueRoutingContext` (Issue #3691).
 */

import { assertEquals } from "@std/assert";
import {
  buildIssueRoutingContext,
  ISSUE_ROUTING_RECENTLY_CLOSED_DAYS,
  VIBE_CODER_REPO,
} from "../lib/issue_routing_context.ts";
import { createLogger } from "../lib/logger.ts";

const logger = createLogger({ write: () => {} });

function depsWith(repos: string[]) {
  return {
    config: { loadConfig: () => Promise.resolve({ repos } as never) },
  };
}

Deno.test("issue routing context - monitored repos are allowed and the target repo is added when absent", async () => {
  const ctx = await buildIssueRoutingContext({
    targetRepo: "org/other",
    dryRun: false,
    deps: depsWith(["org/a", "org/b"]),
    logger,
    nowMs: 42,
  });
  assertEquals(ctx.allowedRepos, ["org/a", "org/b", "org/other"]);
  assertEquals(ctx.vibeCoderRepo, VIBE_CODER_REPO);
  assertEquals(ctx.recentlyClosedDays, ISSUE_ROUTING_RECENTLY_CLOSED_DAYS);
  assertEquals(ctx.nowMs, 42);
  assertEquals(ctx.dryRun, false);
});

Deno.test("issue routing context - the target repo is not duplicated, compared case-insensitively", async () => {
  const ctx = await buildIssueRoutingContext({
    targetRepo: "ORG/A",
    dryRun: true,
    deps: depsWith(["org/a"]),
    logger,
    nowMs: 1,
  });
  assertEquals(ctx.allowedRepos, ["org/a"]);
  assertEquals(ctx.dryRun, true);
});

Deno.test("issue routing context - a failing loadConfig falls back to allowing only the target repo", async () => {
  const ctx = await buildIssueRoutingContext({
    targetRepo: "org/only",
    dryRun: false,
    deps: {
      config: { loadConfig: () => Promise.reject(new Error("no config")) },
    },
    logger,
    nowMs: 1,
  });
  assertEquals(ctx.allowedRepos, ["org/only"]);
});
