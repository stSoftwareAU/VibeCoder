/**
 * Tests for the milestone-health command outcome (Issue #4106).
 *
 * A repo whose milestones or issue lists could not be read must make the
 * command fail, never report success.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildMilestoneHealthCommandResult } from "../commands/milestone_health.ts";
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
