/**
 * Tests for idle_task_milestone.ts (Issue #1985).
 *
 * Covers the per-template, per-repo milestone helper used by the
 * idle-task framework. Each filed idle-task issue is grouped under a
 * single open milestone named `idle-task: <template>` so operators can
 * track a batch of idle-tasks of the same template to completion.
 *
 * Test coverage:
 *   - Happy path: existing open milestone is returned without a POST.
 *   - Happy path: no existing milestone — POST is invoked and the new
 *     milestone is returned.
 *   - Slug validation rejects uppercase or underscored templates.
 *   - `buildIdleTaskMilestoneTitle` returns the canonical title.
 *   - GH listing failure is wrapped, not silently ignored.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  buildIdleTaskMilestoneTitle,
  ensureIdleTaskMilestone,
} from "../lib/idle_task_milestone.ts";

// ---------------------------------------------------------------------------
// buildIdleTaskMilestoneTitle
// ---------------------------------------------------------------------------

Deno.test("buildIdleTaskMilestoneTitle — returns canonical title", () => {
  assertEquals(
    buildIdleTaskMilestoneTitle("security-scan"),
    "idle-task: security-scan",
  );
});

// ---------------------------------------------------------------------------
// ensureIdleTaskMilestone — existing milestone
// ---------------------------------------------------------------------------

Deno.test(
  "ensureIdleTaskMilestone — returns existing milestone without POST",
  async () => {
    const calls: string[][] = [];
    const ghCommandFn = (args: string[]): Promise<string> => {
      calls.push(args);
      // First call is the listing — return an array containing the
      // milestone we're looking for.
      return Promise.resolve(JSON.stringify([
        { number: 7, title: "idle-task: maintainability" },
        { number: 42, title: "idle-task: security-scan" },
        { number: 100, title: "some other milestone" },
      ]));
    };

    const result = await ensureIdleTaskMilestone({
      repo: "stSoftwareAU/VibeCoder",
      template: "security-scan",
      ghCommandFn,
    });

    assertEquals(result, {
      number: 42,
      title: "idle-task: security-scan",
    });
    assertEquals(calls.length, 1);
    // Listing call only — no POST.
    assertEquals(calls[0]?.[0], "api");
    assertStringIncludes(
      calls[0]?.join(" ") ?? "",
      "repos/stSoftwareAU/VibeCoder/milestones",
    );
    assertStringIncludes(calls[0]?.join(" ") ?? "", "state=open");
  },
);

// ---------------------------------------------------------------------------
// ensureIdleTaskMilestone — creation path
// ---------------------------------------------------------------------------

Deno.test(
  "ensureIdleTaskMilestone — creates new milestone when none exists",
  async () => {
    const calls: string[][] = [];
    const ghCommandFn = (args: string[]): Promise<string> => {
      calls.push(args);
      if (calls.length === 1) {
        // Listing returns an empty array.
        return Promise.resolve("[]");
      }
      // POST response — a newly created milestone object.
      return Promise.resolve(JSON.stringify({
        number: 99,
        title: "idle-task: security-scan",
      }));
    };

    const result = await ensureIdleTaskMilestone({
      repo: "stSoftwareAU/VibeCoder",
      template: "security-scan",
      ghCommandFn,
    });

    assertEquals(result, {
      number: 99,
      title: "idle-task: security-scan",
    });
    assertEquals(calls.length, 2);

    const postArgs = calls[1] ?? [];
    assertEquals(postArgs[0], "api");
    // Must use POST.
    assertEquals(postArgs.includes("POST"), true);
    // Title field uses canonical helper output.
    const joined = postArgs.join(" ");
    assertStringIncludes(joined, "title=idle-task: security-scan");
    // Description present.
    assertStringIncludes(joined, "description=");
    assertStringIncludes(joined, "security-scan");
    // POST hits the right endpoint.
    assertStringIncludes(
      joined,
      "repos/stSoftwareAU/VibeCoder/milestones",
    );
  },
);

// ---------------------------------------------------------------------------
// ensureIdleTaskMilestone — slug validation
// ---------------------------------------------------------------------------

Deno.test(
  "ensureIdleTaskMilestone — rejects uppercase template slug",
  async () => {
    await assertRejects(
      () =>
        ensureIdleTaskMilestone({
          repo: "stSoftwareAU/VibeCoder",
          template: "Security-Scan",
          ghCommandFn: () =>
            Promise.reject(new Error("ghCommandFn should not be called")),
        }),
      Error,
      "invalid template name",
    );
  },
);

Deno.test(
  "ensureIdleTaskMilestone — rejects underscored template slug",
  async () => {
    await assertRejects(
      () =>
        ensureIdleTaskMilestone({
          repo: "stSoftwareAU/VibeCoder",
          template: "security_scan",
          ghCommandFn: () =>
            Promise.reject(new Error("ghCommandFn should not be called")),
        }),
      Error,
      "invalid template name",
    );
  },
);

// ---------------------------------------------------------------------------
// ensureIdleTaskMilestone — listing failure surfaces wrapped error
// ---------------------------------------------------------------------------

Deno.test(
  "ensureIdleTaskMilestone — surfaces wrapped error when listing fails",
  async () => {
    let postCalled = false;
    const ghCommandFn = (args: string[]): Promise<string> => {
      // Reject the listing call.
      const joined = args.join(" ");
      if (joined.includes("state=open")) {
        return Promise.reject(new Error("network down"));
      }
      postCalled = true;
      return Promise.resolve("{}");
    };

    await assertRejects(
      () =>
        ensureIdleTaskMilestone({
          repo: "stSoftwareAU/VibeCoder",
          template: "security-scan",
          ghCommandFn,
        }),
      Error,
      "list milestones",
    );
    assertEquals(postCalled, false);
  },
);
