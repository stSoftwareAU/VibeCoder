/**
 * Tests for the milestone-health command outcome (Issue #4106).
 *
 * A repo whose milestones or issue lists could not be read must make the
 * command fail, never report success.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMilestoneHealthCommandResult,
  runMilestoneHealth,
} from "../commands/milestone_health.ts";
import { clearDefaultBranchMemoryCache } from "../lib/shell_helpers.ts";
import type { WorkerConfig } from "../types.ts";
import {
  formatMilestoneHealthReport,
  type MilestoneHealthReport,
} from "../lib/milestone_health.ts";

const CLEAN_REPORT: MilestoneHealthReport = {
  repos: [{ repo: "owner/good", milestones: [] }],
};

const FAILED_REPORT: MilestoneHealthReport = {
  repos: [{
    repo: "owner/bad",
    milestones: [],
    error: "gh api repos/owner/bad/milestones failed: HTTP 500",
  }],
};

Deno.test("buildMilestoneHealthCommandResult - clean report succeeds with the formatted text (Issue #4106)", () => {
  const result = buildMilestoneHealthCommandResult(CLEAN_REPORT);
  assertEquals(result.success, true);
  assertEquals(result.data, CLEAN_REPORT);
  assertStringIncludes(result.message, "Repository: owner/good");
  assertStringIncludes(result.message, "No active milestones");
  assertEquals(result.message, formatMilestoneHealthReport(CLEAN_REPORT));
});

Deno.test("buildMilestoneHealthCommandResult - a repo with an error fails and names the failure (Issue #4106)", () => {
  const result = buildMilestoneHealthCommandResult(FAILED_REPORT);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Failed to read milestones");
  assertStringIncludes(result.message, "owner/bad");
  assertEquals(result.data, FAILED_REPORT);
});

Deno.test("buildMilestoneHealthCommandResult - a mixed report with one errored repo fails (Issue #4106)", () => {
  const mixed: MilestoneHealthReport = {
    repos: [...CLEAN_REPORT.repos, ...FAILED_REPORT.repos],
  };
  const result = buildMilestoneHealthCommandResult(mixed);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Repository: owner/good");
  assertStringIncludes(result.message, "Failed to read milestones");
});

/** Run `execute` against a fake gh with a throwaway default-branch cache. */
async function executeWithGh(
  ghCommandFn: (args: string[]) => Promise<string>,
) {
  const dir = await Deno.makeTempDir({ prefix: "milestone-health-cmd-" });
  clearDefaultBranchMemoryCache();
  try {
    return await runMilestoneHealth(
      { repos: ["org/repo"] } as unknown as WorkerConfig,
      { ghCommandFn, defaultBranchCachePath: `${dir}/cache.json` },
    );
  } finally {
    clearDefaultBranchMemoryCache();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("runMilestoneHealth - a failed milestone list fails the command (Issue #4106)", async () => {
  const result = await executeWithGh((args) => {
    const key = args.join(" ");
    if (key.includes("repos/org/repo/milestones")) {
      return Promise.reject(new Error("HTTP 500"));
    }
    if (key.includes(".default_branch")) return Promise.resolve("main");
    return Promise.resolve("[]");
  });
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "1 repo(s) failed milestone health");
  assertStringIncludes(result.message, "org/repo");
  assertStringIncludes(result.message, "Failed to read milestones");
  assertEquals(result.data?.repos[0]?.repo, "org/repo");
});

Deno.test("runMilestoneHealth - an empty healthy repo succeeds with the report (Issue #4106)", async () => {
  const result = await executeWithGh((args) => {
    const key = args.join(" ");
    if (key.includes(".default_branch")) return Promise.resolve("main");
    return Promise.resolve("[]");
  });
  assertEquals(result.success, true);
  assertStringIncludes(result.message, "Repository: org/repo");
  assertStringIncludes(result.message, "No active milestones");
  assertEquals(result.data?.repos.length, 1);
});
