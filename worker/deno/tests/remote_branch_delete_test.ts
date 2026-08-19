/**
 * Tests for remote_branch_delete.ts — the remote-branch deletion chokepoint
 * (Issue #3931).
 *
 * Every test calls the real decision function with an injected `gh` runner and
 * asserts on the verdict it returns.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  assessRemoteBranchDeletion,
  renderDeletionDecision,
} from "../lib/remote_branch_delete.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `gh` stub that answers the open-PR queries by side.
 *
 * @param head - Output for the `--head <branch>` query
 * @param base - Output for the `--base <branch>` query
 * @param failOn - Optional side whose query throws
 */
function ghStub(
  { head = "", base = "", failOn }: {
    head?: string;
    base?: string;
    failOn?: "head" | "base";
  } = {},
) {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const side = args.includes("--head") ? "head" : "base";
    if (failOn === side) {
      return Promise.reject(new Error(`gh exploded on the ${side} query`));
    }
    return Promise.resolve(side === "head" ? head : base);
  };
  return { ghCommandFn, calls };
}

// ---------------------------------------------------------------------------
// assessRemoteBranchDeletion
// ---------------------------------------------------------------------------

Deno.test("remote branch delete - allows a branch no open PR uses", async () => {
  const { ghCommandFn, calls } = ghStub();
  const assessment = await assessRemoteBranchDeletion(
    "org/repo",
    "issue-1-fix",
    ghCommandFn,
  );

  assertEquals(assessment.safe, true);
  assertEquals(assessment.refusal, undefined);
  // Both sides must actually be queried before a deletion is authorised.
  assertEquals(calls.length, 2);
  assertEquals(calls[0]?.includes("--head"), true);
  assertEquals(calls[1]?.includes("--base"), true);
});

Deno.test("remote branch delete - refuses a branch an open PR is based on", async () => {
  const { ghCommandFn } = ghStub({ base: "3928" });
  const assessment = await assessRemoteBranchDeletion(
    "org/repo",
    "issue-1-fix",
    ghCommandFn,
  );

  assertEquals(assessment.safe, false);
  assertEquals(assessment.refusal, "open-base-pr");
  assertEquals(assessment.blockingPr, 3928);
  assertStringIncludes(assessment.reason, "#3928");
});

Deno.test("remote branch delete - refuses a branch that is an open PR's head", async () => {
  const { ghCommandFn } = ghStub({ head: "42" });
  const assessment = await assessRemoteBranchDeletion(
    "org/repo",
    "issue-1-fix",
    ghCommandFn,
  );

  assertEquals(assessment.safe, false);
  assertEquals(assessment.refusal, "open-head-pr");
  assertEquals(assessment.blockingPr, 42);
});

Deno.test("remote branch delete - refuses a milestone branch outright", async () => {
  const { ghCommandFn, calls } = ghStub();
  const assessment = await assessRemoteBranchDeletion(
    "org/repo",
    "milestone/3872-security-scan-overflow-17-unfiled-findings",
    ghCommandFn,
  );

  assertEquals(assessment.safe, false);
  assertEquals(assessment.refusal, "protected");
  // No network call is needed to refuse a protected branch.
  assertEquals(calls.length, 0);
});

Deno.test("remote branch delete - refuses the default branch", async () => {
  const { ghCommandFn } = ghStub();
  const assessment = await assessRemoteBranchDeletion(
    "org/repo",
    "Develop",
    ghCommandFn,
  );

  assertEquals(assessment.safe, false);
  assertEquals(assessment.refusal, "protected");
});

Deno.test("remote branch delete - a failed head query refuses, never allows", async () => {
  const { ghCommandFn } = ghStub({ failOn: "head" });
  const assessment = await assessRemoteBranchDeletion(
    "org/repo",
    "issue-1-fix",
    ghCommandFn,
  );

  assertEquals(assessment.safe, false);
  assertEquals(assessment.refusal, "undecidable");
  assertStringIncludes(assessment.reason, "gh exploded");
});

Deno.test("remote branch delete - a failed base query refuses, never allows", async () => {
  const { ghCommandFn } = ghStub({ failOn: "base" });
  const assessment = await assessRemoteBranchDeletion(
    "org/repo",
    "issue-1-fix",
    ghCommandFn,
  );

  assertEquals(assessment.safe, false);
  assertEquals(assessment.refusal, "undecidable");
});

Deno.test("remote branch delete - unparseable PR output refuses", async () => {
  const { ghCommandFn } = ghStub({ head: "not-a-number" });
  const assessment = await assessRemoteBranchDeletion(
    "org/repo",
    "issue-1-fix",
    ghCommandFn,
  );

  assertEquals(assessment.safe, false);
  assertEquals(assessment.refusal, "undecidable");
});

Deno.test("remote branch delete - a jq null result means no blocking PR", async () => {
  const { ghCommandFn } = ghStub({ head: "null", base: "null" });
  const assessment = await assessRemoteBranchDeletion(
    "org/repo",
    "issue-1-fix",
    ghCommandFn,
  );

  assertEquals(assessment.safe, true);
});

Deno.test("remote branch delete - rejects a malformed repository", async () => {
  const { ghCommandFn, calls } = ghStub();
  const assessment = await assessRemoteBranchDeletion(
    "not-a-repo",
    "issue-1-fix",
    ghCommandFn,
  );

  assertEquals(assessment.safe, false);
  assertEquals(assessment.refusal, "undecidable");
  assertEquals(calls.length, 0);
});

Deno.test("remote branch delete - rejects an option-shaped branch name", async () => {
  const { ghCommandFn, calls } = ghStub();
  const assessment = await assessRemoteBranchDeletion(
    "org/repo",
    "--force",
    ghCommandFn,
  );

  assertEquals(assessment.safe, false);
  assertEquals(assessment.refusal, "undecidable");
  assertEquals(calls.length, 0);
});

Deno.test("remote branch delete - rejects an empty branch name", async () => {
  const { ghCommandFn } = ghStub();
  const assessment = await assessRemoteBranchDeletion(
    "org/repo",
    "",
    ghCommandFn,
  );

  assertEquals(assessment.safe, false);
  assertEquals(assessment.refusal, "undecidable");
});

// ---------------------------------------------------------------------------
// renderDeletionDecision
// ---------------------------------------------------------------------------

Deno.test("remote branch delete - only a safe verdict renders SAFE_TO_DELETE", async () => {
  const { ghCommandFn } = ghStub();
  const safe = await assessRemoteBranchDeletion(
    "org/repo",
    "issue-1-fix",
    ghCommandFn,
  );

  assertEquals(renderDeletionDecision(safe), {
    success: true,
    message: "SAFE_TO_DELETE",
  });
});

Deno.test("remote branch delete - head refusal keeps the HAS_OPEN_PR contract", () => {
  assertEquals(
    renderDeletionDecision({
      safe: false,
      refusal: "open-head-pr",
      blockingPr: 42,
      reason: "…",
    }),
    { success: true, message: "HAS_OPEN_PR:42" },
  );
});

Deno.test("remote branch delete - base refusal renders HAS_OPEN_CHILD_PR", () => {
  assertEquals(
    renderDeletionDecision({
      safe: false,
      refusal: "open-base-pr",
      blockingPr: 3928,
      reason: "…",
    }),
    { success: true, message: "HAS_OPEN_CHILD_PR:3928" },
  );
});

Deno.test("remote branch delete - protected refusal renders PROTECTED_BRANCH", () => {
  assertEquals(
    renderDeletionDecision({
      safe: false,
      refusal: "protected",
      reason: "…",
    }),
    { success: true, message: "PROTECTED_BRANCH" },
  );
});

Deno.test("remote branch delete - an undecidable verdict fails loud", () => {
  const rendered = renderDeletionDecision({
    safe: false,
    refusal: "undecidable",
    reason: "gh timed out",
  });

  assertEquals(rendered.success, false);
  assertStringIncludes(rendered.message, "UNDECIDABLE");
  assertStringIncludes(rendered.message, "gh timed out");
});
