/**
 * Tests for the idle-task milestone merge gate (Issue #2060).
 *
 * Verifies that the security-scan idle-task milestone is correctly
 * gated: no merge PR when the milestone branch has no real source-code
 * changes, fall-through to the standard flow otherwise.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideIdleTaskMerge,
  extractIdleTaskTemplate,
  fetchMilestoneBranchChangedFiles,
  isIdleTaskMilestone,
  isOnlyNoiseChanges,
  postNoIssuesFoundComments,
  renderNoIssuesFoundComment,
} from "../lib/idle_task_merge_gate.ts";

// ============================================================================
// Title parsing
// ============================================================================

Deno.test("isIdleTaskMilestone - matches the canonical prefix", () => {
  assertEquals(isIdleTaskMilestone("idle-task: security-scan"), true);
  assertEquals(isIdleTaskMilestone("idle-task: docs-audit"), true);
  assertEquals(isIdleTaskMilestone("  idle-task: security-scan  "), true);
});

Deno.test("isIdleTaskMilestone - rejects regular milestones", () => {
  assertEquals(isIdleTaskMilestone("v1.0"), false);
  assertEquals(isIdleTaskMilestone("OIDC Authentication"), false);
  assertEquals(isIdleTaskMilestone("idle task: typo"), false);
});

Deno.test("extractIdleTaskTemplate - returns template slug", () => {
  assertEquals(
    extractIdleTaskTemplate("idle-task: security-scan"),
    "security-scan",
  );
  assertEquals(
    extractIdleTaskTemplate("idle-task: maintainability"),
    "maintainability",
  );
});

Deno.test("extractIdleTaskTemplate - returns null when not an idle-task milestone", () => {
  assertEquals(extractIdleTaskTemplate("v1.0"), null);
  assertEquals(extractIdleTaskTemplate(""), null);
  assertEquals(extractIdleTaskTemplate("idle-task:"), null);
  assertEquals(extractIdleTaskTemplate("idle-task:    "), null);
});

// ============================================================================
// Noise-file classification
// ============================================================================

Deno.test("isOnlyNoiseChanges - empty list is treated as no changes", () => {
  assertEquals(isOnlyNoiseChanges([]), true);
});

Deno.test("isOnlyNoiseChanges - PR summary and version bump are noise", () => {
  assertEquals(
    isOnlyNoiseChanges([
      "docs/pr-summary-2694.md",
      "docs/pr-summary-2703.md",
      "deno.json",
      "deno.lock",
      "src/Version.ts",
      "Version.ts",
      "cspell.json",
    ]),
    true,
  );
});

Deno.test("isOnlyNoiseChanges - archived PR summaries (Issue #2173) are noise", () => {
  // Issue #2173 moved PR summaries from docs/ root into the
  // docs/archive/pr-summaries/ directory. The gate must continue to
  // treat the auto-generated audit log as noise at the new path.
  assertEquals(
    isOnlyNoiseChanges([
      "docs/archive/pr-summaries/pr-summary-2694.md",
      "docs/archive/pr-summaries/pr-summary-2703.md",
      "deno.json",
    ]),
    true,
  );
});

Deno.test("isOnlyNoiseChanges - other docs/archive paths are NOT noise", () => {
  // The archive dedup is scoped to the pr-summaries subdirectory only;
  // an unrelated archived doc should still force the merge PR.
  assertEquals(
    isOnlyNoiseChanges([
      "docs/archive/other-notes.md",
    ]),
    false,
  );
});

Deno.test("isOnlyNoiseChanges - any source-code file forces raise", () => {
  assertEquals(
    isOnlyNoiseChanges([
      "docs/pr-summary-2694.md",
      "src/server/auth.ts", // real code change
    ]),
    false,
  );
});

Deno.test("isOnlyNoiseChanges - test files are NOT classified as noise", () => {
  // A test tweak still represents a code change we want a reviewer to
  // see, so the gate falls through to the standard merge-PR flow.
  assertEquals(
    isOnlyNoiseChanges([
      "tests/server/auth_test.ts",
    ]),
    false,
  );
});

Deno.test("isOnlyNoiseChanges - unrelated docs are NOT noise", () => {
  assertEquals(
    isOnlyNoiseChanges([
      "docs/architecture.md",
    ]),
    false,
  );
});

// ============================================================================
// fetchMilestoneBranchChangedFiles
// ============================================================================

Deno.test("fetchMilestoneBranchChangedFiles - parses the jq newline-delimited output", async () => {
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    assertStringIncludes(
      key,
      "api repos/owner/repo/compare/main...milestone/x",
    );
    assertStringIncludes(key, "--jq .files[].filename");
    return Promise.resolve(
      "docs/pr-summary-2694.md\ndeno.json\nsrc/server/auth.ts\n",
    );
  };
  const result = await fetchMilestoneBranchChangedFiles(
    "owner/repo",
    "main",
    "milestone/x",
    ghFn,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, [
      "docs/pr-summary-2694.md",
      "deno.json",
      "src/server/auth.ts",
    ]);
  }
});

Deno.test("fetchMilestoneBranchChangedFiles - empty response gives empty list", async () => {
  const ghFn = (_args: string[]): Promise<string> => Promise.resolve("");
  const result = await fetchMilestoneBranchChangedFiles(
    "owner/repo",
    "main",
    "milestone/x",
    ghFn,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, []);
  }
});

Deno.test("fetchMilestoneBranchChangedFiles - surfaces gh errors", async () => {
  const ghFn = (_args: string[]): Promise<string> => {
    throw new Error("boom");
  };
  const result = await fetchMilestoneBranchChangedFiles(
    "owner/repo",
    "main",
    "milestone/x",
    ghFn,
  );
  assertEquals(result.ok, false);
});

// ============================================================================
// decideIdleTaskMerge
// ============================================================================

Deno.test("decideIdleTaskMerge - non-idle-task milestone falls through to raise", async () => {
  const decision = await decideIdleTaskMerge({
    milestoneTitle: "v1.0",
    repo: "owner/repo",
    defaultBranch: "main",
    milestoneBranch: "milestone/v1-0",
    ghCommandFn: (_args) =>
      Promise.reject(new Error("compare should not be called")),
  });
  assertEquals(decision.decision, "raise");
});

Deno.test("decideIdleTaskMerge - non-security-scan idle-task milestone falls through", async () => {
  const decision = await decideIdleTaskMerge({
    milestoneTitle: "idle-task: docs-audit",
    repo: "owner/repo",
    defaultBranch: "main",
    milestoneBranch: "milestone/idle-task-docs-audit",
    ghCommandFn: (_args) =>
      Promise.reject(new Error("compare should not be called")),
  });
  assertEquals(decision.decision, "raise");
});

Deno.test("decideIdleTaskMerge - security-scan with no source-code changes skips", async () => {
  const ghFn = (_args: string[]): Promise<string> =>
    Promise.resolve(
      "docs/pr-summary-2694.md\ndocs/pr-summary-2703.md\ndeno.json\nsrc/Version.ts\ncspell.json\n",
    );
  const decision = await decideIdleTaskMerge({
    milestoneTitle: "idle-task: security-scan",
    repo: "owner/repo",
    defaultBranch: "Develop",
    milestoneBranch: "milestone/idle-task-security-scan",
    ghCommandFn: ghFn,
  });
  assertEquals(decision.decision, "skip-no-changes");
  if (decision.decision === "skip-no-changes") {
    assertEquals(decision.changedFiles.length, 5);
  }
});

Deno.test("decideIdleTaskMerge - security-scan with real source change raises PR", async () => {
  const ghFn = (_args: string[]): Promise<string> =>
    Promise.resolve("src/server/auth.ts\ndeno.json\n");
  const decision = await decideIdleTaskMerge({
    milestoneTitle: "idle-task: security-scan",
    repo: "owner/repo",
    defaultBranch: "Develop",
    milestoneBranch: "milestone/idle-task-security-scan",
    ghCommandFn: ghFn,
  });
  assertEquals(decision.decision, "raise");
});

Deno.test("decideIdleTaskMerge - gh failure on compare falls through to raise", async () => {
  const ghFn = (_args: string[]): Promise<string> => {
    throw new Error("gh broke");
  };
  const decision = await decideIdleTaskMerge({
    milestoneTitle: "idle-task: security-scan",
    repo: "owner/repo",
    defaultBranch: "Develop",
    milestoneBranch: "milestone/idle-task-security-scan",
    ghCommandFn: ghFn,
  });
  assertEquals(decision.decision, "raise");
});

Deno.test("decideIdleTaskMerge - security-scan with empty diff skips", async () => {
  // Milestone branch has no commits ahead of default — definitely no
  // source-code changes.
  const ghFn = (_args: string[]): Promise<string> => Promise.resolve("");
  const decision = await decideIdleTaskMerge({
    milestoneTitle: "idle-task: security-scan",
    repo: "owner/repo",
    defaultBranch: "Develop",
    milestoneBranch: "milestone/idle-task-security-scan",
    ghCommandFn: ghFn,
  });
  assertEquals(decision.decision, "skip-no-changes");
});

// ============================================================================
// renderNoIssuesFoundComment
// ============================================================================

Deno.test("renderNoIssuesFoundComment - lists changed bookkeeping files", () => {
  const body = renderNoIssuesFoundComment(
    "idle-task: security-scan",
    ["docs/pr-summary-2694.md", "deno.json"],
  );
  assertStringIncludes(body, "no issues found");
  assertStringIncludes(body, "Issue #2060");
  assertStringIncludes(body, "`docs/pr-summary-2694.md`");
  assertStringIncludes(body, "`deno.json`");
});

Deno.test("renderNoIssuesFoundComment - explains empty branch case", () => {
  const body = renderNoIssuesFoundComment("idle-task: security-scan", []);
  assertStringIncludes(body, "no commits ahead");
});

// ============================================================================
// postNoIssuesFoundComments
// ============================================================================

Deno.test("postNoIssuesFoundComments - comments on every supplied issue", async () => {
  const commented: { issueNumber: string; body: string }[] = [];
  const ghFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (!key.startsWith("issue comment")) {
      throw new Error(`unexpected gh call: ${key}`);
    }
    const numIdx = args.indexOf("comment") + 1;
    const bodyIdx = args.indexOf("--body");
    commented.push({
      issueNumber: args[numIdx]!,
      body: args[bodyIdx + 1]!,
    });
    return Promise.resolve("");
  };
  const logs: string[] = [];
  await postNoIssuesFoundComments({
    repo: "owner/repo",
    issueNumbers: [2694, 2703],
    milestoneTitle: "idle-task: security-scan",
    changedFiles: ["docs/pr-summary-2694.md"],
    ghCommandFn: ghFn,
    log: (m) => logs.push(m),
  });
  assertEquals(commented.length, 2);
  assertEquals(commented[0]!.issueNumber, "2694");
  assertEquals(commented[1]!.issueNumber, "2703");
  assertStringIncludes(commented[0]!.body, "no issues found");
});

Deno.test("postNoIssuesFoundComments - logs and continues on individual failures", async () => {
  const ghFn = (args: string[]): Promise<string> => {
    const numIdx = args.indexOf("comment") + 1;
    if (args[numIdx] === "2694") {
      throw new Error("permission denied");
    }
    return Promise.resolve("");
  };
  const logs: string[] = [];
  await postNoIssuesFoundComments({
    repo: "owner/repo",
    issueNumbers: [2694, 2703],
    milestoneTitle: "idle-task: security-scan",
    changedFiles: [],
    ghCommandFn: ghFn,
    log: (m) => logs.push(m),
  });
  const failed = logs.find((l) => l.includes("WARNING") && l.includes("2694"));
  const succeeded = logs.find((l) =>
    l.includes("Posted") && l.includes("2703")
  );
  assertEquals(typeof failed, "string");
  assertEquals(typeof succeeded, "string");
});
