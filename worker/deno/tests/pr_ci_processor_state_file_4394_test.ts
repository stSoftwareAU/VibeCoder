/**
 * Regression tests for Issue #4394: the post-Claude commit step must unstage
 * worker-owned state files (e.g. `.pr_response_message`) and run the pre-commit
 * safety gate before it commits.
 *
 * Drives `processCiFailure` with the REAL git runner against a real temporary
 * repository (one initial commit, no `.gitignore`). The push is mocked.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import type { Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const PR_RESPONSE_MESSAGE = ".pr_response_message";

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

function makeInput(): CiFixInput {
  const annotations = [
    {
      path: "tests/main_test.ts",
      start_line: 42,
      message: "Test assertion failed",
    },
  ];
  return {
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    checkRunId: "67890",
    checkName: "CI / test",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  };
}

/** Runs a git command in `cwd` and returns stdout, throwing on failure. */
async function gitOut(cwd: string, args: string[]): Promise<string> {
  const result = await runGitCommand(args, { cwd });
  if (!result.ok || result.value.code !== 0) {
    const detail = result.ok ? result.value.stderr : result.error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.value.stdout;
}

/**
 * A real repository with exactly one initial commit and no `.gitignore`,
 * checked out on the PR branch so `preparePrBranch` lets the agent run.
 */
async function makeRepo(): Promise<string> {
  const repo = await Deno.makeTempDir({ prefix: "ci_fix_4394_repo_" });
  await gitOut(repo, ["init", "-q"]);
  await gitOut(repo, ["config", "user.email", "worker@example.invalid"]);
  await gitOut(repo, ["config", "user.name", "Worker Test"]);
  await gitOut(repo, ["config", "commit.gpgsign", "false"]);
  await Deno.writeTextFile(`${repo}/README.md`, "# fixture\n");
  await gitOut(repo, ["add", "--", "README.md"]);
  await gitOut(repo, ["commit", "-q", "-m", "Initial commit"]);
  await gitOut(repo, ["checkout", "-q", "-b", makeInput().branchName]);
  return repo;
}

async function commitCount(repo: string): Promise<number> {
  return Number((await gitOut(repo, ["rev-list", "--count", "HEAD"])).trim());
}

/** What the push saw: how often it ran, and what was on disk at that moment. */
interface PushObservation {
  pushCalls: number;
  /** Paths from `agentFiles` still on disk when the push ran. */
  onDiskAtPush: string[];
}

/**
 * Runs `processCiFailure` in `repo`, with `agentWrites` standing in for the
 * Claude fix. The quality gate passes, so the post-Claude commit step runs.
 * The push is mocked; it records which of `agentFiles` are still on disk,
 * because `readPrResponseMessage` removes `.pr_response_message` after it.
 */
async function runCiFix(
  repo: string,
  stateRoot: string,
  agentFiles: readonly string[],
  agentWrites: (repo: string) => Promise<void>,
): Promise<{
  result: Awaited<ReturnType<typeof processCiFailure>>;
  push: PushObservation;
}> {
  const push: PushObservation = { pushCalls: 0, onDiskAtPush: [] };
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (async () => {
      await agentWrites(repo);
      return {
        ok: true,
        value: { output: "Fixed", exitCode: 0, timedOut: false },
      };
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: openPrGh(),
  };
  const deps = createMockDeps({
    claude: mockClaude,
    github: mockGithub,
    git: {
      // The real runner: the unstage and safety gate run against `repo`.
      runGitCommand,
      commitAndPushPending: (async () => {
        push.pushCalls++;
        for (const file of agentFiles) {
          if (await fileExists(`${repo}/${file}`)) {
            push.onDiskAtPush.push(file);
          }
        }
        return {
          ok: true,
          value: {
            committedNewChanges: false,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        };
      }) as unknown as GitDeps["commitAndPushPending"],
    },
  });
  const processorDeps: CiProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    // Outside the repo, so `git add -A` never stages the state directory.
    stateDir: `${stateRoot}/.ci_check_state`,
    workDir: repo,
    workRoot: repo,
    qualityGateFn: () =>
      Promise.resolve({ action: "passed", qualityOutput: "" }),
  };
  const result = await processCiFailure(makeInput(), processorDeps);
  return { result, push };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("processCiFailure - only worker state changed after Claude creates no commit and keeps .pr_response_message on disk (Issue #4394)", async () => {
  const repo = await makeRepo();
  const stateRoot = await Deno.makeTempDir({ prefix: "ci_fix_4394_state_" });
  try {
    const before = await commitCount(repo);

    const { result, push } = await runCiFix(
      repo,
      stateRoot,
      [PR_RESPONSE_MESSAGE],
      async (dir) => {
        await Deno.writeTextFile(`${dir}/${PR_RESPONSE_MESSAGE}`, "Reply\n");
      },
    );
    assertEquals(result.ok, true);
    assertEquals(
      push.pushCalls,
      1,
      "the push must run, so the on-disk check at push time is meaningful",
    );

    assertEquals(
      await commitCount(repo),
      before,
      "no new commit should be created when only worker state changed",
    );
    assertEquals(
      push.onDiskAtPush.includes(PR_RESPONSE_MESSAGE),
      true,
      ".pr_response_message must still be on disk at push time, for readPrResponseMessage",
    );
    const tracked = await gitOut(repo, ["ls-files"]);
    assertEquals(
      tracked.split("\n").includes(PR_RESPONSE_MESSAGE),
      false,
      ".pr_response_message must not be tracked",
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test("processCiFailure - real fix plus .pr_response_message commits only the fix (Issue #4394)", async () => {
  const repo = await makeRepo();
  const stateRoot = await Deno.makeTempDir({ prefix: "ci_fix_4394_state_" });
  try {
    const before = await commitCount(repo);

    const { result, push } = await runCiFix(
      repo,
      stateRoot,
      [PR_RESPONSE_MESSAGE],
      async (dir) => {
        await Deno.mkdir(`${dir}/src`, { recursive: true });
        await Deno.writeTextFile(
          `${dir}/src/fix.ts`,
          "export const fixed = 1;\n",
        );
        await Deno.writeTextFile(`${dir}/${PR_RESPONSE_MESSAGE}`, "Reply\n");
      },
    );
    assertEquals(result.ok, true);
    assertEquals(push.pushCalls, 1, "the push must run");

    assertEquals(
      await commitCount(repo),
      before + 1,
      "exactly one new commit should be created for the real fix",
    );
    const committed = (await gitOut(repo, [
      "show",
      "--name-only",
      "--format=",
      "HEAD",
    ]))
      .split("\n")
      .filter((line) => line.length > 0);
    assertEquals(
      committed.includes("src/fix.ts"),
      true,
      `the commit should include src/fix.ts; got: ${committed.join(", ")}`,
    );
    assertEquals(
      committed.includes(PR_RESPONSE_MESSAGE),
      false,
      `the commit must not include ${PR_RESPONSE_MESSAGE}; got: ${
        committed.join(", ")
      }`,
    );
    assertEquals(
      push.onDiskAtPush.includes(PR_RESPONSE_MESSAGE),
      true,
      ".pr_response_message must still be on disk at push time, for readPrResponseMessage",
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test("processCiFailure - the safety gate still refuses a secret-bearing file beside worker state (Issue #4394)", async () => {
  const repo = await makeRepo();
  const stateRoot = await Deno.makeTempDir({ prefix: "ci_fix_4394_state_" });
  try {
    const before = await commitCount(repo);

    const { push } = await runCiFix(
      repo,
      stateRoot,
      [".env", PR_RESPONSE_MESSAGE],
      async (dir) => {
        await Deno.writeTextFile(`${dir}/.env`, "API_TOKEN=not-a-real-token\n");
        await Deno.writeTextFile(`${dir}/${PR_RESPONSE_MESSAGE}`, "Reply\n");
      },
    );

    assertEquals(
      await commitCount(repo),
      before,
      "the pre-commit safety gate must refuse the commit when .env is staged",
    );
    assertEquals(
      push.onDiskAtPush.includes(".env"),
      true,
      ".env must stay on disk; the gate refuses the commit, it does not delete",
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
    await Deno.remove(stateRoot, { recursive: true });
  }
});
