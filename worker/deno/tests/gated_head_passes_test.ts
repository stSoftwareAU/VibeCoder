/**
 * The three agent PR passes stand down from a ruleset-gated head (Issue #1679).
 *
 * `stSoftwareAU/GRQ#4702` is the case: its head is a `milestone/**` branch
 * under a `required_status_checks` ruleset, so every direct push was refused
 * with GH013 — once per worker run, spending a merge-conflict attempt and a
 * CI-fix retry on a push that could never land. These tests assert the pass
 * stops before the agent runs and before its budget is spent.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { processSpellingFailure } from "../lib/pr_spelling_processor.ts";
import { processCiFailure } from "../lib/pr_ci_processor.ts";
import { processMergeConflict } from "../lib/pr_merge_conflict_processor.ts";
import { resetGatedHeadReportsForTest } from "../lib/gated_head_guard.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import type { ClaudeDeps, GitHubDeps } from "../lib/issue_worker_wiring.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const GATED_HEAD = "milestone/4690-bug-sampler-enospc";

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
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

/** What the pass did to GitHub and to the agent. */
interface Observed {
  ghCalls: string[][];
  agentRuns: number;
}

/**
 * Mock deps whose repo answers with a `required_status_checks` ruleset on the
 * milestone head — GRQ's ruleset 21835388, in effect.
 */
function makeDeps(observed: Observed) {
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      observed.ghCalls.push(args);
      const joined = args.join(" ");
      if (joined.includes("rules/branches")) {
        return Promise.resolve(
          JSON.stringify([{ type: "required_status_checks" }]),
        );
      }
      if (joined.includes("pr view")) {
        return Promise.resolve(JSON.stringify({ comments: [] }));
      }
      return Promise.resolve("");
    },
  };
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() => {
      observed.agentRuns++;
      return Promise.resolve({
        ok: true,
        value: { output: "ran", exitCode: 0, timedOut: false },
      });
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  return createMockDeps({ github: mockGithub, claude: mockClaude });
}

/** True when any `gh` call was a write beyond the stand-down comment. */
function wroteAnythingElse(observed: Observed): boolean {
  return observed.ghCalls.some((args) =>
    !(args[0] === "pr" && (args[1] === "comment" || args[1] === "view")) &&
    !args.join(" ").includes("rules/branches")
  );
}

function standDownComments(observed: Observed): string[] {
  return observed.ghCalls
    .filter((args) => args[0] === "pr" && args[1] === "comment")
    .map((args) => args[args.indexOf("--body") + 1] ?? "");
}

Deno.test("spelling pass - stands down from a gated head without running the agent (Issue #1679)", async () => {
  resetGatedHeadReportsForTest();
  const observed: Observed = { ghCalls: [], agentRuns: 0 };

  const result = await processSpellingFailure({
    repo: "org/repo",
    prNumber: 4702,
    branchName: GATED_HEAD,
    checkRunId: "1",
    checkName: "cspell",
    encodedAnnotations: btoa(JSON.stringify([])),
  }, {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps: makeDeps(observed),
    workDir: "/tmp/test-repo",
    workRoot: "/tmp/test-work-root",
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.processed, false);
    assertEquals(result.value.changesPushed, false);
    assertStringIncludes(result.value.summary, "refuses direct pushes");
  }
  assertEquals(observed.agentRuns, 0, "the agent must not run on a gated head");
  assertEquals(wroteAnythingElse(observed), false);
  const comments = standDownComments(observed);
  assertEquals(comments.length, 1, "one comment names the rule");
  assertStringIncludes(comments[0]!, "required_status_checks");
});

Deno.test("CI-fix pass - a gated head spends no retry (Issue #1679)", async () => {
  resetGatedHeadReportsForTest();
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-gated-ci-" });
  try {
    const observed: Observed = { ghCalls: [], agentRuns: 0 };
    const stateDir = `${tmpDir}/.ci_check_state`;

    const result = await processCiFailure({
      repo: "org/repo",
      prNumber: 4702,
      branchName: GATED_HEAD,
      checkRunId: "67890",
      checkName: "CI / test",
      encodedAnnotations: btoa(JSON.stringify([])),
    }, {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps: makeDeps(observed),
      stateDir,
      workDir: tmpDir,
      workRoot: tmpDir,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, false);
      assertEquals(
        result.value.retryCount,
        0,
        "a refusal that recurs every run must not spend a CI-fix retry",
      );
    }
    assertEquals(observed.agentRuns, 0);
    assertEquals(wroteAnythingElse(observed), false);
    assertEquals(standDownComments(observed).length, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("merge-conflict pass - a gated head opens no attempt (Issue #1679)", async () => {
  resetGatedHeadReportsForTest();
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-gated-merge-" });
  try {
    const observed: Observed = { ghCalls: [], agentRuns: 0 };

    const result = await processMergeConflict({
      repo: "org/repo",
      prNumber: 4702,
      branchName: GATED_HEAD,
      baseBranch: "Develop",
      attemptCount: 0,
    }, {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps: makeDeps(observed),
      workDir: tmpDir,
      workRoot: tmpDir,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, false);
      assertEquals(result.value.merged, false);
      assertEquals(result.value.escalated, false);
    }
    assertEquals(observed.agentRuns, 0);
    assertEquals(wroteAnythingElse(observed), false);
    // The stand-down comment is the only comment: no attempt marker was
    // posted, so the attempt budget is intact for a real conflict.
    const comments = standDownComments(observed);
    assertEquals(comments.length, 1);
    assertEquals(
      comments.some((body) => body.includes("Attempt")),
      false,
      "no merge-conflict attempt is opened on a gated head",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
