/**
 * Push-recovery diagnostics (Issue #211).
 *
 * A rejected push used to be logged as a bare "Push failed after recovery
 * attempt": the recovery Result's error — which names whether the rebase
 * conflicted, auto-resolution gave up, or `--force-with-lease` was refused —
 * was discarded, and git's stderr with it. The operator was left with a
 * "please check the branch status" comment and nothing to check it against.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { recoverFromPushRejection } from "../lib/git_push_recovery.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";

/** Run a git command in a repo, failing loudly on a non-zero exit. */
async function git(args: string[], cwd: string): Promise<void> {
  const result = await runGitCommand(args, { cwd });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(
      `git ${
        args.join(" ")
      } failed (${result.value.code}): ${result.value.stderr}`,
    );
  }
}

// ---------------------------------------------------------------------------
// recoverFromPushRejection — the failing step and git's own words
// ---------------------------------------------------------------------------

Deno.test("recoverFromPushRejection - names the failing step and carries git stderr", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "recovery_detail_" });
  try {
    const repoPath = `${tmpDir}/repo`;
    await Deno.mkdir(repoPath, { recursive: true });
    await git(["init", "-b", "feature"], repoPath);
    await git(["config", "user.email", "worker@example.com"], repoPath);
    await git(["config", "user.name", "Worker"], repoPath);
    await Deno.writeTextFile(`${repoPath}/README.md`, "# Test\n");
    await git(["add", "README.md"], repoPath);
    await git(["commit", "-m", "Initial commit"], repoPath);
    // A remote that does not exist — every git step against it fails loudly.
    await git(["remote", "add", "origin", `${tmpDir}/missing.git`], repoPath);

    const result = await recoverFromPushRejection("feature", { cwd: repoPath });

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "Push recovery step");
      // git's own diagnosis of the failure, not a generic message.
      assertStringIncludes(result.error.message, "missing.git");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// processCiFailure — the recovery error reaches the log
// ---------------------------------------------------------------------------

interface CapturedLog {
  message: string;
  context?: Record<string, unknown>;
}

function makeCapturingLogger(errors: CapturedLog[]): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: ((message: string, context?: Record<string, unknown>) => {
      errors.push({ message, context });
    }) as Logger["error"],
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

function makeInput(): CiFixInput {
  return {
    repo: "org/repo",
    prNumber: 557,
    branchName: "issue-556-fix",
    checkRunId: "67890",
    checkName: "Quality Checks",
    encodedAnnotations: btoa(JSON.stringify([])),
  };
}

Deno.test("processCiFailure - logs the recovery error when the push cannot be recovered", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "recovery_log_" });
  const errors: CapturedLog[] = [];
  try {
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Fixed", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const mockGithub: Partial<GitHubDeps> = {
      runGhCommand: () => Promise.resolve(""),
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: true,
              commitsPushed: 0,
              finalUnpushedCount: 4,
              finalUnpushedSource: "remote-head" as const,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
        recoverFromPushRejection: (() =>
          Promise.resolve({
            ok: false,
            error: new Error(
              "Push recovery step 'retry-push' failed: ! [rejected] issue-556-fix -> issue-556-fix (fetch first)",
            ),
          })) as unknown as GitDeps["recoverFromPushRejection"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      logger: makeCapturingLogger(errors),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);

    const pushFailure = errors.find((e) =>
      e.message.includes("Push failed after recovery attempt")
    );
    assertEquals(
      pushFailure !== undefined,
      true,
      "the push failure must still be logged",
    );
    const recoveryError = String(pushFailure?.context?.recoveryError ?? "");
    assertStringIncludes(recoveryError, "retry-push");
    assertStringIncludes(recoveryError, "fetch first");
    assertEquals(pushFailure?.context?.unpushed, 4);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
