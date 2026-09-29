/**
 * Tests for the git push recovery module (Issue #1309, #2808).
 *
 * Error handling paths run in a temp directory that is not a git repo; the
 * merge-and-push paths drive real repositories end to end and assert over the
 * recorded git argv that recovery never forces and never rebases.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { recoverFromPushRejection } from "../lib/git_push_recovery.ts";
import {
  commitFile,
  git,
  setupDivergedRepos,
} from "./support/push_recovery_repos.ts";
import {
  isForcedPush,
  recordedPushes,
  recordedRebase,
  startGitTrace,
} from "./support/git_trace.ts";

// ============================================================================
// Error handling paths — exercised in non-git directories
// ============================================================================

Deno.test("recoverFromPushRejection - fails gracefully when not in a git repo", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await recoverFromPushRejection("test-branch", {
      cwd: tmpDir,
    });
    // Should return an error result, not throw
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(typeof result.error.message, "string");
      assertEquals(result.error.message.length > 0, true);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("recoverFromPushRejection - handles empty branch name", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await recoverFromPushRejection("", { cwd: tmpDir });
    // Refused by the ref guard before any git runs
    assertEquals(result.ok, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Merge-and-push recovery (Issue #2808) — real repositories
// ============================================================================

Deno.test("recoverFromPushRejection - merges the remote in and pushes plainly, keeping the other author's commit (Issue #2808)", async () => {
  const repos = await setupDivergedRepos("other.txt", "other work\n");
  const trace = await startGitTrace();
  try {
    await commitFile(repos.workerPath, "worker.txt", "worker work\n");
    const workerSha = await git(["rev-parse", "HEAD"], repos.workerPath);

    const result = await recoverFromPushRejection(repos.branch, {
      cwd: repos.workerPath,
      env: trace.env,
    });

    assertEquals(result.ok, true);
    // Success is reported only once the push landed: the remote tip is the
    // local merge commit, which carries both authors' commits.
    const remoteTip = await git(
      ["rev-parse", `refs/heads/${repos.branch}`],
      repos.remotePath,
    );
    assertEquals(remoteTip, await git(["rev-parse", "HEAD"], repos.workerPath));
    for (const sha of [repos.otherSha, workerSha]) {
      await git(
        ["merge-base", "--is-ancestor", sha, remoteTip],
        repos.remotePath,
      );
    }
    const pushes = await recordedPushes(trace);
    assertEquals(pushes.length, 1, "exactly one retried push");
    assert(
      !pushes.some(isForcedPush),
      `forced push: ${JSON.stringify(pushes)}`,
    );
    assertEquals(await recordedRebase(trace), false);
    const commands = await trace.commands();
    assert(
      commands.some((argv) => argv[0] === "merge"),
      "recovery must merge the remote branch",
    );
    assert(
      !commands.some((argv) => argv[0] === "pull"),
      "recovery must not pull (and so never pull --rebase)",
    );
  } finally {
    await trace.dispose();
    await Deno.remove(repos.tmpDir, { recursive: true });
  }
});

Deno.test("recoverFromPushRejection - a conflicting merge is aborted and the other author's commit survives (Issue #2808)", async () => {
  const repos = await setupDivergedRepos("shared.txt", "other version\n");
  const trace = await startGitTrace();
  try {
    await commitFile(repos.workerPath, "shared.txt", "worker version\n");
    const workerSha = await git(["rev-parse", "HEAD"], repos.workerPath);

    const result = await recoverFromPushRejection(repos.branch, {
      cwd: repos.workerPath,
      env: trace.env,
    });

    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(
        result.error.message.includes("Push recovery step 'merge' failed"),
        `diagnostic must name the merge step, got: ${result.error.message}`,
      );
      assert(
        result.error.message.includes("shared.txt"),
        `diagnostic must name the conflicted path, got: ${result.error.message}`,
      );
    }
    assertEquals(
      await git(["rev-parse", `refs/heads/${repos.branch}`], repos.remotePath),
      repos.otherSha,
      "the other author's commit must remain the remote tip",
    );
    // The merge was aborted: the branch is exactly as it was, no merge pending.
    assertEquals(await git(["rev-parse", "HEAD"], repos.workerPath), workerSha);
    assertEquals(await git(["status", "--porcelain"], repos.workerPath), "");
    assertEquals((await recordedPushes(trace)).length, 0, "no push at all");
    assertEquals(await recordedRebase(trace), false);
  } finally {
    await trace.dispose();
    await Deno.remove(repos.tmpDir, { recursive: true });
  }
});
