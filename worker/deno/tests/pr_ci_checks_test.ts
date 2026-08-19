/**
 * Tests for pr_ci_checks.ts — CI check monitoring (Issue #915).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  buildMaxRetriesComment,
  encodeBase64,
  formatFailedCheck,
  getCiCheckRetryCount,
  isSpellingCheck,
  recordCiCheckRetry,
  sanitiseRepoName,
} from "../lib/pr_ci_checks.ts";

// --- sanitiseRepoName ---

Deno.test("pr_ci_checks - sanitiseRepoName replaces slash with underscore", () => {
  assertEquals(sanitiseRepoName("owner/repo"), "owner_repo");
});

Deno.test("pr_ci_checks - sanitiseRepoName handles repo without slash", () => {
  assertEquals(sanitiseRepoName("repo"), "repo");
});

// --- recordCiCheckRetry / getCiCheckRetryCount ---

Deno.test("pr_ci_checks - recordCiCheckRetry increments count", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const count1 = await recordCiCheckRetry(tmpDir, "owner/repo", "12345");
    assertEquals(count1, 1);

    const count2 = await recordCiCheckRetry(tmpDir, "owner/repo", "12345");
    assertEquals(count2, 2);

    const count3 = await recordCiCheckRetry(tmpDir, "owner/repo", "12345");
    assertEquals(count3, 3);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("pr_ci_checks - getCiCheckRetryCount returns 0 for new check", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const count = await getCiCheckRetryCount(
      tmpDir,
      "owner/repo",
      "nonexistent",
    );
    assertEquals(count, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("pr_ci_checks - getCiCheckRetryCount returns recorded count", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await recordCiCheckRetry(tmpDir, "owner/repo", "99999");
    await recordCiCheckRetry(tmpDir, "owner/repo", "99999");
    const count = await getCiCheckRetryCount(tmpDir, "owner/repo", "99999");
    assertEquals(count, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("pr_ci_checks - recordCiCheckRetry handles different checks independently", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await recordCiCheckRetry(tmpDir, "owner/repo", "aaa");
    await recordCiCheckRetry(tmpDir, "owner/repo", "aaa");
    await recordCiCheckRetry(tmpDir, "owner/repo", "bbb");

    assertEquals(await getCiCheckRetryCount(tmpDir, "owner/repo", "aaa"), 2);
    assertEquals(await getCiCheckRetryCount(tmpDir, "owner/repo", "bbb"), 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- buildMaxRetriesComment ---

Deno.test("pr_ci_checks - buildMaxRetriesComment includes check name and count", () => {
  const comment = buildMaxRetriesComment("validate-scripts", "12345", 3);
  assertEquals(comment.includes("validate-scripts"), true);
  assertEquals(comment.includes("12345"), true);
  assertEquals(comment.includes("3 times"), true);
  assertEquals(comment.includes("Manual intervention"), true);
});

// --- isSpellingCheck ---

Deno.test("pr_ci_checks - isSpellingCheck identifies spelling checks", () => {
  assertEquals(isSpellingCheck("cspell"), true);
  assertEquals(isSpellingCheck("Spell Check"), true);
  assertEquals(isSpellingCheck("codespell"), true);
  assertEquals(isSpellingCheck("typo-ci"), true);
});

Deno.test("pr_ci_checks - isSpellingCheck rejects non-spelling checks", () => {
  assertEquals(isSpellingCheck("validate-scripts"), false);
  assertEquals(isSpellingCheck("build"), false);
  assertEquals(isSpellingCheck("test"), false);
});

// --- encodeBase64 ---

Deno.test("pr_ci_checks - encodeBase64 encodes correctly", () => {
  assertEquals(encodeBase64("hello"), btoa("hello"));
  assertEquals(encodeBase64(""), btoa(""));
});

// --- formatFailedCheck ---

Deno.test("pr_ci_checks - formatFailedCheck returns pipe-delimited string", () => {
  const result = formatFailedCheck({
    repo: "owner/repo",
    prNumber: 42,
    branchName: "fix-branch",
    checkId: "12345",
    checkName: "validate-scripts",
    encodedAnnotations: "base64data",
  });
  assertEquals(
    result,
    "owner/repo|42|fix-branch|12345|validate-scripts|base64data",
  );
});
