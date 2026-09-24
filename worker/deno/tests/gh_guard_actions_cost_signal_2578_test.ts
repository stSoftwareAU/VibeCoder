/**
 * The agent `gh` guard and the github-actions-audit cost signal (Issue
 * #2578).
 *
 * The audit's cost group (checks 37–41) may read run history — one
 * `gh run list` per workflow and the per-run `timing` endpoint — and nothing
 * else touching Actions. Those calls are reads, so the guard passes them
 * whatever the write-repo allowlist says; their write neighbours (rerun,
 * cancel, delete, dispatch, a `POST` to the same endpoints) are mutations the
 * allowlist still governs. Both directions are pinned here so widening the
 * grant, or narrowing the reads, fails in CI.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { evaluateGhCommand } from "../lib/gh_guard_decision.ts";

/** A run whose allowlist does not name the audited repository. */
const ACTIVE = {
  active: true,
  allowedRepos: ["stSoftwareAU/VibeCoder"],
} as const;

const COST_SIGNAL_READS: readonly string[][] = [
  [
    "run",
    "list",
    "--workflow",
    "quality.yml",
    "--limit",
    "20",
    "--json",
    "databaseId,conclusion,createdAt,updatedAt,event",
  ],
  ["api", "repos/other/repo/actions/runs/123/timing"],
  ["api", "repos/{owner}/{repo}/actions/runs/123/timing"],
  ["api", "--method", "GET", "repos/other/repo/actions/runs/123/timing"],
];

Deno.test("evaluateGhCommand - the audit's cost-signal reads are allowed", () => {
  for (const args of COST_SIGNAL_READS) {
    assertEquals(
      evaluateGhCommand(args, ACTIVE),
      { allowed: true },
      `gh ${args.join(" ")}`,
    );
  }
});

Deno.test("evaluateGhCommand - Actions writes beside the cost signal stay mutations", () => {
  const writes: readonly string[][] = [
    ["run", "rerun", "123", "--repo", "other/repo"],
    ["run", "cancel", "123", "--repo", "other/repo"],
    ["run", "delete", "123", "--repo", "other/repo"],
    ["workflow", "run", "quality.yml", "--repo", "other/repo"],
    ["api", "-X", "POST", "repos/other/repo/actions/runs/123/rerun"],
    // A body field turns the timing read into a POST.
    ["api", "repos/other/repo/actions/runs/123/timing", "-f", "x=y"],
  ];
  for (const args of writes) {
    const decision = evaluateGhCommand(args, ACTIVE);
    assertEquals(decision.allowed, false, `gh ${args.join(" ")}`);
    assertEquals(
      decision.marker,
      "WRITE_REPO_BLOCKED",
      `gh ${args.join(" ")}`,
    );
  }
});
