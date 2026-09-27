/**
 * Tests for codebase map wiring in the issue phase (Issue #4281).
 *
 * The phase must generate (or reuse) the map for the repository checkout and
 * hand it to the prompt builder, honour the opt-out, and continue — loudly —
 * when the map cannot be generated.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import type { CachedIssuePromptOptions } from "../lib/prompt_builder_cache.ts";

function createMockDeps(
  captured: { options?: CachedIssuePromptOptions },
  logs: string[],
): ExecuteClaudePhaseDeps {
  return {
    runClaudeWithRetry: () =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 0, output: "done", timedOut: false },
      }),
    buildIssuePrompt: () =>
      Promise.resolve({
        ok: true,
        value: { systemPrompt: "sys", prompt: "user" },
      }),
    buildCachedIssuePrompt: (options: CachedIssuePromptOptions) => {
      captured.options = options;
      return Promise.resolve({
        ok: true as const,
        value: {
          systemPrompt: "sys",
          prompt: "user",
          promptSha: "a".repeat(64),
          cacheHit: false,
        },
      });
    },
    validateRepoState: () =>
      Promise.resolve({
        ok: true,
        value: { valid: true, actions: [], warnings: [] },
      }),
    findExistingPrForBranch: () =>
      Promise.resolve({ ok: false, error: new Error("No PR found") }),
    retargetPrToMilestone: () => Promise.resolve({ ok: true, value: "ok" }),
    finalisePr: () => Promise.resolve({ ok: true, value: "ok" }),
    ensureIssueClosedIfPrMerged: () =>
      Promise.resolve({ ok: true, value: undefined }),
    runGitCommand: (args: string[]) =>
      Promise.resolve({
        ok: true,
        value: args[0] === "status" ? "M src/main.ts" : "",
      }),
    recordHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    clearHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    getPromptsCommit: () => Promise.resolve({ ok: true, value: "abc1234" }),
    log: (message: string) => logs.push(message),
  };
}

function createTestOptions(
  overrides: Partial<ExecuteClaudePhaseOptions> = {},
): ExecuteClaudePhaseOptions {
  return {
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Fix the parser",
    issueBody: "The date parser drops the year.",
    issueLabels: "bug",
    githubUser: "bot-user",
    branchName: "issue-42-fix-the-parser",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: "/tmp/test-work-4281",
    includeRecentActivity: false,
    ...overrides,
  };
}

async function git(dir: string, args: string[]): Promise<void> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

/** Build a work directory holding a git checkout named `repo`. */
async function withWorkDir(
  fn: (workDir: string, cacheDir: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "phase_map_work_" });
  const cacheDir = await Deno.makeTempDir({ prefix: "phase_map_cache_" });
  const repoDir = `${workDir}/repo`;
  await Deno.mkdir(`${repoDir}/src`, { recursive: true });
  await git(repoDir, ["init", "-q"]);
  await git(repoDir, ["config", "user.email", "test@example.com"]);
  await git(repoDir, ["config", "user.name", "test"]);
  await Deno.writeTextFile(
    `${repoDir}/src/date_parser.ts`,
    "/** Parses ISO dates into epoch seconds. */\n",
  );
  try {
    await fn(workDir, cacheDir);
  } finally {
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(cacheDir, { recursive: true });
  }
}

Deno.test("runExecuteClaudePhase - hands the generated codebase map to the prompt builder", async () => {
  await withWorkDir(async (workDir, cacheDir) => {
    const captured: { options?: CachedIssuePromptOptions } = {};
    const logs: string[] = [];
    await runExecuteClaudePhase(
      createTestOptions({ workDir, codebaseMapCacheDir: cacheDir }),
      createMockDeps(captured, logs),
    );

    const map = captured.options?.codebaseMap;
    assert(map, "expected a codebase map to reach the prompt builder");
    assertStringIncludes(
      map,
      "src/date_parser.ts — Parses ISO dates into epoch seconds.",
    );
    assert(
      logs.some((l) => l.includes("Codebase map:")),
      "the phase must report the map it built",
    );
  });
});

Deno.test("runExecuteClaudePhase - reuses the cached map on the second run", async () => {
  await withWorkDir(async (workDir, cacheDir) => {
    const first: { options?: CachedIssuePromptOptions } = {};
    const firstLogs: string[] = [];
    await runExecuteClaudePhase(
      createTestOptions({ workDir, codebaseMapCacheDir: cacheDir }),
      createMockDeps(first, firstLogs),
    );

    const second: { options?: CachedIssuePromptOptions } = {};
    const secondLogs: string[] = [];
    await runExecuteClaudePhase(
      createTestOptions({ workDir, codebaseMapCacheDir: cacheDir }),
      createMockDeps(second, secondLogs),
    );

    assertEquals(second.options?.codebaseMap, first.options?.codebaseMap);
    assert(
      secondLogs.some((l) => l.includes("(cached)")),
      "the second run must be served from cache",
    );
  });
});

Deno.test("runExecuteClaudePhase - includeCodebaseMap=false skips the map", async () => {
  await withWorkDir(async (workDir, cacheDir) => {
    const captured: { options?: CachedIssuePromptOptions } = {};
    const logs: string[] = [];
    await runExecuteClaudePhase(
      createTestOptions({
        workDir,
        codebaseMapCacheDir: cacheDir,
        includeCodebaseMap: false,
      }),
      createMockDeps(captured, logs),
    );

    assertEquals(captured.options?.codebaseMap, undefined);
    assertEquals(logs.some((l) => l.includes("Codebase map:")), false);
  });
});

Deno.test("runExecuteClaudePhase - a map failure warns loudly and does not stop the phase", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "phase_map_nogit_" });
  const cacheDir = await Deno.makeTempDir({ prefix: "phase_map_cache_" });
  try {
    // No checkout at workDir/repo at all — generation must fail.
    const captured: { options?: CachedIssuePromptOptions } = {};
    const logs: string[] = [];
    const result = await runExecuteClaudePhase(
      createTestOptions({ workDir, codebaseMapCacheDir: cacheDir }),
      createMockDeps(captured, logs),
    );

    assertEquals(captured.options?.codebaseMap, undefined);
    assert(
      logs.some((l) => l.startsWith("WARN: codebase map unavailable")),
      `expected a loud warning, got: ${logs.join(" | ")}`,
    );
    assert(
      result.action !== "failure",
      "a missing map must not fail the phase",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(cacheDir, { recursive: true });
  }
});
