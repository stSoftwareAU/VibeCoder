/**
 * Tests for the milestone activity gate (Issue #1488).
 *
 * The gate decides — from the cheap REST `closed_issues` count the
 * milestone pass already fetches — whether the expensive closed-issue
 * query is worth making at all.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideMilestoneQuery,
  loadMilestoneActivity,
  milestoneActivityKey,
  milestoneActivityPath,
  type MilestoneActivityState,
  recordMilestoneActivity,
  saveMilestoneActivity,
} from "../lib/milestone_activity_gate.ts";

// ---------------------------------------------------------------------------
// decideMilestoneQuery
// ---------------------------------------------------------------------------

Deno.test("decideMilestoneQuery - no closed issues means no query and not active", () => {
  assertEquals(decideMilestoneQuery(undefined, 0), {
    query: false,
    active: false,
  });
});

Deno.test("decideMilestoneQuery - first observation must query", () => {
  assertEquals(decideMilestoneQuery(undefined, 3), {
    query: true,
    active: false,
  });
});

Deno.test("decideMilestoneQuery - unchanged count reuses the previous verdict", () => {
  assertEquals(
    decideMilestoneQuery({ closedIssues: 3, active: true }, 3),
    { query: false, active: true },
  );
  assertEquals(
    decideMilestoneQuery({ closedIssues: 3, active: false }, 3),
    { query: false, active: false },
  );
});

Deno.test("decideMilestoneQuery - any change invalidates, in either direction", () => {
  // Gained a closed issue.
  assertEquals(
    decideMilestoneQuery({ closedIssues: 3, active: true }, 4),
    { query: true, active: false },
  );
  // Lost one (reopened, or moved out of the milestone).
  assertEquals(
    decideMilestoneQuery({ closedIssues: 3, active: true }, 2),
    { query: true, active: false },
  );
});

Deno.test("decideMilestoneQuery - an absent count cannot gate anything", () => {
  assertEquals(
    decideMilestoneQuery({ closedIssues: 3, active: true }, undefined),
    { query: true, active: false },
  );
});

// ---------------------------------------------------------------------------
// recordMilestoneActivity
// ---------------------------------------------------------------------------

Deno.test("recordMilestoneActivity - stores the verdict and marks state dirty", () => {
  const state: MilestoneActivityState = { observations: {}, dirty: false };
  recordMilestoneActivity(state, "owner/repo", 7, 2, true);
  assertEquals(state.dirty, true);
  assertEquals(state.observations[milestoneActivityKey("owner/repo", 7)], {
    closedIssues: 2,
    active: true,
  });
});

Deno.test("recordMilestoneActivity - an unchanged observation leaves state clean", () => {
  const state: MilestoneActivityState = {
    observations: { "owner/repo|7": { closedIssues: 2, active: true } },
    dirty: false,
  };
  recordMilestoneActivity(state, "owner/repo", 7, 2, true);
  assertEquals(state.dirty, false);
});

Deno.test("recordMilestoneActivity - an absent count records nothing", () => {
  const state: MilestoneActivityState = { observations: {}, dirty: false };
  recordMilestoneActivity(state, "owner/repo", 7, undefined, true);
  assertEquals(state.observations, {});
  assertEquals(state.dirty, false);
});

Deno.test("milestoneActivityPath - sits beside the other sync state", () => {
  assertEquals(
    milestoneActivityPath("/work"),
    "/work/milestone_activity.json",
  );
});

Deno.test("loadMilestoneActivity - round-trips through the work dir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = milestoneActivityPath(dir);
    await saveMilestoneActivity(path, {
      "owner/repo|1": { closedIssues: 4, active: true },
    });
    const loaded = await loadMilestoneActivity(path);
    assertEquals(loaded, { "owner/repo|1": { closedIssues: 4, active: true } });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadMilestoneActivity - a missing file reads as empty", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await loadMilestoneActivity(`${dir}/absent.json`), {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadMilestoneActivity - corrupt entries are discarded, not repaired", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = milestoneActivityPath(dir);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        "owner/repo|1": { closedIssues: 4, active: true },
        "owner/repo|2": { closedIssues: "many", active: true },
        "owner/repo|3": { closedIssues: -1, active: true },
        "owner/repo|4": { closedIssues: 2, active: "yes" },
        "owner/repo|5": null,
      }),
    );
    const loaded = await loadMilestoneActivity(path);
    assertEquals(loaded, { "owner/repo|1": { closedIssues: 4, active: true } });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadMilestoneActivity - a corrupt file is reported loudly, not silently emptied", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = milestoneActivityPath(dir);
    await Deno.writeTextFile(path, "{not json");
    const warnings: string[] = [];
    assertEquals(
      await loadMilestoneActivity(path, (m) => warnings.push(m)),
      {},
    );
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "[STATE_LOAD_FAILURE]");
    assertStringIncludes(warnings[0]!, path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadMilestoneActivity - a missing file is not reported as a fault", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const warnings: string[] = [];
    assertEquals(
      await loadMilestoneActivity(
        `${dir}/absent.json`,
        (m) => warnings.push(m),
      ),
      {},
    );
    assertEquals(warnings, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
