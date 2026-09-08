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
  isSpellingStep,
  recordCiCheckRetry,
  resolveCheckFixRoute,
  sanitiseRepoName,
} from "../lib/pr_ci_checks.ts";
import type { Logger } from "../types.ts";

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

// --- isSpellingStep / resolveCheckFixRoute (Issue #1579) ---

Deno.test("pr_ci_checks - isSpellingStep matches the three spelling tools only", () => {
  assertEquals(isSpellingStep("Run codespell"), true);
  assertEquals(isSpellingStep("cspell"), true);
  assertEquals(isSpellingStep("Check typos with typos-cli"), true);
  assertEquals(isSpellingStep("Run bats (tests/scripts)"), false);
  assertEquals(isSpellingStep("Spelling"), false);
});

/** A `gh` stub serving one Actions job with the given failing step. */
function ghForFailedStep(
  stepName: string,
  calls: string[][] = [],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push(args);
    const endpoint = args[args.length - 1] ?? "";
    if (endpoint === "repos/o/r/check-runs/900") {
      return Promise.resolve(JSON.stringify({
        app: { slug: "github-actions" },
        details_url: "https://github.com/o/r/actions/runs/12/job/34",
      }));
    }
    if (endpoint === "repos/o/r/actions/jobs/34") {
      return Promise.resolve(JSON.stringify({
        steps: [
          { name: "Set up job", conclusion: "success" },
          { name: stepName, conclusion: "failure" },
        ],
      }));
    }
    return Promise.reject(new Error(`unexpected gh api call: ${endpoint}`));
  };
}

Deno.test("pr_ci_checks - a non-spelling check name routes to CI-fix with no extra API call", async () => {
  const calls: string[][] = [];
  const routing = await resolveCheckFixRoute({
    repo: "o/r",
    checkId: "900",
    checkName: "build",
    ghCommandFn: (args) => {
      calls.push(args);
      return Promise.resolve("{}");
    },
  });

  assertEquals(routing.route, "ci-fix");
  assertEquals(calls.length, 0);
});

Deno.test("pr_ci_checks - a bats failure inside a spelling-named job routes to CI-fix (Issue #1579)", async () => {
  const routing = await resolveCheckFixRoute({
    repo: "o/r",
    checkId: "900",
    checkName: "Scripts & spelling",
    ghCommandFn: ghForFailedStep("Run bats (tests/scripts)"),
  });

  assertEquals(routing.route, "ci-fix");
  assertEquals(routing.failedStep, "Run bats (tests/scripts)");
});

Deno.test("pr_ci_checks - a codespell step failure still routes to the spelling fixer", async () => {
  const routing = await resolveCheckFixRoute({
    repo: "o/r",
    checkId: "900",
    checkName: "Scripts & spelling",
    ghCommandFn: ghForFailedStep("Run codespell"),
  });

  assertEquals(routing.route, "spelling");
  assertEquals(routing.failedStep, "Run codespell");
});

Deno.test("pr_ci_checks - an unresolvable failed step routes to CI-fix and says why", async () => {
  const logged: string[] = [];
  const routing = await resolveCheckFixRoute({
    repo: "o/r",
    checkId: "900",
    checkName: "cspell",
    ghCommandFn: () => Promise.reject(new Error("HTTP 500")),
    logger: makeCapturingLogger(logged),
  });

  assertEquals(routing.route, "ci-fix");
  assertEquals(routing.failedStep, undefined);
  assertEquals(logged.length, 1);
  assertEquals(routing.reason.includes("HTTP 500"), true);
});

/** Minimal logger recording `info` messages only. */
function makeCapturingLogger(sink: string[]): Logger {
  const noop = () => {};
  return {
    info: (message: string) => sink.push(message),
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}
