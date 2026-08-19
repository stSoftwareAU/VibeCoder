/**
 * Force-with-lease regression tests for push recovery (Issue #3723).
 *
 * `recoverFromPushRejection` pulls before its last-resort force push. A bare
 * `--force-with-lease` leases against `refs/remotes/origin/<branch>` — the very
 * ref that pull just refreshed — so the lease could never fail and the push
 * behaved as a plain `--force`, overwriting a concurrent author's commits
 * (CWE-367). These tests drive real git repositories end to end.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { recoverFromPushRejection } from "../lib/git_push_recovery.ts";
import { buildForceWithLeaseArgs } from "../lib/git_push_lease_args.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

const BRANCH = "feature-lease";

/** Run a git command in a repo, failing loudly on a non-zero exit. */
async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGitCommand(args, { cwd });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(
      `git ${
        args.join(" ")
      } failed (${result.value.code}): ${result.value.stderr}`,
    );
  }
  return result.value.stdout.trim();
}

/** Resolve a ref, or null when it does not exist. */
async function revParse(ref: string, cwd: string): Promise<string | null> {
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", ref],
    {
      cwd,
    },
  );
  if (!result.ok || result.value.code !== 0) return null;
  return result.value.stdout.trim();
}

interface TestRepos {
  tmpDir: string;
  remotePath: string;
  /** The worker's clone — the one push recovery runs in. */
  workerPath: string;
  /** A second author's clone of the same remote. */
  otherPath: string;
}

/**
 * Create a bare remote plus two clones, with `BRANCH` pushed from the worker
 * clone. Both clones therefore start with the same remote-tracking ref.
 */
async function setupRepos(): Promise<TestRepos> {
  const tmpDir = await Deno.makeTempDir({ prefix: "push_recovery_lease_" });
  const remotePath = `${tmpDir}/remote.git`;
  const workerPath = `${tmpDir}/worker`;
  const otherPath = `${tmpDir}/other`;

  await Deno.mkdir(remotePath, { recursive: true });
  await git(["init", "--bare"], remotePath);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], remotePath);

  await git(["clone", remotePath, workerPath], tmpDir);
  await git(["config", "user.email", "worker@example.com"], workerPath);
  await git(["config", "user.name", "Worker"], workerPath);

  await Deno.writeTextFile(`${workerPath}/README.md`, "# Test\n");
  await git(["add", "README.md"], workerPath);
  await git(["commit", "-m", "Initial commit"], workerPath);
  await git(["push", "origin", "main"], workerPath);
  await git(["checkout", "-b", BRANCH], workerPath);
  await git(["push", "origin", BRANCH], workerPath);

  await git(["clone", remotePath, otherPath], tmpDir);
  await git(["config", "user.email", "other@example.com"], otherPath);
  await git(["config", "user.name", "Other Author"], otherPath);
  await git(["checkout", BRANCH], otherPath);

  return { tmpDir, remotePath, workerPath, otherPath };
}

/**
 * Give the worker clone a local commit, then arrange for the pull inside
 * `recoverFromPushRejection` to fetch successfully but fail to rebase with no
 * rebase left in progress — an untracked file that the upstream commit also
 * adds. That drives the last-resort force push, which is the path under test.
 */
async function primeWorkerForLastResortPush(
  workerPath: string,
  clashingFile: string,
): Promise<void> {
  await Deno.writeTextFile(`${workerPath}/worker.txt`, "worker work\n");
  await git(["add", "worker.txt"], workerPath);
  await git(["commit", "-m", "Worker commit"], workerPath);
  await Deno.writeTextFile(
    `${workerPath}/${clashingFile}`,
    "untracked clash\n",
  );
}

async function cleanup(tmpDir: string): Promise<void> {
  try {
    await Deno.remove(tmpDir, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Regression test — the concurrent author's commit must survive
// ---------------------------------------------------------------------------

Deno.test("recoverFromPushRejection - lease rejects the force push when another author pushed during recovery", async () => {
  const { tmpDir, remotePath, workerPath, otherPath } = await setupRepos();
  try {
    // Another author pushes to the same branch after the worker last fetched.
    await Deno.writeTextFile(`${otherPath}/other.txt`, "other author work\n");
    await git(["add", "other.txt"], otherPath);
    await git(["commit", "-m", "Other author commit"], otherPath);
    await git(["push", "origin", BRANCH], otherPath);
    const otherSha = await revParse("HEAD", otherPath);

    await primeWorkerForLastResortPush(workerPath, "other.txt");
    const staleSha = await revParse(
      `refs/remotes/origin/${BRANCH}`,
      workerPath,
    );
    assertNotEquals(staleSha, otherSha, "worker should start with a stale ref");

    const result = await recoverFromPushRejection(BRANCH, { cwd: workerPath });

    // The push must be refused, and the other author's commit must still be
    // the remote tip.
    assertEquals(result.ok, false);
    assertEquals(
      await revParse(`refs/heads/${BRANCH}`, remotePath),
      otherSha,
      "the other author's commit must not be overwritten",
    );
    // The pull did refresh the tracking ref — proving the lease was pinned to
    // the pre-pull baseline rather than to the refreshed ref.
    assertEquals(
      await revParse(`refs/remotes/origin/${BRANCH}`, workerPath),
      otherSha,
    );
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Happy path — an uncontested branch still force-pushes
// ---------------------------------------------------------------------------

Deno.test("recoverFromPushRejection - force push still succeeds when nobody else pushed", async () => {
  const { tmpDir, remotePath, workerPath, otherPath } = await setupRepos();
  try {
    // The clash file comes from a commit the worker has not seen, but it is
    // pushed by the worker's own identity — no third-party commit to protect.
    await Deno.writeTextFile(`${otherPath}/ci.txt`, "ci reformat\n");
    await git(["add", "ci.txt"], otherPath);
    await git(["commit", "-m", "CI commit"], otherPath);
    await git(["push", "origin", BRANCH], otherPath);

    await primeWorkerForLastResortPush(workerPath, "ci.txt");
    // The worker has since seen that commit — its lease baseline is current.
    await git(["fetch", "origin", BRANCH], workerPath);
    const workerHead = await revParse("HEAD", workerPath);

    const result = await recoverFromPushRejection(BRANCH, { cwd: workerPath });

    assertEquals(result.ok, true);
    assertEquals(
      await revParse(`refs/heads/${BRANCH}`, remotePath),
      workerHead,
      "the worker's commit should become the remote tip",
    );
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Missing baseline — falls back to the bare lease rather than failing
// ---------------------------------------------------------------------------

Deno.test("recoverFromPushRejection - falls back to a bare lease when no remote-tracking ref exists", async () => {
  const { tmpDir, remotePath, workerPath } = await setupRepos();
  try {
    const newBranch = "branch-never-pushed";
    await git(["checkout", "-b", newBranch], workerPath);
    await Deno.writeTextFile(`${workerPath}/new.txt`, "new work\n");
    await git(["add", "new.txt"], workerPath);
    await git(["commit", "-m", "New branch commit"], workerPath);
    assertEquals(
      await revParse(`refs/remotes/origin/${newBranch}`, workerPath),
      null,
      "no remote-tracking ref should exist for this branch",
    );

    const result = await recoverFromPushRejection(newBranch, {
      cwd: workerPath,
    });

    // The pull fails (no such remote branch), conflict resolution has nothing
    // to do, and the bare-lease fallback creates the branch on the remote.
    assertEquals(result.ok, true);
    assertEquals(
      await revParse(`refs/heads/${newBranch}`, remotePath),
      await revParse("HEAD", workerPath),
    );
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Argument builder
// ---------------------------------------------------------------------------

Deno.test("buildForceWithLeaseArgs - pins the lease to the captured baseline", () => {
  assertEquals(
    buildForceWithLeaseArgs(
      "feature",
      "0123456789abcdef0123456789abcdef01234567",
    ),
    [
      "push",
      "origin",
      "feature",
      "--force-with-lease=feature:0123456789abcdef0123456789abcdef01234567",
    ],
  );
});

Deno.test("buildForceWithLeaseArgs - falls back to the bare lease with no baseline", () => {
  assertEquals(buildForceWithLeaseArgs("feature", null), [
    "push",
    "origin",
    "feature",
    "--force-with-lease",
  ]);
});
