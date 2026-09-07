/**
 * Tests for repo_loop_quota_stop.ts — one quota exhaustion is one line
 * (Issue #1515).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatRepoLoopQuotaStop,
  RepoLoopQuotaStop,
} from "../lib/repo_loop_quota_stop.ts";

const REFUSED =
  "gh command failed (exit 1): GraphQL: API rate limit already exceeded for user ID 1.";
const SKIPPED =
  "gh command skipped: GraphQL primary quota exhausted (API rate limit already exceeded) — in 24m";

Deno.test("repo-loop-quota-stop - inert with a healthy quota: every repo is visited, nothing is logged", () => {
  const lines: string[] = [];
  const quota = new RepoLoopQuotaStop(
    "Scan",
    3,
    (m) => lines.push(m),
    () => false,
  );
  let visited = 0;
  for (const _repo of ["a", "b", "c"]) {
    if (quota.latchedBeforeRepo()) break;
    visited++;
    quota.repoDone();
  }
  assertEquals(visited, 3);
  assertEquals(lines, []);
  assertEquals(quota.stopped, undefined);
});

Deno.test("repo-loop-quota-stop - the first refusal ends the loop with one line naming the remainder", () => {
  const lines: string[] = [];
  const quota = new RepoLoopQuotaStop(
    "Scan",
    19,
    (m) => lines.push(m),
    () => false,
  );
  const calls: string[] = [];
  for (const repo of Array.from({ length: 19 }, (_, i) => `org/r${i}`)) {
    if (quota.latchedBeforeRepo()) break;
    try {
      calls.push(repo);
      throw new Error(REFUSED);
    } catch (err) {
      if (quota.isQuotaFailure(err)) break;
      quota.repoDone();
    }
  }
  assertEquals(calls.length, 1, "the first refusal is the last call");
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "Scan: GraphQL quota exhausted");
  assertStringIncludes(lines[0]!, "skipped 19 of 19 repo(s)");
  assertStringIncludes(lines[0]!, "rate limit already exceeded");
  assertEquals(quota.stopped?.reposSkipped, 19);
});

Deno.test("repo-loop-quota-stop - a refusal part-way counts only what was left undone", () => {
  const lines: string[] = [];
  const quota = new RepoLoopQuotaStop(
    "Scan",
    5,
    (m) => lines.push(m),
    () => false,
  );
  const repos = ["a", "b", "c", "d", "e"];
  for (const repo of repos) {
    if (quota.latchedBeforeRepo()) break;
    try {
      if (repo === "c") throw new Error(SKIPPED);
    } catch (err) {
      if (quota.isQuotaFailure(err)) break;
    }
    quota.repoDone();
  }
  assertEquals(quota.stopped, {
    condition: SKIPPED,
    reposSkipped: 3,
    reposTotal: 5,
  });
  assertStringIncludes(lines[0]!, "skipped 3 of 5 repo(s)");
});

Deno.test("repo-loop-quota-stop - an ordinary failure is not the quota and stays the caller's to report", () => {
  const lines: string[] = [];
  const quota = new RepoLoopQuotaStop(
    "Scan",
    2,
    (m) => lines.push(m),
    () => false,
  );
  assertEquals(quota.isQuotaFailure(new Error("HTTP 404: Not Found")), false);
  assertEquals(quota.isQuotaFailure("boom"), false);
  assertEquals(lines, []);
  assertEquals(quota.stopped, undefined);
});

Deno.test("repo-loop-quota-stop - a latch already set stops before the first repo, without a call", () => {
  const lines: string[] = [];
  const quota = new RepoLoopQuotaStop(
    "Scan",
    4,
    (m) => lines.push(m),
    () => true,
  );
  assertEquals(quota.latchedBeforeRepo(), true);
  assertEquals(quota.latchedBeforeRepo(), true, "stays stopped");
  assertEquals(lines.length, 1, "logged once, however often it is asked");
  assertStringIncludes(lines[0]!, "latched for this process");
  assertEquals(quota.stopped?.reposSkipped, 4);
});

Deno.test("repo-loop-quota-stop - a latch that fires between repos stops the loop there", () => {
  const lines: string[] = [];
  let latched = false;
  const quota = new RepoLoopQuotaStop(
    "Scan",
    3,
    (m) => lines.push(m),
    () => latched,
  );
  const visited: string[] = [];
  for (const repo of ["a", "b", "c"]) {
    if (quota.latchedBeforeRepo()) break;
    visited.push(repo);
    quota.repoDone();
    if (repo === "a") latched = true;
  }
  assertEquals(visited, ["a"]);
  assertEquals(quota.stopped?.reposSkipped, 2);
  assertEquals(lines.length, 1);
});

Deno.test("repo-loop-quota-stop - the format names the scan, the count and the condition", () => {
  assertEquals(
    formatRepoLoopQuotaStop("Auto-merge sweep", {
      condition: "why",
      reposSkipped: 2,
      reposTotal: 9,
    }),
    "Auto-merge sweep: GraphQL quota exhausted — skipped 2 of 9 repo(s) this cycle, resumes next cycle: why",
  );
});
