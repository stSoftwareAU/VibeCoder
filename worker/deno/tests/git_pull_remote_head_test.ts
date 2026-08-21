/**
 * The branch-update pass must judge a PR by its remote head (Issue #211).
 *
 * The worker reuses a clone across passes, so the local copy of a PR branch can
 * carry commits the remote does not have (a previous run's leftovers, or work a
 * sibling host rebased away). Rebasing *that* onto the base branch can conflict
 * where the PR's real head would not — which is how PR #557 was labelled
 * `merge-conflict` while GitHub reported it mergeable. The pass therefore
 * fast-forwards onto the remote head, and refuses loudly — with a distinct
 * error, never a conflict verdict — when the local branch is ahead of it.
 *
 * Real git repositories — no stubs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { isPrBranchConflictError, updatePrBranch } from "../lib/git_pull.ts";
import { isLocalAheadOfRemoteError } from "../lib/git_branch_sync.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGitCommand(args, { cwd });
  return result.ok ? result.value.stdout.trim() : "";
}

/**
 * Build a repo where the PR branch is clean against the base, but the local
 * copy of it carries an unpushed commit that collides with the base.
 */
async function setupStaleLocalBranch(): Promise<{
  tmpDir: string;
  localPath: string;
  staleSha: string;
  remoteHead: string;
}> {
  const tmpDir = await Deno.makeTempDir({ prefix: "git_pull_remote_head_" });
  const remotePath = `${tmpDir}/remote.git`;
  const localPath = `${tmpDir}/local`;

  await Deno.mkdir(remotePath, { recursive: true });
  await runGitCommand(["init", "--bare"], { cwd: remotePath });
  await runGitCommand(["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: remotePath,
  });
  await runGitCommand(["clone", remotePath, localPath], { cwd: tmpDir });
  await runGitCommand(["config", "user.email", "test@example.com"], {
    cwd: localPath,
  });
  await runGitCommand(["config", "user.name", "Test User"], { cwd: localPath });

  await Deno.writeTextFile(`${localPath}/shared.txt`, "base\n");
  await runGitCommand(["add", "."], { cwd: localPath });
  await runGitCommand(["commit", "-m", "Initial commit"], { cwd: localPath });
  await runGitCommand(["push", "origin", "main"], { cwd: localPath });

  // The PR branch: touches a different file, so it rebases onto main cleanly.
  await runGitCommand(["checkout", "-b", "issue-556-fix"], { cwd: localPath });
  await Deno.writeTextFile(`${localPath}/feature.txt`, "feature\n");
  await runGitCommand(["add", "."], { cwd: localPath });
  await runGitCommand(["commit", "-m", "Add feature"], { cwd: localPath });
  await runGitCommand(["push", "-u", "origin", "issue-556-fix"], {
    cwd: localPath,
  });
  const remoteHead = await git(["rev-parse", "HEAD"], localPath);

  // main moves on, touching shared.txt.
  await runGitCommand(["checkout", "main"], { cwd: localPath });
  await Deno.writeTextFile(`${localPath}/shared.txt`, "main change\n");
  await runGitCommand(["add", "."], { cwd: localPath });
  await runGitCommand(["commit", "-m", "Change shared on main"], {
    cwd: localPath,
  });
  await runGitCommand(["push", "origin", "main"], { cwd: localPath });

  // The stale local-only commit on the PR branch: collides with main.
  await runGitCommand(["checkout", "issue-556-fix"], { cwd: localPath });
  await Deno.writeTextFile(`${localPath}/shared.txt`, "stale local change\n");
  await runGitCommand(["add", "."], { cwd: localPath });
  await runGitCommand(["commit", "-m", "Stale local commit"], {
    cwd: localPath,
  });
  const staleSha = await git(["rev-parse", "HEAD"], localPath);
  await runGitCommand(["checkout", "main"], { cwd: localPath });

  return { tmpDir, localPath, staleSha, remoteHead };
}

Deno.test("updatePrBranch - refuses a local branch ahead of the PR's remote head (Issue #211)", async () => {
  const { tmpDir, localPath, staleSha, remoteHead } =
    await setupStaleLocalBranch();
  try {
    const result = await updatePrBranch("issue-556-fix", "main", {
      cwd: localPath,
    });

    assertEquals(result.ok, false);
    if (!result.ok) {
      // The refusal must not read as a conflict verdict — that is what put a
      // `merge-conflict` label on a mergeable PR.
      assertEquals(isPrBranchConflictError(result.error), false);
      assert(
        isLocalAheadOfRemoteError(result.error),
        `expected the ahead-of-remote refusal, got: ${result.error.message}`,
      );
      assertStringIncludes(result.error.message, "1 commit(s)");
    }

    // The local-only commit is unpushed work: left exactly where it was, not
    // reset away, and never force-pushed over the PR's real head.
    const log = await git(["log", "--format=%H", "issue-556-fix"], localPath);
    assertStringIncludes(log, staleSha);
    assertEquals(
      await git(["rev-parse", "refs/remotes/origin/issue-556-fix"], localPath),
      remoteHead,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("updatePrBranch - a genuine conflict on the remote head is still left untouched (Issue #211)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "git_pull_remote_head_c_" });
  try {
    const remotePath = `${tmpDir}/remote.git`;
    const localPath = `${tmpDir}/local`;
    await Deno.mkdir(remotePath, { recursive: true });
    await runGitCommand(["init", "--bare"], { cwd: remotePath });
    await runGitCommand(["symbolic-ref", "HEAD", "refs/heads/main"], {
      cwd: remotePath,
    });
    await runGitCommand(["clone", remotePath, localPath], { cwd: tmpDir });
    await runGitCommand(["config", "user.email", "test@example.com"], {
      cwd: localPath,
    });
    await runGitCommand(["config", "user.name", "Test User"], {
      cwd: localPath,
    });

    await Deno.writeTextFile(`${localPath}/shared.txt`, "base\n");
    await runGitCommand(["add", "."], { cwd: localPath });
    await runGitCommand(["commit", "-m", "Initial commit"], { cwd: localPath });
    await runGitCommand(["push", "origin", "main"], { cwd: localPath });

    // The PR branch really does collide with main — and it is pushed.
    await runGitCommand(["checkout", "-b", "issue-9-collide"], {
      cwd: localPath,
    });
    await Deno.writeTextFile(`${localPath}/shared.txt`, "pr change\n");
    await runGitCommand(["add", "."], { cwd: localPath });
    await runGitCommand(["commit", "-m", "PR changes shared"], {
      cwd: localPath,
    });
    await runGitCommand(["push", "-u", "origin", "issue-9-collide"], {
      cwd: localPath,
    });

    await runGitCommand(["checkout", "main"], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/shared.txt`, "main change\n");
    await runGitCommand(["add", "."], { cwd: localPath });
    await runGitCommand(["commit", "-m", "main changes shared"], {
      cwd: localPath,
    });
    await runGitCommand(["push", "origin", "main"], { cwd: localPath });

    const result = await updatePrBranch("issue-9-collide", "main", {
      cwd: localPath,
    });

    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(
        isPrBranchConflictError(result.error),
        `expected a left-untouched conflict, got: ${result.error.message}`,
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
