/**
 * Tests for evaluating a PR branch against its remote head (Issue #211).
 *
 * The branch-update pass runs in a long-lived clone. A run that failed to
 * push leaves its commits on the local branch, and nothing ever resets it.
 * The next pass merged the base into that stale branch, hit a conflict that
 * exists only locally, and labelled a mergeable PR `merge-conflict`
 * (NEAT-AI-core #557). The PR is what lives on origin, so that is what the
 * pass must evaluate.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  alignBranchWithRemoteHead,
  isPrBranchConflictError,
  updatePrBranch,
} from "../lib/git_pull.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const BRANCH = "issue-556-feature";

/** Bare remote + clone, with `main` seeded. */
async function setupRepos(
  tmpDir: string,
): Promise<{ remotePath: string; localPath: string }> {
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

  await Deno.writeTextFile(`${localPath}/README.md`, "# Test Repo\n");
  await runGitCommand(["add", "README.md"], { cwd: localPath });
  await runGitCommand(["commit", "-m", "Initial commit"], { cwd: localPath });
  await runGitCommand(["push", "origin", "main"], { cwd: localPath });

  return { remotePath, localPath };
}

async function headSha(cwd: string): Promise<string> {
  const result = await runGitCommand(["rev-parse", "HEAD"], { cwd });
  return result.ok ? result.value.stdout.trim() : "";
}

/**
 * Reproduce the incident: the PR branch on origin is mergeable with the base,
 * but the local clone still carries an unpushed commit that collides with the
 * base's change to the same file.
 */
async function seedStaleLocalBranch(localPath: string): Promise<string> {
  // The PR as it exists on origin: touches only feature.txt.
  await runGitCommand(["checkout", "-b", BRANCH], { cwd: localPath });
  await Deno.writeTextFile(`${localPath}/feature.txt`, "feature work\n");
  await runGitCommand(["add", "."], { cwd: localPath });
  await runGitCommand(["commit", "-m", "PR commit"], { cwd: localPath });
  await runGitCommand(["push", "-u", "origin", BRANCH], { cwd: localPath });
  const remoteHead = await headSha(localPath);

  // The base moves on, editing shared.txt.
  await runGitCommand(["checkout", "main"], { cwd: localPath });
  await Deno.writeTextFile(`${localPath}/shared.txt`, "base version\n");
  await runGitCommand(["add", "."], { cwd: localPath });
  await runGitCommand(["commit", "-m", "base change"], { cwd: localPath });
  await runGitCommand(["push", "origin", "main"], { cwd: localPath });

  // A failed run leaves an unpushed commit on the local PR branch that
  // collides with that base change.
  await runGitCommand(["checkout", BRANCH], { cwd: localPath });
  await Deno.writeTextFile(`${localPath}/shared.txt`, "local unpushed\n");
  await runGitCommand(["add", "."], { cwd: localPath });
  await runGitCommand(["commit", "-m", "unpushed local commit"], {
    cwd: localPath,
  });

  return remoteHead;
}

Deno.test("alignBranchWithRemoteHead - moves a stale local branch onto the remote head (Issue #211)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "remote_head_align_" });
  try {
    const { localPath } = await setupRepos(tmpDir);
    const remoteHead = await seedStaleLocalBranch(localPath);

    const result = await alignBranchWithRemoteHead(BRANCH, { cwd: localPath });

    assert(result.ok, !result.ok ? result.error.message : "");
    if (result.ok) {
      assertEquals(result.value.aligned, true);
      assertEquals(result.value.discardedLocalCommits, 1);
    }
    assertEquals(await headSha(localPath), remoteHead);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("alignBranchWithRemoteHead - leaves an in-sync branch untouched (Issue #211)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "remote_head_insync_" });
  try {
    const { localPath } = await setupRepos(tmpDir);
    await runGitCommand(["checkout", "-b", BRANCH], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/feature.txt`, "feature\n");
    await runGitCommand(["add", "."], { cwd: localPath });
    await runGitCommand(["commit", "-m", "PR commit"], { cwd: localPath });
    await runGitCommand(["push", "-u", "origin", BRANCH], { cwd: localPath });
    const before = await headSha(localPath);

    const result = await alignBranchWithRemoteHead(BRANCH, { cwd: localPath });

    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.aligned, false);
      assertEquals(result.value.discardedLocalCommits, 0);
    }
    assertEquals(await headSha(localPath), before);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("alignBranchWithRemoteHead - leaves a branch that origin does not have alone (Issue #211)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "remote_head_local_only_" });
  try {
    const { localPath } = await setupRepos(tmpDir);
    await runGitCommand(["checkout", "-b", BRANCH], { cwd: localPath });
    await Deno.writeTextFile(`${localPath}/feature.txt`, "feature\n");
    await runGitCommand(["add", "."], { cwd: localPath });
    await runGitCommand(["commit", "-m", "local only"], { cwd: localPath });
    const before = await headSha(localPath);

    const result = await alignBranchWithRemoteHead(BRANCH, { cwd: localPath });

    assert(result.ok);
    if (result.ok) assertEquals(result.value.aligned, false);
    assertEquals(
      await headSha(localPath),
      before,
      "a branch origin has never seen must not be reset",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("updatePrBranch - does not report a conflict that exists only on the stale local branch (Issue #211)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "remote_head_update_" });
  try {
    const { localPath } = await setupRepos(tmpDir);
    await seedStaleLocalBranch(localPath);

    const result = await updatePrBranch(BRANCH, "main", { cwd: localPath });

    assert(
      !isPrBranchConflictError(!result.ok ? result.error : null),
      `the remote PR is mergeable, so no conflict must be reported: ${
        !result.ok ? result.error.message : ""
      }`,
    );
    assert(result.ok, !result.ok ? result.error.message : "");

    // The base's change really is on the branch now.
    const shared = await Deno.readTextFile(`${localPath}/shared.txt`);
    assertEquals(shared, "base version\n");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
