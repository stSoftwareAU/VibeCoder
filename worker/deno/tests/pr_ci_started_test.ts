/**
 * Tests for pr_ci_started.ts — CI start detection (Issue #2099).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { getCiStartStatus } from "../lib/pr_ci_started.ts";

const REPO = "owner/repo";
const PR_NUMBER = 42;
const HEAD_SHA = "abcdef1234567890";

/** Build a stub gh runner that returns canned responses keyed by URL path. */
function stubGh(
  responses: Record<string, string>,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    // gh api <path>
    if (args[0] === "api") {
      const path = args[1] ?? "";
      for (const key of Object.keys(responses)) {
        if (path.includes(key)) {
          return Promise.resolve(responses[key] ?? "");
        }
      }
    }
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({ headRefOid: HEAD_SHA }));
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
}

Deno.test("pr_ci_started - returns 'started' when check_runs is non-empty", async () => {
  const gh = stubGh({
    "check-runs": JSON.stringify({
      total_count: 1,
      check_runs: [{ id: 1, name: "build", status: "in_progress" }],
    }),
    "actions/runs": JSON.stringify({ total_count: 0, workflow_runs: [] }),
  });

  const status = await getCiStartStatus(REPO, PR_NUMBER, gh);
  assertEquals(status, "started");
});

Deno.test("pr_ci_started - returns 'started' when check run is completed", async () => {
  const gh = stubGh({
    "check-runs": JSON.stringify({
      total_count: 1,
      check_runs: [{
        id: 1,
        name: "build",
        status: "completed",
        conclusion: "success",
      }],
    }),
    "actions/runs": JSON.stringify({ total_count: 0, workflow_runs: [] }),
  });

  const status = await getCiStartStatus(REPO, PR_NUMBER, gh);
  assertEquals(status, "started");
});

Deno.test("pr_ci_started - returns 'queued' when a workflow_run is queued but no check_runs", async () => {
  const gh = stubGh({
    "check-runs": JSON.stringify({ total_count: 0, check_runs: [] }),
    "actions/runs": JSON.stringify({
      total_count: 1,
      workflow_runs: [{ id: 99, status: "queued", head_sha: HEAD_SHA }],
    }),
  });

  const status = await getCiStartStatus(REPO, PR_NUMBER, gh);
  assertEquals(status, "queued");
});

Deno.test("pr_ci_started - returns 'none' when no check_runs and no workflow_runs", async () => {
  const gh = stubGh({
    "check-runs": JSON.stringify({ total_count: 0, check_runs: [] }),
    "actions/runs": JSON.stringify({ total_count: 0, workflow_runs: [] }),
  });

  const status = await getCiStartStatus(REPO, PR_NUMBER, gh);
  assertEquals(status, "none");
});

Deno.test("pr_ci_started - prefers 'started' over a queued workflow_run", async () => {
  const gh = stubGh({
    "check-runs": JSON.stringify({
      total_count: 1,
      check_runs: [{ id: 1, name: "build", status: "queued" }],
    }),
    "actions/runs": JSON.stringify({
      total_count: 1,
      workflow_runs: [{ id: 99, status: "queued", head_sha: HEAD_SHA }],
    }),
  });

  const status = await getCiStartStatus(REPO, PR_NUMBER, gh);
  assertEquals(status, "started");
});

Deno.test("pr_ci_started - 'none' when workflow_runs has only completed runs for old SHA", async () => {
  // Filter is done server-side by ?head_sha=, but defend against an empty list.
  const gh = stubGh({
    "check-runs": JSON.stringify({ total_count: 0, check_runs: [] }),
    "actions/runs": JSON.stringify({ total_count: 0, workflow_runs: [] }),
  });

  const status = await getCiStartStatus(REPO, PR_NUMBER, gh);
  assertEquals(status, "none");
});

Deno.test("pr_ci_started - accepts an explicit headSha override (no gh pr view call)", async () => {
  let prViewCalled = false;
  const gh = (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") {
      prViewCalled = true;
      return Promise.resolve(JSON.stringify({ headRefOid: "wrong" }));
    }
    if (args[0] === "api" && args[1]?.includes("check-runs")) {
      return Promise.resolve(
        JSON.stringify({ total_count: 0, check_runs: [] }),
      );
    }
    if (args[0] === "api" && args[1]?.includes("actions/runs")) {
      return Promise.resolve(
        JSON.stringify({ total_count: 0, workflow_runs: [] }),
      );
    }
    throw new Error(`unexpected: ${args.join(" ")}`);
  };

  const status = await getCiStartStatus(REPO, PR_NUMBER, gh, HEAD_SHA);
  assertEquals(status, "none");
  assertEquals(prViewCalled, false);
});

Deno.test("pr_ci_started - propagates gh errors", async () => {
  const gh = (_args: string[]) => Promise.reject(new Error("gh boom"));
  let caught: unknown;
  try {
    await getCiStartStatus(REPO, PR_NUMBER, gh, HEAD_SHA);
  } catch (err) {
    caught = err;
  }
  assertEquals(caught instanceof Error, true);
  assertEquals((caught as Error).message.includes("boom"), true);
});

Deno.test("pr_ci_started - queries the correct API paths with head_sha", async () => {
  const seenPaths: string[] = [];
  const gh = (args: string[]) => {
    if (args[0] === "api") {
      seenPaths.push(args[1] ?? "");
      if (args[1]?.includes("check-runs")) {
        return Promise.resolve(
          JSON.stringify({ total_count: 0, check_runs: [] }),
        );
      }
      if (args[1]?.includes("actions/runs")) {
        return Promise.resolve(
          JSON.stringify({ total_count: 0, workflow_runs: [] }),
        );
      }
    }
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  await getCiStartStatus(REPO, PR_NUMBER, gh, HEAD_SHA);
  assertEquals(
    seenPaths.some((p) => p.includes(`commits/${HEAD_SHA}/check-runs`)),
    true,
  );
  assertEquals(
    seenPaths.some((p) => p.includes(`actions/runs?head_sha=${HEAD_SHA}`)),
    true,
  );
});
