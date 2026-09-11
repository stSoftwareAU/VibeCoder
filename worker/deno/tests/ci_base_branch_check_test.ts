/**
 * Tests for `isCheckRedOnBranch` (Issue #1880, parent #1861).
 *
 * The base-branch deferral spends no attempt and posts no `needs-human`, so
 * the reading behind it must be exact: the latest completed run of the same
 * check decides, a check the branch never ran is not red, and a read that
 * failed is an error rather than a quiet green.
 */

import { assertEquals } from "@std/assert";
import { isCheckRedOnBranch } from "../lib/ci_base_branch_check.ts";

/** A `gh` runner returning `body` and recording the args it was given. */
function stubGh(body: string, calls: string[][] = []) {
  return (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve(body);
  };
}

/** Render a check-runs payload. */
function payload(
  runs: Array<
    { id: number; name: string; status?: string; conclusion?: string | null }
  >,
): string {
  return JSON.stringify({
    check_runs: runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status ?? "completed",
      conclusion: run.conclusion ?? null,
    })),
  });
}

Deno.test("isCheckRedOnBranch - latest completed run failed is red", async () => {
  const calls: string[][] = [];
  const result = await isCheckRedOnBranch({
    repo: "org/repo",
    branch: "develop",
    checkName: "Project Validation",
    ghCommandFn: stubGh(
      payload([
        { id: 10, name: "Project Validation", conclusion: "success" },
        { id: 22, name: "Project Validation", conclusion: "failure" },
        { id: 30, name: "Other Check", conclusion: "success" },
      ]),
      calls,
    ),
  });

  assertEquals(result.ok, true);
  assertEquals(result.ok && result.value, true);
  // The branch, not a head SHA, is what was read.
  assertEquals(
    calls[0]?.includes("repos/org/repo/commits/develop/check-runs"),
    true,
  );
});

Deno.test("isCheckRedOnBranch - a green re-run after an earlier failure is not red", async () => {
  const result = await isCheckRedOnBranch({
    repo: "org/repo",
    branch: "develop",
    checkName: "Project Validation",
    ghCommandFn: stubGh(payload([
      { id: 22, name: "Project Validation", conclusion: "failure" },
      { id: 41, name: "Project Validation", conclusion: "success" },
    ])),
  });

  assertEquals(result.ok, true);
  assertEquals(result.ok && result.value, false);
});

Deno.test("isCheckRedOnBranch - a check the branch never ran is not red", async () => {
  const result = await isCheckRedOnBranch({
    repo: "org/repo",
    branch: "develop",
    checkName: "Project Validation",
    ghCommandFn: stubGh(payload([
      { id: 5, name: "Some Other Check", conclusion: "failure" },
    ])),
  });

  assertEquals(result.ok, true);
  assertEquals(result.ok && result.value, false);
});

Deno.test("isCheckRedOnBranch - an in-progress re-run does not hide the completed failure", async () => {
  const result = await isCheckRedOnBranch({
    repo: "org/repo",
    branch: "develop",
    checkName: "Project Validation",
    ghCommandFn: stubGh(payload([
      { id: 22, name: "Project Validation", conclusion: "failure" },
      {
        id: 99,
        name: "Project Validation",
        status: "in_progress",
        conclusion: null,
      },
    ])),
  });

  assertEquals(result.ok, true);
  assertEquals(result.ok && result.value, true);
});

Deno.test("isCheckRedOnBranch - malformed JSON is an error, never false", async () => {
  const result = await isCheckRedOnBranch({
    repo: "org/repo",
    branch: "develop",
    checkName: "Project Validation",
    ghCommandFn: stubGh("not json at all"),
  });

  assertEquals(result.ok, false);
  assertEquals(
    !result.ok && result.error.message.includes("Failed to parse check runs"),
    true,
  );
});

Deno.test("isCheckRedOnBranch - a payload with no check_runs array is an error", async () => {
  const result = await isCheckRedOnBranch({
    repo: "org/repo",
    branch: "develop",
    checkName: "Project Validation",
    ghCommandFn: stubGh(JSON.stringify({ message: "Not Found" })),
  });

  assertEquals(result.ok, false);
  assertEquals(
    !result.ok && result.error.message.includes("no check_runs array"),
    true,
  );
});

Deno.test("isCheckRedOnBranch - an API failure is an error, never false", async () => {
  const result = await isCheckRedOnBranch({
    repo: "org/repo",
    branch: "develop",
    checkName: "Project Validation",
    ghCommandFn: () => Promise.reject(new Error("HTTP 404: Not Found")),
  });

  assertEquals(result.ok, false);
  assertEquals(
    !result.ok && result.error.message.includes("Failed to read check runs"),
    true,
  );
});
