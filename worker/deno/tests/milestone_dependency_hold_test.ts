/**
 * Tests for the milestone declared-dependency hold (Issue #3014).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  describePendingDependency,
  findPendingMilestoneDependencies,
  PENDING_DEPENDENCIES_BLOCK_MARKER,
  renderPendingDependenciesBlockComment,
  renderPendingDependenciesSection,
} from "../lib/milestone_dependency_hold.ts";
import type { PendingDependency } from "../lib/milestone_dependency_hold.ts";

// ---------------------------------------------------------------------------
// findPendingMilestoneDependencies - happy paths
// ---------------------------------------------------------------------------

Deno.test("findPendingMilestoneDependencies - classifies open, unmerged-milestone and satisfied deps", async () => {
  const members = [
    { number: 100, body: "Depends on #200" },
    { number: 101, body: "Depends on #201" },
    { number: 102, body: "Depends on #202" },
    { number: 103, body: "Depends on #203" },
    { number: 104, body: "Depends on #100" }, // same-milestone member, satisfied
    { number: 105, body: "Depends on #105" }, // self-reference ignored
  ];

  const deps: Record<number, unknown> = {
    200: { state: "open" },
    201: {
      state: "closed",
      milestone: { number: 9, title: "Other", state: "open" },
    },
    202: { state: "closed", milestone: null },
    203: {
      state: "closed",
      milestone: { number: 8, title: "Done", state: "closed" },
    },
  };

  let listCalls = 0;
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      listCalls++;
      return JSON.stringify(members);
    }
    const match = key.match(/\/issues\/(\d+)$/);
    if (match) {
      const num = Number(match[1]);
      return JSON.stringify(deps[num]);
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findPendingMilestoneDependencies({
    repo: "owner/repo",
    milestoneNumber: 7,
    ghCommandFn: ghFn,
  });

  assertEquals(listCalls, 1);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, [
    { issueNumber: 100, dependencyNumber: 200, reason: "open" },
    {
      issueNumber: 101,
      dependencyNumber: 201,
      reason: "unmerged-milestone",
      milestoneTitle: "Other",
    },
  ]);
});

Deno.test("findPendingMilestoneDependencies - memoises repeated dependency lookups", async () => {
  const members = [
    { number: 1, body: "Depends on #999" },
    { number: 2, body: "Depends on #999" },
  ];

  let depLookups = 0;
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify(members);
    }
    if (key.includes("/issues/999")) {
      depLookups++;
      return JSON.stringify({ state: "open" });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findPendingMilestoneDependencies({
    repo: "owner/repo",
    milestoneNumber: 1,
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, true);
  assertEquals(depLookups, 1);
  if (!result.ok) return;
  assertEquals(result.value.length, 2);
});

Deno.test("findPendingMilestoneDependencies - parses concatenated paginated pages", async () => {
  const page1 = JSON.stringify([{ number: 1, body: "Depends on #50" }]);
  const page2 = JSON.stringify([{ number: 2, body: "no deps here" }]);

  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return page1 + page2;
    }
    if (key.includes("/issues/50")) {
      return JSON.stringify({ state: "open" });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findPendingMilestoneDependencies({
    repo: "owner/repo",
    milestoneNumber: 1,
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, [
    { issueNumber: 1, dependencyNumber: 50, reason: "open" },
  ]);
});

Deno.test("findPendingMilestoneDependencies - skips pull requests in the member list", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([
        { number: 1, body: "Depends on #50", pull_request: {} },
        { number: 2, body: "no deps" },
      ]);
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findPendingMilestoneDependencies({
    repo: "owner/repo",
    milestoneNumber: 1,
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, []);
});

// ---------------------------------------------------------------------------
// findPendingMilestoneDependencies - failure paths
// ---------------------------------------------------------------------------

Deno.test("findPendingMilestoneDependencies - fails loud when the list call throws", async () => {
  const ghFn = async (): Promise<string> => {
    throw new Error("boom");
  };

  const result = await findPendingMilestoneDependencies({
    repo: "owner/repo",
    milestoneNumber: 1,
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "milestone #1");
  assertStringIncludes(result.error.message, "owner/repo");
});

Deno.test("findPendingMilestoneDependencies - fails loud when a dependency lookup throws", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([{ number: 1, body: "Depends on #50" }]);
    }
    if (key.includes("/issues/50")) {
      throw new Error("not found");
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findPendingMilestoneDependencies({
    repo: "owner/repo",
    milestoneNumber: 1,
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "#50");
});

Deno.test("findPendingMilestoneDependencies - fails loud on malformed dependency JSON", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([{ number: 1, body: "Depends on #50" }]);
    }
    if (key.includes("/issues/50")) {
      return "{not json";
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findPendingMilestoneDependencies({
    repo: "owner/repo",
    milestoneNumber: 1,
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, false);
});

Deno.test("findPendingMilestoneDependencies - fails loud on unexpected issue state", async () => {
  const ghFn = async (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify([{ number: 1, body: "Depends on #50" }]);
    }
    if (key.includes("/issues/50")) {
      return JSON.stringify({ state: "weird" });
    }
    throw new Error(`unexpected gh call: ${key}`);
  };

  const result = await findPendingMilestoneDependencies({
    repo: "owner/repo",
    milestoneNumber: 1,
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, false);
});

Deno.test("findPendingMilestoneDependencies - rejects an invalid repo without calling gh", async () => {
  let called = false;
  const ghFn = async (): Promise<string> => {
    called = true;
    return "[]";
  };

  const result = await findPendingMilestoneDependencies({
    repo: "not-a-repo",
    milestoneNumber: 1,
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, false);
  assertEquals(called, false);
});

Deno.test("findPendingMilestoneDependencies - rejects a non-positive milestone number without calling gh", async () => {
  let called = false;
  const ghFn = async (): Promise<string> => {
    called = true;
    return "[]";
  };

  const result = await findPendingMilestoneDependencies({
    repo: "owner/repo",
    milestoneNumber: 0,
    ghCommandFn: ghFn,
  });

  assertEquals(result.ok, false);
  assertEquals(called, false);
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

Deno.test("renderPendingDependenciesSection - returns empty string for no pending dependencies", () => {
  assertEquals(renderPendingDependenciesSection([]), "");
});

Deno.test("renderPendingDependenciesSection - renders a heading and a bullet per entry", () => {
  const pending: PendingDependency[] = [
    { issueNumber: 1963, dependencyNumber: 1961, reason: "open" },
  ];
  const section = renderPendingDependenciesSection(pending);
  assertStringIncludes(section, "### ⏸️ Held: pending dependencies");
  assertStringIncludes(section, "#1963 depends on #1961 (still open)");
});

Deno.test("describePendingDependency - describes both reasons and scrubs the milestone title", () => {
  const open: PendingDependency = {
    issueNumber: 1963,
    dependencyNumber: 1961,
    reason: "open",
  };
  assertEquals(
    describePendingDependency(open),
    "#1963 depends on #1961 (still open)",
  );

  const unmerged: PendingDependency = {
    issueNumber: 1963,
    dependencyNumber: 1810,
    reason: "unmerged-milestone",
    milestoneTitle: "X",
  };
  assertEquals(
    describePendingDependency(unmerged),
    "#1963 depends on #1810 (closed, but its milestone 'X' is still open, so its work is not merged yet)",
  );
});

Deno.test("renderPendingDependenciesBlockComment - starts with the marker and scrubs the title", () => {
  const pending: PendingDependency[] = [
    { issueNumber: 1963, dependencyNumber: 1961, reason: "open" },
  ];
  const comment = renderPendingDependenciesBlockComment(
    "<!-- injected -->Evil Milestone",
    pending,
  );
  const lines = comment.split("\n");
  assertEquals(lines[0], PENDING_DEPENDENCIES_BLOCK_MARKER);
  assertStringIncludes(comment, "Issue #3014");
  assertStringIncludes(comment, "#1963 depends on #1961 (still open)");
  // the injected HTML comment must be neutralised, not echoed verbatim
  assertEquals(comment.includes("<!-- injected -->"), false);
});
