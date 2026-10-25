/**
 * A merge-only `skipped` resolution verdict lands unverified (Issue #4326).
 *
 * `judgeResolutionVerdict` turns a `skipped` verdict into a refusal, because a
 * resolution nothing verified is not a resolution (Issue #1559). A merge-only
 * gate marks its verdict `landUnverified`, and only that verdict is let through.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { judgeResolutionVerdict } from "../lib/milestone_gate_repair.ts";
import { buildConflictEscalationComment } from "../lib/milestone_sync_conflict.ts";

Deno.test("judgeResolutionVerdict - a skipped verdict is a refusal (Issue #1559)", () => {
  const verdict = judgeResolutionVerdict({
    status: "skipped",
    detail: "nothing to run",
    output: "",
  });
  assertEquals(verdict.status, "failed");
  assertStringIncludes(verdict.detail, "cannot be verified");
});

Deno.test("judgeResolutionVerdict - a skipped verdict marked landUnverified passes through unchanged (Issue #4326)", () => {
  const skipped = {
    status: "skipped" as const,
    detail: "left to the repository's CI",
    output: "",
    landUnverified: true,
  };
  assertEquals(judgeResolutionVerdict(skipped), skipped);
});

Deno.test("judgeResolutionVerdict - landUnverified does not soften a failure (Issue #4326)", () => {
  const failed = {
    status: "failed" as const,
    detail: "the check refused the tree",
    output: "",
    landUnverified: true,
  };
  assertEquals(judgeResolutionVerdict(failed).status, "failed");
});

Deno.test("buildConflictEscalationComment - an unverified auto resolution says the tree was not checked, a verified one says it was (Issue #4326)", () => {
  const base = {
    repo: "org/repo",
    milestoneBranch: "milestone/4326",
    defaultBranch: "main",
    tips: [],
    landing: { kind: "tip" as const, branch: "milestone/4326", sha: "bbb" },
  };
  const conflict = {
    files: ["scan.ts"],
    milestoneSha: "aaa",
    defaultSha: "bbb",
    resolution: "auto" as const,
    decisions: [],
  };

  const verified = buildConflictEscalationComment({ ...base, conflict });
  assertStringIncludes(verified, "passed the repository's own check");
  assertEquals(verified.includes("NOT checked"), false);

  const unverified = buildConflictEscalationComment({
    ...base,
    conflict: { ...conflict, unverified: true },
  });
  assertStringIncludes(unverified, "NOT checked before it landed");
  assertStringIncludes(unverified, "milestone PR's CI builds it");
  assertEquals(unverified.includes("passed the repository's own check"), false);
});
